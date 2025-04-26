const request = require('supertest');
const express = require('express');
const routes = require('../../src/api/routes');
const { TEST_ACCOUNTS } = require('../utils/test-utils');

describe('Webhook API Integration', () => {
  let app, mockServices;
  const traderAddr = TEST_ACCOUNTS.trader.address;

  beforeAll(() => {
    mockServices = {
      dbService: {
        registerWebhook: jest.fn().mockImplementation(data => Promise.resolve(data)),
        getWebhooks: jest.fn().mockResolvedValue([{ 
          id: 'uuid-1',
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted,swap_confirmed',
          active: true,
          createdAt: new Date().toISOString()
        }]),
        getWebhook: jest.fn().mockResolvedValue({
          id: 'uuid-1',
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted,swap_confirmed',
          active: true,
          updatedAt: new Date().toISOString()
        }),
        updateWebhook: jest.fn().mockImplementation((id, data) => Promise.resolve({
          id,
          trader: traderAddr,
          callbackUrl: 'http://example.com/webhook',
          events: 'swap_submitted',
          active: data.active,
          updatedAt: new Date().toISOString()
        }))
      },
      signatureUtils: {
        verifySignature: jest.fn().mockResolvedValue(true)
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };
    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /api/webhooks/register', () => {
    test('should register a webhook successfully', async () => {
      const payload = {
        trader: traderAddr,
        callbackUrl: 'http://example.com/webhook',
        events: ['swap_submitted'],
        signature: '0xSignature'
      };
      const res = await request(app)
        .post('/api/webhooks/register')
        .send(payload);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.trader).toBe(traderAddr);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(mockServices.dbService.registerWebhook).toHaveBeenCalled();
    });

    test('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/webhooks/register')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    test('should reject invalid signature', async () => {
      mockServices.signatureUtils.verifySignature.mockResolvedValueOnce(false);
      const payload = {
        trader: traderAddr,
        callbackUrl: 'http://example.com/webhook',
        events: ['swap_submitted'],
        signature: '0xBad'
      };
      const res = await request(app)
        .post('/api/webhooks/register')
        .send(payload);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/webhooks/trader/:address', () => {
    test('should return webhooks for trader', async () => {
      const res = await request(app)
        .get(`/api/webhooks/trader/${traderAddr}`);
      expect(res.status).toBe(200);
      expect(res.body.trader).toBe(traderAddr);
      expect(Array.isArray(res.body.webhooks)).toBe(true);
      expect(mockServices.dbService.getWebhooks).toHaveBeenCalledWith(traderAddr, true);
    });
  });

  describe('PUT /api/webhooks/:id', () => {
    test('should update webhook status', async () => {
      const payload = { trader: traderAddr, active: false, signature: '0xSignature' };
      const res = await request(app)
        .put('/api/webhooks/uuid-1')
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(mockServices.dbService.updateWebhook).toHaveBeenCalledWith('uuid-1', { active: false });
    });

    test('should reject update if not found', async () => {
      mockServices.dbService.getWebhook.mockResolvedValueOnce(null);
      const payload = { trader: traderAddr, active: false, signature: '0xSignature' };
      const res = await request(app)
        .put('/api/webhooks/unknown')
        .send(payload);
      expect(res.status).toBe(404);
    });
  });
});
