// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
pragma abicoder v2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import "./vendor/v3-core/interfaces/IUniswapV3Pool.sol";
import "./vendor/v3-core/interfaces/callback/IUniswapV3SwapCallback.sol";
import "./IHyperDexFactory.sol";

/**
 * @title HyperDex
 * @notice Relayer gateway that executes gasless swaps against Uniswap v3 pools.
 * @dev The trader signs an EIP-712 message naming the pool, direction, amount,
 *      price limit, deadline and nonce. This contract verifies that signature,
 *      calls `IUniswapV3Pool.swap`, and settles the pool's callback by pulling
 *      the input token from the trader.
 *
 *      The AMM itself is the audited `UniswapV3Pool`. Nothing here re-implements
 *      swap, tick or liquidity math.
 */
contract HyperDex is IUniswapV3SwapCallback, Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    /// @dev Matches the struct signed by traders. `pool` binds the signature to
    ///      one specific pool so it cannot be replayed against another market.
    bytes32 private constant _GASLESS_SWAP_TYPEHASH = keccak256(
        "GaslessSwap(address pool,address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)"
    );

    struct GaslessSwapParams {
        address pool;
        address trader;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 deadline;
        uint256 nonce;
    }

    IHyperDexFactory public immutable factory;

    address public relayer;
    mapping(address => uint256) public userNonces;

    event GaslessSwapExecuted(
        address indexed trader,
        address indexed relayer,
        address indexed pool,
        bool zeroForOne,
        int256 amount0Delta,
        int256 amount1Delta
    );
    event RelayerUpdated(address indexed relayer);

    error InvalidRelayer();
    error InvalidSignature();
    error InvalidNonce();
    error DeadlineExpired();
    error UnknownPool();
    error ZeroAmount();
    error UnauthorizedCallback();

    constructor(address _factory) EIP712("HyperDex", "1") {
        factory = IHyperDexFactory(_factory);
    }

    // --- Admin ---

    function setRelayer(address _relayer) external onlyOwner {
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice The trader's next expected nonce.
    function getNonce(address trader) external view returns (uint256) {
        return userNonces[trader];
    }

    // --- Gasless swaps ---

    /**
     * @notice Submits a trader-signed swap. Callable only by the relayer.
     * @param params The signed swap parameters.
     * @param signature The trader's EIP-712 signature over `params`.
     * @return amount0Delta Signed token0 delta reported by the pool.
     * @return amount1Delta Signed token1 delta reported by the pool.
     */
    function executeGaslessSwap(
        GaslessSwapParams calldata params,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (int256 amount0Delta, int256 amount1Delta) {
        if (msg.sender != relayer) revert InvalidRelayer();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.amountSpecified == 0) revert ZeroAmount();
        if (params.nonce != userNonces[params.trader]) revert InvalidNonce();

        _verifySignature(params, signature);

        // Only pools this protocol deployed may be swapped through; this is also
        // what authenticates the swap callback below.
        if (!factory.isPool(params.pool)) revert UnknownPool();

        // Checks-effects-interactions: consume the nonce before touching the pool.
        userNonces[params.trader] = params.nonce + 1;

        // The trader is the recipient, so the pool sends the output token
        // straight to them once this contract has settled the input leg.
        (amount0Delta, amount1Delta) = IUniswapV3Pool(params.pool).swap(
            params.trader,
            params.zeroForOne,
            params.amountSpecified,
            params.sqrtPriceLimitX96,
            abi.encode(params.trader)
        );

        emit GaslessSwapExecuted(
            params.trader,
            msg.sender,
            params.pool,
            params.zeroForOne,
            amount0Delta,
            amount1Delta
        );
    }

    /**
     * @notice Settles the input leg of a swap. Called by the pool mid-swap.
     * @param amount0Delta Signed token0 delta; positive means the pool is owed.
     * @param amount1Delta Signed token1 delta; positive means the pool is owed.
     * @param data ABI-encoded trader address.
     */
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        // Only a pool this protocol deployed may call back. Without this, any
        // contract could drain a trader's approval by faking a callback.
        if (!factory.isPool(msg.sender)) revert UnauthorizedCallback();

        address trader = abi.decode(data, (address));
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);

        if (amount0Delta > 0) {
            IERC20(pool.token0()).safeTransferFrom(trader, msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(pool.token1()).safeTransferFrom(trader, msg.sender, uint256(amount1Delta));
        }
    }

    // --- Signature verification ---

    function _verifySignature(GaslessSwapParams calldata params, bytes calldata signature)
        internal
        view
    {
        address signer = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    _GASLESS_SWAP_TYPEHASH,
                    params.pool,
                    params.trader,
                    params.zeroForOne,
                    params.amountSpecified,
                    params.sqrtPriceLimitX96,
                    params.deadline,
                    params.nonce
                )
            )
        ).recover(signature);

        if (signer != params.trader || signer == address(0)) revert InvalidSignature();
    }
}
