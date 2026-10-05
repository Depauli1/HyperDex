// ConnextAdapter against the REAL Connext deployment on a Sepolia fork.
//
// What is proven here, with no test doubles anywhere:
//   * our adapter's domain mapping agrees with the deployed Connext contract
//   * a full BridgeRouter -> ConnextAdapter -> Connext.xcall path executes on
//     the real protocol and the real contract emits its own logs
//   * the adapter records the transfer id the protocol returned
//   * the xReceive callback path only accepts the real Connext contract

const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const { sepolia } = require("./helpers/addresses");
const { skipUnlessForked, impersonate, stopImpersonating, hasLogFrom } = require("./helpers/fork");
const { signBridgeRequest } = require("../helpers/bridge-eip712");

describe("ConnextAdapter on a Sepolia fork (real Connext)", function () {
  let owner, user, relayer;
  let adapter, router, connext, requestIdCounter = 0;

  const ZERO_ASSET = ethers.constants.AddressZero;
  const RELAYER_FEE = ethers.utils.parseEther("0.01");

  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;

    [owner, user, relayer] = await ethers.getSigners();

    const { abi: connextAbi } = await artifacts.readArtifact("IConnext");
    connext = new ethers.Contract(sepolia.connext, connextAbi, ethers.provider);

    const Adapter = await ethers.getContractFactory("ConnextAdapter");
    adapter = await Adapter.deploy(sepolia.connext);
    await adapter.deployed();

    const Router = await ethers.getContractFactory("BridgeRouter");
    router = await Router.deploy();
    await router.deployed();

    // The deployed Connext contract is the source of truth for its own domain.
    const liveDomain = await connext.domain();
    await adapter.setDomainMapping(sepolia.chainId, liveDomain);
    await adapter.setRemoteAdapter(sepolia.chainId, adapter.address);
    await adapter.setBridgeRouter(router.address);
    await adapter.setRelayerFee(RELAYER_FEE);

    await router.registerAdapter(sepolia.chainId, adapter.address);
    await router.setRelayer(relayer.address, true);
  });

  it("agrees with the deployed Connext contract on its domain", async function () {
    const liveDomain = await connext.domain();
    expect(Number(liveDomain)).to.equal(sepolia.connextDomain);
    expect(await adapter.chainToDomain(sepolia.chainId)).to.equal(liveDomain);
  });

  function makeRequest(overrides = {}) {
    return {
      id: ++requestIdCounter,
      srcChainId: 1,
      dstChainId: sepolia.chainId,
      token: ZERO_ASSET, // message-only: no asset moves, no escrow needed
      amount: 0,
      user: user.address,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      fee: RELAYER_FEE,
      ...overrides,
    };
  }

  it("quotes the configured relayer fee for a mapped destination", async function () {
    expect(await adapter.quoteFees(makeRequest())).to.equal(RELAYER_FEE);
  });

  it("rejects a destination chain with no domain mapping", async function () {
    await expect(adapter.quoteFees(makeRequest({ dstChainId: 999999 }))).to.be.revertedWithCustomError(
      adapter,
      "InvalidDestinationDomain"
    );
  });

  it("executes a real Connext xcall through the router", async function () {
    const request = makeRequest();
    const signature = await signBridgeRequest(router, user, request);
    const nonceBefore = await connext.nonce();

    const tx = await router
      .connect(relayer)
      .initiateBridge(request, signature, { value: request.fee });
    const receipt = await tx.wait();

    // The real protocol accepted the message: its own nonce advanced and it
    // emitted at least one log. (Connext's event ABI is not part of
    // @connext/interfaces, so we assert on the protocol's state + logs rather
    // than on an event shape we would have to invent.)
    expect(hasLogFrom(receipt, sepolia.connext)).to.equal(true);
    expect(await connext.nonce()).to.equal(nonceBefore.add(1));

    const event = receipt.events.find((e) => e.event === "BridgeInitiated");
    const requestId = event.args.requestId;
    const transferId = await adapter.requestToTransferId(requestId);
    expect(transferId).to.not.equal(ethers.constants.HashZero);
  });

  it("only lets the deployed Connext contract deliver an inbound transfer", async function () {
    const transferId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const callData = ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "address"],
      [ethers.utils.hexlify(ethers.utils.randomBytes(32)), user.address]
    );

    await expect(
      adapter
        .connect(user)
        .xReceive(transferId, 1, ZERO_ASSET, ethers.constants.AddressZero, 1, callData)
    ).to.be.revertedWithCustomError(adapter, "OnlyConnext");
  });

  it("accepts a delivery from the real Connext address and marks it delivered", async function () {
    const requestId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const transferId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const callData = ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "address"],
      [requestId, user.address]
    );

    const connextSigner = await impersonate(sepolia.connext);
    await adapter
      .connect(connextSigner)
      .xReceive(transferId, 1, ZERO_ASSET, ethers.constants.AddressZero, 1, callData);
    await stopImpersonating(sepolia.connext);

    expect(await adapter.delivered(requestId)).to.equal(true);
    expect(await adapter.transferToRequestId(transferId)).to.equal(requestId);
  });
});
