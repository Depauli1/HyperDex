// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { IBridgeAdapter } from "./interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "./interfaces/IBridgeTypes.sol";

/**
 * @title BridgeRouter
 * @notice Central contract for managing cross-chain bridge requests.
 */
contract BridgeRouter is EIP712, Ownable, Pausable {
    using SafeERC20 for IERC20;

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
    mapping(address => bool) public authorizedRelayers; // relayer => allowed to finalise inbound requests

    uint256 public nextRequestId; // Simple counter for request IDs
    uint256 public bridgeTimeout; // Timeout for bridge requests in seconds (default 1 hour)

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

    event BridgeInboundRecorded(
        bytes32 indexed requestId,
        address indexed user,
        uint256 srcChainId,
        uint256 dstChainId,
        address token,
        uint256 amount
    );

    event BridgeFailed(bytes32 indexed requestId, string reason);
    event BridgeRefunded(bytes32 indexed requestId, address indexed user, uint256 amount);
    event AdapterRegistered(uint256 indexed chainId, address adapter);
    event BridgeTimeoutUpdated(uint256 newTimeout);
    event RelayerUpdated(address indexed relayer, bool allowed);

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
    error AlreadyRecorded();
    error WrongDestination();

    // --- Constructor ---

    constructor() EIP712("HyperDex Bridge", "1") Ownable() {
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
        // 1. Validate the cheap, caller-independent invariants first. These are
        //    pure reads, so running them before ECDSA recovery saves gas on the
        //    reject path and surfaces a precise error instead of a signature one.
        if (block.timestamp > _request.deadline) revert DeadlineExceeded();

        // Adapters are keyed by the chain they know how to reach. Selecting on the
        // destination (rather than the source) is what makes several protocols
        // usable side by side -- Connext for one destination, LayerZero for
        // another -- and it matches `completeBridge`, which also resolves the
        // adapter for `_request.dstChainId` on the far side.
        IBridgeAdapter adapter = bridgeAdapters[_request.dstChainId];
        if (address(adapter) == address(0)) revert InvalidAdapter();

        // 2. Validate signature (EIP-712)
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

        // 3. Calculate unique request ID
        bytes32 requestId = keccak256(abi.encodePacked(nextRequestId++, _request.user, _request.srcChainId, _request.dstChainId, _request.token, _request.amount));

        // 4. Check provided fee
        uint256 requiredFee = adapter.quoteFees(_request);
        if (msg.value < requiredFee) revert InsufficientFee();
        // Any excess msg.value is refunded to the caller at the end.

        // 5. Escrow tokens from the user (who must have approved this router).
        IERC20(_request.token).safeTransferFrom(_request.user, address(this), _request.amount);

        // 6. Store request details and status
        bridgeRequests[requestId] = _request;
        requestStatus[requestId] = RequestStatus.Initiated;

        // 7. Let the adapter pull exactly what it needs to send, then forward the
        //    fee. Without this allowance the adapter's own `transferFrom` reverts.
        IERC20(_request.token).safeIncreaseAllowance(address(adapter), _request.amount);
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
     * @notice Records a request that was initiated on another chain, so it can
     *         be completed here.
     * @dev This is the missing half of the inbound leg. `initiateBridge` runs on
     *      the source chain and its effects (the `bridgeRequests` entry and the
     *      `Initiated` status) only exist there; a destination-chain router has
     *      no way to learn about the request, so `completeBridge` used to revert
     *      with `InvalidStatus()` for every inbound transfer. The off-chain
     *      watcher calls this once the source-chain event is final, then calls
     *      `completeBridge`, which releases the funds through the adapter.
     *
     *      Guards: only an authorised relayer, only once per request id, only if
     *      the request names *this* chain as its destination, and only before
     *      the user's deadline — after that the source-chain refund path is the
     *      correct outcome and paying out here as well would double-spend.
     * @param _request The full request, as emitted by the source chain.
     * @param _requestId The id assigned by `initiateBridge` on the source chain.
     */
    function recordInbound(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external whenNotPaused {
        if (!authorizedRelayers[msg.sender]) revert Unauthorized();
        if (_request.dstChainId != block.chainid) revert WrongDestination();
        if (bridgeRequests[_requestId].user != address(0)) revert AlreadyRecorded();
        if (block.timestamp > _request.deadline) revert DeadlineExceeded();

        IBridgeAdapter adapter = bridgeAdapters[_request.dstChainId];
        if (address(adapter) == address(0)) revert InvalidAdapter();

        bridgeRequests[_requestId] = _request;
        requestStatus[_requestId] = RequestStatus.Initiated;

        emit BridgeInboundRecorded(
            _requestId,
            _request.user,
            _request.srcChainId,
            _request.dstChainId,
            _request.token,
            _request.amount
        );
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
        // 0. Only the relayer/watcher may finalise an inbound request.
        if (!authorizedRelayers[msg.sender]) revert Unauthorized();

        // 1. Validate request status
        if (requestStatus[_requestId] != RequestStatus.Initiated) revert InvalidStatus();

        // 2. Validate request exists
        if (bridgeRequests[_requestId].user == address(0)) revert RequestNotFound();

        // 3. Get the adapter for the destination chain
        IBridgeAdapter adapter = bridgeAdapters[_request.dstChainId];
        if (address(adapter) == address(0)) revert InvalidAdapter();

        // 4. Mark complete *before* the external call (checks-effects-interactions),
        //    so a re-entrant or repeated call cannot pay out twice.
        requestStatus[_requestId] = RequestStatus.Completed;

        // 5. Release the funds to the user. The adapter owns the payout: on the
        //    destination chain this router instance never escrowed anything, the
        //    tokens arrive from the bridge protocol into the adapter. Doing the
        //    transfer here as well would pay the user twice.
        adapter.bridgeIn(_request, _requestId, _proof);

        // 6. Emit event
        emit BridgeCompleted(
            _requestId,
            _request.user,
            _request.token,
            _request.amount
        );
    }

    /**
     * @notice Registers a bridge adapter for a specific chain.
     * @dev `_chainId` is the chain the adapter knows how to reach: `initiateBridge`
     *      resolves `bridgeAdapters[dstChainId]` on the source chain, and
     *      `completeBridge` resolves the same key on the destination chain.
     * @param _chainId The chain ID.
     * @param _adapter The adapter contract address.
     */
    function registerAdapter(uint256 _chainId, address _adapter) external onlyOwner {
        if (_adapter == address(0)) revert InvalidAdapter();
        bridgeAdapters[_chainId] = IBridgeAdapter(_adapter);
        emit AdapterRegistered(_chainId, _adapter);
    }

    /**
     * @notice Grants or revokes an off-chain relayer's right to call `completeBridge`.
     * @param _relayer The relayer address.
     * @param _allowed Whether the relayer is authorised.
     */
    function setRelayer(address _relayer, bool _allowed) external onlyOwner {
        if (_relayer == address(0)) revert Unauthorized();
        authorizedRelayers[_relayer] = _allowed;
        emit RelayerUpdated(_relayer, _allowed);
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
        IERC20(request.token).safeTransfer(request.user, request.amount);
        
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
} 