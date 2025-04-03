const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("HyperDex", function () {
  let HyperDex;
  let hyperDex;
  let owner;

  beforeEach(async function () {
    // Get the contract owner (deployer)
    [owner] = await ethers.getSigners();

    // Get the HyperDex contract factory
    HyperDex = await ethers.getContractFactory("HyperDex");

    // Deploy the contract with Uniswap V3 factory and router addresses
    const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory (mainnet)
    const routerAddress = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // SwapRouter (mainnet)
    hyperDex = await HyperDex.deploy(factoryAddress, routerAddress);
    // Removed: await hyperDex.deployed(); (not needed with Hardhat ethers.js)
  });

  it("should set the correct factory and router addresses", async function () {
    expect(await hyperDex.factoryAddress()).to.equal("0x1F98431c8aD98523631AE4a59f267346ea31F984");
    expect(await hyperDex.routerAddress()).to.equal("0xE592427A0AEce92De3Edee1F18E0157C05861564");
  });

  // Add more tests for custom functions here
});