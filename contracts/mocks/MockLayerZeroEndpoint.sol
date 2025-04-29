// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../adapters/LayerZeroAdapter.sol";

/**
 * @title MockLayerZeroEndpoint
 * @notice A mock implementation of the LayerZero endpoint for testing
 */
contract MockLayerZeroEndpoint {
    // --- State Variables ---
    
    // Fee to return from estimateFees
    uint256 public nativeFee;
    uint256 public zroFee;
    
    // Store the last parameters received by send
    uint16 public lastDstChainId;
    bytes public lastDestination;
    bytes public lastPayload;
    address payable public lastRefundAddress;
    address public lastZroPaymentAddress;
    bytes public lastAdapterParams;
    
    // --- Events ---
    
    event MessageSent(
        uint16 dstChainId,
        bytes destination,
        bytes payload,
        address refundAddress,
        address zroPaymentAddress
    );
    
    event MessageReceived(
        uint16 srcChainId,
        bytes srcAddress,
        address dstAddress,
        uint64 nonce,
        bytes payload
    );
    
    // --- Constructor ---
    
    constructor() {
        nativeFee = 0.01 ether; // Default fee
    }
    
    // --- External Functions ---
    
    /**
     * @notice Sets the native fee to return
     * @param _nativeFee The native fee
     */
    function setNativeFee(uint256 _nativeFee) external {
        nativeFee = _nativeFee;
    }
    
    /**
     * @notice Sets the ZRO fee to return
     * @param _zroFee The ZRO fee
     */
    function setZroFee(uint256 _zroFee) external {
        zroFee = _zroFee;
    }
    
    /**
     * @notice Mock implementation of estimateFees
     * @param _dstChainId The destination chain ID
     * @param _userApplication The user application address
     * @param _payload The payload
     * @param _payInZRO Whether to pay in ZRO
     * @param _adapterParams The adapter parameters
     * @return nativeFee The native fee
     * @return zroFee The ZRO fee
     */
    function estimateFees(
        uint16 _dstChainId,
        address _userApplication,
        bytes calldata _payload,
        bool _payInZRO,
        bytes calldata _adapterParams
    ) external view returns (uint256, uint256) {
        // Store parameters (not actually stored since this is a view function)
        lastDstChainId = _dstChainId;
        lastDestination = abi.encode(_userApplication);
        lastPayload = _payload;
        lastAdapterParams = _adapterParams;
        
        return (nativeFee, zroFee);
    }
    
    /**
     * @notice Mock implementation of send
     * @param _dstChainId The destination chain ID
     * @param _destination The destination address
     * @param _payload The payload
     * @param _refundAddress The refund address
     * @param _zroPaymentAddress The ZRO payment address
     * @param _adapterParams The adapter parameters
     */
    function send(
        uint16 _dstChainId,
        bytes calldata _destination,
        bytes calldata _payload,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes calldata _adapterParams
    ) external payable {
        // Store parameters
        lastDstChainId = _dstChainId;
        lastDestination = _destination;
        lastPayload = _payload;
        lastRefundAddress = _refundAddress;
        lastZroPaymentAddress = _zroPaymentAddress;
        lastAdapterParams = _adapterParams;
        
        emit MessageSent(
            _dstChainId,
            _destination,
            _payload,
            _refundAddress,
            _zroPaymentAddress
        );
    }
    
    /**
     * @notice Simulates receiving a message from LayerZero
     * @param _srcChainId The source chain ID
     * @param _srcAddress The source address
     * @param _dstAddress The destination address (ILayerZeroReceiver)
     * @param _nonce The nonce
     * @param _payload The payload
     */
    function receiveMessage(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        address _dstAddress,
        uint64 _nonce,
        bytes calldata _payload
    ) external {
        emit MessageReceived(
            _srcChainId,
            _srcAddress,
            _dstAddress,
            _nonce,
            _payload
        );
        
        // Call the lzReceive function on the destination address
        ILayerZeroReceiver(_dstAddress).lzReceive(
            _srcChainId,
            _srcAddress,
            _nonce,
            _payload
        );
    }
} 