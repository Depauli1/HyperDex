const { ethers } = require('ethers');
// load env (if not loaded by caller)
require('dotenv').config();

const UNISWAP_V3_POOL_ADDRESS = process.env.POOL_ADDRESS;
const PROVIDER_URL = process.env.PROVIDER_URL;
const CHAINLINK_FEED_ADDRESSES = process.env.CHAINLINK_FEED_ADDRESSES.split(',').map(s => s.trim());

const aggregatorAbi = ["function latestAnswer() view returns (int256)"];

let provider;
let poolContract;
let aggregatorContracts = [];
let metricsState = {
  lastPrice: null,
  priceImpact: null,
  slippage: null,
  efficiency: null,
  aggregatorPrices: {},
};

const start = (io) => {
  provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);
  // instantiate aggregator contracts for all feeds
  aggregatorContracts = CHAINLINK_FEED_ADDRESSES.map(addr => new ethers.Contract(addr, aggregatorAbi, provider));
  const abi = [
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
  ];
  poolContract = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, abi, provider);

  poolContract.on('Swap', async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
    const price = (BigInt(sqrtPriceX96) ** 2n) / (1n << 192n);
    const executionPrice = Number(amount1) / Number(amount0);
    const priceImpact = ((executionPrice - Number(price)) / Number(price)) * 100;
    const slippage = priceImpact * 0.1; // placeholder
    const efficiency = Number(liquidity) / 1000000; // placeholder
    // fetch all oracle prices
    const answers = await Promise.all(aggregatorContracts.map(c => c.latestAnswer()));
    const aggregatorPrices = {};
    CHAINLINK_FEED_ADDRESSES.forEach((addr, idx) => {
      aggregatorPrices[addr] = Number(answers[idx]) / 1e8;
    });
    metricsState = { lastPrice: Number(price), priceImpact, slippage, efficiency, aggregatorPrices };
    io.emit('metrics', metricsState);
    const swapData = {
      price: Number(price),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      liquidity: liquidity.toString(),
      tick
    };
    io.emit('swap', swapData);
  });

  console.log('Subscribed to Swap events on', UNISWAP_V3_POOL_ADDRESS);
};

const getMetrics = () => metricsState;

module.exports = { start, getMetrics };
