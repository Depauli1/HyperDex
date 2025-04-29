// scripts/deploy-sepolia.js
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  try {
    // Deploy Mock Tokens first
    console.log("\nDeploying Mock Tokens...");
    const MockToken = await ethers.getContractFactory("MockERC20");
    const token0 = await MockToken.deploy("Mock Token 0", "MTK0", 18);
    await token0.deployed();
    console.log("TOKEN0_ADDRESS=" + token0.address);

    const token1 = await MockToken.deploy("Mock Token 1", "MTK1", 18);
    await token1.deployed();
    console.log("TOKEN1_ADDRESS=" + token1.address);

    // Deploy Factory
    console.log("\nDeploying Factory...");
    const Factory = await ethers.getContractFactory("HyperDexFactory");
    const factory = await Factory.deploy(ethers.constants.AddressZero);
    await factory.deployed();
    console.log("FACTORY_ADDRESS=" + factory.address);

    // Deploy HyperDex
    console.log("\nDeploying HyperDex...");
    const HyperDex = await ethers.getContractFactory("HyperDex");
    const hyperDex = await HyperDex.deploy(factory.address);
    await hyperDex.deployed();
    console.log("HYPERDEX_ADDRESS=" + hyperDex.address);

    // Deploy BridgeRouter
    console.log("\nDeploying BridgeRouter...");
    const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
    const bridgeRouter = await BridgeRouter.deploy();
    await bridgeRouter.deployed();
    console.log("BRIDGE_ROUTER_ADDRESS=" + bridgeRouter.address);

    // Deploy ConnextAdapter
    console.log("\nDeploying ConnextAdapter...");
    const ConnextAdapter = await ethers.getContractFactory("ConnextAdapter");
    const connextAdapter = await ConnextAdapter.deploy(
      "0x0000000000000000000000000000000000000000", // Mock Connext address
      11155111, // Sepolia domain ID
      bridgeRouter.address
    );
    await connextAdapter.deployed();
    console.log("CONNEXT_ADAPTER_ADDRESS=" + connextAdapter.address);

    // Deploy Pool
    console.log("\nDeploying Pool...");
    const Pool = await ethers.getContractFactory("HyperDexPool");
    const pool = await Pool.deploy(
      factory.address,
      token0.address,
      token1.address,
      500, // fee = 0.05%
      10 // tickSpacing
    );
    await pool.deployed();
    console.log("POOL_ADDRESS=" + pool.address);

    // Initialize pool
    console.log("\nInitializing Pool...");
    const initialPrice = ethers.BigNumber.from("79228162514264337593543950336"); // 1:1 price
    await pool.initialize(initialPrice);
    console.log("Pool initialized at price 1:1");

    // Register pool in factory
    console.log("\nRegistering pool in factory...");
    await factory.registerExistingPool(token0.address, token1.address, 500, pool.address);
    console.log("Pool registered in factory");

    // Set up initial liquidity
    console.log("\nSetting up initial liquidity...");
    const mintAmount = ethers.utils.parseEther("1000000");
    await token0.mint(deployer.address, mintAmount);
    await token1.mint(deployer.address, mintAmount);
    await token0.approve(pool.address, mintAmount);
    await token1.approve(pool.address, mintAmount);

    // Add liquidity across full range
    const minTick = -887250;
    const maxTick = 887250;
    await pool.mint(deployer.address, minTick, maxTick, ethers.utils.parseEther("100000"));
    console.log("Initial liquidity added");

    console.log("\nDeployment complete! Add these values to your .env file:");
    console.log(`
TOKEN0_ADDRESS=${token0.address}
TOKEN1_ADDRESS=${token1.address}
FACTORY_ADDRESS=${factory.address}
HYPERDEX_ADDRESS=${hyperDex.address}
BRIDGE_ROUTER_ADDRESS=${bridgeRouter.address}
CONNEXT_ADAPTER_ADDRESS=${connextAdapter.address}
POOL_ADDRESS=${pool.address}
    `);

  } catch (error) {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
