// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./IBridgeAdapter.sol";
import "../fee/FeeController.sol";

/// @title Bridge Router
/// @notice Routes cross-chain bridge requests through modular adapters
contract BridgeRouter is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Pending, Bridged, Completed, Refunded }

    /// @notice Mapping of adapter keys to adapter addresses
    mapping(bytes32 => address) public adapters;

    /// @notice External relayers authorized to call router functions
    mapping(address => bool) public authorizedRelayers;

    /// @notice Tracks status of each bridge request by ID
    mapping(bytes32 => Status) public requestStatus;

    /// @notice Timestamp when request was initiated
    mapping(bytes32 => uint256) public initiatedAt;

    /// @notice Collected native fees (in wei) awaiting withdrawal
    uint256 public collectedNativeFees;

    /// @notice Dynamic fee controller
    FeeController public feeController;

    /// @notice Configurable timeout for refunds (seconds)
    uint256 public refundTimeout;

    /// @notice Stored requests for completion or refund
    mapping(bytes32 => BridgeRequest) public requests;

    event BridgeInitiated(
        bytes32 indexed id,
        bytes32 indexed adapterKey,
        address indexed user,
        uint256 amount,
        uint256 fee
    );
    event BridgeOutbound(bytes32 indexed id);
    event BridgeCompleted(bytes32 indexed id);
    event BridgeRefunded(bytes32 indexed id);

    error InvalidAdapter(bytes32 adapterKey);
    error UnauthorizedRelayer(address sender);
    error InvalidStatus(Status expected, Status actual);
    error InsufficientFee(uint256 sent, uint256 required);

    /// @param _feeController Address of the FeeController
    /// @param _refundTimeout Time in seconds after which pending requests can be refunded
    constructor(address _feeController, uint256 _refundTimeout) {
        require(_feeController != address(0), "Zero address: feeController");
        require(_refundTimeout > 0, "BridgeRouter: zero timeout");
        feeController = FeeController(_feeController);
        refundTimeout = _refundTimeout;
    }

    /// @notice Register or update a bridge adapter
    function setAdapter(bytes32 key, address adapter) external onlyOwner {
        require(adapter != address(0), "Zero address");
        adapters[key] = adapter;
    }

    /// @notice Authorize or revoke a relayer
    function setRelayer(address relayer, bool ok) external onlyOwner {
        authorizedRelayers[relayer] = ok;
    }

    modifier onlyRelayer() {
        if (!authorizedRelayers[msg.sender]) revert UnauthorizedRelayer(msg.sender);
        _;
    }

    /// @notice Initiate a cross-chain bridge request
    /// @param req BridgeRequest struct with request details
    /// @param adapterKey Key of the adapter to use
    function initiateBridge(
        BridgeRequest calldata req,
        bytes32 adapterKey
    ) external payable whenNotPaused nonReentrant onlyRelayer {
        address adapter = adapters[adapterKey];
        if (adapter == address(0)) revert InvalidAdapter(adapterKey);

        if (requestStatus[req.id] != Status.None) {
            revert InvalidStatus(Status.None, requestStatus[req.id]);
        }

        // ensure request not expired
        require(req.deadline >= block.timestamp, "BridgeRouter: deadline expired");

        // Compute dynamic fee in wei
        uint256 feeBP = feeController.getCurrentFee();
        uint256 fee = (req.amount * feeBP) / 10_000;
        if (msg.value < fee) {
            revert InsufficientFee(msg.value, fee);
        }
        collectedNativeFees += fee;

        // Refund any excess
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool sent, ) = payable(msg.sender).call{value: refund}(
                ""
            );
            require(sent, "Refund failed");
        }

        // Pull tokens from user and escrow
        IERC20(req.token).safeTransferFrom(req.user, address(this), req.amount);
        // Approve adapter to pull escrowed tokens
        IERC20(req.token).safeApprove(adapter, req.amount);

        requestStatus[req.id] = Status.Pending;
        initiatedAt[req.id] = block.timestamp;

        // store request for later completion or refund
        requests[req.id] = req;

        emit BridgeInitiated(req.id, adapterKey, req.user, req.amount, fee);

        // Outbound bridge via adapter
        IBridgeAdapter(adapter).bridgeOut(req);
        requestStatus[req.id] = Status.Bridged;
        emit BridgeOutbound(req.id);
    }

    /// @notice Complete inbound bridge on destination chain
    /// @param req BridgeRequest struct
    /// @param proof Proof data from source chain
    /// @param adapterKey Key of the adapter to use
    function completeBridge(
        BridgeRequest calldata req,
        bytes calldata proof,
        bytes32 adapterKey
    ) external whenNotPaused nonReentrant onlyRelayer {
        if (requestStatus[req.id] != Status.Bridged) {
            revert InvalidStatus(Status.Bridged, requestStatus[req.id]);
        }
        address adapter = adapters[adapterKey];
        if (adapter == address(0)) revert InvalidAdapter(adapterKey);

        IBridgeAdapter(adapter).bridgeIn(req, proof);
        requestStatus[req.id] = Status.Completed;
        emit BridgeCompleted(req.id);
    }

    /// @notice Refund a timed-out bridge request
    /// @param id Bridge request identifier
    function refundBridge(bytes32 id) external whenNotPaused nonReentrant onlyRelayer {
        Status s = requestStatus[id];
        if (s != Status.Pending && s != Status.Bridged) {
            revert InvalidStatus(Status.Pending, s);
        }
        require(block.timestamp >= initiatedAt[id] + refundTimeout, "BridgeRouter: not timed out");
        BridgeRequest memory req = requests[id];
        requestStatus[id] = Status.Refunded;
        IERC20(req.token).safeTransfer(req.user, req.amount);
        emit BridgeRefunded(id);
    }

    /// @notice Update refund timeout
    function setRefundTimeout(uint256 _refundTimeout) external onlyOwner {
        require(_refundTimeout > 0, "BridgeRouter: zero timeout");
        refundTimeout = _refundTimeout;
    }

    /// @notice Withdraw accumulated native fees
    function withdrawFees(address to, uint256 amount) external onlyOwner {
        require(amount <= collectedNativeFees, "Amount too high");
        collectedNativeFees -= amount;
        (bool sent, ) = payable(to).call{value: amount}("");
        require(sent, "Withdraw failed");
    }

    /// @notice Pause all bridge operations
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause bridge operations
    function unpause() external onlyOwner {
        _unpause();
    }
}
