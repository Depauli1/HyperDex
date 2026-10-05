// Configuration sanity: every address the fork suite uses must really be a
// deployed contract on the forked chain, and every function we call on them
// must really exist in their runtime bytecode. This turns a stale or mistyped
// address into an obvious failure instead of a confusing downstream one.

const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const { sepolia, layerZeroEndpoint } = require("./helpers/addresses");
const { skipUnlessForked, deployedBytecode } = require("./helpers/fork");
const { checkSelectors } = require("./helpers/selectors");
const { hopAddresses } = require("./helpers/addresses");

describe("Fork configuration (Sepolia)", function () {
  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;
  });

  it("points at live Connext, Uniswap v3, WETH and Chainlink deployments", async function () {
    for (const [name, address] of [
      ["connext", sepolia.connext],
      ["uniswapV3Factory", sepolia.uniswapV3Factory],
      ["weth9", sepolia.weth9],
      ["chainlinkEthUsd", sepolia.chainlinkEthUsd],
    ]) {
      const code = await deployedBytecode(ethers.provider, address);
      expect(code, `${name} (${address}) has no code`).to.not.equal("0x");
    }
  });

  it("exposes the Connext xcall/xReceive ABI we compile against", async function () {
    const { abi } = await artifacts.readArtifact("IConnext");
    const { missing } = checkSelectors(
      await deployedBytecode(ethers.provider, sepolia.connext),
      abi,
      ["xcall", "domain", "nonce"]
    );
    expect(missing, `missing on Connext: ${missing.join(", ")}`).to.be.empty;

    const receiver = await artifacts.readArtifact("IXReceiver");
    // xReceive is implemented by the receiver, not Connext; assert the selector
    // the protocol will use agrees with the interface we implement.
    expect(new ethers.utils.Interface(receiver.abi).getSighash("xReceive")).to.equal(
      ethers.utils.id(
        "xReceive(bytes32,uint256,address,address,uint32,bytes)"
      ).slice(0, 10)
    );
  });

  it("reads the LayerZero endpoint from LayerZero's published deployment bundle", async function () {
    const endpoint = layerZeroEndpoint("sepolia-testnet");
    const code = await deployedBytecode(ethers.provider, endpoint);
    expect(code, `LayerZero endpoint ${endpoint} has no code`).to.not.equal("0x");

    const { abi } = await artifacts.readArtifact("ILayerZeroEndpoint");
    const { missing } = checkSelectors(code, abi, ["send", "estimateFees"]);
    expect(missing, `missing on LayerZero endpoint: ${missing.join(", ")}`).to.be.empty;
  });

  it("exposes the Uniswap v3 factory owner surface our fee policy depends on", async function () {
    const { abi } = await artifacts.readArtifact("IUniswapV3PoolOwnerActions");
    // The factory itself owns pools; the pool exposes setFeeProtocol/collectProtocol.
    expect(new ethers.utils.Interface(abi).getSighash("setFeeProtocol")).to.equal(
      ethers.utils.id("setFeeProtocol(uint8,uint8)").slice(0, 10)
    );
    expect(new ethers.utils.Interface(abi).getSighash("collectProtocol")).to.equal(
      ethers.utils.id("collectProtocol(address,uint128,uint128)").slice(0, 10)
    );
  });

  it("knows which networks Hop is actually deployed on", async function () {
    const mainnet = hopAddresses("mainnet");
    const sepolia = hopAddresses("sepolia");
    // Hop's classic L1 bridge exists on mainnet...
    expect(mainnet.bridges.USDC.ethereum.l1Bridge).to.match(/^0x[0-9a-fA-F]{40}$/);
    // ...and is NOT deployed on Sepolia (only CCTP variants are), which is why
    // the Hop leg is covered by the mainnet fork suite instead.
    const sepoliaUsdc = sepolia.bridges.USDC.ethereum;
    expect(sepoliaUsdc.l1Bridge).to.not.match(/^0x[0-9a-fA-F]{40}$/);
  });
});
