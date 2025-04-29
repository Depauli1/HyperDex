// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IBridgeAdapter.sol";
import "../interfaces/IBridgeTypes.sol";

/**
 * @title MockBridgeAdapter
 * @notice A mock bridge adapter for testing purposes
 */
contract MockBridgeAdapter is IBridgeAdapter {
    // --- State Variables ---
    
    // Store the fee to return from quoteFees
    uint256 private _quotedFee;
    
    // Store the message ID to return from bridgeOut
    bytes private _mockMessageId;
    
    // Track if bridgeIn was called and with what parameters
    bool public bridgeInCalled;
    IBridgeTypes.BridgeRequest public lastRequest;
    bytes32 public lastRequestId;
    bytes public lastProof;
    
    // --- Events ---
    
    event BridgeOutCalled(IBridgeTypes.BridgeRequest request, bytes32 requestId, uint256 value);
    event BridgeInCalled(IBridgeTypes.BridgeRequest request, bytes32 requestId, bytes proof);
    
    // --- Constructor ---
    
    constructor() {
        _quotedFee = 0.01 ether; // Default fee
        _mockMessageId = abi.encode(bytes32(0x1234)); // Default message ID
    }
    
    // --- External Functions ---
    
    /**
     * @notice Sets the fee to return from quoteFees
     * @param fee The fee to return
     */
    function setQuotedFee(uint256 fee) external {
        _quotedFee = fee;
    }
    
    /**
     * @notice Sets the message ID to return from bridgeOut
     * @param messageId The message ID to return
     */
    function setMockMessageId(bytes memory messageId) external {
        _mockMessageId = messageId;
    }
    
    /**
     * @notice Quotes the fee required for a bridge operation.
     * @param _request The bridge request details.
     * @return fee The quoted fee.
     */
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256 fee) {
        return _quotedFee;
    }
    
    /**
     * @notice Simulates initiating an outbound bridge transfer.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @return messageId The mock message ID.
     */
    function bridgeOut(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external payable returns (bytes memory messageId) {
        emit BridgeOutCalled(_request, _requestId, msg.value);
        return _mockMessageId;
    }
    
    /**
     * @notice Simulates completing an inbound bridge transfer.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @param _proof The proof data.
     */
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata _proof
    ) external {
        bridgeInCalled = true;
        lastRequest = _request;
        lastRequestId = _requestId;
        lastProof = _proof;
        
        emit BridgeInCalled(_request, _requestId, _proof);
    }
} 