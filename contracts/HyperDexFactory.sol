// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./vendor/v3-core/interfaces/IUniswapV3Factory.sol";
import "./IHyperDexFactory.sol";
import "./interfaces/IFeeController.sol";

/**
 * @title HyperDexFactory
 * @notice HyperDex's registry and configuration layer on top of the audited
 *         Uniswap v3 core factory.
 * @dev Pools are `UniswapV3Pool` instances deployed by `UniswapV3Factory`.
 *      HyperDex deliberately does not re-implement the AMM: this contract only
 *      tracks which pools belong to the protocol, exposes fee tiers, and holds
 *      protocol-level settings. The previous version of this file tried to
 *      compute a pool address itself and never deployed anything.
 *
 *      The v3 factory is a separate contract because it is written for solc
 *      0.7.6 and cannot be imported by 0.8 code. Deploy it first, enable the
 *      fee tiers you want, then pass its address here and call
 *      `IUniswapV3Factory.setOwner(hyperDexFactory)` so this contract can
 *      enable tiers, set each pool's protocol fee and collect the accrued
 *      protocol revenue.
 *
 *      Protocol fees: v3 lets the factory owner take `1/denominator` of the LP
 *      fee by calling `pool.setFeeProtocol(denominator, denominator)` with a
 *      denominator of 4..10. This contract is that owner, so `setProtocolFee`
 *      both records the setting and applies it to the pool, and an optional
 *      `IFeeController` can drive the value from a volatility policy.
 */
