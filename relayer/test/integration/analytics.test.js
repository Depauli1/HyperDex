const request = require('supertest');
const express = require('express');
const routes = require('../../src/api/routes');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Analytics API Integration', () => {
  let app, mockServices;

  before(async () => {
    mockServices = {
      dbService: {
        getGasPriceHistory: sinon.stub().resolves([
          {
            networkName: 'sepolia',
            timestamp: new Date().toISOString(),
            baseGasPrice: '100',
            chainId: 11155111
          }
        ]),
        getUsageStats: sinon.stub().resolves([
          {
            timestamp: new Date().toISOString(),
            endpoint: '/api/swap/gasless',
            success: true,
            responseTimeMs: 150
          }
        ])
      },
      logger: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() },
      signatureUtils: {},
      mempoolManager: {},
      contractService: {},
      nonceManager: {}
    };
    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  after(async () => {
    sinon.restore();
  });

  describe('GET /api/analytics/gas-prices', () => {
    afterEach(() => {
      sinon.resetHistory();
    });

    it('returns default gas price history', async () => {
      const res = await request(app).get('/api/analytics/gas-prices');
      expect(res.status).to.equal(200);
      expect(res.body.period).to.have.property('days', 7);
      expect(res.body.networks).to.have.property('sepolia');
      const param = mockServices.dbService.getGasPriceHistory.args[0][0];
      expect(param).to.have.property('startDate');
      expect(param).to.have.property('endDate');
      expect(param.networkName).to.be.undefined;
    });

    it('applies days and networkName query params', async () => {
      mockServices.dbService.getGasPriceHistory.resolves([]);
      const res = await request(app)
        .get('/api/analytics/gas-prices')
        .query({ days: 3, networkName: 'sepolia' });
      expect(res.status).to.equal(200);
      expect(res.body.period).to.have.property('days', 3);
      const param = mockServices.dbService.getGasPriceHistory.args[0][0];
      expect(param.networkName).to.equal('sepolia');
    });

    it('handles service errors', async () => {
      mockServices.dbService.getGasPriceHistory.rejects(new Error('DB failure'));
      const res = await request(app).get('/api/analytics/gas-prices');
      expect(res.status).to.equal(500);
      expect(res.body).to.have.property('error', 'Failed to retrieve gas price history');
    });
  });

  describe('GET /api/analytics/usage', () => {
    afterEach(() => {
      sinon.resetHistory();
    });

    it('returns usage statistics', async () => {
      const res = await request(app).get('/api/analytics/usage');
      expect(res.status).to.equal(200);
      expect(res.body.period).to.have.property('days', 7);
      expect(res.body).to.have.property('dailyStats');
      expect(res.body).to.have.property('endpointTotals');
      const param = mockServices.dbService.getUsageStats.args[0][0];
      expect(param).to.have.property('startDate');
      expect(param).to.have.property('endDate');
      expect(param.endpoint).to.be.undefined;
    });

    it('applies days and endpoint query params', async () => {
      mockServices.dbService.getUsageStats.resolves([]);
      const res = await request(app)
        .get('/api/analytics/usage')
        .query({ days: 5, endpoint: '/api/health' });
      expect(res.status).to.equal(200);
      expect(res.body.period).to.have.property('days', 5);
      const param = mockServices.dbService.getUsageStats.args[0][0];
      expect(param.endpoint).to.equal('/api/health');
    });

    it('handles service errors', async () => {
      mockServices.dbService.getUsageStats.rejects(new Error('DB failure'));
      const res = await request(app).get('/api/analytics/usage');
      expect(res.status).to.equal(500);
      expect(res.body).to.have.property('error', 'Failed to retrieve usage statistics');
    });
  });
});
