const request = require('supertest');
const express = require('express');
const { ethers } = require('ethers');
const routes = require('../../src/api/routes');
const swapController = require('../../src/api/controllers/swap-controller');
const statusController = require('../../src/api/controllers/status-controller');
const { TEST_ACCOUNTS, getTestProvider, getTestWallets, createSignedSwapRequest } = require('../utils/test-utils');

jest.mock('../../src/services/mempool-manager');
jest.mock('../../src/services/contracts');
jest.mock('../../src/services/nonce-manager');

describe('API Integration Tests', () => {
  let app;
  let provider;
  let wallets;
  let mockServices;
  let hyperDexAddress;
  
  beforeAll(() => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);
    hyperDexAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    
    // Mock service implementations
    mockServices = {
      mempoolManager: {
        queueTransaction: jest.fn().mockResolvedValue({
          transactionHash: '0x' + '1'.repeat(64),
          blockNumber: 12345678,
          status: 1
        }),
        getTransactionStatus: jest.fn().mockImplementation((txHash) => ({
          status: 'confirmed',
          txHash,
          blockNumber: 12345678,
          submittedAt: Date.now() - 10000, 
          confirmedAt: Date.now()
        }))
      },
      contractService: {
        executeGaslessSwap: jest.fn().mockResolvedValue({
          hash: '0x' + '1'.repeat(64),
          wait: jest.fn().mockResolvedValue({
            status: 1,
            transactionHash: '0x' + '1'.repeat(64),
            blockNumber: 12345678
          })
        }),
        getPool: jest.fn().mockResolvedValue({
          address: '0x9A676e781A523b5d0C0e43731313A708CB607508',
          token0: jest.fn().mockResolvedValue('0xTokenA'),
          token1: jest.fn().mockResolvedValue('0xTokenB'),
          fee: jest.fn().mockResolvedValue(3000)
        })
      },
      nonceManager: {
        getNonce: jest.fn().mockResolvedValue(100),
        reserveNonce: jest.fn().mockResolvedValue(100)
      },
      signatureUtils: {
        verifySignature: jest.fn().mockResolvedValue(true)
      },
      logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
      },
      providerManager: {
        getHealthStatus: jest.fn().mockResolvedValue({ hasHealthyProvider: true, providers: [] }),
        executeWithProvider: jest.fn().mockResolvedValue(12345678)
      },
      dbService: {
        sequelize: { authenticate: jest.fn().mockResolvedValue() }
      }
    };
    
    // Create Express app and configure routes
    app = express();
    app.use(express.json());
    
    // Inject mock services into route handlers
    const routeConfig = routes(mockServices);
    app.use('/api', routeConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/swap/gasless', () => {
    test('executes a valid gasless swap', async () => {
      // Create a valid signed swap request
      const swapRequest = await createSignedSwapRequest(wallets.user, hyperDexAddress);
      
      // Make the request to the API
      const response = await request(app)
        .post('/api/swap/gasless')
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
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('transactionHash');
      expect(response.body).toHaveProperty('status', 'submitted');
      
      // Verify services were called correctly
      expect(mockServices.signatureUtils.verifySignature).toHaveBeenCalled();
      expect(mockServices.contractService.executeGaslessSwap).toHaveBeenCalled();
    });

    test('rejects invalid signature', async () => {
      // Create request but with invalid signature
      const swapRequest = await createSignedSwapRequest(wallets.user, hyperDexAddress);
      
      // Mock signature verification to fail
      mockServices.signatureUtils.verifySignature.mockResolvedValueOnce(false);
      
      // Make the request to the API
      const response = await request(app)
        .post('/api/swap/gasless')
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
      
      // Check rejection response
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid signature');
      
      // Verify execution was not attempted
      expect(mockServices.contractService.executeGaslessSwap).not.toHaveBeenCalled();
    });

    test('handles missing parameters', async () => {
      // Make request with missing parameters
      const response = await request(app)
        .post('/api/swap/gasless')
        .send({
          // Missing crucial parameters
          trader: TEST_ACCOUNTS.user.address,
          signature: '0xSampleSignature'
        });
      
      // Check validation error response
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    test('handles service errors gracefully', async () => {
      // Create a valid signed swap request
      const swapRequest = await createSignedSwapRequest(wallets.user, hyperDexAddress);
      
      // Mock service to throw error
      mockServices.contractService.executeGaslessSwap.mockRejectedValueOnce(
        new Error('Transaction underpriced')
      );
      
      // Make the request to the API
      const response = await request(app)
        .post('/api/swap/gasless')
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
      
      // Check error response
      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Transaction underpriced');
    });
  });

  describe('GET /api/status/:txHash', () => {
    test('retrieves transaction status', async () => {
      // Sample transaction hash
      const txHash = '0x' + '1'.repeat(64);
      
      // Make the request to the API
      const response = await request(app)
        .get(`/api/status/${txHash}`);
      
      // Check response
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'confirmed');
      expect(response.body).toHaveProperty('txHash', txHash);
      expect(response.body).toHaveProperty('blockNumber', 12345678);
      
      // Verify service was called
      expect(mockServices.mempoolManager.getTransactionStatus).toHaveBeenCalledWith(txHash);
    });

    test('handles unknown transaction', async () => {
      // Unknown transaction hash
      const txHash = '0x' + '9'.repeat(64);
      
      // Mock service to return null for unknown tx
      mockServices.mempoolManager.getTransactionStatus.mockReturnValueOnce(null);
      
      // Make the request to the API
      const response = await request(app)
        .get(`/api/status/${txHash}`);
      
      // Check response
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Transaction not found');
    });

    test('validates transaction hash format', async () => {
      // Invalid transaction hash
      const invalidTxHash = 'not-a-valid-tx-hash';
      
      // Make the request to the API
      const response = await request(app)
        .get(`/api/status/${invalidTxHash}`);
      
      // Check validation error response
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid transaction hash');
    });
  });

  describe('GET /api/health', () => {
    test('returns proper health status', async () => {
      // Make the request to the API
      const response = await request(app)
        .get('/api/health');
      
      // Check response
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('version');
    });
  });
});
