// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  // Deploy WETH9
  const WETH9 = await hre.ethers.getContractFactory("WETH9");
  const weth9 = await WETH9.deploy();
  console.log("WETH9 deployed to:", weth9.address);

  // Deploy HyperDexFactory
  const HyperDexFactory = await hre.ethers.getContractFactory("HyperDexFactory");
  const factory = await HyperDexFactory.deploy(hre.ethers.constants.AddressZero);
  console.log("HyperDexFactory deployed to:", factory.address);

  // Deploy SwapRouter
  const SwapRouter = await hre.ethers.getContractFactory("SwapRouter");
  const router = await SwapRouter.deploy(factory.address, weth9.address);
  console.log("SwapRouter deployed to:", router.address);

  // Deploy HyperDex
  const HyperDex = await hre.ethers.getContractFactory("HyperDex");
  const hyperDex = await HyperDex.deploy(factory.address);
  console.log("HyperDex deployed to:", hyperDex.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });