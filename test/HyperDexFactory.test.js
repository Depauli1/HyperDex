// HyperDexFactory: pool registry, protocol fees and analytics.
//
// The AMM under test is the vendored, audited Uniswap v3 core, deployed here
// exactly as production deploys it. There are no protocol doubles: every
// assertion below is made against a real `UniswapV3Pool` deployed by a real
// `UniswapV3Factory`, with real swaps and real token movements.
//
// The regression this pins down: `setProtocolFee` used to only write to the
// factory's own mapping and never told the pool, so no protocol fee was ever
// taken. The equivalent test against Uniswap's live Sepolia deployment is in
// test/fork/Sepolia.uniswap.fork.test.js.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const { getSqrtRatioAtTick, getMinTick, getMaxTick } = require("./helpers/v3");

const FEE = 3000;
const TICK_SPACING = 60;
const LIQUIDITY = 10n ** 18n;
const MAX_UINT128 = ethers.BigNumber.from(2).pow(128).sub(1);

// Deploys a fresh stack for every test.
//
// These files deliberately do NOT use `loadFixture`: its snapshot/revert
// machinery reverts the whole in-process chain to an older snapshot, which
// invalidates the state other test files are relying on (and, because
// CREATE addresses are deterministic, can leave them talking to contracts whose
// approvals have vanished). Re-running the deploy per test is cheap here.
async function fresh(fixture) {
  return fixture();
}

