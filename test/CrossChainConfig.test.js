// The cross-chain configuration script, run against a real deployment.
//
// scripts/lib/configure.js is what `npx hardhat run scripts/configure-cross-chain.js`
// executes on a live network. Testing it here - against contracts deployed on
// the in-process chain - means the wiring is proven before it is ever pointed at
// a funded deployment, and it documents the exact state the script leaves
// behind.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { configure } = require("../scripts/lib/configure");

const DEST_CHAIN_ID = 10;
const SRC_CHAIN_ID = 11155111;
const REMOTE_ADAPTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LZ_CHAIN_ID = 111;
const RELAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

describe("Cross-chain configuration", function () {
  let admin, router, connext, layerzero, hop, hyperdex;

  beforeEach(async function () {
    [admin] = await ethers.getSigners();

    const Router = await ethers.getContractFactory("BridgeRouter");
    router = await Router.deploy();

    // The adapters take the protocol's own address (Connext, the LayerZero
    // endpoint, the Hop bridge) plus the router they serve. On a live network
    // those are the deployed contracts; here they only have to be valid
    // addresses, because the configuration steps never call them.
    const Connext = await ethers.getContractFactory("ConnextAdapter");
    connext = await Connext.deploy(REMOTE_ADAPTER);

    const LayerZero = await ethers.getContractFactory("LayerZeroAdapter");
    layerzero = await LayerZero.deploy(REMOTE_ADAPTER, router.address);

    const Hop = await ethers.getContractFactory("HopAdapter");
    hop = await Hop.deploy(REMOTE_ADAPTER, admin.address);

    const PositionManager = await ethers.getContractFactory("PositionManager");
    hyperdex = await PositionManager.deploy(REMOTE_ADAPTER);
  });

  function config(overrides = {}) {
    return {
      bridgeRouter: router.address,
      relayer: RELAYER,
      adapters: { [DEST_CHAIN_ID]: connext.address },
      connext: { adapter: connext.address, domains: { [DEST_CHAIN_ID]: 1869640549 } },
      layerzero: {
        adapter: layerzero.address,
        chains: { [DEST_CHAIN_ID]: LZ_CHAIN_ID },
        trustedRemotes: { [LZ_CHAIN_ID]: REMOTE_ADAPTER }
      },
      hop: { adapter: hop.address, bridge: REMOTE_ADAPTER },
      ...overrides
    };
  }

  it("wires the adapters, the relayer, the domains and the remotes", async function () {
    const summary = await configure({ ethers, config: config(), log: () => {} });

    expect(await router.bridgeAdapters(DEST_CHAIN_ID)).to.equal(connext.address);
    expect(await router.authorizedRelayers(RELAYER)).to.equal(true);

    expect(await connext.bridgeRouter()).to.equal(router.address);
    expect(Number(await connext.chainToDomain(DEST_CHAIN_ID))).to.equal(1869640549);

    expect(await layerzero.bridgeRouter()).to.equal(router.address);
    expect(Number(await layerzero.chainToLzId(DEST_CHAIN_ID))).to.equal(LZ_CHAIN_ID);
    expect(await layerzero.trustedRemoteLookup(LZ_CHAIN_ID)).to.equal(
      ethers.utils.solidityPack(["address"], [REMOTE_ADAPTER])
    );

    expect(await hop.bridgeRouter()).to.equal(router.address);
    expect(await hop.hopRelayer()).to.equal(REMOTE_ADAPTER);

    expect(summary.changes).to.be.greaterThan(0);
  });

  it("changes nothing on a second run", async function () {
    await configure({ ethers, config: config(), log: () => {} });
    const second = await configure({ ethers, config: config(), log: () => {} });

    expect(second.changes).to.equal(0);
    expect(second.skipped).to.be.greaterThan(0);
  });

  it("reports the plan without sending anything when dryRun is set", async function () {
    const summary = await configure({ ethers, config: config(), dryRun: true, log: () => {} });

    expect(summary.changes).to.equal(0); // nothing sent
    expect(await router.bridgeAdapters(DEST_CHAIN_ID)).to.equal(ethers.constants.AddressZero);
    expect(await connext.bridgeRouter()).to.equal(ethers.constants.AddressZero);
  });

  it("refuses a config with an invalid address instead of sending a bad transaction", async function () {
    let error;
    try {
      await configure({
        ethers,
        config: config({ adapters: { [DEST_CHAIN_ID]: "0xnot-an-address" } }),
        log: () => {}
      });
    } catch (err) {
      error = err;
    }
    expect(error?.message).to.match(/adapter for chain 10 must be a valid address/);
    expect(await router.bridgeAdapters(DEST_CHAIN_ID)).to.equal(ethers.constants.AddressZero);
  });

  it("fails loudly when a value does not take", async function () {
    // Point the Connext section at a contract that is not a ConnextAdapter: the
    // write reverts, and the script must surface it rather than continue with
    // half the wiring in place.
    let error;
    try {
      await configure({
        ethers,
        config: config({ connext: { adapter: hop.address, domains: { [DEST_CHAIN_ID]: 1 } } }),
        log: () => {}
      });
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(Error);
  });
});
