const request = require('supertest');
const express = require('express');
const routes = require('../../src/api/routes');
const { TEST_ACCOUNTS } = require('../utils/test-utils');
const sinon = require('sinon');
const { expect } = require('chai');

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

  before(async () => {
    mockServices = {
      dbService: {
        getTransactionsByTrader: sinon.stub().resolves(sampleTxs)
      },
      signatureUtils: { verifySignature: sinon.stub() },
      logger: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() },
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

  it('GET /api/history/trader/:address returns transactions', async () => {
    const res = await request(app)
      .get(`/api/history/trader/${traderAddr}`);

    expect(res.status).to.equal(200);
    expect(res.body.trader).to.equal(traderAddr);
    expect(res.body.transactions).to.be.an('array');
    expect(res.body.transactions[0].id).to.equal('tx1');
    expect(mockServices.dbService.getTransactionsByTrader.calledWith(traderAddr, { limit: 50, offset: 0 })).to.be.true;
  });

  it('GET /api/history with query params', async () => {
    mockServices.dbService.getTransactionsByTrader.resolves([]);
    const res = await request(app)
      .get(`/api/history/trader/${traderAddr}`)
      .query({ limit: 5, offset: 10, status: 'failed' });

    expect(res.status).to.equal(200);
    expect(res.body.count).to.equal(0);
    expect(mockServices.dbService.getTransactionsByTrader.calledWith(traderAddr, { limit: 5, offset: 10, status: 'failed' })).to.be.true;
  });

  it('GET /api/history returns 500 on service error', async () => {
    mockServices.dbService.getTransactionsByTrader.rejects(new Error('DB error'));
    const res = await request(app)
      .get(`/api/history/trader/${traderAddr}`);

    expect(res.status).to.equal(500);
    expect(res.body).to.have.property('error', 'Failed to retrieve transaction history');
  });
});
