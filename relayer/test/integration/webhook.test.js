const request = require('supertest');
const express = require('express');
const routes = require('../../src/api/routes');
const { expect } = require('chai');
const { TEST_ACCOUNTS } = require('../utils/test-utils');
const sinon = require('sinon');

describe('Webhook API Integration', () => {
  let app, mockServices;
  const traderAddr = TEST_ACCOUNTS.trader.address;

  before(async () => {
    mockServices = {
      dbService: {
        registerWebhook: sinon.stub().resolves({ 
          id: 'uuid-1',
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted,swap_confirmed',
          active: true,
          createdAt: new Date().toISOString()
        }),
        getWebhooks: sinon.stub().resolves([{ 
          id: 'uuid-1',
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted,swap_confirmed',
          active: true,
          createdAt: new Date().toISOString()
        }]),
        getWebhook: sinon.stub().resolves({
          id: 'uuid-1',
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted,swap_confirmed',
          active: true,
          updatedAt: new Date().toISOString()
        }),
        updateWebhook: sinon.stub().callsFake((id, data) => Promise.resolve({
          id,
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted',
          active: data.active,
          updatedAt: new Date().toISOString()
        })),
        verifyAuthToken: sinon.stub()
      },
      signatureUtils: {
        verifySignature: sinon.stub().resolves(true)
      },
      logger: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub()
      }
    };
    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  beforeEach(() => {
    if (mockServices.dbService.verifyAuthToken) {
      mockServices.dbService.verifyAuthToken.resolves('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    }
    // Reset signature stub to valid by default
    mockServices.signatureUtils.verifySignature.resolves(true);
  });

  after(async () => {
    sinon.restore();
  });

  describe('POST /api/webhooks/register', () => {
    afterEach(() => {
      sinon.resetHistory();
    });

    it('should register a webhook successfully', async () => {
      const payload = {
        trader: traderAddr,
        callbackUrl: 'http://example.com/webhook',
        events: ['swap_submitted'],
        signature: '0xSignature'
      };
      const res = await request(app)
        .post('/api/webhooks/register')
        .send(payload);
      expect(res.status).to.equal(201);
      expect(res.body).to.have.property('id');
      expect(res.body.trader).to.equal(traderAddr);
      expect(res.body.events).to.be.an('array');
      expect(mockServices.dbService.registerWebhook.callCount).to.equal(1);
    });

    it('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/webhooks/register')
        .send({});
      expect(res.status).to.equal(400);
      expect(res.body).to.have.property('error');
    });

    it('should reject invalid signature', async () => {
      mockServices.signatureUtils.verifySignature.resolves(false);
      const payload = {
        trader: traderAddr,
        callbackUrl: 'http://example.com/webhook',
        events: ['swap_submitted'],
        signature: '0xBad'
      };
      const res = await request(app)
        .post('/api/webhooks/register')
        .send(payload);
      expect(res.status).to.equal(401);
    });
  });

  describe('GET /api/webhooks/trader/:address', () => {
    it('should return webhooks for trader', async () => {
      const res = await request(app)
        .get(`/api/webhooks/trader/${traderAddr}`);
      expect(res.status).to.equal(200);
      expect(res.body.trader).to.equal(traderAddr);
      expect(res.body.webhooks).to.be.an('array');
      expect(mockServices.dbService.getWebhooks.callCount).to.equal(1);
      expect(mockServices.dbService.getWebhooks.calledWith(traderAddr, true)).to.be.true;
    });
  });

  describe('PUT /api/webhooks/:id', () => {
    it('should update webhook status', async () => {
      // Ensure signature and auth mocks pass for this test
      mockServices.signatureUtils.verifySignature.returns(true);
      if (mockServices.dbService.verifyAuthToken) {
        mockServices.dbService.verifyAuthToken.resolves('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
      }
      const validAuthHeader = 'Bearer testtoken';
      const payload = { trader: traderAddr, active: false, signature: '0xSignature' };
      const res = await request(app)
        .put('/api/webhooks/uuid-1')
        .set('Authorization', validAuthHeader)
        .send(payload);
      expect(res.status).to.equal(200);
      expect(res.body.active).to.be.false;
      expect(mockServices.dbService.updateWebhook.callCount).to.equal(1);
      expect(mockServices.dbService.updateWebhook.calledWith('uuid-1', { active: false })).to.be.true;
    });

    it('should reject update if not found', async () => {
      mockServices.dbService.getWebhook.resolves(null);
      const payload = { trader: traderAddr, active: false, signature: '0xSignature' };
      const validAuthHeader = 'Bearer testtoken';
      const res = await request(app)
        .put('/api/webhooks/unknown')
        .set('Authorization', validAuthHeader)
        .send(payload);
      // For not found, expect 404
      expect(res.status).to.equal(404);
    });
  });
});
