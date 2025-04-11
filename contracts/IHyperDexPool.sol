// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

// Interface for HyperDexPool (based on hyperdex-pool.txt & hyperdex-pool-continued.txt)
interface IHyperDexPool {
    // Mirror the GaslessSwapParams struct from the pool contract
    // Ensure this matches the struct expected by the pool's gaslessSwap function
    // AND the struct used for hashing in HyperDex.sol
     struct GaslessSwapParams {
        address trader;
        address tokenIn;  // Added for clarity in main contract hashing
        address tokenOut; // Added for clarity in main contract hashing
        uint24 fee;       // Added for pool lookup
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 deadline;
        uint256 nonce;
        // bytes signature is NOT part of the struct passed to pool's gaslessSwap
     }

    // Note: The pool's internal gaslessSwap might take a slightly different
    // struct if it doesn't need tokenIn/tokenOut/fee directly.
    // However, the signature here must match what HyperDex.sol calls.
    // The pool contract will need to be adjusted if its gaslessSwap signature
    // doesn't match this interface's expectation based on HyperDex.sol.
    function gaslessSwap(GaslessSwapParams calldata params, bytes calldata signature)
        external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    // Add other function signatures from HyperDexPool.sol if HyperDex.sol needs to call them
}