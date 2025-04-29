// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IBridgeTypes
 * @notice Shared types for the bridge system.
 */
interface IBridgeTypes {
    struct BridgeRequest {
        uint256 id; // Consider using bytes32 for uniqueness
        uint256 srcChainId;
        uint256 dstChainId;
        address token; // Address of the token being bridged
        uint256 amount; // Amount of the token
        address user; // User initiating the request
        uint256 deadline; // Timestamp for request expiry
        uint256 fee; // Fee paid for the bridging operation
        // Add other relevant fields like recipient address if different from user
    }
} 