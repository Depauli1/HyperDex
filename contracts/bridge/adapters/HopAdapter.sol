// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../IBridgeAdapter.sol";

/// @notice Minimal interface for Hop bridge contract
interface IHopBridge {
    function send(
        uint256 _dstChainId,
        address _recipient,
        address _token,
        uint256 _amount,
        uint256 _bonderFee,
        uint256 _amountOutMin,
        bytes calldata _data
    ) external payable returns (bytes32);

    function getFee(
        uint256 _dstChainId,
        address _token,
        uint256 _amount
    ) external view returns (
        uint256 nativeFee,
        uint256 bonderFee,
        uint256 amountOutMin
    );
}

/**
 * @title HopAdapter
 * @notice Adapter for Hop cross-chain protocol
 */
contract HopAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    IHopBridge public immutable hop;
    mapping(bytes32 => bool) public processed;

    event HopBridgeRequested(bytes32 indexed id, uint256 dstChainId, address token, uint256 amount, address user);
    event HopBridgeCompleted(bytes32 indexed id, address user, address token, uint256 amount);

    constructor(address _hop) {
        require(_hop != address(0), "HopAdapter: zero address");
        hop = IHopBridge(_hop);
    }

    function getName() external pure override returns (string memory) {
        return "Hop";
    }

    function getVersion() external pure override returns (string memory) {
        return "1.0.0";
    }

    function quoteFees(BridgeRequest calldata req) external view override returns (uint256) {
        (uint256 nativeFee,,) = hop.getFee(req.dstChainId, req.token, req.amount);
        return nativeFee;
    }

    function bridgeOut(BridgeRequest calldata req) external payable override {
        require(req.deadline >= block.timestamp, "HopAdapter: deadline expired");
        require(req.amount > 0, "HopAdapter: amount=0");

        IERC20(req.token).safeTransferFrom(msg.sender, address(this), req.amount);
        IERC20(req.token).safeApprove(address(hop), req.amount);

        (uint256 nativeFee, uint256 bonderFee, uint256 amountOutMin) = hop.getFee(req.dstChainId, req.token, req.amount);

        hop.send{value: msg.value}(
            req.dstChainId,
            msg.sender,
            req.token,
            req.amount,
            bonderFee,
            amountOutMin,
            abi.encode(req.id)
        );

        emit HopBridgeRequested(req.id, req.dstChainId, req.token, req.amount, msg.sender);
    }

    function bridgeIn(BridgeRequest calldata req, bytes calldata /* proof */) external override {
        require(msg.sender == owner(), "HopAdapter: caller not owner");
        require(!processed[req.id], "HopAdapter: already processed");
        processed[req.id] = true;

        IERC20(req.token).safeTransfer(req.user, req.amount);
        emit HopBridgeCompleted(req.id, req.user, req.token, req.amount);
    }
}
