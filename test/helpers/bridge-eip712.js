const { ethers } = require("hardhat");

// EIP-712 domain + types mirroring contracts/BridgeRouter.sol
// (constructor: EIP712("HyperDex Bridge", "1"); BRIDGE_REQUEST_TYPEHASH).
const BRIDGE_REQUEST_TYPES = {
  BridgeRequest: [
    { name: "id", type: "uint256" },
    { name: "srcChainId", type: "uint256" },
    { name: "dstChainId", type: "uint256" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "user", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "fee", type: "uint256" }
  ]
};

/**
 * Signs a bridge request exactly the way BridgeRouter.initiateBridge recovers it.
 * @param {import("ethers").Contract} bridgeRouter deployed router (domain's verifyingContract)
 * @param {import("ethers").Signer} signer the user authorising the request
 * @param {Object} request the IBridgeTypes.BridgeRequest fields
 * @returns {Promise<string>} the EIP-712 signature
 */
async function signBridgeRequest(bridgeRouter, signer, request) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return signer._signTypedData(
    {
      name: "HyperDex Bridge",
      version: "1",
      chainId,
      verifyingContract: bridgeRouter.address
    },
    BRIDGE_REQUEST_TYPES,
    request
  );
}

module.exports = { signBridgeRequest, BRIDGE_REQUEST_TYPES };
