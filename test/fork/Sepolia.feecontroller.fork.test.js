// FeeController against the REAL Chainlink ETH/USD feed on a Sepolia fork.
//
// The controller's volatility input can only come from a live feed, so this is
// where its behaviour belongs: there is no way to exercise it in-process
// without faking an oracle.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { sepolia } = require("./helpers/addresses");
const { skipUnlessForked } = require("./helpers/fork");

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

describe("FeeController on a Sepolia fork (real Chainlink feed)", function () {
  let owner, controller, feed;

  const BASE = 10;
  const MIN = 4;

  before(async function () {
    if (!(await skipUnlessForked(sepolia.chainId, this))) return;

    [owner] = await ethers.getSigners();

    const Controller = await ethers.getContractFactory("FeeController");
    controller = await Controller.deploy(sepolia.chainlinkEthUsd, BASE, MIN);
    await controller.deployed();

    feed = new ethers.Contract(sepolia.chainlinkEthUsd, AGGREGATOR_ABI, ethers.provider);
  });

  it("reads a live price from the feed it was configured with", async function () {
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.be.greaterThan(0);
    expect(await controller.priceFeed()).to.equal(sepolia.chainlinkEthUsd);
  });

  it("returns the base denominator before any observation", async function () {
    expect(await controller.getProtocolFeeDenominator()).to.equal(BASE);
    expect(await controller.historyLength()).to.equal(0);
  });

  it("records an observation from the real feed and clamps the result", async function () {
    const [, answer] = await feed.latestRoundData();

    await expect(controller.update()).to.emit(controller, "FeeUpdated");

    expect(await controller.historyLength()).to.equal(1);
    // The recorded raw answer is the feed's own, proving the observation is real.
    expect(await controller.lastAnswer()).to.equal(answer);

    const denominator = await controller.getProtocolFeeDenominator();
    expect(denominator).to.be.within(MIN, BASE);

    // A fresh controller never having seen a move reports zero volatility.
    expect(await controller.volatilityBps()).to.equal(0);
  });

  it("enforces the update cooldown between observations", async function () {
    await expect(controller.update()).to.be.revertedWithCustomError(controller, "CooldownActive");
  });

  it("exposes history through getFeeHistory", async function () {
    const history = await controller.getFeeHistory(0, 1);
    expect(history.length).to.equal(1);
    expect(Number(history[0])).to.equal(await controller.getProtocolFeeDenominator());
  });

  it("refuses out-of-range parameters", async function () {
    await expect(controller.setParameters(3, 4, 2000, 2000, 60)).to.be.revertedWithCustomError(
      controller,
      "InvalidParameter"
    );
    await expect(controller.setParameters(4, 10, 2000, 2000, 60)).to.be.revertedWithCustomError(
      controller,
      "InvalidParameter"
    );
    await expect(controller.setParameters(10, 4, 0, 2000, 60)).to.be.revertedWithCustomError(
      controller,
      "InvalidParameter"
    );
  });

  it("only lets the owner pause and retune", async function () {
    const [, other] = await ethers.getSigners();
    await expect(
      controller.connect(other).setParameters(8, 4, 2000, 2000, 60)
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });
});
