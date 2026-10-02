// scripts/deploy-sepolia.js
//
// Deploys the HyperDex stack on top of the audited Uniswap v3 core factory.
//
// Tokens are NOT deployed here. Pass the real token addresses in the
// environment; deploying a test ERC20 to a public network is opt-in only.
//
//   TOKEN0_ADDRESS=0x... TOKEN1_ADDRESS=0x... \
//   RELAYER_ADDRESS=0x... ANALYTICS_UPDATER=0x... \
//   npx hardhat run scripts/deploy-sepolia.js --network sepolia
const { ethers } = require("hardhat");

const {
  TOKEN0_ADDRESS,
  TOKEN1_ADDRESS,
  RELAYER_ADDRESS,
  ANALYTICS_UPDATER,
  FEE_AMOUNT = "500",
  DEPLOY_TEST_TOKENS,
} = process.env;

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer configured. Set PRIVATE_KEY.");
  console.log("Deploying with account:", deployer.address);

  // --- Tokens ---
  let token0Address = TOKEN0_ADDRESS;
  let token1Address = TOKEN1_ADDRESS;

  if (DEPLOY_TEST_TOKENS === "true") {
    console.warn("\nDEPLOY_TEST_TOKENS=true — deploying test ERC20s.");
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const a = await TestERC20.deploy(ethers.utils.parseEther("1000000"));
    const b = await TestERC20.deploy(ethers.utils.parseEther("1000000"));
    await a.deployed();
    await b.deployed();
    const sorted = [a.address, b.address].sort();
    token0Address = sorted[0];
    token1Address = sorted[1];
  } else if (!token0Address || !token1Address) {
    throw new Error(
      "TOKEN0_ADDRESS and TOKEN1_ADDRESS are required (or set DEPLOY_TEST_TOKENS=true)."
    );
  }
  console.log("TOKEN0_ADDRESS=" + token0Address);
  console.log("TOKEN1_ADDRESS=" + token1Address);

  // --- Uniswap v3 core factory (audited) ---
  const V3Factory = await ethers.getContractFactory("UniswapV3Factory");
  const v3Factory = await V3Factory.deploy();
  await v3Factory.deployed();
  console.log("V3_FACTORY_ADDRESS=" + v3Factory.address);

  // --- HyperDex registry ---
  const Factory = await ethers.getContractFactory("HyperDexFactory");
  const factory = await Factory.deploy(v3Factory.address);
  await factory.deployed();
  console.log("FACTORY_ADDRESS=" + factory.address);

  // Let the registry manage fee tiers from now on.
  await (await v3Factory.setOwner(factory.address)).wait();
  console.log("v3 factory ownership transferred to HyperDexFactory");

  // --- Pool ---
  const fee = Number(FEE_AMOUNT);
  await (await factory.createPool(token0Address, token1Address, fee)).wait();
  const poolAddress = await factory.getPool(token0Address, token1Address, fee);
  console.log("POOL_ADDRESS=" + poolAddress);

  const pool = await ethers.getContractAt("UniswapV3Pool", poolAddress);
  // 1:1 price, i.e. tick 0 => sqrtPriceX96 = 2**96.
  await (await pool.initialize(ethers.BigNumber.from("79228162514264337593543950336"))).wait();
  console.log("Pool initialised at 1:1");

  // --- Gasless-swap gateway ---
  const HyperDex = await ethers.getContractFactory("HyperDex");
  const hyperDex = await HyperDex.deploy(factory.address);
  await hyperDex.deployed();
  console.log("HYPERDEX_ADDRESS=" + hyperDex.address);

  if (RELAYER_ADDRESS) {
    await (await hyperDex.setRelayer(RELAYER_ADDRESS)).wait();
    console.log("RELAYER_ADDRESS=" + RELAYER_ADDRESS);
  }
  if (ANALYTICS_UPDATER) {
    await (await factory.setAnalyticsUpdater(ANALYTICS_UPDATER)).wait();
    console.log("ANALYTICS_UPDATER=" + ANALYTICS_UPDATER);
  }

  // --- Bridge ---
  const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
  const bridgeRouter = await BridgeRouter.deploy();
  await bridgeRouter.deployed();
  console.log("BRIDGE_ROUTER_ADDRESS=" + bridgeRouter.address);

  console.log("\nDeployment complete. Add these to your .env:");
  console.log(
    [
      `TOKEN0_ADDRESS=${token0Address}`,
      `TOKEN1_ADDRESS=${token1Address}`,
      `V3_FACTORY_ADDRESS=${v3Factory.address}`,
      `FACTORY_ADDRESS=${factory.address}`,
      `POOL_ADDRESS=${poolAddress}`,
      `HYPERDEX_ADDRESS=${hyperDex.address}`,
      `BRIDGE_ROUTER_ADDRESS=${bridgeRouter.address}`,
    ].join("\n")
  );
  console.log(
    "\nNote: the Connext/LayerZero adapters need their protocol addresses and " +
      "must be registered with BridgeRouter.registerAdapter(chainId, adapter)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
