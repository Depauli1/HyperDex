const request = require('supertest');
const express = require('express');
const routes = require('../../src/api/routes');

describe('Analytics API Integration', () => {
  let app, mockServices;

  beforeAll(() => {
    mockServices = {
      dbService: {
        getGasPriceHistory: jest.fn().mockResolvedValue([
          {
            networkName: 'sepolia',
            timestamp: new Date().toISOString(),
            baseGasPrice: '100',
            chainId: 11155111
          }
        ]),
        getUsageStats: jest.fn().mockResolvedValue([
          {
            timestamp: new Date().toISOString(),
            endpoint: '/api/swap/gasless',
            success: true,
            responseTimeMs: 150
          }
        ])
      },
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      signatureUtils: {},
      mempoolManager: {},
      contractService: {},
      nonceManager: {}
    };
    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  afterEach(() => jest.clearAllMocks());

  describe('GET /api/analytics/gas-prices', () => {
    test('returns default gas price history', async () => {
      const res = await request(app).get('/api/analytics/gas-prices');
      expect(res.status).toBe(200);
      expect(res.body.period).toHaveProperty('days', 7);
      expect(res.body.networks).toHaveProperty('sepolia');
      const param = mockServices.dbService.getGasPriceHistory.mock.calls[0][0];
      expect(param).toHaveProperty('startDate');
      expect(param).toHaveProperty('endDate');
      expect(param.networkName).toBeUndefined();
    });

    test('applies days and networkName query params', async () => {
      mockServices.dbService.getGasPriceHistory.mockResolvedValue([]);
      const res = await request(app)
        .get('/api/analytics/gas-prices')
        .query({ days: 3, networkName: 'sepolia' });
      expect(res.status).toBe(200);
      expect(res.body.period).toHaveProperty('days', 3);
      const param = mockServices.dbService.getGasPriceHistory.mock.calls[0][0];
      expect(param.networkName).toBe('sepolia');
    });

    test('handles service errors', async () => {
      mockServices.dbService.getGasPriceHistory.mockRejectedValueOnce(new Error('DB failure'));
      const res = await request(app).get('/api/analytics/gas-prices');
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error', 'Failed to retrieve gas price history');
    });
  });

  describe('GET /api/analytics/usage', () => {
    test('returns usage statistics', async () => {
      const res = await request(app).get('/api/analytics/usage');
      expect(res.status).toBe(200);
      expect(res.body.period).toHaveProperty('days', 7);
      expect(res.body).toHaveProperty('dailyStats');
      expect(res.body).toHaveProperty('endpointTotals');
      const param = mockServices.dbService.getUsageStats.mock.calls[0][0];
      expect(param).toHaveProperty('startDate');
      expect(param).toHaveProperty('endDate');
      expect(param.endpoint).toBeUndefined();
    });

    test('applies days and endpoint query params', async () => {
      mockServices.dbService.getUsageStats.mockResolvedValue([]);
      const res = await request(app)
        .get('/api/analytics/usage')
        .query({ days: 5, endpoint: '/api/health' });
      expect(res.status).toBe(200);
      expect(res.body.period).toHaveProperty('days', 5);
      const param = mockServices.dbService.getUsageStats.mock.calls[0][0];
      expect(param.endpoint).toBe('/api/health');
    });

    test('handles service errors', async () => {
      mockServices.dbService.getUsageStats.mockRejectedValueOnce(new Error('DB failure'));
      const res = await request(app).get('/api/analytics/usage');
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error', 'Failed to retrieve usage statistics');
    });
  });
});
