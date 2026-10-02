// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBridgeAdapter } from "../interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "../interfaces/IBridgeTypes.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ILayerZeroEndpoint
 * @notice Interface for interacting with LayerZero Endpoint
 */
interface ILayerZeroEndpoint {
    /**
     * @notice Gets the fee required for a LayerZero transaction
     * @param _dstChainId The destination chain ID in LayerZero format
     * @param _userApplication The address of the user application
     * @param _payload The payload to be sent
     * @param _payInZRO Whether to pay in ZRO tokens
     * @param _adapterParams Additional parameters for the adapter
     * @return nativeFee The fee in native gas token
     * @return zroFee The fee in ZRO tokens
     */
    function estimateFees(
        uint16 _dstChainId,
        address _userApplication,
        bytes calldata _payload,
        bool _payInZRO,
        bytes calldata _adapterParams
    ) external view returns (uint256 nativeFee, uint256 zroFee);

    /**
     * @notice Sends a message to the specified chain
     * @param _dstChainId The destination chain ID in LayerZero format
     * @param _destination The address of the destination contract
     * @param _payload The payload to be sent
     * @param _refundAddress The address to refund excess fee to
     * @param _zroPaymentAddress The address to pay ZRO from
     * @param _adapterParams Additional parameters for the adapter
     */
    function send(
        uint16 _dstChainId,
        bytes calldata _destination,
        bytes calldata _payload,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes calldata _adapterParams
    ) external payable;
}

/**
 * @title ILayerZeroReceiver
 * @notice Interface that must be implemented by a contract receiving messages from LayerZero
 */
interface ILayerZeroReceiver {
    /**
     * @notice Called by the LayerZero endpoint when a message is received
     * @param _srcChainId The source chain ID in LayerZero format
     * @param _srcAddress The source address in bytes
     * @param _nonce The message nonce
     * @param _payload The payload being delivered
     */
    function lzReceive(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        uint64 _nonce,
        bytes calldata _payload
    ) external;
}

/**
 * @title LayerZeroAdapter
 * @notice Adapter for LayerZero messaging protocol
 */
