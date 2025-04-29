const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("ConnextAdapter", function () {
  let connextAdapter;
  let connext;
  let bridgeRouter;
  let token;
  let owner;
  let user;
  const domain = 22; // Example domain ID

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();
    // Deploy a mock Connext contract
    const MockConnext = await ethers.getContractFactory("MockConnext");
    connext = await MockConnext.deploy();
    await connext.deployed();
    // Deploy a mock BridgeRouter
    const MockBridgeRouter = await ethers.getContractFactory("MockBridgeRouter");
    bridgeRouter = await MockBridgeRouter.deploy();
    await bridgeRouter.deployed();
    // Deploy a mock ERC20 token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock Token", "MTK", 18);
    await token.deployed();
    // Deploy ConnextAdapter
    const ConnextAdapter = await ethers.getContractFactory("ConnextAdapter");
    connextAdapter = await ConnextAdapter.deploy(connext.address, domain, bridgeRouter.address);
    await connextAdapter.deployed();
  });

  describe("Constructor", function () {
    it("Should set the correct connext address, domain, and bridgeRouter", async function () {
      expect(await connextAdapter.connext()).to.equal(connext.address);
      expect(await connextAdapter.domain()).to.equal(domain);
      expect(await connextAdapter.bridgeRouter()).to.equal(bridgeRouter.address);
    });
  });

  describe("bridgeOut", function () {
    it("Should revert if deadline expired", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: ethers.utils.parseEther("1"),
        deadline: Math.floor(Date.now() / 1000) - 1, // Expired deadline
      };
      await expect(connextAdapter.bridgeOut(req, { value: ethers.utils.parseEther("0.1") }))
        .to.be.revertedWith("ConnextAdapter: deadline expired");
    });

    it("Should revert if amount is zero", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      await expect(connextAdapter.bridgeOut(req, { value: ethers.utils.parseEther("0.1") }))
        .to.be.revertedWith("ConnextAdapter: amount=0");
    });

    it("Should emit BridgeRequested event on successful bridgeOut", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: ethers.utils.parseEther("1"),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      await token.mint(connextAdapter.address, req.amount);
      await expect(connextAdapter.bridgeOut(req, { value: ethers.utils.parseEther("0.1") }))
        .to.emit(connextAdapter, "BridgeRequested")
        .withArgs(req.id, domain, req.token, req.amount, user.address);
    });
  });

  describe("bridgeIn", function () {
    it("Should revert if caller is not BridgeRouter", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: ethers.utils.parseEther("1"),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      await expect(connextAdapter.bridgeIn(req, "0x"))
        .to.be.revertedWith("ConnextAdapter: caller not BridgeRouter");
    });

    it("Should revert if request already processed", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: ethers.utils.parseEther("1"),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      await connextAdapter.connect(bridgeRouter).bridgeIn(req, "0x");
      await expect(connextAdapter.connect(bridgeRouter).bridgeIn(req, "0x"))
        .to.be.revertedWith("ConnextAdapter: already processed");
    });

    it("Should emit BridgeSucceeded event on successful bridgeIn", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: ethers.utils.parseEther("1"),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      await token.mint(connextAdapter.address, req.amount);
      await expect(connextAdapter.connect(bridgeRouter).bridgeIn(req, "0x"))
        .to.emit(connextAdapter, "BridgeSucceeded")
        .withArgs(req.id, req.user, req.token, req.amount);
    });
  });

  describe("quoteFees", function () {
    it("Should return the estimated fee from Connext", async function () {
      const req = {
        id: ethers.utils.id("test"),
        dstChainId: 2,
        user: user.address,
        token: token.address,
        amount: ethers.utils.parseEther("1"),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      const fee = await connextAdapter.quoteFees(req);
      expect(fee).to.equal(await connext.estimateReceiverFee(domain, ethers.utils.defaultAbiCoder.encode(["bytes32"], [req.id])));
    });
  });
}); 