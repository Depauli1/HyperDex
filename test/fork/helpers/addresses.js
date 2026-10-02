// Real, live deployments used by the fork suite.
//
// Everything here is an address of a contract that exists on a public network.
// Nothing in this directory is a test double: the fork tests talk to the actual
// Connext, LayerZero, Hop, Chainlink and Uniswap deployments, and the only
// "impersonation" used is Hardhat's `hardhat_impersonateAccount` against a real
// deployed address (e.g. calling `xReceive` as the Connext contract itself),
// which is standard fork-testing practice and not a stand-in for the protocol.
//
// Sources
//   Uniswap v3 factory  Uniswap Labs' Sepolia deployment
//                       https://sepolia.etherscan.io/address/0x0227628f3F023bb0B980b67D528571c95c6DaC1c
//   Uniswap v3 NFPM     Uniswap's deployed NonfungiblePositionManager (Etherscan-verified bytecode)
//   WETH9               canonical wrapped ether on Sepolia
//   Connext + domain    connext/gitbook-docs, resources/deployments.md (Sepolia)
//   ETH/USD feed        docs.chain.link data-feeds price-feed address table (Sepolia)
//   LayerZero endpoint  read from the published @layerzerolabs/lz-evm-sdk-v1 bundle
//   Hop                 read from the published @hop-protocol/core address tables
//
// Each value can be overridden by an environment variable so a redeployment
// does not require editing this file.

const fs = require("fs");
const path = require("path");

const SEPOLIA_CHAIN_ID = 11155111;
const MAINNET_CHAIN_ID = 1;

const sepolia = {
  chainId: SEPOLIA_CHAIN_ID,
  // Canonical Uniswap v3 periphery; verified against the deployed bytecode on
  // Sepolia (see https://sepolia.etherscan.io/address/0x1238536071E1c677A632429e3655c799b22cDA52).
  nonfungiblePositionManager:
    process.env.SEPOLIA_NFPM || "0x1238536071E1c677A632429e3655c799b22cDA52",
  uniswapV3Factory:
    process.env.SEPOLIA_V3_FACTORY || "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  weth9: process.env.SEPOLIA_WETH9 || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  connext: process.env.SEPOLIA_CONNEXT || "0x445fbf9cCbaf7d557fd771d56937E94397f43965",
  // Connext domain ids are NOT chain ids; this is Connext's own Sepolia domain.
  connextDomain: Number(process.env.SEPOLIA_CONNEXT_DOMAIN || 1936027759),
  chainlinkEthUsd:
    process.env.SEPOLIA_CHAINLINK_ETH_USD || "0x694AA1769357215DE4FAC081bf1f309aDC325306",
};

function readJsonFromPackage(pkg, relative) {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "node_modules", ...pkg.split("/"), relative),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return null;
}

/**
 * LayerZero v1 endpoint address for a network, taken from the deployment bundle
 * LayerZero publishes in @layerzerolabs/lz-evm-sdk-v1. Reading the published
 * bundle means the test cannot silently drift from the real deployment.
 */
function layerZeroEndpoint(network = "sepolia-testnet") {
  const override = process.env.LAYERZERO_ENDPOINT_ADDRESS;
  if (override) return override;
  const deployment = readJsonFromPackage(
    "@layerzerolabs/lz-evm-sdk-v1",
    path.join("deployments", network, "Endpoint.json")
  );
  if (!deployment) {
    throw new Error(
      `LayerZero deployment bundle missing for ${network}; run npm install (or set LAYERZERO_ENDPOINT_ADDRESS)`
    );
  }
  return deployment.address;
}

/**
 * Hop deployment table for a network, from @hop-protocol/core. Returns the
 * published address book (bridges, tokens, bonders) untouched.
 */
function hopAddresses(network = "mainnet") {
  const table = readJsonFromPackage("@hop-protocol/core", path.join("addresses", `${network}.js`));
  return table;
}

/** The Hop L1 bridge address for a token on a network, if one is deployed. */
function hopL1Bridge(network, token) {
  const addresses = hopAddresses(network);
  const entry = addresses?.bridges?.[token]?.ethereum;
  if (!entry) return null;
  return entry.l1Bridge || null;
}

module.exports = {
  SEPOLIA_CHAIN_ID,
  MAINNET_CHAIN_ID,
  sepolia,
  layerZeroEndpoint,
  hopAddresses,
  hopL1Bridge,
};
