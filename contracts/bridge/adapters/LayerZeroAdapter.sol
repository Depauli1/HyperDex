// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../IBridgeAdapter.sol";

/// @notice Minimal interface for LayerZero Endpoint contract
interface ILayerZeroEndpoint {
    function send(
        uint16 _dstChainId,
        bytes calldata _destination,
        bytes calldata _payload,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes calldata _adapterParams
    ) external payable;
    
    function estimateFees(
        uint16 _dstChainId,
        address _userApplication,
        bytes calldata _payload,
        bool _payInZRO,
        bytes calldata _adapterParam
    ) external view returns (uint256 nativeFee, uint256 zroFee);
}

/**
 * @title LayerZeroAdapter
 * @notice Adapter for LayerZero bridge protocol
 * @dev Implements IBridgeAdapter; handles token escrow and cross-chain messaging
 */
contract LayerZeroAdapter is IBridgeAdapter, Ownable {
    using SafeERC20 for IERC20;

    /// @notice LayerZero Endpoint contract address
    ILayerZeroEndpoint public immutable lzEndpoint;
    
    /// @notice Tracks processed inbound requests (prevent replay)
    mapping(bytes32 => bool) public processed;

    /// @notice Mapping from LayerZero chain ID to trusted remote address
    mapping(uint16 => bytes) public trustedRemoteLookup;

    event BridgeRequested(
        bytes32 indexed id,
        uint16 indexed dstChainId,
        address indexed token,
        uint256 amount,
        address user
    );
    event BridgeSucceeded(bytes32 indexed id, address user, address token, uint256 amount);
    event SetTrustedRemote(uint16 indexed remoteChainId, bytes remoteAddress);

    constructor(address _lzEndpoint) {
        require(_lzEndpoint != address(0), "LayerZero: zero address");
        lzEndpoint = ILayerZeroEndpoint(_lzEndpoint);
    }

    /// @notice Sets the trusted remote address for a source chain ID
    /// @param _remoteChainId LayerZero chain ID of the source chain
    /// @param _remoteAddress Trusted source address (e.g., BridgeRouter or Adapter on source chain)
    function setTrustedRemote(uint16 _remoteChainId, bytes calldata _remoteAddress) external onlyOwner {
        trustedRemoteLookup[_remoteChainId] = _remoteAddress;
        emit SetTrustedRemote(_remoteChainId, _remoteAddress);
    }

    function getName() external pure override returns (string memory) {
        return "LayerZero";
    }

    function getVersion() external pure override returns (string memory) {
        return "1.0.0";
    }

    /// @inheritdoc IBridgeAdapter
    function quoteFees(BridgeRequest calldata req) external view override returns (uint256) {
        bytes memory payload = abi.encode(req);
        bytes memory adapterParams = ""; // Default adapter params
        
        (uint256 nativeFee,) = lzEndpoint.estimateFees(
            uint16(req.dstChainId),
            address(this),
            payload,
            false, // don't pay in ZRO
            adapterParams
        );
        return nativeFee;
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeOut(BridgeRequest calldata req) external payable override {
        require(req.deadline >= block.timestamp, "LayerZeroAdapter: deadline expired");
        require(req.amount > 0, "LayerZeroAdapter: amount=0");

        IERC20(req.token).safeTransferFrom(msg.sender, address(this), req.amount);
        bytes memory payload = abi.encode(req);
        bytes memory adapterParams = ""; // Default adapter params

        // Retrieve the trusted remote address for the source chain (this chain)
        // This assumes setTrustedRemote was called to configure the remote address for the *destination* chain
        // Note: LayerZero requires the destination address in bytes format.
        // We send *to* this contract's address on the destination chain.
        bytes memory destinationAddressBytes = abi.encodePacked(address(this));

        lzEndpoint.send{value: msg.value}(
            uint16(req.dstChainId),
            destinationAddressBytes, // destination contract address
            payload,
            payable(msg.sender), // refund address
            address(0), // zro payment address
            adapterParams 
        );

        emit BridgeRequested(req.id, uint16(req.dstChainId), req.token, req.amount, msg.sender);
    }
    
    /**
     * @notice Called by the LayerZero Endpoint upon receiving a cross-chain message
     * @param _srcChainId LayerZero chain ID of the source chain
     * @param _srcAddress Source address from the source chain
     * @param _nonce Unique nonce provided by LayerZero
     * @param _payload The payload (abi.encoded BridgeRequest) sent from the source chain
     */
    function lzReceive(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        uint64 _nonce,
        bytes calldata _payload
    ) external {
        // Ensure the message comes from the LayerZero Endpoint
        require(msg.sender == address(lzEndpoint), "LayerZeroAdapter: invalid caller");

        // Ensure the message comes from a trusted source address and chain
        bytes memory trustedRemote = trustedRemoteLookup[_srcChainId];
        require(trustedRemote.length > 0, "LayerZeroAdapter: untrusted remote chain");
        require(keccak256(_srcAddress) == keccak256(trustedRemote), "LayerZeroAdapter: untrusted remote address");

        // Decode the BridgeRequest payload
        BridgeRequest memory req = abi.decode(_payload, (BridgeRequest));

        // Prevent replay attacks
        require(!processed[req.id], "LayerZeroAdapter: already processed");
        processed[req.id] = true;

        // Transfer bridged tokens to the user
        IERC20(req.token).safeTransfer(req.user, req.amount);

        emit BridgeSucceeded(req.id, req.user, req.token, req.amount);
    }

    /// @inheritdoc IBridgeAdapter
    /// @dev This function is required by the interface but is unused in the LayerZero flow.
    /// The actual inbound logic is handled by lzReceive.
    function bridgeIn(BridgeRequest calldata /* req */, bytes calldata /* proof */) external pure override {
        revert("LayerZeroAdapter: bridgeIn is not used, use lzReceive");
    }
} 