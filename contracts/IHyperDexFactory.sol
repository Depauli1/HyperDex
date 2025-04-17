// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9.0;
pragma abicoder v2;

// Interface for HyperDexFactory (based on hyperdex-factory.txt)
interface IHyperDexFactory {
    // Mirror the PoolInfo struct if needed by functions used here
    // (Not strictly required if only using getPool and getPoolInfo signatures)
    struct PoolInfo {
        address poolAddress;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        bool enabled;
        uint256 creationTimestamp;
        uint256 totalValueLocked;
        uint256 volume24h;
        uint256 lastAnalyticsUpdate;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function getPoolInfo(address tokenA, address tokenB, uint24 fee) external view returns (PoolInfo memory);
    // Add other function signatures from HyperDexFactory.sol if HyperDex.sol needs to call them
     function updatePoolAnalytics(address pool, uint256 tvl, uint256 volume24h) external; // Added based on pool code
     function getProtocolFee(address pool) external view returns (uint32); // Added based on pool code
     function allPools(uint256 index) external view returns (address); // Add access to the allPools array
}