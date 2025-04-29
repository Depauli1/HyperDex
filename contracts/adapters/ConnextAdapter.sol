// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBridgeAdapter } from "../interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "../interfaces/IBridgeTypes.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title IConnext
 * @notice Interface for interacting with Connext bridge
 */
interface IConnext {
    /**
     * @notice The nomad domain ID for the specified chain
     * @param chainId The chain ID
     * @return domain The nomad domain ID
     */
    function domainLookup(uint256 chainId) external view returns (uint32 domain);

    /**
     * @notice Estimates the relayer fee for a cross-chain transfer
     * @param destinationDomain The destination nomad domain
     * @param tokenAddress The token address
     * @param amount The amount of tokens
     * @return fee The estimated relayer fee
     */
    function calculateRelayerFee(
        uint32 destinationDomain,
        address tokenAddress,
        uint256 amount
    ) external view returns (uint256 fee);

    /**
     * @notice Cross-chain transfer of tokens
     * @param destinationDomain The destination nomad domain
     * @param recipient The recipient address on the destination chain
     * @param tokenAddress The token address
     * @param amount The amount of tokens
     * @param slippage The maximum slippage percentage
     * @param relayerFee The relayer fee
     * @return transferId The ID of the transfer
     */
    function xcTransfer(
        uint32 destinationDomain,
        address recipient,
        address tokenAddress,
        uint256 amount,
        uint256 slippage,
        uint256 relayerFee
    ) external payable returns (bytes32 transferId);

    /**
     * @notice Completes a cross-chain transfer on the destination chain
     * @param originDomain The origin nomad domain
     * @param nonce The nonce of the transfer
     * @param originSender The sender address on the origin chain
     * @param bridgeData The bridge data
     */
    function completeTransfer(
        uint32 originDomain,
        uint32 nonce,
        bytes32 originSender,
        bytes calldata bridgeData
    ) external;
}

/**
 * @title ConnextAdapter
 * @notice Adapter for Connext bridge protocol
 */
contract ConnextAdapter is IBridgeAdapter, Ownable {
    // --- Constants ---
    
    uint256 private constant MAX_SLIPPAGE = 300; // 3% as basis points

    // --- State Variables ---
    
    IConnext public connext;
    mapping(uint256 => uint32) public chainToDomain; // Ethereum chain ID to Connext domain mapping
    mapping(bytes32 => bytes32) public requestToTransferId; // BridgeRouter request ID to Connext transfer ID

    // --- Events ---
    
    event ConnextTransferInitiated(bytes32 requestId, bytes32 transferId);
    event ConnextTransferCompleted(bytes32 requestId, bytes32 transferId);

    // --- Constructor ---
    
    constructor(address _connext) Ownable(msg.sender) {
        connext = IConnext(_connext);
    }

    // --- External Functions ---

    /**
     * @notice Sets the domain mapping for a chain
     * @param _chainId The Ethereum chain ID
     * @param _domain The Connext domain ID
     */
    function setDomainMapping(uint256 _chainId, uint32 _domain) external onlyOwner {
        chainToDomain[_chainId] = _domain;
    }
    
    /**
     * @notice Sets the transferId for a request (for testing purposes)
     * @param _requestId The request ID
     * @param _transferId The transfer ID
     */
    function setRequestTransferId(bytes32 _requestId, bytes32 _transferId) external onlyOwner {
        requestToTransferId[_requestId] = _transferId;
    }

    /**
     * @notice Quotes the fee required for a bridge operation.
     * @param _request The bridge request details.
     * @return fee The estimated fee in the native currency.
     */
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256 fee) {
        uint32 destinationDomain = chainToDomain[_request.dstChainId];
        require(destinationDomain != 0, "ConnextAdapter: Invalid destination domain");

        // Return the relayer fee estimate from Connext
        return connext.calculateRelayerFee(
            destinationDomain,
            _request.token,
            _request.amount
        );
    }

    /**
     * @notice Initiates the outbound bridge transfer via Connext.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @return messageId The Connext transfer ID.
     */
    function bridgeOut(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external payable returns (bytes memory messageId) {
        // Get the destination domain
        uint32 destinationDomain = chainToDomain[_request.dstChainId];
        require(destinationDomain != 0, "ConnextAdapter: Invalid destination domain");

        // Ensure BridgeRouter contract has approved this adapter to spend tokens
        require(
            IERC20(_request.token).transferFrom(msg.sender, address(this), _request.amount),
            "ConnextAdapter: Transfer failed"
        );

        // Approve Connext to spend tokens
        IERC20(_request.token).approve(address(connext), _request.amount);

        // Initiate cross-chain transfer
        bytes32 transferId = connext.xcTransfer{value: msg.value}(
            destinationDomain,
            _request.user, // recipient is the user
            _request.token,
            _request.amount,
            MAX_SLIPPAGE, // 3% max slippage
            msg.value // relayer fee
        );

        // Store the mapping between request ID and transfer ID
        requestToTransferId[_requestId] = transferId;

        // Emit event
        emit ConnextTransferInitiated(_requestId, transferId);

        // Return transfer ID as bytes
        return abi.encode(transferId);
    }

    /**
     * @notice Completes the inbound bridge transfer on the destination chain.
     * @param _request The bridge request details.
     * @param _requestId The unique ID of the bridge request.
     * @param _proof Protocol-specific proof required for verification.
     */
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata _proof
    ) external {
        // Decode the proof data
        (uint32 originDomain, uint32 nonce, bytes32 originSender, bytes memory bridgeData) = 
            abi.decode(_proof, (uint32, uint32, bytes32, bytes));

        // Call Connext to complete the transfer
        connext.completeTransfer(
            originDomain,
            nonce,
            originSender,
            bridgeData
        );

        // Emit event
        emit ConnextTransferCompleted(_requestId, requestToTransferId[_requestId]);
    }

    /**
     * @notice Allows the owner to withdraw any tokens or ETH from the adapter.
     * @param _token The token address (address(0) for ETH).
     * @param _amount The amount to withdraw.
     */
    function withdraw(address _token, uint256 _amount) external onlyOwner {
        if (_token == address(0)) {
            payable(owner()).transfer(_amount);
        } else {
            IERC20(_token).transfer(owner(), _amount);
        }
    }

    // Allow adapter to receive ETH
    receive() external payable {}
} 