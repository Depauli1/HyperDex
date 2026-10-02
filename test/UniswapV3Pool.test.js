const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Q96,
  MIN_SQRT_RATIO,
  getSqrtRatioAtTick,
  getMinTick,
  getMaxTick,
  getAmount0Delta,
  getAmount1Delta,
  deployV3Stack,
} = require("./helpers/v3");

/**
 * Regression tests for the concentrated-liquidity math.
 *
 * HyperDex used to re-implement this in `HyperDexPool.sol`. The audit found the
 * direction inverted (C3), no fee ever charged (C4), the resulting price taken
 * from the caller (C5), tick accounting that only ever grew (C8), no tick
 * crossing (C9) and mis-scaled mint amounts (C10). That file is deleted. These
 * tests run against the audited `UniswapV3Pool` and assert against values
 * computed independently in `test/helpers/v3.js`, whose TickMath transcription
 * is itself checked against the on-chain implementation in
 * `test/TickMathReference.test.js`.
 */
describe("UniswapV3Pool concentrated-liquidity math", function () {
  const FEE = 500; // 0.05%
  const TICK_SPACING = 10;
  const SQRT_P0 = getSqrtRatioAtTick(0); // 2^96, the price the pool is initialised at
  const LIQUIDITY = 1000000000000000000n; // 1e18

  let stack, pool, callee, token0, token1, owner;

  beforeEach(async function () {
    stack = await deployV3Stack({ fee: FEE, tickSpacing: TICK_SPACING });
    ({ pool, callee, token0, token1, owner } = stack);

    await token0.approve(callee.address, ethers.constants.MaxUint256);
    await token1.approve(callee.address, ethers.constants.MaxUint256);
  });

  async function mintWide() {
    const tickLower = getMinTick(TICK_SPACING);
    const tickUpper = getMaxTick(TICK_SPACING);
    await callee.mint(pool.address, owner.address, tickLower, tickUpper, LIQUIDITY);
    return { tickLower, tickUpper };
  }

  /** Exact-input zeroForOne reference over a flat liquidity pool. */
  function referenceOut(amountIn, fee) {
    const effective = (amountIn * BigInt(1000000 - fee)) / 1000000n;
    const sqrtP1 =
      (LIQUIDITY * SQRT_P0 * Q96) / (LIQUIDITY * Q96 + effective * SQRT_P0);
    return {
      sqrtP1,
      amount1Out: (LIQUIDITY * (SQRT_P0 - sqrtP1)) / Q96,
    };
  }

  describe("C10 — mint amounts", function () {
    it("charges exactly the reference token amounts for a position", async function () {
      const tickLower = -TICK_SPACING * 5;
      const tickUpper = TICK_SPACING * 5;

      const tx = await callee.mint(
        pool.address,
        owner.address,
        tickLower,
        tickUpper,
        LIQUIDITY
      );
      const receipt = await tx.wait();
      // The Mint log comes from the pool, not the callee that sent the
      // transaction, so ethers leaves it unparsed in `receipt.events`.
      const mintEvent = receipt.logs
        .map((l) => {
          try {
            return pool.interface.parseLog({ topics: l.topics, data: l.data });
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "Mint");
      expect(mintEvent, "pool emitted no Mint event").to.not.be.undefined;

      // The position straddles the current price (tick 0), so the pool charges
      // token0 only for the part of the range ABOVE the price and token1 only
      // for the part below it. Charging the full range for both is exactly the
      // mistake the old `_calculateTokenAmounts` made.
      const sqrtLower = getSqrtRatioAtTick(tickLower);
      const sqrtCurrent = getSqrtRatioAtTick(0);
      const sqrtUpper = getSqrtRatioAtTick(tickUpper);
      const expected0 = getAmount0Delta(sqrtCurrent, sqrtUpper, LIQUIDITY, true);
      const expected1 = getAmount1Delta(sqrtLower, sqrtCurrent, LIQUIDITY, true);

      expect(expected0 > 0n && expected1 > 0n, "reference amounts are zero").to.be
        .true;
      expect(mintEvent.args.amount0.toBigInt()).to.equal(expected0);
      expect(mintEvent.args.amount1.toBigInt()).to.equal(expected1);
    });

    it("rejects a mint the caller cannot pay for", async function () {
      await token0.transfer(stack.other.address, await token0.balanceOf(owner.address));
      await expect(
        callee.mint(pool.address, owner.address, -TICK_SPACING * 5, TICK_SPACING * 5, LIQUIDITY)
      ).to.be.reverted;
    });
  });

  describe("C8 — tick accounting is reversible", function () {
    it("returns liquidity and tick state to zero after a burn", async function () {
      const { tickLower, tickUpper } = await mintWide();
      expect((await pool.liquidity()).toBigInt()).to.equal(LIQUIDITY);

      await pool.connect(owner).burn(tickLower, tickUpper, LIQUIDITY);

      expect((await pool.liquidity()).toBigInt()).to.equal(0n);

      const lower = await pool.ticks(tickLower);
      const upper = await pool.ticks(tickUpper);
      expect(lower.liquidityGross.toBigInt()).to.equal(0n);
      expect(upper.liquidityGross.toBigInt()).to.equal(0n);
      expect(lower.liquidityNet.toBigInt()).to.equal(0n);
      expect(upper.liquidityNet.toBigInt()).to.equal(0n);
    });
  });

  describe("C3 — swap direction", function () {
    it("moves token0 in and token1 out, and lowers the price", async function () {
      await mintWide();

      const trader = stack.trader;
      const amountIn = 1000000n;

      await token0.transfer(trader.address, amountIn);
      await token0.connect(trader).approve(callee.address, amountIn);

      const t0Before = await token0.balanceOf(trader.address);
      const t1Before = await token1.balanceOf(trader.address);
      const priceBefore = (await pool.slot0()).sqrtPriceX96.toBigInt();

      await callee
        .connect(trader)
        .swapExact0For1(pool.address, amountIn, trader.address, MIN_SQRT_RATIO + 1n);

      const t0After = (await token0.balanceOf(trader.address)).toBigInt();
      const t1After = (await token1.balanceOf(trader.address)).toBigInt();
      const priceAfter = (await pool.slot0()).sqrtPriceX96.toBigInt();

      expect(t0Before.toBigInt() - t0After).to.equal(amountIn);
      expect(t1After > t1Before.toBigInt(), "trader received no token1").to.be.true;
      expect(priceAfter < priceBefore, "price did not fall").to.be.true;
    });
  });

  describe("C4 — the swap fee is actually charged", function () {
    it("accrues fee growth and pays less than a feeless swap would", async function () {
      await mintWide();

      const trader = stack.trader;
      const amountIn = 1000000n;

      await token0.transfer(trader.address, amountIn);
      await token0.connect(trader).approve(callee.address, amountIn);
      const t1Before = (await token1.balanceOf(trader.address)).toBigInt();

      await callee
        .connect(trader)
        .swapExact0For1(pool.address, amountIn, trader.address, MIN_SQRT_RATIO + 1n);

      expect((await pool.feeGrowthGlobal0X128()).toBigInt() > 0n, "no fee accrued")
        .to.be.true;

      const withFee = referenceOut(amountIn, FEE).amount1Out;
      const noFee = referenceOut(amountIn, 0).amount1Out;
      const received = (await token1.balanceOf(trader.address)).toBigInt() - t1Before;

      expect(withFee < noFee, "reference says the fee has no effect").to.be.true;
      // The pool is the source of truth for exact rounding; allow a unit of it.
      expect(received).to.be.at.least(withFee - 2n);
      expect(received).to.be.at.most(withFee);
      // ...and the shortfall against a feeless swap is the fee.
      expect(noFee - received).to.be.at.least(490n);
      expect(noFee - received).to.be.at.most(510n);
    });
  });

  describe("C5 — the caller does not choose the resulting price", function () {
    it("reverts when the price limit cannot be honoured", async function () {
      await mintWide();

      const trader = stack.trader;
      const amountIn = 1000000n;
      await token0.transfer(trader.address, amountIn);
      await token0.connect(trader).approve(callee.address, amountIn);

      // A zeroForOne swap drives the price DOWN; demanding a limit above the
      // current price is rejected rather than silently accepted.
      await expect(
        callee
          .connect(trader)
          .swapExact0For1(pool.address, amountIn, trader.address, SQRT_P0 + 1n)
      ).to.be.revertedWith("SPL");
    });

    it("produces the same price for the same inputs regardless of the limit", async function () {
      const runSwap = async (limit) => {
        const s = await deployV3Stack({ fee: FEE, tickSpacing: TICK_SPACING });
        await s.token0.approve(s.callee.address, ethers.constants.MaxUint256);
        await s.token1.approve(s.callee.address, ethers.constants.MaxUint256);
        await s.callee.mint(
          s.pool.address,
          s.owner.address,
          getMinTick(TICK_SPACING),
          getMaxTick(TICK_SPACING),
          LIQUIDITY
        );
        await s.callee.swapExact0For1(s.pool.address, 1000000n, s.owner.address, limit);
        return (await s.pool.slot0()).sqrtPriceX96.toBigInt();
      };

      const a = await runSwap(MIN_SQRT_RATIO + 1n);
      const b = await runSwap(MIN_SQRT_RATIO + 1000n);
      expect(a).to.equal(b);

      // SwapMath rounds the price up when it is derived from the input amount,
      // so the pool lands one unit above the floored reference.
      const expected = referenceOut(1000000n, FEE).sqrtP1;
      expect(a - expected).to.be.at.least(0n);
      expect(a - expected).to.be.at.most(1n);
    });
  });

  describe("C9 — ticks are crossed", function () {
    it("activates and then deactivates a position as the price crosses it", async function () {
      const tickLower = -TICK_SPACING * 2; // -20
      const tickUpper = -TICK_SPACING; // -10

      await callee.mint(pool.address, owner.address, tickLower, tickUpper, LIQUIDITY);

      // The position sits below the current price (tick 0), so it is inactive.
      expect((await pool.liquidity()).toBigInt()).to.equal(0n);

      // A small swap with no active liquidity drives the price to the next
      // initialised tick, crossing `tickUpper` and activating the position.
      await callee.swapExact0For1(
        pool.address,
        1000000n,
        owner.address,
        MIN_SQRT_RATIO + 1n
      );

      let slot0 = await pool.slot0();
      expect(slot0.tick, "price did not move down").to.be.below(0);
      expect(slot0.tick, "price overshot the position").to.be.at.least(tickLower);
      expect((await pool.liquidity()).toBigInt(), "position not activated").to.equal(
        LIQUIDITY
      );

      // Now push the price out through the bottom of the range.
      await callee.swapExact0For1(
        pool.address,
        LIQUIDITY * 10n,
        owner.address,
        MIN_SQRT_RATIO + 1n
      );

      slot0 = await pool.slot0();
      expect(slot0.tick, "tickLower was never crossed").to.be.below(tickLower);
      expect((await pool.liquidity()).toBigInt(), "liquidity not removed").to.equal(0n);

      // Crossing direction is recorded on the ticks themselves.
      expect((await pool.ticks(tickUpper)).liquidityNet.toBigInt()).to.equal(-LIQUIDITY);
      expect((await pool.ticks(tickLower)).liquidityNet.toBigInt()).to.equal(LIQUIDITY);
    });
  });

  describe("factory analytics", function () {
    it("only the configured updater may record TVL", async function () {
      await expect(
        stack.hyperdexFactory
          .connect(stack.other)
          .updatePoolAnalytics(pool.address, 123n, 456n)
      ).to.be.revertedWithCustomError(stack.hyperdexFactory, "NotAnalyticsUpdater");
    });

    it("records TVL once an updater is set", async function () {
      await stack.hyperdexFactory.setAnalyticsUpdater(stack.owner.address);
      await stack.hyperdexFactory.updatePoolAnalytics(pool.address, 123n, 456n);

      const info = await stack.hyperdexFactory.getPoolInfo(
        await token0.address,
        await token1.address,
        FEE
      );
      expect(info.totalValueLocked.toBigInt()).to.equal(123n);
      expect(info.volume24h.toBigInt()).to.equal(456n);
    });

    it("rejects analytics for an unregistered pool", async function () {
      await stack.hyperdexFactory.setAnalyticsUpdater(stack.owner.address);
      await expect(
        stack.hyperdexFactory.updatePoolAnalytics(stack.other.address, 1n, 1n)
      ).to.be.revertedWithCustomError(stack.hyperdexFactory, "UnknownPool");
    });
  });
});
