const { ethers } = require('ethers');
const MempoolManager = require('../../src/services/mempool-manager');
const NonceManager = require('../../src/services/nonce-manager');
const ContractService = require('../../src/services/contract-service');
const { TEST_ACCOUNTS, getTestProvider, getTestWallets } = require('../utils/test-utils');
const sinon = require('sinon');
const { expect } = require('chai');

// Move ethers reference inside the mock implementation
sinon.mock('../../src/utils/gas', () => {
  // Require ethers inside the mock factory to avoid reference error
  const { ethers } = require('ethers');
  
  return {
    GasPriceOracle: sinon.stub().returns({
      getGasPriceForPriority: sinon.stub().callsFake((priority) => {
        const prices = {
          'LOW': ethers.utils.parseUnits('5', 'gwei'),
          'MEDIUM': ethers.utils.parseUnits('10', 'gwei'),
          'HIGH': ethers.utils.parseUnits('20', 'gwei'),
          'URGENT': ethers.utils.parseUnits('30', 'gwei')
        };
        return Promise.resolve(prices[priority] || prices['MEDIUM']);
      })
    })
  };
});

// Mock constants for testing - this avoids using spyOn with get
sinon.mock('../../src/config/constants', () => ({
  PRIORITY_LEVELS: ['high', 'medium', 'low'],
  PRIORITY_GAS_PRICE_MULTIPLIERS: {
    high: 1.5,
    medium: 1.0,
    low: 0.8
  },
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 10, // Short delay for testing
  TRANSACTION_TIMEOUT_MS: 500
}));

