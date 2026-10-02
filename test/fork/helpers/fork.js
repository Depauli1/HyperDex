// Shared plumbing for the fork suite.

const { ethers, network } = require("hardhat");

const SEPOLIA_CHAIN_ID = 11155111;
const MAINNET_CHAIN_ID = 1;

/**
 * Skips the enclosing suite unless the fork currently backing Hardhat is the
 * expected chain. Fork tests therefore no-op on a plain `npm test` run (which
 * uses an ephemeral, unforked Hardhat network) instead of failing for lack of
 * an RPC endpoint.
 */
async function skipUnlessForked(wantChainId, ctx) {
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== Number(wantChainId)) {
    ctx.skip();
    return false;
  }
  return true;
}

/** The account Hardhat fakes for a real deployed address. */
async function impersonate(address) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return ethers.getSigner(address);
}

async function stopImpersonating(address) {
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [address],
  });
}

/** Gives an impersonated account enough gas money for the test. */
async function fundWithEther(address, eth = "100") {
  await network.provider.send("hardhat_setBalance", [
    address,
    ethers.utils.parseEther(eth).toHexString(),
  ]);
}

/** True if `receipt` contains at least one log emitted by `address`. */
function hasLogFrom(receipt, address) {
  const target = address.toLowerCase();
  return receipt.logs.some((log) => log.address.toLowerCase() === target);
}

/** Reads the deployed bytecode of a real contract. */
async function deployedBytecode(provider, address) {
  return provider.getCode(address);
}

module.exports = {
  SEPOLIA_CHAIN_ID,
  MAINNET_CHAIN_ID,
  skipUnlessForked,
  impersonate,
  stopImpersonating,
  fundWithEther,
  hasLogFrom,
  deployedBytecode,
};
