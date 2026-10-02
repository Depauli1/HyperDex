const request = require('supertest');
const app = require('../src/index');
const { expect } = require('chai');
const {
  computeSwapMetrics,
  sqrtPriceX96ToPrice,
  parseFeedAddresses
} = require('../src/services/chainEvents');
const { ethers } = require('ethers');

const Q96 = 2n ** 96n;

describe('Analytics Service Metrics API', () => {
  it('should return priceImpact', async () => {
    const res = await request(app).get('/metrics/price-impact');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('priceImpact');
  });

  it('should return slippage', async () => {
    const res = await request(app).get('/metrics/slippage');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('slippage');
  });

  it('should return efficiency', async () => {
    const res = await request(app).get('/metrics/efficiency');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('efficiency');
  });

  it('should return oracle-prices', async () => {
    const res = await request(app).get('/metrics/oracle-prices');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('aggregatorPrices');
    expect(res.body.aggregatorPrices).to.be.an('object');
  });

  it('should answer health checks', async () => {
    const res = await request(app).get('/health');
    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal('ok');
  });
});

describe('Swap metric derivation', () => {
  it('converts a sqrt price into a human price', () => {
    // price = 1 (sqrtPriceX96 = 2^96) for two 18-decimal tokens.
    expect(sqrtPriceX96ToPrice(Q96.toString(), 18, 18)).to.be.closeTo(1, 1e-9);

    // price = 4 for two 18-decimal tokens (sqrtPriceX96 = 2 * 2^96).
    expect(sqrtPriceX96ToPrice((2n * Q96).toString(), 18, 18)).to.be.closeTo(4, 1e-9);

    // USDC (6dp) / WETH (18dp) style pair: one raw unit ratio needs the
    // decimal adjustment, 10^(6-18).
    const price = sqrtPriceX96ToPrice((2n * Q96).toString(), 6, 18);
    expect(price).to.be.closeTo(4e-12, 1e-18);
  });

  it('derives impact, slippage and utilisation from the swap itself', () => {
    const metrics = computeSwapMetrics(
      {
        // Selling 1 token0 for 0.99 token1 while the post-swap pool price is 1.
        amount0: ethers.utils.parseEther('1'),
        amount1: ethers.utils.parseEther('-0.99'),
        sqrtPriceX96: Q96.toString(),
        liquidity: 1_000_000
      },
      { decimals0: 18, decimals1: 18 }
    );

    expect(metrics.price).to.be.closeTo(1, 1e-9);
    expect(metrics.executionPrice).to.be.closeTo(0.99, 1e-9);
    expect(metrics.priceImpact).to.be.closeTo(-1, 1e-9); // 1% below the pool price
    expect(metrics.slippage).to.be.closeTo(100, 1e-6); // in basis points
    expect(metrics.efficiency).to.be.closeTo(0.99 / 1_000_000, 1e-15);
    expect(metrics.volume).to.be.closeTo(0.99, 1e-9);
  });

  it('handles a zero-liquidity swap without dividing by zero', () => {
    const metrics = computeSwapMetrics(
      {
        amount0: ethers.utils.parseEther('1'),
        amount1: ethers.utils.parseEther('-1'),
        sqrtPriceX96: Q96.toString(),
        liquidity: 0
      },
      { decimals0: 18, decimals1: 18 }
    );
    expect(metrics.efficiency).to.equal(0);
    expect(Number.isFinite(metrics.priceImpact)).to.equal(true);
  });

  it('treats Chainlink feeds as optional', () => {
    expect(parseFeedAddresses(undefined)).to.deep.equal([]);
    expect(parseFeedAddresses('')).to.deep.equal([]);
    expect(parseFeedAddresses('not-an-address, 0x1234')).to.deep.equal([]);
    expect(
      parseFeedAddresses('0x694AA1769357215DE4FAC081bf1f309aDC325306')
    ).to.deep.equal(['0x694AA1769357215DE4FAC081bf1f309aDC325306']);
  });
});
