// Shared helpers for exercising real Uniswap v3 pools in tests.
//
// The price/amount functions below are a direct transcription of the reference
// implementation in Uniswap v3's `TickMath` and `SqrtPriceMath`, so tests can
// assert on independently computed values rather than on whatever the pool
// happens to return.

const { ethers } = require("hardhat");

const Q96 = 2n ** 96n;
const Q32 = 2n ** 32n;
const MAX_UINT160_MINUS_1 = 2n ** 160n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO =
  1461446703485210103287273052203988822378723970342n;

// The magic constants below are Q128 fixed-point, so a multiply has to be
// shifted back down by 128 fractional bits.
const mulShift = (val, mulBy) => (val * BigInt(mulBy)) >> 128n;

/** Transcription of TickMath.getSqrtRatioAtTick. */
function getSqrtRatioAtTick(tick) {
  const absTick = tick < 0 ? -tick : tick;
  if (absTick > 887272) throw new Error("TICK_BOUND");

  let ratio =
    (absTick & 0x1) !== 0
      ? BigInt("0xfffcb933bd6fad37aa2d162d1a594001")
      : BigInt("0x100000000000000000000000000000000");
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, "0xfff97272373d413259a46990580e213a");
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, "0xfff2e50f5f656932ef12357cf3c7fdcc");
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, "0xffe5caca7e10e4e61c3624eaa0941cd0");
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, "0xffcb9843d60f6159c9db58835c926644");
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, "0xff973b41fa98c081472e6896dfb254c0");
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, "0xff2ea16466c96a3843ec78b326b52861");
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, "0xfe5dee046a99a2a811c461f1969c3053");
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, "0xfcbe86c7900a88aedcffc83b479aa3a4");
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, "0xf987a7253ac413176f2b074cf7815e54");
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, "0xf3392b0822b70005940c7a398e4b70f3");
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, "0xe7159475a2c29b7443b29c7fa6e889d9");
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, "0xd097f3bdfd2022b8845ad8f792aa5825");
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, "0xa9f746462d870fdf8a65dc1f90e061e5");
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, "0x70d869a156d2a1b890bb3df62baf32f7");
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, "0x31be135f97d08fd981231505542fcfa6");
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, "0x9aa508b5b7a84e1c677de54f3e99bc9");
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, "0x5d6af8dedb81196699c329225ee604");
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, "0x2216e584f5fa1ea926041bedfe98");
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, "0x48a170391f7dc42444e8fa2");

  if (tick > 0) ratio = UINT256_MAX / ratio + 1n;

  // Q128 -> Q96, rounding up.
  if (ratio % Q32 > 0n) return ratio / Q32 + 1n;
  return ratio / Q32;
}

const getMinTick = (spacing) => Math.ceil(-887272 / spacing) * spacing;
const getMaxTick = (spacing) => Math.floor(887272 / spacing) * spacing;

/** Transcription of SqrtPriceMath.getAmount0Delta. */
function getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  // FullMath.mulDiv floors here; the round-up is applied to the OUTER division
  // by sqrtRatioAX96 (UnsafeMath.divRoundingUp), not to the inner one.
  const inner = (numerator1 * numerator2) / sqrtRatioBX96;
  if (roundUp) {
    return inner / sqrtRatioAX96 + (inner % sqrtRatioAX96 === 0n ? 0n : 1n);
  }
  return inner / sqrtRatioAX96;
}

/** Transcription of SqrtPriceMath.getAmount1Delta. */
function getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const product = liquidity * (sqrtRatioBX96 - sqrtRatioAX96);
  if (roundUp) {
    return product % Q96 === 0n ? product / Q96 : product / Q96 + 1n;
  }
  return product / Q96;
}

/** Price of token0 expressed in token1, as a JS number (for display only). */
function priceOf(sqrtPriceX96) {
  return Number((sqrtPriceX96 * sqrtPriceX96) / (2n ** 192n)) / 1;
}

/**
 * Deploys the full HyperDex stack on real Uniswap v3 core:
 * tokens -> UniswapV3Factory (fee tiers enabled) -> HyperDexFactory -> pool -> HyperDex.
 */
async function deployV3Stack({ fee = 500, tickSpacing = 10, initializeAtTick = 0 } = {}) {
  const [owner, relayer, trader, other] = await ethers.getSigners();

  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const supply = 2n ** 255n - 1n;
  const tokenA = await TestERC20.deploy(supply);
  const tokenB = await TestERC20.deploy(supply);

  const sort = [tokenA.address, tokenB.address].sort();
  const [token0Addr, token1Addr] = sort;
  const token0 = token0Addr === (tokenA.address) ? tokenA : tokenB;
  const token1 = token1Addr === (tokenA.address) ? tokenA : tokenB;

  const V3Factory = await ethers.getContractFactory("UniswapV3Factory");
  const v3Factory = await V3Factory.deploy();
  // The v3 factory constructor already enables the 500/10, 3000/60 and
  // 10000/200 tiers, so nothing needs enabling here.

  const HyperDexFactory = await ethers.getContractFactory("HyperDexFactory");
  const hyperdexFactory = await HyperDexFactory.deploy(v3Factory.address);

  // Hand fee-tier management to the HyperDex registry.
  await v3Factory.setOwner(hyperdexFactory.address);

  await hyperdexFactory.createPool(token0Addr, token1Addr, fee);
  const poolAddr = await hyperdexFactory.getPool(token0Addr, token1Addr, fee);
  const pool = await ethers.getContractAt("UniswapV3Pool", poolAddr);

  const sqrtPriceX96 = getSqrtRatioAtTick(initializeAtTick);
  await pool.initialize(sqrtPriceX96);

  const Callee = await ethers.getContractFactory("TestUniswapV3Callee");
  const callee = await Callee.deploy();

  const HyperDex = await ethers.getContractFactory("HyperDex");
  const hyperdex = await HyperDex.deploy(hyperdexFactory.address);
  await hyperdex.setRelayer(relayer.address);

  return {
    owner,
    relayer,
    trader,
    other,
    tokenA,
    tokenB,
    token0,
    token1,
    v3Factory,
    hyperdexFactory,
    pool,
    callee,
    hyperdex,
    fee,
    tickSpacing,
  };
}

module.exports = {
  Q96,
  MAX_UINT160_MINUS_1,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  getSqrtRatioAtTick,
  getMinTick,
  getMaxTick,
  getAmount0Delta,
  getAmount1Delta,
  priceOf,
  deployV3Stack,
};
