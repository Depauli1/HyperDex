// The inbound (destination-side) bridge leg, end to end, on a Sepolia fork.
//
// Regression test for the bug where bridging was one-legged: the destination
// router had no record of a request initiated on the source chain, so
// `completeBridge` reverted `InvalidStatus()` for every inbound transfer. The
// router now exposes `recordInbound`, which the watcher calls once the
// source-chain event is final.
//
// Everything here is real: real WETH, the real Connext address delivering the
// transfer through the canonical `xReceive` callback, the real adapter, the real
// router. Only the speed is fake — Connext's delivery is performed by
// impersonating the deployed Connext contract, which is the same caller the
// protocol itself would be.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { sepolia } = require("./helpers/addresses");
const { skipUnlessForked, impersonate, stopImpersonating, fundWithEther } = require("./helpers/fork");

const RequestStatus = { None: 0, Initiated: 1, Completed: 2, Failed: 3, Refunding: 4 };
const ORIGIN_CHAIN_ID = 1; // mainnet, the "source" side
const AMOUNT = ethers.utils.parseEther("0.25");

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

describe("Bridge inbound leg on a Sepolia fork (real Connext + real WETH)", function () {
  let admin, user, relayer, other;
  let router, adapter, weth;
  let requestId, transferId, request;

  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;

    [admin, user, relayer, other] = await ethers.getSigners();

    const Router = await ethers.getContractFactory("BridgeRouter");
    router = await Router.deploy();
    await router.deployed();

    const Adapter = await ethers.getContractFactory("ConnextAdapter");
    adapter = await Adapter.deploy(sepolia.connext);
    await adapter.deployed();
    await adapter.setBridgeRouter(router.address);
    await adapter.setRemoteAdapter(ORIGIN_CHAIN_ID, adapter.address);

    // On this fork the local chain is Sepolia, so that is the destination.
    await router.registerAdapter(sepolia.chainId, adapter.address);
    await router.setRelayer(relayer.address, true);

    weth = new ethers.Contract(sepolia.weth9, WETH_ABI, ethers.provider);

    // Connext delivers the bridged asset to the adapter before calling
    // xReceive; give the adapter that balance with real WETH.
    await fundWithEther(admin.address, "10");
    await weth.connect(admin).deposit({ value: AMOUNT });
    await weth.connect(admin).transfer(adapter.address, AMOUNT);

    requestId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    transferId = ethers.utils.hexlify(ethers.utils.randomBytes(32));

    request = {
      id: 7,
      srcChainId: ORIGIN_CHAIN_ID,
      dstChainId: sepolia.chainId,
      token: sepolia.weth9,
      amount: AMOUNT,
      user: user.address,
      deadline: (await ethers.provider.getBlock("latest")).timestamp + 3600,
      fee: 0,
    };
  });

  function callDataFor(requestId_, recipient) {
    return ethers.utils.defaultAbiCoder.encode(["bytes32", "address"], [requestId_, recipient]);
  }

  it("rejects an inbound record from anyone but an authorised relayer", async function () {
    await expect(
      router.connect(other).recordInbound(request, requestId)
    ).to.be.revertedWithCustomError(router, "Unauthorized");
  });

  it("rejects a request whose destination is another chain", async function () {
    await expect(
      router.connect(relayer).recordInbound({ ...request, dstChainId: ORIGIN_CHAIN_ID }, requestId)
    ).to.be.revertedWithCustomError(router, "WrongDestination");
  });

  it("cannot complete before the delivery is recorded", async function () {
    await expect(
      router.connect(relayer).completeBridge(request, requestId, "0x")
    ).to.be.revertedWithCustomError(router, "InvalidStatus");
  });

  it("accepts delivery from the real Connext contract", async function () {
    const connextSigner = await impersonate(sepolia.connext);
    await adapter
      .connect(connextSigner)
      .xReceive(
        transferId,
        AMOUNT,
        sepolia.weth9,
        ethers.constants.AddressZero,
        ORIGIN_CHAIN_ID,
        callDataFor(requestId, user.address)
      );
    await stopImpersonating(sepolia.connext);

    expect(await adapter.delivered(requestId)).to.equal(true);
  });

  it("records the inbound request and completes it, paying the user exactly once", async function () {
    const balanceBefore = await weth.balanceOf(user.address);

    await expect(router.connect(relayer).recordInbound(request, requestId))
      .to.emit(router, "BridgeInboundRecorded")
      .withArgs(
        requestId,
        user.address,
        ORIGIN_CHAIN_ID,
        sepolia.chainId,
        sepolia.weth9,
        AMOUNT
      );

    const [, statusAfterRecord] = await router.getBridgeRequest(requestId);
    expect(statusAfterRecord).to.equal(RequestStatus.Initiated);

    await expect(router.connect(relayer).completeBridge(request, requestId, "0x"))
      .to.emit(router, "BridgeCompleted")
      .withArgs(requestId, user.address, sepolia.weth9, AMOUNT);

    const [, statusAfterComplete] = await router.getBridgeRequest(requestId);
    expect(statusAfterComplete).to.equal(RequestStatus.Completed);
    expect(await adapter.completed(requestId)).to.equal(true);

    expect(await weth.balanceOf(user.address)).to.equal(balanceBefore.add(AMOUNT));
  });

  it("cannot be recorded or completed twice", async function () {
    await expect(
      router.connect(relayer).recordInbound(request, requestId)
    ).to.be.revertedWithCustomError(router, "AlreadyRecorded");

    await expect(
      router.connect(relayer).completeBridge(request, requestId, "0x")
    ).to.be.revertedWithCustomError(router, "InvalidStatus");
  });

  it("refuses an expired request, which belongs on the source chain's refund path", async function () {
    const expiredId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const expired = {
      ...request,
      deadline: (await ethers.provider.getBlock("latest")).timestamp - 1,
    };
    await expect(
      router.connect(relayer).recordInbound(expired, expiredId)
    ).to.be.revertedWithCustomError(router, "DeadlineExceeded");
  });
});
