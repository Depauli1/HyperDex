const ethers = require('ethers');
const { randomBytes } = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

// Load test environment
dotenv.config({ path: path.join(__dirname, '../.env.test') });

// Test accounts with private keys and addresses, prefer .env.test values
const TEST_ACCOUNTS = {
  relayer: {
    privateKey: process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    address: process.env.RELAYER_ADDRESS || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  },
  trader: {
    privateKey: process.env.TRADER_PRIVATE_KEY || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    address: process.env.TRADER_ADDRESS || '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
  },
  user: {
    privateKey: process.env.USER_PRIVATE_KEY || '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    address: process.env.USER_ADDRESS || '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
  }
};

/**
 * Creates a mock provider for testing
 * @returns {Object} - Mock ethers provider
 */
function getTestProvider() {
  const provider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 31337 }),
    getTransactionCount: jest.fn().mockResolvedValue(10),
    getGasPrice: jest.fn().mockResolvedValue(ethers.utils.parseUnits('50', 'gwei')),
    waitForTransaction: jest.fn().mockResolvedValue(mockTxReceipt()),
    sendTransaction: jest.fn().mockImplementation(tx => ({
      hash: '0x' + '1'.repeat(64),
      wait: jest.fn().mockResolvedValue(mockTxReceipt())
    })),
    estimateGas: jest.fn().mockResolvedValue(ethers.BigNumber.from(200000))
  };
  
  return provider;
}

/**
 * Creates test wallets using the test provider
 * @param {Object} provider - Test provider
 * @returns {Object} - Map of test wallets
 */
function getTestWallets(provider) {
  const wallets = {};
  
  for (const [role, account] of Object.entries(TEST_ACCOUNTS)) {
    // Create mock wallet directly rather than using ethers.Wallet constructor
    const wallet = {
      address: account.address,
      privateKey: account.privateKey,
      provider: provider,
      getAddress: jest.fn().mockResolvedValue(account.address),
      signMessage: jest.fn().mockResolvedValue('0x' + '1'.repeat(130)),
      _signTypedData: jest.fn().mockResolvedValue('0x' + '2'.repeat(130)),
      connect: jest.fn().mockReturnThis(),
      sendTransaction: jest.fn().mockImplementation(tx => ({
        hash: '0x' + '1'.repeat(64),
        wait: jest.fn().mockResolvedValue(mockTxReceipt())
      }))
    };
    
    wallets[role] = wallet;
  }
  
  return wallets;
}

/**
 * Creates a mock transaction receipt
 * @param {Object} params - Optional receipt params to override defaults
 * @returns {Object} - Mock transaction receipt
 */
function mockTxReceipt(params = {}) {
  return {
    blockNumber: 12345678,
    transactionHash: params.transactionHash || '0x' + '1'.repeat(64),
    status: 1,
    gasUsed: ethers.BigNumber.from(100000),
    ...params
  };
}

/**
 * Utility to sleep for a specified time
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after the timeout
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a random gasless swap request with valid signature
 * @param {Object} signer - Signer wallet
 * @param {string} hyperDexAddress - HyperDex contract address
 * @param {Object} params - Optional swap request params to override defaults
 * @returns {Object} - Signed gasless swap request
 */
function createSignedSwapRequest(signer, hyperDexAddress, params) {
  const domain = {
    name: 'HyperDex Protocol',
    version: '1',
    chainId: 1, // Mock chain ID for tests
    verifyingContract: hyperDexAddress
  };

  const types = {
    GaslessSwap: [
      { name: 'trader', type: 'address' },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountSpecified', type: 'int256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
      { name: 'poolAddress', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }
    ]
  };
  
  // Default values merged with provided params
  const swapParams = {
    trader: signer.address,
    zeroForOne: true,
    amountSpecified: ethers.utils.parseEther('1').toString(),
    sqrtPriceLimitX96: '0',
    poolAddress: ethers.constants.AddressZero,
    deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    nonce: ethers.BigNumber.from(randomBytes(32)).toString(),
    ...params
  };

  // For tests, we'll mock the signature
  const signature = '0x' + '2'.repeat(130);
  
  return {
    ...swapParams,
    signature
  };
}

module.exports = {
  TEST_ACCOUNTS,
  getTestProvider,
  getTestWallets,
  createSignedSwapRequest,
  mockTxReceipt,
  sleep
};
