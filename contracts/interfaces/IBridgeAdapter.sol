// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IBridgeTypes } from "./IBridgeTypes.sol";

/**
 * @title IBridgeAdapter
 * @notice Interface for cross-chain bridge adapters.
 */
interface IBridgeAdapter {
    /**
     * @notice Quotes the fee required for a bridge operation.
     * @param _request The bridge request details.
     * @return fee The estimated fee in the native currency of the source chain.
     */
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256 fee);

    /**
     * @notice Initiates the outbound bridge transfer.
     * @dev Called by BridgeRouter on the source chain.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @return messageId An identifier for the specific bridge message/transaction (protocol-dependent).
     */
    function bridgeOut(IBridgeTypes.BridgeRequest calldata _request, bytes32 _requestId) external payable returns (bytes memory messageId);

    /**
     * @notice Completes the inbound bridge transfer.
     * @dev Called by the off-chain relayer/watcher on the destination chain.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @param _proof Protocol-specific proof or payload required to validate the transfer.
     */
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata _proof
    ) external;
} 