// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHyperDexFactory
/// @notice Read surface of HyperDex's pool registry.
interface IHyperDexFactory {
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

    /// @notice Resolves a pool for a token pair and fee tier.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /// @notice Registry entry for a token pair and fee tier.
    function getPoolInfo(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (PoolInfo memory);

    /// @notice Number of pools registered by this factory.
    function allPoolsLength() external view returns (uint256);

    /// @notice Divisor for the protocol's share of the LP fee for a pool.
    /// @dev Matches Uniswap v3's own encoding: 0 disables the protocol fee,
    ///      4..10 means the protocol keeps 1/4 .. 1/10 of the swap fee.
    function getProtocolFee(address pool) external view returns (uint8);

    /// @notice Records off-chain computed analytics for a pool.
    function updatePoolAnalytics(address pool, uint256 tvl, uint256 volume24h) external;

    /// @notice True when `pool` was deployed and registered by this factory.
    function isPool(address pool) external view returns (bool);
}