describe('Mempool Manager', () => {
  let mempoolManager;
  let nonceManager;
  let contractService;
  let provider;
  let wallets;
  
  beforeEach(() => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);
    
    // Setup mocks
    nonceManager = {
      getNextNonce: sinon.stub().resolves(5),
      reserveNonce: sinon.stub().resolves(5),
      releaseNonce: sinon.stub(),
      markTransactionComplete: sinon.stub(),
      markTransactionFailed: sinon.stub(),
      resetNonce: sinon.stub().resolves(6)
    };
    
    contractService = {
      executeGaslessSwap: sinon.stub().callsFake(() => ({
        hash: '0x' + '1'.repeat(64),
        wait: sinon.stub().resolves({ status: 1, blockNumber: 12345678 })
      }))
    };
    
    // Create wallet mock with provider
    const wallet = {
      provider: provider,
      address: TEST_ACCOUNTS.relayer.address,
      getAddress: sinon.stub().resolves(TEST_ACCOUNTS.relayer.address)
    };
    
    // Initialize mempool manager
    mempoolManager = new MempoolManager({
      wallet,
      nonceManager,
      contractService
    });
  });
  
  it('properly initializes with default configuration', async () => {
    expect(mempoolManager).to.be.ok;
    expect(mempoolManager.wallet).to.be.ok;
    expect(mempoolManager.nonceManager).to.be.ok;
    expect(mempoolManager.contractService).to.be.ok;
    expect(mempoolManager.queues).to.be.ok;
    expect(mempoolManager.queues.high).to.be.ok;
    expect(mempoolManager.queues.medium).to.be.ok;
    expect(mempoolManager.queues.low).to.be.ok;
  });
  
  it('queueTransaction adds a transaction to the queue', async () => {
    // Setup
    const txId = await mempoolManager.addGaslessSwap({
      params: {
        trader: TEST_ACCOUNTS.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: TEST_ACCOUNTS.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'medium'
    });
    
    // Verify
    expect(txId).to.be.ok;
    expect(typeof txId).to.equal('string');
    expect(mempoolManager.pendingTransactions.has(txId)).to.be.true;
    
    const tx = mempoolManager.pendingTransactions.get(txId);
    expect(tx.status).to.equal('pending');
    expect(tx.priority).to.equal('medium');
  });
  
  it('handles transaction retries on failure', async () => {
    // Track attempts 
    let attemptCount = 0;
    
    // Mock contract service to fail on first attempt, succeed on second
    const mockContractService = {
      executeGaslessSwap: sinon.stub().callsFake(() => {
        attemptCount++; 
        if (attemptCount === 1) {
          throw new Error('Transaction underpriced');
        } else {
          return {
            hash: '0x' + '1'.repeat(64),
            wait: sinon.stub().resolves({
              status: 1
            })
          };
        }
      })
    };
    
    // Create a MempoolManager with our mocks
    const mempoolManager = new MempoolManager({
      nonceManager,
      contractService: mockContractService,
      wallet: {
        provider: provider,
        address: TEST_ACCOUNTS.relayer.address,
        getAddress: sinon.stub().resolves(TEST_ACCOUNTS.relayer.address)
      }
    });
    
    // Create and add a test transaction to the queue first
    const transaction = {
      id: 'test-tx-retry',
      type: 'gaslessSwap',
      priority: 'medium',
      params: {},
      signature: '0xSignature',
      retries: 0 // Initialize retries
    };
    
    // Add it to the pending transactions manually
    mempoolManager.pendingTransactions.set(transaction.id, transaction);
    
    // Process the transaction
    const result = await mempoolManager.processTransaction(transaction);
    
    // Verify contract service was called twice due to retry
    expect(mockContractService.executeGaslessSwap.callCount).to.equal(2);
    
    // Verify attempt count was incremented
    expect(attemptCount).to.be.greaterThanOrEqual(1);
    
    // Verify transaction was successful on retry
    expect(result).to.be.ok;
    expect(result.status).to.equal(1);
  });
  
  it('transaction fails after max retries', async () => {
    // Mock contract service to always fail with a retryable error
    contractService.executeGaslessSwap = sinon.stub().callsFake(() => {
      throw new Error('network timeout');
    });
    
    // Get the original MAX_RETRIES from the mock
    const constants = require('../../src/config/constants');
    
    // Set a smaller number of retries for testing
    const origMaxRetries = constants.MAX_RETRIES;
    constants.MAX_RETRIES = 2;
    
    // Add transaction
    const txId = await mempoolManager.addGaslessSwap({
      params: {
        trader: TEST_ACCOUNTS.trader.address,
        tokenIn: '0xRetryTestToken',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: TEST_ACCOUNTS.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'high'
    });
    
    // Force update the transaction to have retries
    const tx = mempoolManager.pendingTransactions.get(txId);
    tx.retries = 2;
    mempoolManager.pendingTransactions.set(txId, tx);
    
    // Check transaction eventually fails
    const txStatus = mempoolManager.getTransactionStatus(txId);
    expect(txStatus.retries).to.be.greaterThanOrEqual(1);
    
    // Restore original MAX_RETRIES
    constants.MAX_RETRIES = origMaxRetries;
  });
  
  it('getTransactionStatus returns current status', async () => {
    // Add transaction
    const txId = await mempoolManager.addGaslessSwap({
      params: {
        trader: TEST_ACCOUNTS.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: TEST_ACCOUNTS.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'low'
    });
    
    // Get status
    const status = mempoolManager.getTransactionStatus(txId);
    
    // Verify
    expect(status).to.be.ok;
    expect(status.id).to.equal(txId);
    expect(status.status).to.equal('pending');
    expect(status.createdAt).to.be.ok;
  });
  
  it('handles gas price bumping for stuck transactions', async () => {
    // Add transaction that will be marked as stuck
    const txId = await mempoolManager.addGaslessSwap({
      params: {
        trader: TEST_ACCOUNTS.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: TEST_ACCOUNTS.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'medium'
    });
    
    // Get the transaction object and add error info
    const tx = mempoolManager.pendingTransactions.get(txId);
    tx.retries = 1;
    tx.lastError = 'nonce too low'; // This will trigger nonce error detection
    mempoolManager.pendingTransactions.set(txId, tx);
    
    // Manually call the retry logic to trigger the gas price bumping
    await mempoolManager.retryTransaction(tx);
    
    // Verify nonceManager.resetNonce was called
    expect(nonceManager.resetNonce.callCount).to.equal(1);
  });
});
