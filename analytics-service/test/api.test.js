const request = require('supertest');
const app = require('../src/index');
const { expect } = require('chai');

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
});
