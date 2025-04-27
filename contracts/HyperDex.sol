// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9.0;
pragma abicoder v2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

// Interfaces for interacting with other HyperDex contracts
import { IHyperDexFactory } from "./IHyperDexFactory.sol"; // Assuming interface is in a separate file
import "./IHyperDexPool.sol"; // Import the interface

/**
 * @title HyperDex
 * @author HyperDex Team (with enhancements by AI)
 * @notice Main interaction point for HyperDex AMM on Hyperliquid.
 * @dev Provides a central contract for executing gasless swaps via relayers
 * and potentially accessing aggregated analytics in the future.
 * Leverages EIP-712 for secure off-chain signature verification.
 */
contract HyperDex is Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // --- Constants ---

    // EIP-712 Domain Separator details
    // solhint-disable-next-line var-name-mixedcase
    bytes32 private constant _GASLESS_SWAP_TYPEHASH = keccak256(
        "GaslessSwap(address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)"
    );

    // --- State Variables ---

    // Core contracts
    IHyperDexFactory public immutable factory;
    // ISwapRouter public immutable router; // Keep if regular swaps via Uniswap Router are also planned

    // Hyperliquid integration (Optional - if needed for specific main contract logic)
    // address public hyperLiquidSystemContract;

    // Gasless operations
    address public relayer;
    mapping(address => uint256) public userNonces; // Nonce per user to prevent replay attacks
    mapping(bytes32 => bool) public executedMetaTxs; // Tracks executed meta-transaction IDs

    // --- Events ---

    event GaslessSwapExecuted(
        bytes32 indexed metaTxId,
        address indexed user,
        address indexed relayer,
        address pool,
        address tokenIn,
        address tokenOut,
        int256 amount0Delta,
        int256 amount1Delta
    );

    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    // event SystemContractUpdated(address indexed newSystemContract); // Uncomment if using hyperLiquidSystemContract

    // Replace custom errors with string constants for use in require statements
    string private constant ERROR_INVALID_RELAYER = "Invalid relayer";
    string private constant ERROR_INVALID_SIGNATURE = "Invalid signature";
    string private constant ERROR_INVALID_NONCE = "Invalid nonce";
    string private constant ERROR_META_TX_ALREADY_EXECUTED = "Meta-tx already executed";
    string private constant ERROR_DEADLINE_EXPIRED = "Deadline expired";
    string private constant ERROR_POOL_NOT_FOUND = "Pool not found";

    // --- Constructor ---

    /**
     * @notice Constructor sets initial contract addresses and EIP-712 domain.
     * @param _factory Address of the deployed HyperDexFactory contract.
     */
    constructor(
        address _factory //, address _router
    ) EIP712("HyperDex", "1") {
        // Ownable constructor is automatically called
        require(_factory != address(0), "Zero address: factory");
        // require(_router != address(0), "Zero address: router"); // Uncomment if using router

        factory = IHyperDexFactory(_factory);
        // router = ISwapRouter(_router); // Uncomment if using router

        // Set initial relayer to the deployer for testing/initial setup
        relayer = msg.sender;
        emit RelayerUpdated(address(0), msg.sender);
    }

    // --- Gasless Swap Execution ---

    /**
     * @notice Executes a swap based on user's signature, relayed by an authorized relayer.
     * @dev Verifies the EIP-712 signature, checks nonce, deadline, and prevents replay attacks.
     * Calls the `gaslessSwap` function on the target HyperDexPool.
     * @param params The parameters for the gasless swap, including user details and swap specifics.
     * @param signature The EIP-712 signature provided by the user.
     * @return amount0Delta The change in the pool's token0 balance.
     * @return amount1Delta The change in the pool's token1 balance.
     */
    function executeGaslessSwap(
        IHyperDexPool.GaslessSwapParams calldata params,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (int256 amount0Delta, int256 amount1Delta) {
        // 1. Authorization: Only the authorized relayer can submit meta-transactions
        if (msg.sender != relayer) {
            revert(ERROR_INVALID_RELAYER);
        }

        // 2. Deadline Check: Ensure the swap hasn't expired
        if (block.timestamp > params.deadline) {
            revert(ERROR_DEADLINE_EXPIRED);
        }

        // 3. Nonce Check: Ensure the nonce matches the user's expected next nonce
        uint256 expectedNonce = userNonces[params.trader];
        if (params.nonce != expectedNonce) {
            revert(ERROR_INVALID_NONCE);
        }

        // 4. Signature Verification
        _verifySignature(params, signature);
        
        // 5. Find Pool and Execute Swap
        (amount0Delta, amount1Delta) = _executeSwap(params, signature);

        return (amount0Delta, amount1Delta);
    }

    /**
     * @notice Verify the signature for a gasless swap
     * @param params The gasless swap parameters
     * @param signature The signature to verify
     */
    function _verifySignature(
        IHyperDexPool.GaslessSwapParams calldata params,
        bytes calldata signature
    ) internal view {
        // Hash the swap parameters according to EIP-712 standard
        bytes32 structHash = _hashGaslessSwap(params);
        bytes32 digest = _hashTypedDataV4(structHash);

        // Recover the signer address from the digest and signature
        address signer = digest.recover(signature);
        if (signer != params.trader || signer == address(0)) {
            revert(ERROR_INVALID_SIGNATURE);
        }

        // Check for replay attack
        bytes32 metaTxId = keccak256(abi.encodePacked(params.trader, params.nonce));
        if (executedMetaTxs[metaTxId]) {
            revert(ERROR_META_TX_ALREADY_EXECUTED);
        }
    }

    /**
     * @notice Execute the actual swap after verification
     * @param params The gasless swap parameters
     * @param signature The verified signature
     * @return amount0Delta Token0 amount delta
     * @return amount1Delta Token1 amount delta
     */
    function _executeSwap(
        IHyperDexPool.GaslessSwapParams calldata params,
        bytes calldata signature
    ) internal returns (int256 amount0Delta, int256 amount1Delta) {
        // Mark as executed and increment nonce (Checks-Effects-Interactions pattern)
        bytes32 metaTxId = keccak256(abi.encodePacked(params.trader, params.nonce));
        executedMetaTxs[metaTxId] = true;
        userNonces[params.trader]++;

        // Determine Pool Address - this needs to be derived from trader address
        // Since we no longer have tokenIn/tokenOut in the struct, we need to rely on transaction context
        // For this implementation, we'll use factory's first pool as demo
        address poolAddress = factory.allPools(0); // Gets the first registered pool
        if (poolAddress == address(0)) {
            revert(ERROR_POOL_NOT_FOUND);
        }

        // Create a new params struct for the pool
        IHyperDexPool.GaslessSwapParams memory poolParams = IHyperDexPool.GaslessSwapParams({
            trader: params.trader,
            zeroForOne: params.zeroForOne,
            amountSpecified: params.amountSpecified,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96,
            deadline: params.deadline,
            nonce: params.nonce,
            signature: signature
        });

        // Execute Swap on the Pool
        (amount0Delta, amount1Delta) = IHyperDexPool(poolAddress).gaslessSwap(poolParams);

        // Emit Event with placeholder values for tokenIn/tokenOut
        address token0 = IHyperDexPool(poolAddress).token0();
        address token1 = IHyperDexPool(poolAddress).token1();
        emit GaslessSwapExecuted(
            metaTxId,
            params.trader,
            msg.sender, // relayer
            poolAddress,
            params.zeroForOne ? token0 : token1, // tokenIn
            params.zeroForOne ? token1 : token0, // tokenOut
            amount0Delta,
            amount1Delta
        );
        
        return (amount0Delta, amount1Delta);
    }

    // --- EIP-712 Hashing ---

    /**
     * @notice Hashes the gasless swap parameters into the EIP-712 struct hash.
     * @dev Matches the structure defined in _GASLESS_SWAP_TYPEHASH.
     * @param params The gasless swap parameters.
     * @return The EIP-712 struct hash.
     */
    function _hashGaslessSwap(IHyperDexPool.GaslessSwapParams calldata params) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _GASLESS_SWAP_TYPEHASH,
                params.trader,
                params.zeroForOne,
                params.amountSpecified,
                params.sqrtPriceLimitX96,
                params.deadline,
                params.nonce
            )
        );
    }

    // --- Analytics Access ---

    /**
     * @notice Retrieves the latest analytics data for a specific pool from the factory.
     * @dev This function acts as a read-only proxy to the factory's stored analytics.
     * Calculation of derived metrics like APR might be added here later.
     * @return tvl Current Total Value Locked in the pool (needs interpretation based on factory implementation).
     * @return volume24h Trading volume in the last 24 hours (needs interpretation).
     * @return lastUpdate Timestamp of the last analytics update in the factory.
     */
    function getPoolAnalyticsData(address)
        external
        pure
        returns (
            uint256 tvl,
            uint256 volume24h,
            uint256 lastUpdate
        )
    {
        // Placeholder: Returning raw data from factory requires knowing tokenA, tokenB, fee.
        // Example (assuming you can get these details):
        // IHyperDexPool pool = IHyperDexPool(poolAddress);
        // address tokenA = pool.token0(); // Or token1 depending on order
        // address tokenB = pool.token1(); // Or token0
        // uint24 fee = pool.fee();
        // IHyperDexFactory.PoolInfo memory info = factory.getPoolInfo(tokenA, tokenB, fee);
        // return (info.totalValueLocked, info.volume24h, info.lastAnalyticsUpdate);

        // Simplified: Return 0s as direct lookup isn't straightforward with current factory interface
        // TODO: Enhance factory or this function for direct analytics retrieval by pool address.
        return (0, 0, 0);
    }


    // --- Admin Functions ---

    /**
     * @notice Updates the authorized relayer address.
     * @param _newRelayer The address of the new relayer.
     */
    function setRelayer(address _newRelayer) external onlyOwner {
        require(_newRelayer != address(0), "Zero address: relayer");
        address oldRelayer = relayer;
        relayer = _newRelayer;
        emit RelayerUpdated(oldRelayer, _newRelayer);
    }

    /// @notice Pause contract in emergencies
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause contract after emergency
    function unpause() external onlyOwner {
        _unpause();
    }

    /* // Uncomment if using hyperLiquidSystemContract
    function setHyperLiquidSystemContract(address _systemContract) external onlyOwner {
        require(_systemContract != address(0), "Zero address: system contract");
        hyperLiquidSystemContract = _systemContract;
        emit SystemContractUpdated(_systemContract);
    }
    */

    // --- Helper Functions ---

    /**
     * @notice Returns the current nonce for a given user.
     * @param user The address of the user.
     * @return The next nonce to be used for a meta-transaction.
     */
    function getNonce(address user) external view returns (uint256) {
        return userNonces[user];
    }
}
