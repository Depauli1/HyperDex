const { ethers } = require('ethers');
// load env (if not loaded by caller)
require('dotenv').config();

const POOL_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const AGGREGATOR_ABI = [
  'function latestAnswer() view returns (int256)',
  'function decimals() view returns (uint8)'
];

/**
 * Parses `CHAINLINK_FEED_ADDRESSES` (comma separated).
 *
 * The service used to call `.split` on the raw environment variable at import
 * time, so simply requiring this module - or starting the HTTP server -
 * crashed unless every feed was configured. Feeds are optional now: without
 * them the oracle endpoint reports an empty map.
 *
 * @param {string} [value]
 * @returns {string[]}
 */
function parseFeedAddresses(value) {
  return (value || '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => ethers.utils.isAddress(address));
}

/**
 * Converts a v3 sqrt price into a human price (token1 per token0).
 *
 * sqrtPriceX96 encodes sqrt(token1/token0) in raw units, so the raw ratio is
 * scaled back by the token decimals to get a price a user would recognise.
 *
 * @param {ethers.BigNumber|string|bigint} sqrtPriceX96
 * @param {number} decimals0
 * @param {number} decimals1
 * @returns {number}
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const sqrt = BigInt(sqrtPriceX96.toString());
  const Q96 = 1n << 96n;

  // Scale by 1e18 to keep the integer division meaningful, then apply the
  // decimal adjustment (10^(dec0 - dec1)).
  const SCALE = 10n ** 18n;
  const rawPrice = (sqrt * sqrt * SCALE) / (Q96 * Q96);

  const decimalFactor = Number(decimals0) - Number(decimals1);
  const scaled = Number(rawPrice) / 1e18;
  return scaled * Math.pow(10, decimalFactor);
}

/**
 * Derives the metrics for one observed swap.
 *
 * All three numbers are computed from the swap itself rather than from
 * hand-written constants:
 *
 *  - `executionPrice` is what the trader actually paid (quote per base).
 *  - `marginalPrice` is the pool price *after* the swap.
 *  - `priceImpact` is how far the execution price deviated from it, in percent.
 *    That deviation is the realised slippage cost of the swap, so `slippage`
 *    reports the same quantity in basis points instead of a fabricated fraction
 *    of the impact.
 *  - `efficiency` is the notional the swap moved per unit of in-range
 *    liquidity: a utilisation ratio (higher means the trade consumed available
 *    liquidity more efficiently). It is not a measure of capital efficiency
 *    versus a full-range AMM, and is documented as such.
 *
 * @param {Object} swap { amount0, amount1, sqrtPriceX96, liquidity }
 * @param {{decimals0: number, decimals1: number}} tokens
 * @returns {{price: number, executionPrice: number, priceImpact: number,
 *            slippage: number, efficiency: number, volume: number}}
 */
function computeSwapMetrics(swap, { decimals0 = 18, decimals1 = 18 } = {}) {
  const amount0 = Number(ethers.utils.formatUnits(swap.amount0, decimals0));
  const amount1 = Number(ethers.utils.formatUnits(swap.amount1, decimals1));

  const price = sqrtPriceX96ToPrice(swap.sqrtPriceX96, decimals0, decimals1);

  // Token0 in, token1 out means amount0 > 0 and amount1 < 0 (and vice versa).
  const baseAmount = Math.abs(amount0);
  const quoteAmount = Math.abs(amount1);

  const executionPrice = baseAmount === 0 ? 0 : quoteAmount / baseAmount;
  const priceImpact =
    price === 0 ? 0 : ((executionPrice - price) / price) * 100;

  const liquidity = Number(swap.liquidity.toString());
  const volume = quoteAmount;

  return {
    price,
    executionPrice,
    priceImpact,
    slippage: Math.abs(priceImpact) * 100, // percent -> basis points
    efficiency: liquidity === 0 ? 0 : volume / liquidity,
    volume
  };
}

let provider;
let poolContract;
let aggregatorContracts = [];
let tokenDecimals = { decimals0: 18, decimals1: 18 };
let metricsState = {
  lastPrice: null,
  priceImpact: null,
  slippage: null,
  efficiency: null,
  volume: null,
  aggregatorPrices: {}
};

/**
 * Subscribes to Swap events and publishes metrics over socket.io.
 *
 * @param {import('socket.io').Server} io
 * @param {Object} [config] optional overrides (used by tests)
 * @returns {{provider: ethers.providers.Provider, pool: string, feeds: string[]}|null}
 */
const start = async (io, config = {}) => {
  const poolAddress = config.poolAddress || process.env.POOL_ADDRESS;
  const providerUrl = config.providerUrl || process.env.PROVIDER_URL;
  const feedAddresses = config.feedAddresses || parseFeedAddresses(process.env.CHAINLINK_FEED_ADDRESSES);

  if (!poolAddress || !ethers.utils.isAddress(poolAddress)) {
    throw new Error('POOL_ADDRESS must be a valid Uniswap v3 pool address');
  }
  if (!providerUrl) {
    throw new Error('PROVIDER_URL is required to watch pool events');
  }

  provider = new ethers.providers.JsonRpcProvider(providerUrl);
  poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
  aggregatorContracts = feedAddresses.map(
    (address) => new ethers.Contract(address, AGGREGATOR_ABI, provider)
  );

  // Read the token decimals once; the swap math needs them.
  try {
    const [token0, token1] = await Promise.all([poolContract.token0(), poolContract.token1()]);
    const [d0, d1] = await Promise.all([
      new ethers.Contract(token0, ERC20_DECIMALS_ABI, provider).decimals(),
      new ethers.Contract(token1, ERC20_DECIMALS_ABI, provider).decimals()
    ]);
    tokenDecimals = { decimals0: Number(d0), decimals1: Number(d1) };
  } catch (error) {
    // Fall back to 18/18 rather than refusing to report anything.
    tokenDecimals = { decimals0: 18, decimals1: 18 };
  }

  poolContract.on('Swap', async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
    try {
      const computed = computeSwapMetrics(
        { amount0, amount1, sqrtPriceX96, liquidity },
        tokenDecimals
      );

      // One unreachable feed must not lose the whole update.
      const aggregatorPrices = {};
      await Promise.all(
        aggregatorContracts.map(async (contract, index) => {
          try {
            const [answer, decimals] = await Promise.all([
              contract.latestAnswer(),
              contract.decimals().catch(() => 8)
            ]);
            aggregatorPrices[feedAddresses[index]] = Number(answer) / 10 ** Number(decimals);
          } catch (error) {
            aggregatorPrices[feedAddresses[index]] = null;
          }
        })
      );

      metricsState = {
        lastPrice: computed.price,
        priceImpact: computed.priceImpact,
        slippage: computed.slippage,
        efficiency: computed.efficiency,
        volume: computed.volume,
        aggregatorPrices
      };

      io.emit('metrics', metricsState);
      io.emit('swap', {
        sender,
        recipient,
        price: computed.price,
        executionPrice: computed.executionPrice,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        liquidity: liquidity.toString(),
        tick
      });
    } catch (error) {
      // Never let a malformed event kill the subscription.
      console.error('Failed to process Swap event:', error.message);
    }
  });

  console.log('Subscribed to Swap events on', poolAddress);
  return { provider, pool: poolAddress, feeds: feedAddresses };
};

const getMetrics = () => metricsState;

/** Stops the subscription and detaches listeners. */
const stop = () => {
  if (poolContract && poolContract.removeAllListeners) {
    poolContract.removeAllListeners('Swap');
  }
  if (provider && provider.removeAllListeners) {
    provider.removeAllListeners();
  }
  poolContract = null;
};

module.exports = {
  start,
  stop,
  getMetrics,
  computeSwapMetrics,
  sqrtPriceX96ToPrice,
  parseFeedAddresses
};