contract LayerZeroAdapter is IBridgeAdapter, Ownable, ILayerZeroReceiver {
    using SafeERC20 for IERC20;

    // --- State Variables ---
    
    ILayerZeroEndpoint public endpoint;
    mapping(uint256 => uint16) public chainToLzId; // Ethereum chain ID to LayerZero chain ID mapping
    mapping(bytes32 => bytes) public requestPayloads; // Request ID to payload mapping
    address public bridgeRouter; // Address of the BridgeRouter contract

    // Standard adapter params (configurable)
    bytes public adapterParams;
    address public zroPaymentAddress;
    mapping(uint16 => bytes) public trustedRemoteLookup; // LayerZero chain ID to trusted remote address

    // requestId => the LayerZero message for it was delivered and authenticated
    mapping(bytes32 => bool) public verifiedMessages;
    // requestId => funds already released to the user
    mapping(bytes32 => bool) public completedMessages;

    // --- Events ---
    
    event LayerZeroMessageSent(bytes32 requestId, uint16 dstChainId);
    event LayerZeroMessageReceived(uint16 srcChainId, bytes srcAddress, uint64 nonce);
    event TrustedRemoteSet(uint16 _remoteChainId, bytes _path);
    event BridgeInCompleted(bytes32 requestId, address user, uint256 amount);

    // --- Constructor ---
    
    constructor(address _endpoint, address _bridgeRouter) Ownable() {
        endpoint = ILayerZeroEndpoint(_endpoint);
        bridgeRouter = _bridgeRouter;
        
        // Default adapter params (version 1, gas limit)
        adapterParams = abi.encodePacked(uint16(1), uint256(200000));
        zroPaymentAddress = address(0);
    }

    // --- External Functions ---

    /**
     * @notice Sets the LayerZero chain ID mapping
     * @param _chainId The Ethereum chain ID
     * @param _layerZeroId The LayerZero chain ID
     */
    function setChainMapping(uint256 _chainId, uint16 _layerZeroId) external onlyOwner {
        chainToLzId[_chainId] = _layerZeroId;
    }

    /**
     * @notice Sets the trusted remote for a specific chain
     * @param _chainId The LayerZero chain ID
     * @param _remoteAddress The remote address on the chain
     */
    function setTrustedRemote(uint16 _chainId, bytes calldata _remoteAddress) external onlyOwner {
        trustedRemoteLookup[_chainId] = _remoteAddress;
        emit TrustedRemoteSet(_chainId, _remoteAddress);
    }

    /**
     * @notice Sets the adapter parameters
     * @param _adapterParams The adapter parameters
     */
    function setAdapterParams(bytes calldata _adapterParams) external onlyOwner {
        adapterParams = _adapterParams;
    }

    /**
     * @notice Sets the ZRO payment address
     * @param _zroPaymentAddress The ZRO payment address
     */
    function setZroPaymentAddress(address _zroPaymentAddress) external onlyOwner {
        zroPaymentAddress = _zroPaymentAddress;
    }

    /**
     * @notice Sets the bridge router address
     * @param _bridgeRouter The bridge router address
     */
    function setBridgeRouter(address _bridgeRouter) external onlyOwner {
        bridgeRouter = _bridgeRouter;
    }

    /**
     * @notice Quotes the fee required for a bridge operation.
     * @param _request The bridge request details.
     * @return fee The estimated fee in the native currency.
     */
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256 fee) {
        uint16 dstChainId = chainToLzId[_request.dstChainId];
        require(dstChainId != 0, "LayerZeroAdapter: Invalid destination chain");
        
        // Generate the payload
        bytes memory payload = abi.encode(
            _request,
            keccak256(abi.encodePacked(_request.user, _request.srcChainId, _request.dstChainId, _request.token, _request.amount))
        );

        // Get the remote address for the destination chain
        bytes memory remoteAddress = trustedRemoteLookup[dstChainId];
        require(remoteAddress.length != 0, "LayerZeroAdapter: Remote not configured");

        // Estimate fees
        (uint256 nativeFee, ) = endpoint.estimateFees(
            dstChainId,
            address(this),
            payload,
            false, // Don't pay in ZRO
            adapterParams
        );

        return nativeFee;
    }

    /**
     * @notice Initiates the outbound bridge transfer via LayerZero.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @return messageId Identifier for the LayerZero message.
     */
    function bridgeOut(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external payable returns (bytes memory messageId) {
        require(msg.sender == bridgeRouter, "LayerZeroAdapter: Only bridge router");
        
        uint16 dstChainId = chainToLzId[_request.dstChainId];
        require(dstChainId != 0, "LayerZeroAdapter: Invalid destination chain");

        // Get the trusted remote address
        bytes memory remoteAddress = trustedRemoteLookup[dstChainId];
        require(remoteAddress.length != 0, "LayerZeroAdapter: Remote not configured");

        // Since we're using messaging rather than direct token bridge, we expect the router
        // to handle token transfers. This adapter just passes the message.

        // Create the payload with request data and requestId
        bytes memory payload = abi.encode(_request, _requestId);
        
        // Store payload for reference
        requestPayloads[_requestId] = payload;

        // Send message via LayerZero
        endpoint.send{value: msg.value}(
            dstChainId,
            remoteAddress,
            payload,
            payable(msg.sender), // Refund to the router
            zroPaymentAddress,
            adapterParams
        );

        // Emit event
        emit LayerZeroMessageSent(_requestId, dstChainId);

        // Return a message identifier
        return abi.encodePacked(dstChainId, _requestId);
    }

    /**
     * @notice Completes the inbound bridge transfer on the destination chain.
     * @dev This is called by the bridge router or relayer.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     */
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata /* _proof */
    ) external {
        // Only the BridgeRouter finalises an inbound request.
        require(msg.sender == bridgeRouter, "LayerZeroAdapter: Only bridge router");

        // The LayerZero endpoint must have delivered (and we must have verified)
        // the matching message before any funds move.
        require(verifiedMessages[_requestId], "LayerZeroAdapter: Message not verified");
        require(!completedMessages[_requestId], "LayerZeroAdapter: Already completed");
        completedMessages[_requestId] = true;

        // Release the bridged amount to the user. Verification itself happened in
        // `lzReceive` against the trusted remote, so no extra proof is needed here.
        IERC20(_request.token).safeTransfer(_request.user, _request.amount);

        emit BridgeInCompleted(_requestId, _request.user, _request.amount);
    }

    /**
     * @notice LayerZero receive function, called by the LayerZero endpoint
     * @param _srcChainId The source chain ID
     * @param _srcAddress The source address in bytes
     * @param _nonce The message nonce
     * @param _payload The payload being delivered
     */
    function lzReceive(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        uint64 _nonce,
        bytes calldata _payload
    ) external override {
        // Only the endpoint can call this
        require(msg.sender == address(endpoint), "LayerZeroAdapter: Caller is not the endpoint");
        
        // Verify the sender is a trusted source
        bytes memory trustedRemote = trustedRemoteLookup[_srcChainId];
        require(_srcAddress.length == trustedRemote.length, "LayerZeroAdapter: Invalid source length");
        require(keccak256(_srcAddress) == keccak256(trustedRemote), "LayerZeroAdapter: Invalid source address");

        // Decode the payload
        (IBridgeTypes.BridgeRequest memory request, bytes32 requestId) = abi.decode(_payload, (IBridgeTypes.BridgeRequest, bytes32));
        
        // Emit event
        emit LayerZeroMessageReceived(_srcChainId, _srcAddress, _nonce);

        // Record that this request's message has been delivered and authenticated.
        // The BridgeRouter later calls `bridgeIn`, which refuses to pay out unless
        // this flag is set.
        verifiedMessages[requestId] = true;
    }

    /**
     * @notice Allows the owner to withdraw any tokens or ETH from the adapter
     * @param _token The token address (address(0) for ETH)
     * @param _amount The amount to withdraw
     */
    function withdraw(address _token, uint256 _amount) external onlyOwner {
        if (_token == address(0)) {
            payable(owner()).transfer(_amount);
        } else {
            IERC20(_token).safeTransfer(owner(), _amount);
        }
    }

    // Allow adapter to receive ETH
    receive() external payable {}
} 