describe("HyperDexFactory", function () {
  async function deployFactoryFixture() {
    const [owner, updater, trader, recipient, other] = await ethers.getSigners();

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const supply = 2n ** 255n - 1n;
    const tokenA = await TestERC20.deploy(supply);
    const tokenB = await TestERC20.deploy(supply);
    await Promise.all([tokenA.deployed(), tokenB.deployed()]);

    const V3Factory = await ethers.getContractFactory("UniswapV3Factory");
    const v3Factory = await V3Factory.deploy();
    await v3Factory.deployed();

    const Factory = await ethers.getContractFactory("HyperDexFactory");
    const factory = await Factory.deploy(v3Factory.address);
    await factory.deployed();

    await v3Factory.setOwner(factory.address);

    return { factory, v3Factory, tokenA, tokenB, owner, updater, trader, recipient, other };
  }

  /** Creates a pool, initialises it at 1:1 and seeds full-range liquidity. */
  async function deployPoolFixture() {
    const base = await deployFactoryFixture();
    const { factory, tokenA, tokenB, owner } = base;

    await factory.createPool(tokenA.address, tokenB.address, FEE);
    const poolAddress = await factory.getPool(tokenA.address, tokenB.address, FEE);
    const pool = await ethers.getContractAt("UniswapV3Pool", poolAddress);
    await pool.initialize(getSqrtRatioAtTick(0));

    const Callee = await ethers.getContractFactory("TestUniswapV3Callee");
    const callee = await Callee.deploy();
    await callee.deployed();

    const token0 = (await pool.token0()) === tokenA.address ? tokenA : tokenB;
    const token1 = (await pool.token1()) === tokenA.address ? tokenA : tokenB;

    await token0.approve(callee.address, ethers.constants.MaxUint256);
    await token1.approve(callee.address, ethers.constants.MaxUint256);
    await callee.mint(
      poolAddress,
      owner.address,
      getMinTick(TICK_SPACING),
      getMaxTick(TICK_SPACING),
      LIQUIDITY
    );

    return { ...base, pool, callee, token0, token1, poolAddress };
  }

  describe("Pool registry", function () {
    it("creates pools through the v3 factory and registers them", async function () {
      const { factory, v3Factory, tokenA, tokenB } = await fresh(deployFactoryFixture);

      await expect(factory.createPool(tokenA.address, tokenB.address, FEE)).to.emit(
        factory,
        "PoolCreated"
      );

      const pool = await factory.getPool(tokenA.address, tokenB.address, FEE);
      expect(pool).to.equal(await v3Factory.getPool(tokenA.address, tokenB.address, FEE));
      expect(await factory.isPool(pool)).to.equal(true);
      expect(await factory.allPoolsLength()).to.equal(1);

      const info = await factory.getPoolInfo(tokenA.address, tokenB.address, FEE);
      expect(info.poolAddress).to.equal(pool);
      expect(info.enabled).to.equal(true);
    });

    it("returns an empty record for an unregistered pool", async function () {
      const { factory, tokenA, tokenB, other } = await fresh(deployFactoryFixture);
      const info = await factory.getPoolInfo(tokenA.address, tokenB.address, 10_000);
      expect(info.poolAddress).to.equal(ethers.constants.AddressZero);

      expect(await factory.isPool(other.address)).to.equal(false);
      expect(await factory.getProtocolFee(other.address)).to.equal(0);
    });

    it("rejects identical tokens, the zero address and unknown tiers", async function () {
      const { factory, tokenA, tokenB } = await fresh(deployFactoryFixture);
      await expect(factory.createPool(tokenA.address, tokenA.address, FEE)).to.be.revertedWithCustomError(
        factory,
        "IdenticalTokens"
      );
      await expect(
        factory.createPool(ethers.constants.AddressZero, tokenB.address, FEE)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.createPool(tokenA.address, tokenB.address, 1234)).to.be.revertedWithCustomError(
        factory,
        "UnsupportedFeeTier"
      );
    });

    it("only lets the owner enable fee tiers", async function () {
      const { factory, other } = await fresh(deployFactoryFixture);
      await expect(factory.connect(other).enableFeeAmount(100, 1)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
      await factory.enableFeeAmount(100, 1);
      expect(await factory.getPool(ethers.constants.AddressZero, ethers.constants.AddressZero, 100)).to.equal(
        ethers.constants.AddressZero
      );
    });
  });

  describe("Protocol fees", function () {
    it("applies the fee to the pool itself", async function () {
      const { factory, pool, poolAddress } = await fresh(deployPoolFixture);

      expect((await pool.slot0()).feeProtocol).to.equal(0);

      await factory.setProtocolFee(poolAddress, 5);

      // token0 and token1 denominators are packed into one byte: 0x55.
      expect((await pool.slot0()).feeProtocol).to.equal(0x55);
      expect(await factory.getProtocolFee(poolAddress)).to.equal(5);
    });

    it("applies the default fee when no controller is installed", async function () {
      const { factory, pool, poolAddress } = await fresh(deployPoolFixture);

      await factory.setDefaultProtocolFee(4);
      expect(await factory.pendingProtocolFee(poolAddress)).to.equal(4);

      await factory.applyProtocolFee(poolAddress);

      expect((await pool.slot0()).feeProtocol).to.equal(0x44);
      expect(await factory.getProtocolFee(poolAddress)).to.equal(4);
    });

    it("can switch the fee off again", async function () {
      const { factory, pool, poolAddress } = await fresh(deployPoolFixture);
      await factory.setProtocolFee(poolAddress, 5);
      await factory.setProtocolFee(poolAddress, 0);
      expect((await pool.slot0()).feeProtocol).to.equal(0);
    });

    it("rejects out-of-range denominators and pools it did not create", async function () {
      const { factory, poolAddress, other } = await fresh(deployPoolFixture);
      await expect(factory.setProtocolFee(poolAddress, 3)).to.be.revertedWithCustomError(
        factory,
        "InvalidProtocolFee"
      );
      await expect(factory.setProtocolFee(poolAddress, 11)).to.be.revertedWithCustomError(
        factory,
        "InvalidProtocolFee"
      );
      await expect(factory.setDefaultProtocolFee(3)).to.be.revertedWithCustomError(
        factory,
        "InvalidProtocolFee"
      );
      await expect(factory.setProtocolFee(other.address, 5)).to.be.revertedWithCustomError(
        factory,
        "UnknownPool"
      );
    });

    it("only lets the owner change the fee", async function () {
      const { factory, poolAddress, other } = await fresh(deployPoolFixture);
      await expect(factory.connect(other).setProtocolFee(poolAddress, 5)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
      await expect(factory.connect(other).setDefaultProtocolFee(5)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("accrues fees on a real swap and pays them to the recipient", async function () {
      const { factory, pool, poolAddress, callee, token0 } = await fresh(deployPoolFixture);
      const [, , trader, recipient] = await ethers.getSigners();

      await factory.setProtocolFee(poolAddress, 5);
      const before0 = await pool.protocolFees();
      expect(before0.token0).to.equal(0);

      // A zeroForOne swap spends token0, so the protocol's cut accrues in token0.
      await token0.transfer(trader.address, ethers.utils.parseEther("1"));
      await token0.connect(trader).approve(callee.address, ethers.constants.MaxUint256);
      await callee
        .connect(trader)
        .swapExact0For1(
          pool.address,
          ethers.utils.parseEther("0.5"),
          trader.address,
          getSqrtRatioAtTick(getMinTick(TICK_SPACING))
        );

      const accrued = await pool.protocolFees();
      expect(accrued.token0, "no protocol fee accrued on a real swap").to.be.greaterThan(0);

      const recipientBefore = await token0.balanceOf(recipient.address);
      const tx = await factory.collectProtocolFees(
        poolAddress,
        recipient.address,
        MAX_UINT128,
        MAX_UINT128
      );
      const receipt = await tx.wait();
      const collected = receipt.events.find((e) => e.event === "ProtocolFeesCollected");

      // v3 keeps one wei of the protocol fee behind when the whole balance is
      // collected, so the event's amount - not the accrued total - is what moves.
      expect(collected.args.amount0).to.equal(accrued.token0.sub(1));
      expect(await token0.balanceOf(recipient.address)).to.equal(
        recipientBefore.add(collected.args.amount0)
      );

      // v3 keeps a single wei back when the entire balance is collected, so the
      // pool is drained to at most that remainder.
      const drained = await pool.protocolFees();
      expect(drained.token0.add(drained.token1)).to.be.lte(1);
    });

    it("only lets the owner collect, and only for registered pools", async function () {
      const { factory, poolAddress, other } = await fresh(deployPoolFixture);
      await expect(
        factory.connect(other).collectProtocolFees(poolAddress, other.address, 1, 1)
      ).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(
        factory.collectProtocolFees(other.address, other.address, 1, 1)
      ).to.be.revertedWithCustomError(factory, "UnknownPool");
      await expect(
        factory.collectProtocolFees(poolAddress, ethers.constants.AddressZero, 1, 1)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("requires a policy before applying a fee", async function () {
      const { factory, poolAddress } = await fresh(deployPoolFixture);
      // No controller and no default: there is no policy to apply.
      await expect(factory.applyProtocolFee(poolAddress)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress"
      );
      await expect(
        factory.applyProtocolFee(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(factory, "UnknownPool");
    });
  });

  describe("Analytics", function () {
    it("only lets the configured updater record analytics", async function () {
      const { factory, poolAddress, token0, token1, updater, other } = await fresh(
        deployPoolFixture
      );

      await expect(
        factory.connect(updater).updatePoolAnalytics(poolAddress, 1, 1)
      ).to.be.revertedWithCustomError(factory, "NotAnalyticsUpdater");

      await factory.setAnalyticsUpdater(updater.address);
      await expect(
        factory.connect(other).updatePoolAnalytics(poolAddress, 1, 1)
      ).to.be.revertedWithCustomError(factory, "NotAnalyticsUpdater");

      await factory.connect(updater).updatePoolAnalytics(poolAddress, 1234, 5678);
      const info = await factory.getPoolInfo(token0.address, token1.address, FEE);
      expect(info.totalValueLocked).to.equal(1234);
      expect(info.volume24h).to.equal(5678);
    });

    it("refuses analytics for pools it did not create", async function () {
      const { factory, updater, other } = await fresh(deployPoolFixture);
      await factory.setAnalyticsUpdater(updater.address);
      await expect(
        factory.connect(updater).updatePoolAnalytics(other.address, 1, 1)
      ).to.be.revertedWithCustomError(factory, "UnknownPool");
    });

    it("requires a non-zero updater", async function () {
      const { factory } = await fresh(deployPoolFixture);
      await expect(
        factory.setAnalyticsUpdater(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });
});
