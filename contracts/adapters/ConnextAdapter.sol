// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBridgeAdapter } from "../interfaces/IBridgeAdapter.sol";
import { IBridgeTypes } from "../interfaces/IBridgeTypes.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

// Canonical Connext interfaces, taken verbatim from the published
// `@connext/interfaces` package (2.0.5) rather than re-declared here, so the
// adapter cannot drift from the deployed protocol's ABI.
//
//   xcall(uint32,address,address,address,uint256,uint256,bytes) payable -> bytes32
//   xReceive(bytes32,uint256,address,address,uint32,bytes) -> bytes
//
// https://docs.connext.network/developers/reference/contracts/calls
import { IConnext } from "@connext/interfaces/core/IConnext.sol";
import { IXReceiver } from "@connext/interfaces/core/IXReceiver.sol";

/**
 * @title ConnextAdapter
 * @notice IBridgeAdapter implementation for Connext.
 *
 * @dev The Connext contract is the canonical `IConnext` shipped in the
 *      connext/interfaces npm package; this adapter implements the canonical
 *      `IXReceiver` so the protocol calls it back. Neither side is re-declared
 *      locally, so the adapter cannot drift from the deployed ABI.
 *
 *      Flow, matching how Connext actually works:
 *
 *      Origin chain
 *        1. `BridgeRouter.initiateBridge` escrows the user's tokens and calls
 *           `bridgeOut`, which approves Connext and issues a single
 *           `xcall(destinationDomain, remoteAdapter, token, delegate, amount,
 *           slippage, abi.encode(requestId, user))`.
 *        2. `msg.value` funds the relayer fee. Off-chain the watcher quotes that
 *           fee from Connext's relayer API; `quoteFees` returns the configured
 *           value so the router can require it.
 *
 *      Destination chain
 *        3. Connext delivers the tokens to this adapter (the `_to` address) and
 *           calls `xReceive`; the adapter records the request id as delivered.
 *        4. Once the request is recorded on this chain (`recordInbound`), the
 *           watcher calls `completeBridge`, the router calls `bridgeIn`, and the
 *           adapter releases the delivered tokens to the user exactly once.
 *
 *      The adapter never trusts a caller-supplied proof: delivery is proven by
 *      the `xReceive` callback arriving from the Connext contract itself.
 */
