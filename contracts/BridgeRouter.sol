// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { IBridgeAdapter } from "./interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "./interfaces/IBridgeTypes.sol";
// TODO: Import EIP-712 related contracts if needed
// TODO: Import Pausable, Ownable, etc. if needed

/**
 * @title BridgeRouter
 * @notice Central contract for managing cross-chain bridge requests.
 */
contract BridgeRouter is EIP712, Ownable, Pausable {
    // --- Structs ---

    // Using IBridgeTypes.BridgeRequest instead of defining it here

    enum RequestStatus {
        None,
        Initiated, // BridgeOut called
        Completed, // BridgeIn called successfully
        Failed,    // e.g., Timed out, Refunded
        Refunding  // Refund process started
    }

    // --- Constants ---
    
    // EIP-712 type hashes
    bytes32 private constant BRIDGE_REQUEST_TYPEHASH = keccak256(
        "BridgeRequest(uint256 id,uint256 srcChainId,uint256 dstChainId,address token,uint256 amount,address user,uint256 deadline,uint256 fee)"
    );

    // --- State Variables ---

    mapping(bytes32 => IBridgeTypes.BridgeRequest) public bridgeRequests; // request ID => request details
    mapping(bytes32 => RequestStatus) public requestStatus;  // request ID => status
    mapping(uint256 => IBridgeAdapter) public bridgeAdapters; // chain ID => adapter contract
    mapping(bytes32 => bool) public usedSignatures; // Prevent signature reuse

    uint256 public nextRequestId; // Simple counter for request IDs
    uint256 public bridgeTimeout; // Timeout for bridge requests in seconds (default 1 hour)

    // TODO: Add variables for EIP-712 domain separator
    // TODO: Add variables for owner, pauser, fee controller
    // TODO: Add variables for tracking escrowed funds

    // --- Events ---

    event BridgeInitiated(
        bytes32 indexed requestId,
        address indexed user,
        uint256 srcChainId,
        uint256 dstChainId,
        address token,
        uint256 amount,
        uint256 fee
    );

    event BridgeCompleted(
        bytes32 indexed requestId,
        address indexed user,
        address token,
        uint256 amount
    );

    event BridgeFailed(bytes32 indexed requestId, string reason);
    event BridgeRefunded(bytes32 indexed requestId, address indexed user, uint256 amount);
    event AdapterRegistered(uint256 indexed chainId, address adapter);
    event BridgeTimeoutUpdated(uint256 newTimeout);

    // --- Errors ---
    error InvalidAdapter();
    error RequestNotFound();
    error DeadlineExceeded();
    error InvalidStatus();
    error TransferFailed();
    error InsufficientFee();
    error InvalidSignature();
    error SignatureReused();
    error Unauthorized();
    // TODO: Add more specific errors

    // --- Constructor ---

    constructor() EIP712("HyperDex Bridge", "1") Ownable(msg.sender) {
        bridgeTimeout = 1 hours;
    }

    // --- Functions ---

    /**
     * @notice Initiates a bridge request based on a signed EIP-712 message.
     * @dev Requires the caller (relayer) to provide the fee.
     * @param _request The bridge request details.
     * @param _signature The EIP-712 signature from the user.
     */
    function initiateBridge(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes calldata _signature
    ) external payable whenNotPaused {
        // 1. Validate signature (EIP-712)
        bytes32 structHash = keccak256(
            abi.encode(
                BRIDGE_REQUEST_TYPEHASH,
                _request.id,
                _request.srcChainId,
                _request.dstChainId,
                _request.token,
                _request.amount,
                _request.user,
                _request.deadline,
                _request.fee
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        
        // Verify signature
        address signer = ECDSA.recover(hash, _signature);
        if (signer != _request.user) revert InvalidSignature();
        
        // Prevent signature reuse
        if (usedSignatures[hash]) revert SignatureReused();
        usedSignatures[hash] = true;

        // 2. Validate request parameters (deadline, chain IDs, etc.)
        if (block.timestamp > _request.deadline) revert DeadlineExceeded();
        IBridgeAdapter adapter = bridgeAdapters[_request.srcChainId];
        if (address(adapter) == address(0)) revert InvalidAdapter();

        // 3. Calculate unique request ID
        bytes32 requestId = keccak256(abi.encodePacked(nextRequestId++, _request.user, _request.srcChainId, _request.dstChainId, _request.token, _request.amount));

        // 4. Check provided fee
        uint256 requiredFee = adapter.quoteFees(_request);
        if (msg.value < requiredFee) revert InsufficientFee();
        // TODO: Handle excess fee (refund or keep?)

        // 5. Escrow tokens from user
        // Requires user to have approved BridgeRouter beforehand
        // Use safeTransferFrom
        if (!IERC20(_request.token).transferFrom(_request.user, address(this), _request.amount)) {
            revert TransferFailed();
        }

        // 6. Store request details and status
        bridgeRequests[requestId] = _request;
        requestStatus[requestId] = RequestStatus.Initiated;

        // 7. Call the adapter's bridgeOut function, forwarding the fee
        // Adapter needs to handle the msg.value correctly
        adapter.bridgeOut{value: requiredFee}(_request, requestId);

        // 8. Emit event
        emit BridgeInitiated(
            requestId,
            _request.user,
            _request.srcChainId,
            _request.dstChainId,
            _request.token,
            _request.amount,
            requiredFee // Emitting the fee actually used
        );

        // Optional: Refund excess msg.value if applicable
        if (msg.value > requiredFee) {
            payable(msg.sender).transfer(msg.value - requiredFee);
        }
    }

    /**
     * @notice Completes a bridge request on the destination chain.
     * @dev Called by the relayer after receiving confirmation from the source chain.
     * @param _request The original bridge request.
     * @param _requestId The ID of the bridge request.
     * @param _proof Protocol-specific proof data.
     */
    function completeBridge(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata _proof
    ) external whenNotPaused {
        // 1. Validate request status
        if (requestStatus[_requestId] != RequestStatus.Initiated) revert InvalidStatus();
        
        // 2. Validate request exists
        if (bridgeRequests[_requestId].user == address(0)) revert RequestNotFound();
        
        // 3. Get the adapter for the destination chain
        IBridgeAdapter adapter = bridgeAdapters[_request.dstChainId];
        if (address(adapter) == address(0)) revert InvalidAdapter();
        
        // 4. Call the adapter's bridgeIn function to complete the bridge
        adapter.bridgeIn(_request, _requestId, _proof);
        
        // 5. Update request status
        requestStatus[_requestId] = RequestStatus.Completed;
        
        // 6. Transfer tokens to the user (adapter might handle this instead)
        if (!IERC20(_request.token).transfer(_request.user, _request.amount)) {
            revert TransferFailed();
        }
        
        // 7. Emit event
        emit BridgeCompleted(
            _requestId,
            _request.user,
            _request.token,
            _request.amount
        );
    }

    /**
     * @notice Registers a bridge adapter for a specific chain.
     * @dev Only callable by owner.
     * @param _chainId The chain ID.
     * @param _adapter The adapter contract address.
     */
    function registerAdapter(uint256 _chainId, address _adapter) external onlyOwner {
        bridgeAdapters[_chainId] = IBridgeAdapter(_adapter);
        emit AdapterRegistered(_chainId, _adapter);
    }

    /**
     * @notice Updates the timeout period for bridge requests.
     * @param _newTimeout The new timeout in seconds.
     */
    function setBridgeTimeout(uint256 _newTimeout) external onlyOwner {
        bridgeTimeout = _newTimeout;
        emit BridgeTimeoutUpdated(_newTimeout);
    }

    /**
     * @notice Pauses all bridge operations.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses all bridge operations.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Initiates a refund for a timed out bridge request.
     * @param _requestId The ID of the bridge request to refund.
     */
    function initiateRefund(bytes32 _requestId) external {
        // 1. Validate request status
        if (requestStatus[_requestId] != RequestStatus.Initiated) revert InvalidStatus();
        
        // 2. Validate request exists and check timeout
        IBridgeTypes.BridgeRequest memory request = bridgeRequests[_requestId];
        if (request.user == address(0)) revert RequestNotFound();
        
        // Check if the request has timed out
        if (block.timestamp < request.deadline + bridgeTimeout) revert InvalidStatus();
        
        // 3. Update request status
        requestStatus[_requestId] = RequestStatus.Refunding;
        
        // 4. Transfer tokens back to the user
        if (!IERC20(request.token).transfer(request.user, request.amount)) {
            revert TransferFailed();
        }
        
        // 5. Update status to completed and emit event
        requestStatus[_requestId] = RequestStatus.Failed;
        
        emit BridgeRefunded(_requestId, request.user, request.amount);
    }

    // --- Helper Functions ---

    /**
     * @notice Gets the details of a bridge request.
     * @param _requestId The ID of the bridge request.
     * @return request The bridge request details.
     * @return status The status of the bridge request.
     */
    function getBridgeRequest(bytes32 _requestId) external view returns (IBridgeTypes.BridgeRequest memory request, RequestStatus status) {
        return (bridgeRequests[_requestId], requestStatus[_requestId]);
    }

    // TODO: Implement receive function for bridgeIn callback from adapter/relayer
    // TODO: Implement functions for pausing/unpausing
    // TODO: Implement functions for fee management
    // TODO: Implement functions for handling timeouts and refunds
    // TODO: Implement EIP-712 domain separator logic
} 