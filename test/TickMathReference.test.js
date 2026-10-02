const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSqrtRatioAtTick } = require("./helpers/v3");

describe("JS TickMath vs on-chain TickMath", function () {
  it("agrees across a sweep of ticks", async function () {
    const F = await ethers.getContractFactory("TickMathTest");
    const tm = await F.deploy();
    const ticks = [0, 1, -1, 2, -2, 50, -50, 1000, -1000, 887272, -887272,
      3, 7, 15, 255, 1023, 4095, 65535, 524287];
    let mismatches = 0;
    for (const t of ticks) {
      const onchain = (await tm.getSqrtRatioAtTick(t)).toBigInt();
      const js = getSqrtRatioAtTick(t);
      if (onchain !== js) { mismatches++; console.log("MISMATCH tick", t, "onchain", onchain.toString(), "js", js.toString()); }
    }
    // The boundary ticks must land exactly on the documented extremes.
    expect(getSqrtRatioAtTick(-887272)).to.equal((await tm.MIN_SQRT_RATIO()).toBigInt());
    expect(getSqrtRatioAtTick(887272)).to.equal((await tm.MAX_SQRT_RATIO()).toBigInt());

    expect(mismatches, "JS TickMath disagrees with the on-chain implementation")
      .to.equal(0);
  });
});
