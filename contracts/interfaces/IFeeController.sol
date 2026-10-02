// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFeeController
 * @notice Policy hook consulted by `HyperDexFactory` when it sets a pool's
 *         protocol fee.
 * @dev Uniswap v3 expresses the protocol's cut of the LP fee as a divisor:
 *      the factory passes `setFeeProtocol(0 | 4..10)` and the pool keeps
 *      `1/denominator` of the swap fee. This interface deliberately uses the
 *      same units so the value can be applied without conversion.
 */
interface IFeeController {
    /// @notice Divisor for the protocol's share of the LP fee.
    /// @return denominator 0 (protocol fee off) or 4..10 (pool keeps 1/4..1/10).
    function getProtocolFeeDenominator() external view returns (uint8 denominator);
}