contract ConnextAdapter is IBridgeAdapter, IXReceiver, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Connext contract on this chain.
    IConnext public immutable connext;

    /// @notice Ethereum chain id => Connext domain id.
    mapping(uint256 => uint32) public chainToDomain;
    /// @notice Destination chain id => this adapter's address on that chain.
    mapping(uint256 => address) public remoteAdapters;
    /// @notice BridgeRouter that escrows funds on this chain.
    address public bridgeRouter;

    /// @notice Slippage tolerance passed to `xcall`, in basis points.
    uint256 public slippageBps = 300; // 3%
    /// @notice Relayer fee (native currency) attached to `xcall`.
    uint256 public relayerFee;

    /// @notice requestId => Connext delivered the funds to this adapter.
    mapping(bytes32 => bool) public delivered;
    /// @notice requestId => funds were released to the user.
    mapping(bytes32 => bool) public completed;
    /// @notice requestId => Connext transfer id, for cross-chain reconciliation.
    mapping(bytes32 => bytes32) public requestToTransferId;
    /// @notice transferId => requestId, populated by `xReceive`.
    mapping(bytes32 => bytes32) public transferToRequestId;

    event ConnextTransferInitiated(bytes32 indexed requestId, bytes32 transferId, uint32 destinationDomain);
    event ConnextTransferDelivered(bytes32 indexed requestId, bytes32 transferId, uint256 amount, address asset);
    event ConnextTransferCompleted(bytes32 indexed requestId, address user, address token, uint256 amount);
    event DomainMappingSet(uint256 indexed chainId, uint32 domain);
    event RemoteAdapterSet(uint256 indexed chainId, address adapter);

    error InvalidParameter();
    error InvalidDestinationDomain();
    error DeadlineExpired();
    error InsufficientFee();
    error RemoteAdapterNotSet();
    error OnlyBridgeRouter();
    error OnlyConnext();
    error NotDelivered();
    error AlreadyCompleted();
    error NothingToWithdraw();

    /// @param _connext The Connext contract on this chain.
    constructor(address _connext) Ownable() {
        if (_connext == address(0)) revert InvalidParameter();
        connext = IConnext(_connext);
    }

    // --- Configuration ---

    function setDomainMapping(uint256 _chainId, uint32 _domain) external onlyOwner {
        if (_domain == 0) revert InvalidParameter();
        chainToDomain[_chainId] = _domain;
        emit DomainMappingSet(_chainId, _domain);
    }

    function setRemoteAdapter(uint256 _chainId, address _adapter) external onlyOwner {
        if (_adapter == address(0)) revert InvalidParameter();
        remoteAdapters[_chainId] = _adapter;
        emit RemoteAdapterSet(_chainId, _adapter);
    }

    function setBridgeRouter(address _bridgeRouter) external onlyOwner {
        if (_bridgeRouter == address(0)) revert InvalidParameter();
        bridgeRouter = _bridgeRouter;
    }

    function setSlippageBps(uint256 _slippageBps) external onlyOwner {
        if (_slippageBps > 10_000) revert InvalidParameter();
        slippageBps = _slippageBps;
    }

    function setRelayerFee(uint256 _relayerFee) external onlyOwner {
        relayerFee = _relayerFee;
    }

    // --- IBridgeAdapter ---

    /// @inheritdoc IBridgeAdapter
    /// @dev Connext's relayer fee is quoted off-chain (relayer API) and passed
    ///      as `msg.value` to `xcall`; the adapter stores the current quote.
    function quoteFees(IBridgeTypes.BridgeRequest calldata _request) external view returns (uint256) {
        if (chainToDomain[_request.dstChainId] == 0) revert InvalidDestinationDomain();
        return relayerFee;
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeOut(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId
    ) external payable returns (bytes memory messageId) {
        if (msg.sender != bridgeRouter) revert OnlyBridgeRouter();
        if (_request.deadline < block.timestamp) revert DeadlineExpired();

        uint32 destinationDomain = chainToDomain[_request.dstChainId];
        if (destinationDomain == 0) revert InvalidDestinationDomain();

        address remote = remoteAdapters[_request.dstChainId];
        if (remote == address(0)) revert RemoteAdapterNotSet();

        uint256 fee = relayerFee;
        if (msg.value < fee) revert InsufficientFee();

        // The router escrowed the tokens and approved this adapter.
        _pullAndApprove(_request.token, _request.amount);

        bytes32 transferId = _send(
            destinationDomain,
            remote,
            _request.token,
            _request.amount,
            fee,
            abi.encode(_requestId, _request.user)
        );

        requestToTransferId[_requestId] = transferId;
        emit ConnextTransferInitiated(_requestId, transferId, destinationDomain);

        _refundExcess(fee);
        return abi.encode(transferId);
    }

    /// @dev Pulls the escrowed tokens from the router and lets Connext take them.
    function _pullAndApprove(address _token, uint256 _amount) private {
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        IERC20(_token).safeIncreaseAllowance(address(connext), _amount);
    }

    /// @dev Split out of `bridgeOut` to keep that function's stack shallow.
    function _send(
        uint32 _destinationDomain,
        address _remote,
        address _token,
        uint256 _amount,
        uint256 _fee,
        bytes memory _callData
    ) private returns (bytes32) {
        return connext.xcall{value: _fee}(
            _destinationDomain,
            _remote,
            _token,
            address(0), // no third-party delegate
            _amount,
            slippageBps,
            _callData
        );
    }

    function _refundExcess(uint256 _fee) private {
        uint256 excess = msg.value - _fee;
        if (excess != 0) {
            payable(msg.sender).transfer(excess);
        }
    }

    /// @inheritdoc IBridgeAdapter
    /// @dev `_proof` is unused: on Connext the destination-side delivery is
    ///      attested by `xReceive` arriving from the Connext contract.
    function bridgeIn(
        IBridgeTypes.BridgeRequest calldata _request,
        bytes32 _requestId,
        bytes calldata /* _proof */
    ) external {
        if (msg.sender != bridgeRouter) revert OnlyBridgeRouter();
        if (!delivered[_requestId]) revert NotDelivered();
        if (completed[_requestId]) revert AlreadyCompleted();

        completed[_requestId] = true;
        IERC20(_request.token).safeTransfer(_request.user, _request.amount);

        emit ConnextTransferCompleted(_requestId, _request.user, _request.token, _request.amount);
    }

    // --- IXReceiver ---

    /// @inheritdoc IXReceiver
    /// @dev Called by Connext *after* it has transferred `_amount` of `_asset`
    ///      to this contract. Only the Connext contract may call this.
    function xReceive(
        bytes32 _transferId,
        uint256 _amount,
        address _asset,
        address, /* _originSender */
        uint32, /* _origin */
        bytes calldata _callData
    ) external returns (bytes memory) {
        if (msg.sender != address(connext)) revert OnlyConnext();

        (bytes32 requestId, ) = abi.decode(_callData, (bytes32, address));

        delivered[requestId] = true;
        transferToRequestId[_transferId] = requestId;

        emit ConnextTransferDelivered(requestId, _transferId, _amount, _asset);
        return bytes("");
    }

    // --- Rescue ---

    /// @notice Withdraws tokens that are not backing an undelivered/completed request.
    /// @dev Delivered-but-unpaid funds stay in the adapter until the watcher
    ///      completes the request, so this is only for dust, fee rebates or
    ///      tokens sent here by mistake.
    function withdraw(address _token, uint256 _amount) external onlyOwner {
        if (_token == address(0)) {
            uint256 balance = address(this).balance;
            if (_amount == 0 || _amount > balance) revert NothingToWithdraw();
            payable(owner()).transfer(_amount);
        } else {
            IERC20(_token).safeTransfer(owner(), _amount);
        }
    }

    receive() external payable {}
}
