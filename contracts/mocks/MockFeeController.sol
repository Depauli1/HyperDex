// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Mock FeeController for testing
contract MockFeeController {
    /// @notice Returns a fixed fee basis points (0)
    function getCurrentFee() external pure returns (uint256) {
        return 0;
    }
}
