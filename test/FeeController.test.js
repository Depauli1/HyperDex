const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FeeController", function () {
  let mockAggregator;
  let feeController;
  let owner;

  const BASE_FEE = 100;
  const MAX_FEE = 500;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    // deploy MockV3Aggregator with initial gas price 200 gwei
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    mockAggregator = await Mock.deploy(9, ethers.utils.parseUnits("200", "gwei"));
    await mockAggregator.deployed();

    const Fee = await ethers.getContractFactory("FeeController");
    feeController = await Fee.deploy(mockAggregator.address, BASE_FEE, MAX_FEE);
    await feeController.deployed();
  });

  it("returns base fee initially", async function () {
    expect(await feeController.getCurrentFee()).to.equal(BASE_FEE);
  });

  it("updates fee based on gas price", async function () {
    await feeController.updateFee();
    const expected = BASE_FEE + 200;
    expect(await feeController.getCurrentFee()).to.equal(expected);
    const history = await feeController.getFeeHistory(0, 1);
    expect(history.length).to.equal(1);
    expect(history[0]).to.equal(expected);
  });

  it("caps fee at maxFee", async function () {
    await feeController.setMaxFee(BASE_FEE + 100);
    await feeController.updateFee();
    expect(await feeController.getCurrentFee()).to.equal(BASE_FEE + 100);
  });

  it("allows updating base fee", async function () {
    await feeController.setBaseFee(50);
    await feeController.updateFee();
    expect(await feeController.getCurrentFee()).to.equal(50 + 200);
  });

  it("reverts updateFee when paused", async function () {
    await feeController.pause();
    await expect(feeController.updateFee()).to.be.revertedWith("Pausable: paused");
  });

  it("unpauses to allow updateFee", async function () {
    await feeController.pause();
    await feeController.unpause();
    await feeController.updateFee();
    expect(await feeController.getCurrentFee()).to.equal(BASE_FEE + 200);
  });

  it("reverts getFeeHistory on invalid indices", async function () {
    await expect(feeController.getFeeHistory(1, 0)).to.be.revertedWith("Invalid indices");
    await expect(feeController.getFeeHistory(0, 2)).to.be.revertedWith("Invalid indices");
  });
});
