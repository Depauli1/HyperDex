// scripts/fund-sepolia.js
// Fund a Sepolia address with ETH from your deployer wallet
const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const to = process.env.FUND_TO_ADDRESS;
  const amount = process.env.FUND_AMOUNT || "0.2"; // ETH

  if (!to) throw new Error("FUND_TO_ADDRESS not set in .env");

  const tx = await wallet.sendTransaction({
    to,
    value: ethers.utils.parseEther(amount)
  });
  await tx.wait();
  console.log(`Funded ${to} with ${amount} ETH on Sepolia`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
