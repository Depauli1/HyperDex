// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import { IBridgeAdapter } from "../interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "../interfaces/IBridgeTypes.sol";

/// @notice Minimal interface for the Hop L1 bridge / L2 messenger being adapted.
interface IHopBridge {
    function sendToL2(
        uint256 _chainId,
        address _recipient,
        uint256 _amount,
        uint256 _amountOutMin,
        address _relayer,
        uint256 _relayerFee
    ) external payable;

    function send(
        uint256 _chainId,
        address _recipient,
        uint256 _amount,
        uint256 _amountOutMin,
        uint256 _deadline
    ) external payable;

    function estimateSendFee(
        uint256 _chainId,
        address _token,
        uint256 _amount,
        uint256 _relayerFee
    ) external view returns (uint256 bonderFee, uint256 amountOutMin);
}

/**
 * @title HopAdapter
 * @notice IBridgeAdapter implementation for the Hop protocol.
 * @dev Follows the same contract as ConnextAdapter/LayerZeroAdapter:
 *      `bridgeOut` is called by the BridgeRouter (which escrows the tokens and
 *      approves this adapter), `bridgeIn` is called by the off-chain watcher on
 *      the destination chain and is idempotent per request id.
 */
contract HopAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    IHopBridge public immutable hop;

    /// @notice request id => true once `bridgeIn` has released the funds.
    mapping(bytes32 => bool) public processed;

    event HopBridgeInitiated(bytes32 indexed requestId, uint256 dstChainId, address token, uint256 amount, address user);
    event HopBridgeCompleted(bytes32 indexed requestId, address user, address token, uint256 amount);

    error ZeroAddress();
    error Expired();
    error ZeroAmount();
    error AlreadyProcessed();
    error NotRelayer();

    /// @dev Addresses allowed to call `bridgeIn` on the destination chain.
    mapping(address => bool) public authorizedRelayers;

    constructor(address _hop, address _relayer) {
        if (_hop == address(0)) revert ZeroAddress();
        hop = IHopBridge(_hop);
        if (_relayer != address(0)) authorizedRelayers[_relayer] = true;
    }

    function setRelayer(address _relayer, bool _allowed) external onlyOwner {
        if (_relayer == address(0)) revert ZeroAddress();
        authorizedRelayers[_relayer] = _allowed;
    }

    /// @inheritdoc IBridgeAdapter
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256 fee) {
        (uint256 bonderFee, ) = hop.estimateSendFee(
            _request.dstChainId,
            _request.token,
            _request.amount,
            _request.fee
        );
        return bonderFee;
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeOut(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external payable returns (bytes memory messageId) {
        if (_request.deadline < block.timestamp) revert Expired();
        if (_request.amount == 0) revert ZeroAmount();

        // The BridgeRouter escrows the tokens and approves this adapter.
        IERC20(_request.token).safeTransferFrom(msg.sender, address(this), _request.amount);
        IERC20(_request.token).safeIncreaseAllowance(address(hop), _request.amount);

        (uint256 bonderFee, uint256 amountOutMin) = hop.estimateSendFee(
            _request.dstChainId,
            _request.token,
            _request.amount,
            _request.fee
        );

        // msg.value already carries the relayer payment; Hop takes bonderFee from it.
        hop.sendToL2{value: msg.value}(
            _request.dstChainId,
            _request.user,
            _request.amount,
            amountOutMin,
            address(0), // no Hop relayer on top of the HyperDex relayer
            bonderFee
        );

        emit HopBridgeInitiated(
            _requestId,
            _request.dstChainId,
            _request.token,
            _request.amount,
            _request.user
        );

        return abi.encode(_requestId);
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata /* _proof */
    ) external {
        if (!authorizedRelayers[msg.sender]) revert NotRelayer();
        if (processed[_requestId]) revert AlreadyProcessed();
        processed[_requestId] = true;

        IERC20(_request.token).safeTransfer(_request.user, _request.amount);

        emit HopBridgeCompleted(_requestId, _request.user, _request.token, _request.amount);
    }

    /// @notice Rescue tokens/ETH stranded in this adapter.
    function withdraw(address _token, uint256 _amount) external onlyOwner {
        if (_token == address(0)) {
            payable(owner()).transfer(_amount);
        } else {
            IERC20(_token).safeTransfer(owner(), _amount);
        }
    }

    receive() external payable {}
}
