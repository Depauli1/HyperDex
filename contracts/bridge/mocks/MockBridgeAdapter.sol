// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IBridgeAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Mock Bridge Adapter for testing
contract MockBridgeAdapter is IBridgeAdapter {
    using SafeERC20 for IERC20;

    mapping(bytes32 => bool) public bridgedOut;

    event MockBridgeOut(bytes32 indexed id);
    event MockBridgeIn(bytes32 indexed id);

    /// @inheritdoc IBridgeAdapter
    function quoteFees(BridgeRequest calldata req) external pure override returns (uint256) {
        return req.fee;
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeOut(BridgeRequest calldata req) external payable override {
        bridgedOut[req.id] = true;
        emit MockBridgeOut(req.id);
    }

    /// @inheritdoc IBridgeAdapter
    function bridgeIn(BridgeRequest calldata req, bytes calldata /* proof */) external override {
        require(bridgedOut[req.id], "Not bridged out");
        bridgedOut[req.id] = false;
        emit MockBridgeIn(req.id);
    }

    /// @inheritdoc IBridgeAdapter
    function getName() external pure override returns (string memory) {
        return "Mock";
    }

    /// @inheritdoc IBridgeAdapter
    function getVersion() external pure override returns (string memory) {
        return "1.0.0";
    }
}
