// scripts/deploy-sepolia.js
// Deploy HyperDex, Factory, and Pool contracts to Sepolia and print their addresses
const { ethers } = require("ethers");
require("dotenv").config({ path: require('path').resolve(__dirname, '../.env') });

// TODO: Update these paths to match your actual artifacts
const HyperDexJson = require("../artifacts/contracts/HyperDex.sol/HyperDex.json");
const FactoryJson = require("../artifacts/contracts/HyperDexFactory.sol/HyperDexFactory.json");
const PoolJson = require("../artifacts/contracts/HyperDexPool.sol/HyperDexPool.json");

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // optional override for gas limit
  const GAS_LIMIT = process.env.DEPLOY_GAS_LIMIT ? Number(process.env.DEPLOY_GAS_LIMIT) : 5000000;

  // Deploy Factory
  const systemContract = process.env.HYPERLIQUID_SYSTEM_CONTRACT || ethers.constants.AddressZero;
  const FactoryFactory = new ethers.ContractFactory(FactoryJson.abi, FactoryJson.bytecode, wallet);
  const factory = await FactoryFactory.deploy(systemContract, { gasLimit: GAS_LIMIT });
  await factory.deployed();
  console.log("FACTORY_ADDRESS=" + factory.address);

  // Deploy HyperDex
  const HyperDexFactory = new ethers.ContractFactory(HyperDexJson.abi, HyperDexJson.bytecode, wallet);
  const hyperDex = await HyperDexFactory.deploy(factory.address, { gasLimit: GAS_LIMIT });
  await hyperDex.deployed();
  console.log("HYPERDEX_ADDRESS=" + hyperDex.address);

  // Deploy Pool
  const PoolFactory = new ethers.ContractFactory(PoolJson.abi, PoolJson.bytecode, wallet);
  const pool = await PoolFactory.deploy(
    factory.address,
    process.env.POOL_TOKEN0,
    process.env.POOL_TOKEN1,
    Number(process.env.POOL_FEE),
    Number(process.env.POOL_TICK_SPACING),
    { gasLimit: GAS_LIMIT }
  );
  await pool.deployed();
  console.log("POOL_ADDRESS=" + pool.address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
