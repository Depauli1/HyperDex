// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./vendor/v3-core/interfaces/IUniswapV3Factory.sol";
import "./IHyperDexFactory.sol";

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
 *      `IUniswapV3Factory.setOwner(hyperDexFactory)` if this contract should be
 *      able to enable further tiers.
 */
contract HyperDexFactory is Ownable, IHyperDexFactory {
    /// @notice The audited Uniswap v3 factory that deploys and owns every pool.
    IUniswapV3Factory public immutable v3Factory;

    /// @dev pool address => true, for callbacks to prove a pool is genuine.
    mapping(address => bool) public isPool;
    mapping(bytes32 => IHyperDexFactory.PoolInfo) public pools;
    address[] public allPools;

    /// @dev Protocol share of the trading fee, in basis points.
    uint32 public defaultProtocolFee;
    mapping(address => uint32) public customProtocolFees;

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
    event ProtocolFeeUpdated(address indexed pool, uint32 newFee);
    event AnalyticsUpdated(address indexed pool, uint256 tvl, uint256 volume24h);
    event AnalyticsUpdaterUpdated(address indexed updater);

    error IdenticalTokens();
    error ZeroAddress();
    error UnsupportedFeeTier();
    error UnknownPool();
    error NotAnalyticsUpdater();

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
    function getProtocolFee(address pool) external view override returns (uint32) {
        uint32 custom = customProtocolFees[pool];
        return custom != 0 ? custom : defaultProtocolFee;
    }

    // --- Admin ---

    function setProtocolFee(address pool, uint32 newFee) external onlyOwner {
        if (newFee > 10000) revert UnsupportedFeeTier();
        customProtocolFees[pool] = newFee;
        emit ProtocolFeeUpdated(pool, newFee);
    }

    function setDefaultProtocolFee(uint32 newFee) external onlyOwner {
        if (newFee > 10000) revert UnsupportedFeeTier();
        defaultProtocolFee = newFee;
        emit ProtocolFeeUpdated(address(0), newFee);
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
