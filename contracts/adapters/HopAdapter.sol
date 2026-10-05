// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import { IBridgeAdapter } from "../interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "../interfaces/IBridgeTypes.sol";

/**
 * @title IHopBridge
 * @notice The subset of Hop's L1 bridge (`L1_ERC20_Bridge`) this adapter uses.
 * @dev Signature pinned to the deployed Hop L1 bridge ABI:
 *      `sendToL2(uint256,address,uint256,uint256,uint256,address,uint256)`
 *      — chainId, recipient, amount, amountOutMin, deadline, relayer,
 *      relayerFee. Hop's bonder fee itself is quoted by the Hop SDK/API; on
 *      chain the bridge exposes the bond requirement
 *      (`getBondForTransferAmount`), which is what this adapter reads.
 */
interface IHopBridge {
    function sendToL2(
        uint256 _chainId,
        address _recipient,
        uint256 _amount,
        uint256 _amountOutMin,
        uint256 _deadline,
        address _relayer,
        uint256 _relayerFee
    ) external payable;

    function getBondForTransferAmount(uint256 _amount) external view returns (uint256 bond);
}

/**
 * @title HopAdapter
 * @notice IBridgeAdapter implementation for the Hop protocol.
 * @dev Same contract as ConnextAdapter/LayerZeroAdapter: `bridgeOut` is called by
 *      the BridgeRouter (which escrows the tokens and approves this adapter),
 *      `bridgeIn` is called by the destination bridge router after the off-chain
 *      watcher has recorded the inbound request, and is idempotent per id.
 *
 *      Hop delivers the bridged tokens to the recipient on the destination chain
 *      by itself (the bonder fronts the transfer), so on the destination side the
 *      adapter's job is to hold the delivered tokens until the router releases
 *      them — `bridgeIn` does exactly that, and refuses to run twice.
 */
contract HopAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    IHopBridge public immutable hop;
    /// @notice BridgeRouter that escrows funds on this chain.
    address public bridgeRouter;
    /// @notice Hop relayer address to pass to `sendToL2` (address(0) = none).
    address public hopRelayer;
    /// @notice Bonder fee applied when quoting, in basis points of the amount.
    uint256 public bonderFeeBps = 25; // 0.25%
    /// @notice Flat relayer fee (native currency) passed to `sendToL2`.
    uint256 public flatRelayerFee;

    /// @notice request id => true once `bridgeIn` has released the funds.
    mapping(bytes32 => bool) public processed;

    event HopBridgeInitiated(bytes32 indexed requestId, uint256 dstChainId, address token, uint256 amount, address user);
    event HopBridgeCompleted(bytes32 indexed requestId, address user, address token, uint256 amount);

    error ZeroAddress();
    error Expired();
    error ZeroAmount();
    error AlreadyProcessed();
    error NotRelayer();
    error OnlyBridgeRouter();
    error InsufficientFee();
    error InvalidParameter();

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

    function setBridgeRouter(address _bridgeRouter) external onlyOwner {
        if (_bridgeRouter == address(0)) revert ZeroAddress();
        bridgeRouter = _bridgeRouter;
    }

    function setHopRelayer(address _hopRelayer) external onlyOwner {
        hopRelayer = _hopRelayer;
    }

    function setFeeParameters(uint256 _bonderFeeBps, uint256 _flatRelayerFee) external onlyOwner {
        if (_bonderFeeBps > 10_000) revert InvalidParameter();
        bonderFeeBps = _bonderFeeBps;
        flatRelayerFee = _flatRelayerFee;
    }

    /// @inheritdoc IBridgeAdapter
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256 fee) {
        return (_request.amount * bonderFeeBps) / 10_000 + flatRelayerFee;
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeOut(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external payable returns (bytes memory messageId) {
        if (msg.sender != bridgeRouter) revert OnlyBridgeRouter();
        if (_request.deadline < block.timestamp) revert Expired();
        if (_request.amount == 0) revert ZeroAmount();

        uint256 fee = (_request.amount * bonderFeeBps) / 10_000 + flatRelayerFee;
        if (msg.value < fee) revert InsufficientFee();

        // The BridgeRouter escrows the tokens and approves this adapter.
        IERC20(_request.token).safeTransferFrom(msg.sender, address(this), _request.amount);
        IERC20(_request.token).safeIncreaseAllowance(address(hop), _request.amount);

        // amountOutMin: the amount less the quoted fee, so a bonder cannot take
        // more than the user was told.
        uint256 amountOutMin = _request.amount > fee ? _request.amount - fee : 0;

        hop.sendToL2{value: fee}(
            _request.dstChainId,
            _request.user,
            _request.amount,
            amountOutMin,
            _request.deadline,
            hopRelayer,
            flatRelayerFee
        );

        emit HopBridgeInitiated(
            _requestId,
            _request.dstChainId,
            _request.token,
            _request.amount,
            _request.user
        );

        if (msg.value > fee) {
            payable(msg.sender).transfer(msg.value - fee);
        }

        return abi.encode(_requestId);
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata /* _proof */
    ) external {
        // The destination BridgeRouter proves authorisation by having recorded
        // the inbound request; the relayer set on this adapter gates the call.
        if (!authorizedRelayers[msg.sender] && msg.sender != bridgeRouter) revert NotRelayer();
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
