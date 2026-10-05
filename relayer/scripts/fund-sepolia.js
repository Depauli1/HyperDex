#!/usr/bin/env node
/**
 * Sends a little Sepolia ETH from the deployer wallet to another address -
 * normally the relayer account, which needs gas to record and complete inbound
 * transfers.
 *
 *   SEPOLIA_RPC_URL=... DEPLOYER_PRIVATE_KEY=0x... FUND_TO_ADDRESS=0x... \
 *   FUND_AMOUNT=0.2 node relayer/scripts/fund-sepolia.js
 */
const { ethers } = require('ethers');

async function main() {
  const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.RPC_URL;
  if (!rpcUrl) throw new Error('SEPOLIA_RPC_URL (or RPC_URL) is required');

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('DEPLOYER_PRIVATE_KEY is required');

  const to = process.env.FUND_TO_ADDRESS;
  if (!ethers.utils.isAddress(to || '')) {
    throw new Error('FUND_TO_ADDRESS must be a valid address');
  }

  const amount = process.env.FUND_AMOUNT || '0.2';
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  const value = ethers.utils.parseEther(amount);
  if (balance.lt(value)) {
    throw new Error(
      `Deployer ${wallet.address} holds ${ethers.utils.formatEther(balance)} ETH, needs ${amount}`
    );
  }

  const tx = await wallet.sendTransaction({ to, value });
  console.log(`Sent ${amount} ETH to ${to}: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
