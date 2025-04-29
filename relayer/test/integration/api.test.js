const request = require('supertest');
const express = require('express');
const { ethers } = require('ethers');
const routes = require('../../src/api/routes');
const swapController = require('../../src/api/controllers/swap-controller');
const statusController = require('../../src/api/controllers/status-controller');
const { TEST_ACCOUNTS, getTestProvider, getTestWallets, createSignedSwapRequest } = require('../utils/test-utils');
const sinon = require('sinon');
const { expect } = require('chai');

describe('API Integration Tests', () => {
  let app;
  let provider;
  let wallets;
  let mockServices;
  let hyperDexAddress;

  before(async () => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);
    hyperDexAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

    // Mock service implementations
    mockServices = {
      mempoolManager: {
        queueTransaction: sinon.stub().resolves({
          transactionHash: '0x' + '1'.repeat(64),
          blockNumber: 12345678,
          status: 1
        }),
        getTransactionStatus: sinon.stub().callsFake((txHash) => ({
          status: 'confirmed',
          txHash,
          blockNumber: 12345678,
          submittedAt: Date.now() - 10000, 
          confirmedAt: Date.now()
        }))
      },
      contractService: {
        executeGaslessSwap: sinon.stub().resolves({
          hash: '0x' + '1'.repeat(64),
          wait: sinon.stub().resolves({
            status: 1,
            transactionHash: '0x' + '1'.repeat(64),
            blockNumber: 12345678
          })
        }),
        getPool: sinon.stub().resolves({
          address: '0x9A676e781A523b5d0C0e43731313A708CB607508',
          token0: sinon.stub().resolves('0xTokenA'),
          token1: sinon.stub().resolves('0xTokenB'),
          fee: sinon.stub().resolves(3000)
        })
      },
      nonceManager: {
        getNonce: sinon.stub().resolves(100),
        reserveNonce: sinon.stub().resolves(100)
      },
      signatureUtils: {
        verifySignature: sinon.stub().resolves(true)
      },
      logger: {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub(),
        debug: sinon.stub()
      },
      providerManager: {
        getHealthStatus: sinon.stub().resolves({ hasHealthyProvider: true, providers: [] }),
        executeWithProvider: sinon.stub().resolves(12345678)
      },
      dbService: {
        sequelize: { authenticate: sinon.stub().resolves() },
        verifyAuthToken: sinon.stub()
      }
    };

    // Create Express app and configure routes
    app = express();
    app.use(express.json());

    // Inject mock services into route handlers
    const routeConfig = routes(mockServices);
    app.use('/api', routeConfig);
  });

  beforeEach(() => {
    if (mockServices.dbService.verifyAuthToken) {
      mockServices.dbService.verifyAuthToken.resolves('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    }
  });

  after(async () => {
    sinon.restore();
  });

  describe('POST /api/swap/gasless', () => {
    it('executes a valid gasless swap', async () => {
      // Create a valid signed swap request
      const swapRequest = await createSignedSwapRequest(wallets.user, hyperDexAddress);

      // Add a valid Authorization header for endpoints that require authentication
      const validAuthHeader = 'Bearer testtoken';

      // Make the request to the API
      const response = await request(app)
        .post('/api/swap/gasless')
        .set('Authorization', validAuthHeader)
        .send({
          trader: swapRequest.trader,
          zeroForOne: swapRequest.zeroForOne,
          amountSpecified: swapRequest.amountSpecified.toString(),
          sqrtPriceLimitX96: swapRequest.sqrtPriceLimitX96,
          poolAddress: swapRequest.poolAddress,
          deadline: swapRequest.deadline,
          nonce: swapRequest.nonce,
          signature: swapRequest.signature
        });

      // Check response
      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('transactionHash');
      expect(response.body).to.have.property('status', 'submitted');

      // Verify services were called correctly
      expect(mockServices.signatureUtils.verifySignature.called).to.be.true;
      expect(mockServices.contractService.executeGaslessSwap.called).to.be.true;
    });

    it('rejects invalid signature', async () => {
      // Create a valid signed swap request
      const swapRequest = await createSignedSwapRequest(wallets.user, hyperDexAddress);

      // Ensure verifySignature returns false for this test
      mockServices.signatureUtils.verifySignature.returns(false);
      // Ensure contractService.executeGaslessSwap is not called
      mockServices.contractService.executeGaslessSwap.resetHistory();
      // Add a valid Authorization header for endpoints that require authentication
      const validAuthHeader = 'Bearer testtoken';

      // Make the request to the API
      const response = await request(app)
        .post('/api/swap/gasless')
        .set('Authorization', validAuthHeader)
        .send({
          trader: swapRequest.trader,
          zeroForOne: swapRequest.zeroForOne,
          amountSpecified: swapRequest.amountSpecified,
          sqrtPriceLimitX96: swapRequest.sqrtPriceLimitX96,
          poolAddress: swapRequest.poolAddress,
          deadline: swapRequest.deadline,
          nonce: swapRequest.nonce,
          signature: '0xInvalidSignature'
        });

      // Check rejection response
      expect(response.status).to.equal(401);
      expect(response.body.error).to.contain('Invalid signature');
      expect(mockServices.contractService.executeGaslessSwap.called).to.be.false;
    });

    it('handles missing parameters', async () => {
      // Make request with missing parameters
      const response = await request(app)
        .post('/api/swap/gasless')
        .send({
          // Missing crucial parameters
          trader: TEST_ACCOUNTS.user.address,
          signature: '0xSampleSignature'
        });

      // Check validation error response
      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('error');
    });

    it('handles service errors gracefully', async () => {
      // Create a valid signed swap request
      const swapRequest = await createSignedSwapRequest(wallets.user, hyperDexAddress);

      // Mock signature verification to succeed
      mockServices.signatureUtils.verifySignature.resolves(true);
      // Mock service to throw error
      mockServices.contractService.executeGaslessSwap.rejects(new Error('Transaction underpriced'));

      // Add a valid Authorization header for endpoints that require authentication
      const validAuthHeader = 'Bearer testtoken';

      // Make the request to the API
      const response = await request(app)
        .post('/api/swap/gasless')
        .set('Authorization', validAuthHeader)
        .send({
          trader: swapRequest.trader,
          zeroForOne: swapRequest.zeroForOne,
          amountSpecified: swapRequest.amountSpecified,
          sqrtPriceLimitX96: swapRequest.sqrtPriceLimitX96,
          poolAddress: swapRequest.poolAddress,
          deadline: swapRequest.deadline,
          nonce: swapRequest.nonce,
          signature: swapRequest.signature
        });

      // Check error response
      expect(response.status).to.equal(500);
      expect(response.body).to.have.property('error');
      expect(response.body.error).to.contain('Transaction underpriced');
    });
  });

  describe('GET /api/status/:txHash', () => {
    it('retrieves transaction status', async () => {
      // Sample transaction hash
      const txHash = '0x' + '1'.repeat(64);

      // Make the request to the API
      const response = await request(app)
        .get(`/api/status/${txHash}`);

      // Check response
      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'confirmed');
      expect(response.body).to.have.property('txHash', txHash);
      expect(response.body).to.have.property('blockNumber', 12345678);

      // Verify service was called
      expect(mockServices.mempoolManager.getTransactionStatus.calledWith(txHash)).to.be.true;
    });

    it('handles unknown transaction', async () => {
      // Unknown transaction hash
      const txHash = '0x' + '9'.repeat(64);

      // Mock service to return null for unknown tx
      mockServices.mempoolManager.getTransactionStatus.resolves(null);

      // Make the request to the API
      const response = await request(app)
        .get(`/api/status/${txHash}`);

      // Check response
      expect(response.status).to.equal(404);
      expect(response.body).to.have.property('error');
      expect(response.body.error).to.contain('Transaction not found');
    });

    it('validates transaction hash format', async () => {
      // Invalid transaction hash
      const invalidTxHash = 'not-a-valid-tx-hash';

      // Make the request to the API
      const response = await request(app)
        .get(`/api/status/${invalidTxHash}`);

      // Check validation error response
      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('error');
      expect(response.body.error).to.contain('Invalid transaction hash');
    });
  });

  describe('GET /api/health', () => {
    it('returns proper health status', async () => {
      // Make the request to the API
      const response = await request(app)
        .get('/api/health');

      // Check response
      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'ok');
      expect(response.body).to.have.property('timestamp');
      expect(response.body).to.have.property('uptime');
      expect(response.body).to.have.property('version');
    });
  });
});
