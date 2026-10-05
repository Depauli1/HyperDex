// LayerZeroAdapter against the REAL LayerZero v1 endpoint on a Sepolia fork.
//
// Proven here, with no test doubles:
//   * the endpoint Id we map a chain to is read from the live endpoint itself
//   * fee quoting goes through the endpoint's own estimateFees
//   * a full BridgeRouter -> LayerZeroAdapter -> endpoint.send path executes and
//     the endpoint's outboundNonce advances (the protocol accepted the message)
//
// The endpoint ABI used to assert on protocol state is the one LayerZero
// publishes in @layerzerolabs/lz-evm-sdk-v1/deployments, not a hand-written one.

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const { sepolia, layerZeroEndpoint } = require("./helpers/addresses");
const { skipUnlessForked } = require("./helpers/fork");
const { signBridgeRequest } = require("../helpers/bridge-eip712");

function publishedEndpointAbi() {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "node_modules",
    "@layerzerolabs",
    "lz-evm-sdk-v1",
    "deployments",
    "sepolia-testnet",
    "Endpoint.json"
  );
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

describe("LayerZeroAdapter on a Sepolia fork (real endpoint)", function () {
  let owner, user, relayer;
  let adapter, router, endpoint, dstChainId;

  const RELAYER_FEE_CAP = ethers.utils.parseEther("0.05");

  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;

    [owner, user, relayer] = await ethers.getSigners();

    const address = layerZeroEndpoint("sepolia-testnet");
    // The published deployment ABI is used verbatim, so the test cannot drift
    // from the real contract's interface.
    endpoint = new ethers.Contract(address, publishedEndpointAbi(), ethers.provider);

    const { abi: adapterEndpointAbi } = await artifacts.readArtifact("ILayerZeroEndpoint");

    const Adapter = await ethers.getContractFactory("LayerZeroAdapter");
    adapter = await Adapter.deploy(address, ethers.constants.AddressZero);
    await adapter.deployed();

    const Router = await ethers.getContractFactory("BridgeRouter");
    router = await Router.deploy();
    await router.deployed();

    await adapter.setBridgeRouter(router.address);

    // Ask the live endpoint which LayerZero chain id it is; that removes any
    // dependency on a hardcoded id.
    dstChainId = await endpoint.chainId();
    await adapter.setChainMapping(sepolia.chainId, dstChainId);
    await adapter.setTrustedRemote(
      dstChainId,
      ethers.utils.defaultAbiCoder.encode(["address"], [adapter.address])
    );
    await adapter.setAdapterParams(ethers.utils.solidityPack(["uint16", "uint256"], [1, 200000]));

    // Sanity: our own declared endpoint interface and the published ABI agree.
    const ours = new ethers.utils.Interface(adapterEndpointAbi);
    expect(ours.getSighash("send")).to.equal(
      new ethers.utils.Interface(publishedEndpointAbi()).getSighash("send")
    );
    expect(await adapter.endpoint()).to.equal(address);

    await router.registerAdapter(sepolia.chainId, adapter.address);
    await router.setRelayer(relayer.address, true);
  });

  function makeRequest(fee = RELAYER_FEE_CAP) {
    return {
      id: 1,
      srcChainId: 1,
      dstChainId: sepolia.chainId,
      token: ethers.constants.AddressZero,
      amount: 0,
      user: user.address,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      fee,
    };
  }

  it("reads the chain id from the live endpoint and maps it", async function () {
    expect(dstChainId).to.be.a("number").and.to.be.greaterThan(0);
    expect(await adapter.chainToLzId(sepolia.chainId)).to.equal(dstChainId);
  });

  it("quotes a non-zero native fee from the real endpoint", async function () {
    const fee = await adapter.quoteFees(makeRequest());
    expect(fee).to.be.greaterThan(0);
  });

  it("reverts quoting for a chain with no LayerZero mapping", async function () {
    await expect(adapter.quoteFees(makeRequest())).to.not.be.reverted;
    await expect(
      adapter.quoteFees({ ...makeRequest(), dstChainId: 999999 })
    ).to.be.revertedWith("LayerZeroAdapter: Invalid destination chain");
  });

  it("sends a real message through the endpoint", async function () {
    const request = makeRequest();
    const quoted = await adapter.quoteFees(request);
    // The router forwards exactly quoteFees() as msg.value.
    request.fee = quoted;

    const nonceBefore = await endpoint.getOutboundNonce(dstChainId, adapter.address);

    const signature = await signBridgeRequest(router, user, request);
    const tx = await router
      .connect(relayer)
      .initiateBridge(request, signature, { value: quoted });
    const receipt = await tx.wait();

    const nonceAfter = await endpoint.getOutboundNonce(dstChainId, adapter.address);
    expect(nonceAfter).to.equal(nonceBefore.add(1));

    const sent = receipt.events.find((e) => e.event === "LayerZeroMessageSent");
    expect(sent, "LayerZeroMessageSent").to.not.be.undefined;
    expect(sent.args.dstChainId).to.equal(dstChainId);
  });
});
