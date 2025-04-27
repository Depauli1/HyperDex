// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../IBridgeAdapter.sol";

/// @notice Minimal interface for Connext contract
interface IConnext {
    function xcall(
        uint32 _destination,
        address _to,
        address _asset,
        address _delegate,
        uint256 _amount,
        uint256 _slippage,
        bytes calldata _callData
    ) external payable returns (bytes32);
    function estimateReceiverFee(uint32 _destination, bytes calldata _callData)
        external
        view
        returns (uint256 _nativeFee, uint256 _destinationGas);
}

/**
 * @title ConnextAdapter
 * @notice Adapter for Connext bridge protocol
 * @dev Implements IBridgeAdapter; handles token escrow and xcall
 */
contract ConnextAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Connext contract address
    IConnext public immutable connext;
    /// @notice Connext destination domain (e.g. Arbitrum = 0x66EEB)
    uint32 public immutable domain;

    /// @notice Tracks processed inbound requests (prevent replay)
    mapping(bytes32 => bool) public processed;

    event BridgeRequested(
        bytes32 indexed id,
        uint32 indexed dstDomain,
        address indexed token,
        uint256 amount,
        address user
    );
    event BridgeSucceeded(bytes32 indexed id, address user, address token, uint256 amount);

    constructor(address _connext, uint32 _domain) {
        require(_connext != address(0), "Connext: zero address");
        connext = IConnext(_connext);
        domain = _domain;
    }

    function getName() external pure override returns (string memory) {
        return "Connext";
    }
    function getVersion() external pure override returns (string memory) {
        return "1.0.0";
    }

    /// @inheritdoc IBridgeAdapter
    function quoteFees(BridgeRequest calldata req) external view override returns (uint256) {
        // Use Connext to estimate native fee for callData = abi.encode(req.id)
        (uint256 nativeFee,) = connext.estimateReceiverFee(domain, abi.encode(req.id));
        return nativeFee;
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeOut(BridgeRequest calldata req) external payable override {
        require(req.deadline >= block.timestamp, "ConnextAdapter: deadline expired");
        require(req.amount > 0, "ConnextAdapter: amount=0");

        // Pull tokens from Router
        IERC20(req.token).safeTransferFrom(msg.sender, address(this), req.amount);
        // Approve Connext to take tokens
        IERC20(req.token).safeApprove(address(connext), req.amount);

        // Initiate cross-chain transfer via Connext
        connext.xcall{value: msg.value}(
            uint32(req.dstChainId),    // destination domain
            msg.sender,        // _to (BridgeRouter executes inbound logic)
            req.token,         // asset
            msg.sender,        // delegate (BridgeRouter)
            req.amount,        // amount
            0,                 // slippage (in BPS)
            abi.encode(req.id) // callData to identify request
        );

        emit BridgeRequested(req.id, uint32(req.dstChainId), req.token, req.amount, msg.sender);
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeIn(BridgeRequest calldata req, bytes calldata /* proof */) external override {
        // Only BridgeRouter can call
        require(msg.sender == owner(), "ConnextAdapter: caller not owner");
        require(!processed[req.id], "ConnextAdapter: already processed");

        processed[req.id] = true;
        // Transfer bridged tokens to user
        IERC20(req.token).safeTransfer(req.user, req.amount);

        emit BridgeSucceeded(req.id, req.user, req.token, req.amount);
    }
}
