const express = require('express');
const request = require('supertest');
const routes = require('../../src/api/routes');
const { RATE_LIMITS } = require('../../src/config/constants');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Rate Limiting Integration Tests', () => {
  let app;
  let mockServices;

  before(async () => {
    mockServices = {
      mempoolManager: {
        getTransactionStatus: sinon.stub().resolves({
          status: 'confirmed',
          txHash: '0x' + '1'.repeat(64),
          blockNumber: 1
        })
      },
      providerManager: {
        getHealthStatus: sinon.stub().resolves({ hasHealthyProvider: true, providers: [] }),
        executeWithProvider: sinon.stub().resolves(123)
      },
      dbService: {
        sequelize: { authenticate: sinon.stub().resolves() },
        getGasPriceHistory: sinon.stub().resolves([]),
        getUsageStats: sinon.stub().resolves([])
      },
      logger: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() },
      signatureUtils: {},
      contractService: {},
      nonceManager: {},
      wallet: {}
    };

    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  after(async () => {
    sinon.restore();
  });

  it('should include default rate limit headers on a default-limited endpoint', async () => {
    const txHash = '0x' + '1'.repeat(64);
    const res = await request(app).get(`/api/status/${txHash}`);
    expect(res.status).to.equal(200);
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    const remaining = parseInt(res.headers['ratelimit-remaining'], 10);
    expect(limit).to.equal(RATE_LIMITS.DEFAULT);
    expect(remaining).to.equal(limit - 1);
  });

  it('should include admin rate limit headers on an admin-limited endpoint', async () => {
    const res = await request(app).get('/api/analytics/usage');
    expect(res.status).to.equal(200);
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    const remaining = parseInt(res.headers['ratelimit-remaining'], 10);
    expect(limit).to.equal(RATE_LIMITS.ADMIN);
    expect(remaining).to.equal(limit - 1);
  });
});
