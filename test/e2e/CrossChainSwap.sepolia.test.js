const { ethers, network } = require("hardhat");
const { expect } = require("chai");

describe("Cross-Chain Swap on Sepolia", function () {
  let hyperdex;
  let bridgeRouter;
  let connextAdapter;
  let token;
  let owner;
  let user;
  const sepoliaChainId = 11155111; // Sepolia chain ID

  before(async function () {
    // Skip if not on Sepolia
    if (network.name !== "sepolia") {
      this.skip();
    }
    [owner, user] = await ethers.getSigners();
    // Deploy or get deployed contracts on Sepolia
    const HyperDex = await ethers.getContractFactory("HyperDex");
    hyperdex = await HyperDex.attach("0x..."); // Replace with actual deployed address
    const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
    bridgeRouter = await BridgeRouter.attach("0x..."); // Replace with actual deployed address
    const ConnextAdapter = await ethers.getContractFactory("ConnextAdapter");
    connextAdapter = await ConnextAdapter.attach("0x..."); // Replace with actual deployed address
    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.attach("0x..."); // Replace with actual deployed address
  });

  it("Should execute a full cross-chain swap", async function () {
    // Step 1: Deposit tokens into HyperDex
    const depositAmount = ethers.utils.parseEther("1");
    await token.connect(user).approve(hyperdex.address, depositAmount);
    await hyperdex.connect(user).deposit(token.address, depositAmount);
    expect(await token.balanceOf(hyperdex.address)).to.equal(depositAmount);

    // Step 2: Bridge out tokens via ConnextAdapter
    const bridgeOutReq = {
      id: ethers.utils.id("bridgeOut"),
      dstChainId: 2, // Example destination chain ID
      user: user.address,
      token: token.address,
      amount: depositAmount,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    };
    await hyperdex.connect(user).bridgeOut(bridgeOutReq, { value: ethers.utils.parseEther("0.1") });
    expect(await token.balanceOf(hyperdex.address)).to.equal(0);

    // Step 3: Bridge in tokens via ConnextAdapter
    const bridgeInReq = {
      id: ethers.utils.id("bridgeIn"),
      dstChainId: sepoliaChainId,
      user: user.address,
      token: token.address,
      amount: depositAmount,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    };
    await connextAdapter.connect(bridgeRouter).bridgeIn(bridgeInReq, "0x");
    expect(await token.balanceOf(user.address)).to.equal(depositAmount);
  });
}); 