contract HyperDexFactory is Ownable, IHyperDexFactory {
    /// @notice The audited Uniswap v3 factory that deploys and owns every pool.
    IUniswapV3Factory public immutable v3Factory;

    /// @dev pool address => true, for callbacks to prove a pool is genuine.
    mapping(address => bool) public isPool;
    mapping(bytes32 => IHyperDexFactory.PoolInfo) public pools;
    address[] public allPools;

    /// @dev Divisor for the protocol's share of the LP fee (0 = off, 4..10).
    uint8 public defaultProtocolFee;
    mapping(address => uint8) public customProtocolFees;

    /// @dev Optional policy module consulted by `applyProtocolFee`.
    IFeeController public feeController;

    /// @dev Address authorised to push analytics updates.
    address public analyticsUpdater;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 fee,
        int24 tickSpacing,
        address pool
    );
    event FeeAmountEnabled(uint24 fee, int24 tickSpacing);
    event ProtocolFeeUpdated(address indexed pool, uint8 denominator);
    event ProtocolFeesCollected(address indexed pool, address indexed recipient, uint128 amount0, uint128 amount1);
    event AnalyticsUpdated(address indexed pool, uint256 tvl, uint256 volume24h);
    event AnalyticsUpdaterUpdated(address indexed updater);
    event FeeControllerUpdated(address indexed controller);

    error IdenticalTokens();
    error ZeroAddress();
    error UnsupportedFeeTier();
    error UnknownPool();
    error NotAnalyticsUpdater();
    error InvalidProtocolFee();

    /// @param _v3Factory An already-deployed `UniswapV3Factory`.
    constructor(address _v3Factory) {
        if (_v3Factory == address(0)) revert ZeroAddress();
        v3Factory = IUniswapV3Factory(_v3Factory);
    }

    // --- Pool creation ---

    /**
     * @notice Creates a pool through the Uniswap v3 factory and registers it.
     * @param tokenA One token of the pair, in any order.
     * @param tokenB The other token of the pair.
     * @param fee The fee tier.
     * @return pool The deployed pool address.
     */
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address pool) {
        if (tokenA == tokenB) revert IdenticalTokens();
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (v3Factory.feeAmountTickSpacing(fee) == 0) revert UnsupportedFeeTier();

        // The audited factory sorts the tokens, computes the CREATE2 address and
        // deploys the pool.
        pool = v3Factory.createPool(tokenA, tokenB, fee);
        if (isPool[pool]) revert IdenticalTokens();

        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        bytes32 key = _key(token0, token1, fee);
        pools[key] = IHyperDexFactory.PoolInfo({
            poolAddress: pool,
            token0: token0,
            token1: token1,
            fee: fee,
            tickSpacing: v3Factory.feeAmountTickSpacing(fee),
            enabled: true,
            creationTimestamp: block.timestamp,
            totalValueLocked: 0,
            volume24h: 0,
            lastAnalyticsUpdate: block.timestamp
        });
        isPool[pool] = true;
        allPools.push(pool);

        emit PoolCreated(token0, token1, fee, v3Factory.feeAmountTickSpacing(fee), pool);
        return pool;
    }

    /// @notice Enables an additional fee tier on the underlying v3 factory.
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external onlyOwner {
        _enableFeeAmount(fee, tickSpacing);
    }

    function _enableFeeAmount(uint24 fee, int24 tickSpacing) private {
        v3Factory.enableFeeAmount(fee, tickSpacing);
        emit FeeAmountEnabled(fee, tickSpacing);
    }

    // --- Reads ---

    /// @inheritdoc IHyperDexFactory
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view override returns (address) {
        return v3Factory.getPool(tokenA, tokenB, fee);
    }

    /// @inheritdoc IHyperDexFactory
    function getPoolInfo(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view override returns (IHyperDexFactory.PoolInfo memory) {
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        return pools[_key(token0, token1, fee)];
    }

    /// @inheritdoc IHyperDexFactory
    function allPoolsLength() external view override returns (uint256) {
        return allPools.length;
    }

    /// @inheritdoc IHyperDexFactory
    function getProtocolFee(address pool) external view override returns (uint8) {
        uint8 custom = customProtocolFees[pool];
        return custom != 0 ? custom : defaultProtocolFee;
    }

    // --- Admin ---

    /// @notice Sets a pool's protocol fee and applies it on-chain.
    /// @param pool A pool created by this factory.
    /// @param denominator 0 to switch the protocol fee off, or 4..10 for 1/N.
    function setProtocolFee(address pool, uint8 denominator) external onlyOwner {
        if (!_validDenominator(denominator)) revert InvalidProtocolFee();
        if (!isPool[pool]) revert UnknownPool();

        customProtocolFees[pool] = denominator;
        _applyProtocolFee(pool, denominator);
        emit ProtocolFeeUpdated(pool, denominator);
    }

    /// @notice Sets the fallback protocol fee used when no controller is installed.
    /// @dev Existing pools are untouched; use `setProtocolFee`/`applyProtocolFee`.
    function setDefaultProtocolFee(uint8 denominator) external onlyOwner {
        if (!_validDenominator(denominator)) revert InvalidProtocolFee();
        defaultProtocolFee = denominator;
        emit ProtocolFeeUpdated(address(0), denominator);
    }

    /// @notice Installs (or clears) the policy module used by `applyProtocolFee`.
    function setFeeController(address controller) external onlyOwner {
        feeController = IFeeController(controller);
        emit FeeControllerUpdated(controller);
    }

    /// @notice Applies the current protocol-fee policy to a pool.
    /// @dev Uses the fee controller's output when one is installed, otherwise
    ///      the factory default. Permissionless: the value can only ever be one
    ///      the owner has configured, so anyone may pay the gas to sync a pool.
    ///
    ///      A pool must be initialised before its protocol fee can be set (v3's
    ///      `setFeeProtocol` is guarded by the pool lock), which is why the
    ///      policy is applied here rather than at `createPool` time.
    function applyProtocolFee(address pool) external {
        if (!isPool[pool]) revert UnknownPool();

        uint8 denominator;
        address controller = address(feeController);
        if (controller != address(0)) {
            denominator = IFeeController(controller).getProtocolFeeDenominator();
        } else {
            denominator = defaultProtocolFee;
            if (denominator == 0) revert ZeroAddress();
        }
        if (!_validDenominator(denominator)) revert InvalidProtocolFee();

        _applyProtocolFee(pool, denominator);
        emit ProtocolFeeUpdated(pool, denominator);
    }

    /// @notice The protocol fee that `applyProtocolFee` would apply to a pool.
    function pendingProtocolFee(address pool) external view returns (uint8) {
        if (!isPool[pool]) revert UnknownPool();
        address controller = address(feeController);
        if (controller != address(0)) {
            return IFeeController(controller).getProtocolFeeDenominator();
        }
        return defaultProtocolFee;
    }

    /// @notice Collects the protocol fees a pool has accrued.
    /// @dev Only the v3 factory owner (this contract) may call `collectProtocol`;
    ///      the funds are forwarded to `recipient` in the same transaction.
    function collectProtocolFees(
        address pool,
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external onlyOwner returns (uint128 amount0, uint128 amount1) {
        if (!isPool[pool]) revert UnknownPool();
        if (recipient == address(0)) revert ZeroAddress();

        (amount0, amount1) = IUniswapV3PoolOwnerActions(pool).collectProtocol(
            recipient,
            amount0Requested,
            amount1Requested
        );

        emit ProtocolFeesCollected(pool, recipient, amount0, amount1);
    }

    function setAnalyticsUpdater(address updater) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        analyticsUpdater = updater;
        emit AnalyticsUpdaterUpdated(updater);
    }

    /// @inheritdoc IHyperDexFactory
    function updatePoolAnalytics(
        address pool,
        uint256 tvl,
        uint256 volume24h
    ) external override {
        if (msg.sender != analyticsUpdater) revert NotAnalyticsUpdater();
        if (!isPool[pool]) revert UnknownPool();

        bytes32 key = _poolKey(pool);
        pools[key].totalValueLocked = tvl;
        pools[key].volume24h = volume24h;
        pools[key].lastAnalyticsUpdate = block.timestamp;

        emit AnalyticsUpdated(pool, tvl, volume24h);
    }

    // --- Internals ---

    /// @dev v3 accepts 0 (off) or 4..10 (1/4..1/10 of the LP fee).
    function _validDenominator(uint8 d) private pure returns (bool) {
        return d == 0 || (d >= 4 && d <= 10);
    }

    function _applyProtocolFee(address pool, uint8 denominator) private {
        IUniswapV3PoolOwnerActions(pool).setFeeProtocol(denominator, denominator);
    }

    function _key(address token0, address token1, uint24 fee) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(token0, token1, fee));
    }

    /// @dev Finds the registry key a pool was stored under.
    function _poolKey(address pool) private view returns (bytes32) {
        for (uint256 i = 0; i < allPools.length; i++) {
            if (allPools[i] == pool) {
                return _key(
                    UniswapV3PoolLike(pool).token0(),
                    UniswapV3PoolLike(pool).token1(),
                    UniswapV3PoolLike(pool).fee()
                );
            }
        }
        revert UnknownPool();
    }
}

/// @dev Minimal read surface of a Uniswap v3 pool.
interface UniswapV3PoolLike {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);
}

/// @dev Owner surface of a Uniswap v3 pool (callable only by the v3 factory owner).
interface IUniswapV3PoolOwnerActions {
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;

    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);
}
