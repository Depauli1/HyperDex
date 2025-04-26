const express = require('express');
const request = require('supertest');
const routes = require('../../src/api/routes');
const { RATE_LIMITS } = require('../../src/config/constants');

describe('Rate Limiting Integration Tests', () => {
  let app;
  let mockServices;

  beforeAll(() => {
    mockServices = {
      mempoolManager: {
        getTransactionStatus: jest.fn().mockResolvedValue({
          status: 'confirmed',
          txHash: '0x' + '1'.repeat(64),
          blockNumber: 1
        })
      },
      providerManager: {
        getHealthStatus: jest.fn().mockResolvedValue({ hasHealthyProvider: true, providers: [] }),
        executeWithProvider: jest.fn().mockResolvedValue(123)
      },
      dbService: {
        sequelize: { authenticate: jest.fn().mockResolvedValue() },
        getGasPriceHistory: jest.fn().mockResolvedValue([]),
        getUsageStats: jest.fn().mockResolvedValue([])
      },
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      signatureUtils: {},
      contractService: {},
      nonceManager: {},
      wallet: {}
    };

    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  it('should include default rate limit headers on a default-limited endpoint', async () => {
    const txHash = '0x' + '1'.repeat(64);
    const res = await request(app).get(`/api/status/${txHash}`);
    expect(res.status).toBe(200);
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    const remaining = parseInt(res.headers['ratelimit-remaining'], 10);
    expect(limit).toBe(RATE_LIMITS.DEFAULT);
    expect(remaining).toBe(limit - 1);
  });

  it('should include admin rate limit headers on an admin-limited endpoint', async () => {
    const res = await request(app).get('/api/analytics/usage');
    expect(res.status).toBe(200);
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    const remaining = parseInt(res.headers['ratelimit-remaining'], 10);
    expect(limit).toBe(RATE_LIMITS.ADMIN);
    expect(remaining).toBe(limit - 1);
  });
});
