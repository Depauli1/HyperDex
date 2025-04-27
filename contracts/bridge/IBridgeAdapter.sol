// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Standard data structure for cross-chain bridge requests
struct BridgeRequest {
    bytes32 id;
    uint256 srcChainId;
    uint256 dstChainId;
    address token;
    uint256 amount;
    address user;
    uint256 deadline;
    uint256 fee;
}

/// @title Bridge Adapter Interface
/// @notice Defines functions each bridge protocol adapter must implement
interface IBridgeAdapter {
    /// @notice Quote the fee charged by this adapter for the request
    function quoteFees(BridgeRequest calldata req) external view returns (uint256);

    /// @notice Initiate bridging of assets to the destination chain
    function bridgeOut(BridgeRequest calldata req) external payable;

    /// @notice Complete bridging on destination chain using proof
    function bridgeIn(BridgeRequest calldata req, bytes calldata proof) external;

    /// @notice Get the name of the bridge protocol
    function getName() external pure returns (string memory);

    /// @notice Get the version of the bridge protocol
    function getVersion() external pure returns (string memory);
}
