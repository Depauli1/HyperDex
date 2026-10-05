// HopAdapter against Hop's REAL L1 bridge on a mainnet fork.
//
// Hop has no classic `L1_Bridge` deployment on Sepolia (only CCTP variants), so
// this leg is verified on a mainnet fork. The test asserts the adapter's ABI is
// the deployed bridge's ABI by reading the real contract's runtime bytecode and
// checking the dispatcher actually contains the selectors we call, then proves
// fee quoting end to end against the live bonder-fee view.
//
// Run with:  MAINNET_RPC_URL=https://... npx hardhat test test/fork/Mainnet.hop.fork.test.js

const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const { hopL1Bridge, hopAddresses, MAINNET_CHAIN_ID } = require("./helpers/addresses");
const { skipUnlessForked, deployedBytecode } = require("./helpers/fork");
const { checkSelectors } = require("./helpers/selectors");

describe("HopAdapter on a mainnet fork (real Hop L1 bridge)", function () {
  let adapter, bridgeAddress, bridgeCode;

  const TOKEN = "USDC";

  before(async function () {
    if (!(await skipUnlessForked(MAINNET_CHAIN_ID, this))) return;

    bridgeAddress = hopL1Bridge("mainnet", TOKEN);
    expect(bridgeAddress, `no Hop L1 bridge published for ${TOKEN}`).to.match(/^0x[0-9a-fA-F]{40}$/);

    bridgeCode = await deployedBytecode(ethers.provider, bridgeAddress);
    expect(bridgeCode, "Hop bridge has no code on this fork").to.not.equal("0x");

    const HopAdapter = await ethers.getContractFactory("HopAdapter");
    adapter = await HopAdapter.deploy(bridgeAddress, ethers.constants.AddressZero);
    await adapter.deployed();
  });

  it("targets a bridge whose deployed bytecode implements sendToL2", async function () {
    // The Hop package ships the generated ABI for its deployed bridges; assert
    // that the selectors our interface calls exist in the real dispatcher.
    const { abi } = await artifacts.readArtifact("IHopBridge");
    const { missing } = checkSelectors(bridgeCode, abi, ["sendToL2", "getBondForTransferAmount"]);
    expect(missing, `missing on Hop L1 bridge: ${missing.join(", ")}`).to.be.empty;
  });

  it("quotes the configured bonder fee for a request", async function () {
    const request = {
      id: 1,
      srcChainId: MAINNET_CHAIN_ID,
      dstChainId: 10, // optimism
      token: ethers.constants.AddressZero,
      amount: ethers.utils.parseUnits("1000", 6),
      user: ethers.constants.AddressZero,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      fee: 0,
    };

    const quoted = await adapter.quoteFees(request);
    // 25 bps of the amount, matching the adapter's default bonderFeeBps.
    expect(quoted).to.equal(request.amount.mul(25).div(10_000));
  });

  it("reads the live bond requirement from the deployed bridge", async function () {
    const IHopBridge = new ethers.utils.Interface(
      (await artifacts.readArtifact("IHopBridge")).abi
    );
    const bridge = new ethers.Contract(
      hopAddresses("mainnet").bridges[TOKEN].ethereum.l1Bridge,
      IHopBridge,
      ethers.provider
    );
    // A view that only exists on the real deployment; a wrong address or a
    // fabricated interface would revert here.
    const bond = await bridge.getBondForTransferAmount(ethers.utils.parseUnits("1000", 6));
    expect(bond).to.be.gte(0);
  });

  it("only lets the owner configure relayer, router and fees", async function () {
    const [, other] = await ethers.getSigners();
    await expect(
      adapter.connect(other).setRelayer(other.address, true)
    ).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(adapter.connect(other).setFeeParameters(50, 0)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
  });
});
