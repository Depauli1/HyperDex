// BridgeRouter guards that do not depend on any bridge protocol.
//
// Everything that needs a live adapter - fee quoting, escrow, signature
// recovery, completion - is exercised against real protocol deployments in
// test/fork/ (Connext on a Sepolia fork, LayerZero on a Sepolia fork, Hop on a
// mainnet fork). There are no test doubles in this repository, so this file
// covers exactly the surface that is protocol-independent.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const RequestStatus = { None: 0, Initiated: 1, Completed: 2, Failed: 3, Refunding: 4 };

// Deploys a fresh stack for every test.
//
// These files deliberately do NOT use `loadFixture`: its snapshot/revert
// machinery reverts the whole in-process chain to an older snapshot, which
// invalidates the state other test files are relying on (and, because
// CREATE addresses are deterministic, can leave them talking to contracts whose
// approvals have vanished). Re-running the deploy per test is cheap here.
async function fresh(fixture) {
  return fixture();
}

describe("BridgeRouter", function () {
  async function deployRouterFixture() {
    const [owner, user, relayer, other] = await ethers.getSigners();

    const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
    const bridgeRouter = await BridgeRouter.deploy();
    await bridgeRouter.deployed();

    return { bridgeRouter, owner, user, relayer, other };
  }

  function makeRequest(overrides = {}) {
    return {
      id: 1,
      srcChainId: 1,
      dstChainId: 137,
      token: ethers.constants.AddressZero,
      amount: ethers.utils.parseEther("10"),
      user: ethers.constants.AddressZero,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      fee: ethers.utils.parseEther("0.01"),
      ...overrides,
    };
  }

  describe("Deployment and configuration", function () {
    it("sets the owner and the default timeout", async function () {
      const { bridgeRouter, owner } = await fresh(deployRouterFixture);
      expect(await bridgeRouter.owner()).to.equal(owner.address);
      expect(await bridgeRouter.bridgeTimeout()).to.equal(3600);
    });

    it("only lets the owner register adapters, relayers and timeouts", async function () {
      const { bridgeRouter, owner, relayer, other } = await fresh(deployRouterFixture);

      await expect(
        bridgeRouter.connect(other).registerAdapter(137, other.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(
        bridgeRouter.connect(other).setRelayer(other.address, true)
      ).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(
        bridgeRouter.connect(other).setBridgeTimeout(60)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await bridgeRouter.connect(owner).registerAdapter(137, owner.address);
      expect(await bridgeRouter.bridgeAdapters(137)).to.equal(owner.address);
      expect(relayer.address).to.be.a("string");
    });

    it("rejects the zero address as an adapter or relayer", async function () {
      const { bridgeRouter } = await fresh(deployRouterFixture);
      await expect(
        bridgeRouter.registerAdapter(137, ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidAdapter");
      await expect(
        bridgeRouter.setRelayer(ethers.constants.AddressZero, true)
      ).to.be.revertedWithCustomError(bridgeRouter, "Unauthorized");
    });

    it("pauses and unpauses bridging", async function () {
      const { bridgeRouter } = await fresh(deployRouterFixture);
      await bridgeRouter.pause();
      expect(await bridgeRouter.paused()).to.equal(true);
      await bridgeRouter.unpause();
      expect(await bridgeRouter.paused()).to.equal(false);
    });
  });

  describe("Initiation guards", function () {
    it("reverts when no adapter serves the destination chain", async function () {
      const { bridgeRouter, relayer } = await fresh(deployRouterFixture);
      await expect(
        bridgeRouter.connect(relayer).initiateBridge(makeRequest(), "0x" + "00".repeat(65))
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidAdapter");
    });

    it("reverts on an expired deadline before touching the adapter", async function () {
      const { bridgeRouter, relayer } = await fresh(deployRouterFixture);
      await expect(
        bridgeRouter.connect(relayer).initiateBridge(
          makeRequest({ deadline: Math.floor(Date.now() / 1000) - 1 }),
          "0x" + "00".repeat(65)
        )
      ).to.be.revertedWithCustomError(bridgeRouter, "DeadlineExceeded");
    });

    it("reverts while paused", async function () {
      const { bridgeRouter, relayer } = await fresh(deployRouterFixture);
      await bridgeRouter.pause();
      await expect(
        bridgeRouter.connect(relayer).initiateBridge(makeRequest(), "0x" + "00".repeat(65))
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Inbound guards", function () {
    it("refuses recordInbound from an unauthorised caller", async function () {
      const { bridgeRouter, other } = await fresh(deployRouterFixture);
      await expect(
        bridgeRouter.connect(other).recordInbound(makeRequest(), ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(bridgeRouter, "Unauthorized");
    });

    it("refuses completeBridge from an unauthorised caller", async function () {
      const { bridgeRouter, other } = await fresh(deployRouterFixture);
      await expect(
        bridgeRouter.connect(other).completeBridge(makeRequest(), ethers.constants.HashZero, "0x")
      ).to.be.revertedWithCustomError(bridgeRouter, "Unauthorized");
    });

    it("refuses a request destined for another chain", async function () {
      const { bridgeRouter, relayer } = await fresh(deployRouterFixture);
      await bridgeRouter.setRelayer(relayer.address, true);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      await expect(
        bridgeRouter.connect(relayer).recordInbound(makeRequest(), ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(bridgeRouter, "WrongDestination");
      expect(chainId).to.be.a("number");
    });

    it("reports an unknown request as such", async function () {
      const { bridgeRouter } = await fresh(deployRouterFixture);
      const [stored, status] = await bridgeRouter.getBridgeRequest(ethers.constants.HashZero);
      expect(stored.user).to.equal(ethers.constants.AddressZero);
      expect(status).to.equal(RequestStatus.None);
    });
  });

  describe("Refunds", function () {
    it("reverts for an unknown request", async function () {
      const { bridgeRouter } = await fresh(deployRouterFixture);
      await expect(
        bridgeRouter.initiateRefund(ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidStatus");
    });
  });
});
