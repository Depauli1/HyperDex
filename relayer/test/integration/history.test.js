const request = require('supertest');
const express = require('express');
const routes = require('../../src/api/routes');
const { TEST_ACCOUNTS } = require('../utils/test-utils');

describe('Transaction History API Integration', () => {
  let app, mockServices;
  const traderAddr = TEST_ACCOUNTS.trader.address;
  const sampleTxs = [{
    id: 'tx1',
    poolAddress: '0xPool',
    amountSpecified: '1000',
    zeroForOne: true,
    status: 'submitted',
    transactionHash: '0xHash',
    blockNumber: 123,
    gasPrice: '20000000000',
    gasUsed: '21000',
    createdAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString()
  }];

  beforeAll(() => {
    mockServices = {
      dbService: {
        getTransactionsByTrader: jest.fn().mockResolvedValue(sampleTxs)
      },
      signatureUtils: { verifySignature: jest.fn() },
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      mempoolManager: {},
      contractService: {},
      nonceManager: {}
    };
    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  afterEach(() => jest.clearAllMocks());

  test('GET /api/history/trader/:address returns transactions', async () => {
    const res = await request(app)
      .get(`/api/history/trader/${traderAddr}`);

    expect(res.status).toBe(200);
    expect(res.body.trader).toBe(traderAddr);
    expect(Array.isArray(res.body.transactions)).toBe(true);
    expect(res.body.transactions[0].id).toBe('tx1');
    expect(mockServices.dbService.getTransactionsByTrader)
      .toHaveBeenCalledWith(traderAddr, { limit: 50, offset: 0 });
  });

  test('GET /api/history with query params', async () => {
    mockServices.dbService.getTransactionsByTrader.mockResolvedValue([]);
    const res = await request(app)
      .get(`/api/history/trader/${traderAddr}`)
      .query({ limit: 5, offset: 10, status: 'failed' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(mockServices.dbService.getTransactionsByTrader)
      .toHaveBeenCalledWith(traderAddr, { limit: 5, offset: 10, status: 'failed' });
  });

  test('GET /api/history returns 500 on service error', async () => {
    mockServices.dbService.getTransactionsByTrader.mockRejectedValueOnce(new Error('DB error'));
    const res = await request(app)
      .get(`/api/history/trader/${traderAddr}`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error', 'Failed to retrieve transaction history');
  });
});
