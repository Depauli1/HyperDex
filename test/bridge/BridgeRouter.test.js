const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BridgeRouter", function () {
  let owner, relayer, user, other;
  let Token, FeeControllerMock, AdapterMock, Router;
  let token, feeController, adapter, router;
  let adapterKey;
  let deadline;
  const amount = ethers.utils.parseUnits("100", 18);
  const refundTimeout = 3600;

  // snapshot/revert to isolate time and state per test
  let snapshotId;
  before(async function () {
    snapshotId = await ethers.provider.send('evm_snapshot', []);
  });
  beforeEach(async function () {
    await ethers.provider.send('evm_revert', [snapshotId]);
    snapshotId = await ethers.provider.send('evm_snapshot', []);
  });

  beforeEach(async function () {
    [owner, relayer, user, other] = await ethers.getSigners();
    // Deploy mock token
    Token = await ethers.getContractFactory("contracts/bridge/mocks/MockERC20.sol:MockERC20");
    token = await Token.deploy("Mock", "MCK");
    await token.deployed();
    await token.mint(user.address, ethers.utils.parseUnits("1000", 18));

    // Deploy mock FeeController
    FeeControllerMock = await ethers.getContractFactory("MockFeeController");
    feeController = await FeeControllerMock.deploy();
    await feeController.deployed();

    // Deploy BridgeRouter
    Router = await ethers.getContractFactory("BridgeRouter");
    router = await Router.deploy(feeController.address, refundTimeout);
    await router.deployed();

    // Deploy mock adapter
    AdapterMock = await ethers.getContractFactory("MockBridgeAdapter");
    adapter = await AdapterMock.deploy();
    await adapter.deployed();

    // Register adapter under key
    adapterKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("mock"));
    await router.connect(owner).setAdapter(adapterKey, adapter.address);
    // Authorize relayer
    await router.connect(owner).setRelayer(relayer.address, true);

    // Approve router to transfer tokens
    await token.connect(user).approve(router.address, ethers.constants.MaxUint256);

    // set test-specific deadline relative to current block
    const block = await ethers.provider.getBlock('latest');
    deadline = block.timestamp + refundTimeout;
  });

  function makeRequest() {
    return {
      id: ethers.utils.formatBytes32String("1"),
      srcChainId: 1,
      dstChainId: 2,
      token: token.address,
      amount: amount,
      user: user.address,
      deadline: deadline,
      fee: 0,
    };
  }

  it("reverts if non-relayer calls initiateBridge", async function () {
    const req = makeRequest();
    await expect(
      router.connect(other).initiateBridge(req, adapterKey, { value: 0 })
    )
      .to.be.revertedWithCustomError(router, "UnauthorizedRelayer")
      .withArgs(other.address);
  });

  it("initiates and bridges out tokens", async function () {
    const req = makeRequest();
    // call initiateBridge as relayer
    await expect(
      router.connect(relayer).initiateBridge(req, adapterKey, { value: 0 })
    )
      .to.emit(router, "BridgeInitiated").withArgs(req.id, adapterKey, user.address, amount, 0)
      .and.to.emit(adapter, "MockBridgeOut").withArgs(req.id);

    // status should be Bridged (2)
    expect(await router.requestStatus(req.id)).to.equal(2);
    // tokens escrowed in router
    expect(await token.balanceOf(router.address)).to.equal(amount);
    // adapter recorded bridgedOut
    expect(await adapter.bridgedOut(req.id)).to.be.true;
  });

  it("reverts if non-relayer calls completeBridge", async function () {
    const req = makeRequest();
    await expect(
      router.connect(other).completeBridge(req, [], adapterKey)
    ).to.be.revertedWithCustomError(router, "UnauthorizedRelayer").withArgs(other.address);
  });

  it("completes bridge in after outbound", async function () {
    const req = makeRequest();
    // initiate
    await router.connect(relayer).initiateBridge(req, adapterKey, { value: 0 });

    // complete
    await expect(
      router.connect(relayer).completeBridge(req, [], adapterKey)
    )
      .to.emit(adapter, "MockBridgeIn").withArgs(req.id)
      .and.to.emit(router, "BridgeCompleted").withArgs(req.id);

    // status should be Completed (3)
    expect(await router.requestStatus(req.id)).to.equal(3);
    // adapter state reset
    expect(await adapter.bridgedOut(req.id)).to.be.false;
  });

  it("allows owner to withdraw zero fees but reverts on excess or non-owner", async function () {
    // non-owner
    await expect(
      router.connect(other).withdrawFees(user.address, 0)
    ).to.be.revertedWith("Ownable: caller is not the owner");
    // owner withdraw zero
    await expect(
      router.connect(owner).withdrawFees(user.address, 0)
    ).not.to.be.reverted;
    // withdraw too much
    await expect(
      router.connect(owner).withdrawFees(user.address, 1)
    ).to.be.revertedWith("Amount too high");
  });

  it("pauses and unpauses correctly", async function () {
    // pause
    await router.connect(owner).pause();
    await expect(
      router.connect(relayer).initiateBridge(makeRequest(), adapterKey, { value: 0 })
    ).to.be.revertedWith("Pausable: paused");
    // unpause
    await router.connect(owner).unpause();
    await expect(
      router.connect(relayer).initiateBridge(makeRequest(), adapterKey, { value: 0 })
    ).not.to.be.reverted;
  });

  it("reverts on refundBridge before timeout", async function () {
    const req = makeRequest();
    await router.connect(relayer).initiateBridge(req, adapterKey, { value: 0 });
    await expect(
      router.connect(relayer).refundBridge(req.id)
    ).to.be.revertedWith("BridgeRouter: not timed out");
  });

  it("allows refundBridge after timeout", async function () {
    const req = makeRequest();
    await router.connect(relayer).initiateBridge(req, adapterKey, { value: 0 });
    await ethers.provider.send("evm_increaseTime", [refundTimeout + 1]);
    await ethers.provider.send("evm_mine");
    await expect(
      router.connect(relayer).refundBridge(req.id)
    ).to.emit(router, "BridgeRefunded").withArgs(req.id);
    expect(await router.requestStatus(req.id)).to.equal(4);
    expect(await token.balanceOf(user.address)).to.equal(ethers.utils.parseUnits("1000", 18));
  });

  it("reverts refundBridge if non-relayer", async function () {
    const req = makeRequest();
    await router.connect(relayer).initiateBridge(req, adapterKey, { value: 0 });
    await ethers.provider.send("evm_increaseTime", [refundTimeout + 1]);
    await ethers.provider.send("evm_mine");
    await expect(
      router.connect(other).refundBridge(req.id)
    ).to.be.revertedWithCustomError(router, "UnauthorizedRelayer").withArgs(other.address);
  });
});
