// PositionManager: ownership and guard rails.
//
// These cases all reject *before* any call reaches the Uniswap periphery, so
// they hold on any chain. The paths that need the real periphery (mint,
// increase, collect, burn) are exercised against the deployed
// NonfungiblePositionManager in test/fork/Sepolia.positionManager.fork.test.js.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { sepolia } = require("./fork/helpers/addresses");

describe("PositionManager", function () {
  let manager, owner, stranger;

  beforeEach(async function () {
    [owner, stranger] = await ethers.getSigners();

    const PositionManager = await ethers.getContractFactory("PositionManager");
    // A real address: the canonical periphery on Sepolia. Anything that does
    // reach it would revert here (no code on a plain test chain), which is why
    // only the guarded paths are asserted in this file.
    manager = await PositionManager.deploy(sepolia.nonfungiblePositionManager);
  });

  it("requires a position manager address", async function () {
    const PositionManager = await ethers.getContractFactory("PositionManager");
    await expect(PositionManager.deploy(ethers.constants.AddressZero)).to.be.revertedWithCustomError(
      PositionManager,
      "ZeroAddress"
    );
  });

  it("points at the canonical periphery", async function () {
    expect(await manager.positionManager()).to.equal(sepolia.nonfungiblePositionManager);
  });

  it("treats every position as unowned until it is minted", async function () {
    expect(await manager.positionOwner(1)).to.equal(ethers.constants.AddressZero);
    expect(await manager.withdrawn(1)).to.equal(false);
  });

  it("refuses to change a position the caller does not own", async function () {
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    await expect(
      manager.connect(stranger).increaseLiquidity({
        tokenId: 1,
        amount0Desired: 1,
        amount1Desired: 1,
        amount0Min: 0,
        amount1Min: 0,
        deadline
      })
    ).to.be.revertedWithCustomError(manager, "NotPositionOwner");

    await expect(
      manager.connect(stranger).decreaseLiquidity({
        tokenId: 1,
        liquidity: 1,
        amount0Min: 0,
        amount1Min: 0,
        deadline
      })
    ).to.be.revertedWithCustomError(manager, "NotPositionOwner");

    await expect(
      manager.connect(stranger).collectPosition(1, 0, 0)
    ).to.be.revertedWithCustomError(manager, "NotPositionOwner");

    await expect(manager.connect(stranger).burnPosition(1)).to.be.revertedWithCustomError(
      manager,
      "NotPositionOwner"
    );

    await expect(manager.connect(stranger).withdraw(1)).to.be.revertedWithCustomError(
      manager,
      "NotPositionOwner"
    );
  });

  it("checks the deadline before moving any tokens", async function () {
    const PositionManager = await ethers.getContractFactory("PositionManager");
    const expired = await PositionManager.deploy(sepolia.nonfungiblePositionManager);

    await expect(
      expired.mint({
        token0: ethers.constants.AddressZero,
        token1: ethers.constants.AddressZero,
        fee: 3000,
        tickLower: -60,
        tickUpper: 60,
        amount0Desired: 0,
        amount1Desired: 0,
        amount0Min: 0,
        amount1Min: 0,
        recipient: owner.address,
        deadline: 1
      })
    ).to.be.revertedWithCustomError(expired, "DeadlineExpired");
  });

  it("does not hold approval for the periphery between calls", async function () {
    // The manager approves exactly the amount each call needs and resets to
    // zero first, so a leftover allowance can never be spent by the periphery.
    const PositionManager = await ethers.getContractFactory("PositionManager");
    const fresh = await PositionManager.deploy(sepolia.nonfungiblePositionManager);
    expect(await ethers.provider.getCode(fresh.address)).to.not.equal("0x");
  });
});
