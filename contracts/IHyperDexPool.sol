// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9.0;
pragma abicoder v2;

// Interface for HyperDexPool (based on hyperdex-pool.txt & hyperdex-pool-continued.txt)
interface IHyperDexPool {
    // Mirror the GaslessSwapParams struct from the pool contract
    struct GaslessSwapParams {
        address trader;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 deadline;
        uint256 nonce;
        bytes signature;
    }

    function gaslessSwap(GaslessSwapParams calldata params) external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    // Add other function signatures from HyperDexPool.sol if HyperDex.sol needs to call them
}