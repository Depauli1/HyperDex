// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockConnext
 * @notice A mock implementation of the Connext protocol interface for testing
 */
contract MockConnext {
    // --- State Variables ---
    
    // Fee to return from calculateRelayerFee
    uint256 public relayerFee;
    
    // Transfer ID to return from xcTransfer
    bytes32 public transferId;
    
    // Store the last parameters received by the functions
    uint32 public lastDestinationDomain;
    address public lastRecipient;
    address public lastTokenAddress;
    uint256 public lastAmount;
    uint256 public lastSlippage;
    uint256 public lastRelayerFee;
    
    uint32 public lastOriginDomain;
    uint32 public lastNonce;
    bytes32 public lastOriginSender;
    bytes public lastBridgeData;
    
    // --- Events ---
    
    event TransferInitiated(
        uint32 destinationDomain,
        address recipient,
        address token,
        uint256 amount,
        uint256 slippage,
        uint256 relayerFee,
        bytes32 transferId
    );
    
    event TransferCompleted(
        uint32 originDomain,
        uint32 nonce,
        bytes32 originSender,
        bytes bridgeData
    );
    
    // --- Constructor ---
    
    constructor() {
        relayerFee = 0.01 ether; // Default fee
        transferId = bytes32(uint256(0x123456)); // Default transfer ID
    }
    
    // --- External Functions ---
    
    /**
     * @notice Sets the relayer fee to return
     * @param _relayerFee The relayer fee
     */
    function setRelayerFee(uint256 _relayerFee) external {
        relayerFee = _relayerFee;
    }
    
    /**
     * @notice Sets the transfer ID to return
     * @param _transferId The transfer ID
     */
    function setTransferId(bytes32 _transferId) external {
        transferId = _transferId;
    }
    
    /**
     * @notice Returns a domain ID for a given chain ID (not used in tests)
     * @param chainId The chain ID
     * @return domain A fixed domain ID
     */
    function domainLookup(uint256 chainId) external pure returns (uint32 domain) {
        return uint32(chainId * 1000); // Arbitrary mapping for testing
    }
    
    /**
     * @notice Mock implementation of calculateRelayerFee
     * @param destinationDomain The destination domain
     * @param tokenAddress The token address
     * @param amount The amount of tokens
     * @return fee The relayer fee
     */
    function calculateRelayerFee(
        uint32 destinationDomain,
        address tokenAddress,
        uint256 amount
    ) external view returns (uint256 fee) {
        // Store parameters
        lastDestinationDomain = destinationDomain;
        lastTokenAddress = tokenAddress;
        lastAmount = amount;
        
        return relayerFee;
    }
    
    /**
     * @notice Mock implementation of xcTransfer
     * @param destinationDomain The destination domain
     * @param recipient The recipient address
     * @param tokenAddress The token address
     * @param amount The amount of tokens
     * @param slippage The slippage tolerance
     * @param relayerFeeParam The relayer fee
     * @return The transfer ID
     */
    function xcTransfer(
        uint32 destinationDomain,
        address recipient,
        address tokenAddress,
        uint256 amount,
        uint256 slippage,
        uint256 relayerFeeParam
    ) external payable returns (bytes32) {
        // Store parameters
        lastDestinationDomain = destinationDomain;
        lastRecipient = recipient;
        lastTokenAddress = tokenAddress;
        lastAmount = amount;
        lastSlippage = slippage;
        lastRelayerFee = msg.value;
        
        emit TransferInitiated(
            destinationDomain,
            recipient,
            tokenAddress,
            amount,
            slippage,
            msg.value,
            transferId
        );
        
        return transferId;
    }
    
    /**
     * @notice Mock implementation of completeTransfer
     * @param originDomain The origin domain
     * @param nonce The nonce
     * @param originSender The origin sender
     * @param bridgeData The bridge data
     */
    function completeTransfer(
        uint32 originDomain,
        uint32 nonce,
        bytes32 originSender,
        bytes calldata bridgeData
    ) external {
        // Store parameters
        lastOriginDomain = originDomain;
        lastNonce = nonce;
        lastOriginSender = originSender;
        lastBridgeData = bridgeData;
        
        emit TransferCompleted(
            originDomain,
            nonce,
            originSender,
            bridgeData
        );
    }
} 