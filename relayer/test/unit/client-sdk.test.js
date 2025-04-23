const { ethers } = require('ethers');
const HyperDexRelayerSDK = require('./client-sdk.mock');
const { getTestWallets } = require('../utils/test-utils');

describe('HyperDex Relayer Client SDK', () => {
  let sdk;
  let wallets;
  let provider;
  
  beforeEach(() => {
    provider = new ethers.providers.JsonRpcProvider();
    wallets = getTestWallets(provider);
    
    sdk = new HyperDexRelayerSDK({
      baseUrl: 'http://localhost:3000',
      chainId: 31337,
      hyperdexAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    });
  });
  
  test('initializes with correct configuration', () => {
    expect(sdk).toBeDefined();
    expect(sdk.config.baseUrl).toBe('http://localhost:3000');
    expect(sdk.config.chainId).toBe(31337);
    expect(sdk.config.hyperdexAddress).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });
  
  test('creates signature for gasless swap', async () => {
    // Create a spy on the signer's _signTypedData method
    const signSpy = jest.spyOn(wallets.trader, '_signTypedData');
    
    // Create swap params
    const params = {
      trader: wallets.trader.address,
      tokenIn: '0xTokenA',
      tokenOut: '0xTokenB',
      amountIn: ethers.utils.parseEther('1'),
      amountOutMin: ethers.utils.parseEther('0.5'),
      recipient: wallets.trader.address,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '123456'
    };
    
    // Sign the swap
    await sdk.signGaslessSwap(wallets.trader, params);
    
    // Verify the wallet's signing method was called with correct parameters
    expect(signSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'HyperDex Protocol',
        version: '1'
      }),
      expect.objectContaining({
        GaslessSwap: expect.any(Array)
      }),
      expect.objectContaining({
        trader: params.trader,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        amountOutMin: params.amountOutMin,
        recipient: params.recipient,
        deadline: params.deadline,
        nonce: params.nonce
      })
    );
  });
  
  test('submits gasless swap to relayer', async () => {
    // Create swap params
    const swapParams = {
      params: {
        trader: wallets.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: wallets.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'high'
    };
    
    // Submit swap
    const result = await sdk.submitGaslessSwap(swapParams);
    
    // Verify response structure
    expect(result).toBeDefined();
    expect(result.status).toBe('submitted');
    expect(result.transactionHash).toBeDefined();
    expect(result.transactionHash.startsWith('0x')).toBe(true);
  });
  
  test('submits and waits for gasless swap confirmation', async () => {
    // Create swap params
    const swapParams = {
      params: {
        trader: wallets.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: wallets.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'medium'
    };
    
    // Submit and wait for swap
    const result = await sdk.submitAndWaitForGaslessSwap(swapParams);
    
    // Verify response structure
    expect(result).toBeDefined();
    expect(result.status).toBe('confirmed');
    expect(result.transactionHash).toBeDefined();
    expect(result.blockNumber).toBeDefined();
  });
  
  test('handles relayer API errors', async () => {
    // Create swap params
    const swapParams = {
      params: {
        trader: wallets.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: wallets.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'medium'
    };
    
    // Set next request to fail
    sdk.setNextRequestToFail();
    
    // Expect API error
    await expect(sdk.submitGaslessSwap(swapParams)).rejects.toThrow('Invalid signature');
  });
  
  test('handles network errors gracefully', async () => {
    // Create swap params
    const swapParams = {
      params: {
        trader: wallets.trader.address,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: ethers.utils.parseEther('1'),
        amountOutMin: ethers.utils.parseEther('0.5'),
        recipient: wallets.trader.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce: '123456'
      },
      signature: '0x' + '2'.repeat(130),
      priority: 'medium'
    };
    
    // Simulate network error
    sdk.setNetworkError(true);
    
    // Expect network error wrapped in a readable message
    await expect(sdk.submitGaslessSwap(swapParams)).rejects.toThrow(/network error/i);
  });
  
  test('generates unique nonce for each transaction', async () => {
    // Generate nonces
    const nonce1 = await sdk.generateNonce();
    
    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const nonce2 = await sdk.generateNonce();
    
    // Verify nonces are different
    expect(nonce1).not.toBe(nonce2);
    expect(typeof nonce1).toBe('string');
    expect(typeof nonce2).toBe('string');
  });
  
  test('checks relayer health status', async () => {
    // Check health
    const health = await sdk.getHealth();
    
    // Verify response structure
    expect(health).toBeDefined();
    expect(health.status).toBe('healthy');
    expect(health.version).toBeDefined();
    expect(health.uptime).toBeDefined();
  });
  
  test('constructs complete swap transaction with signature', async () => {
    // Create swap params
    const params = {
      trader: wallets.trader.address,
      tokenIn: '0xTokenA',
      tokenOut: '0xTokenB',
      amountIn: ethers.utils.parseEther('1'),
      amountOutMin: ethers.utils.parseEther('0.5'),
      recipient: wallets.trader.address,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '123456'
    };
    
    // Sign and submit
    const signature = await sdk.signGaslessSwap(wallets.trader, params);
    
    // Verify signature format
    expect(signature).toBeDefined();
    expect(signature.startsWith('0x')).toBe(true);
    
    // Construct complete transaction
    const swapRequest = {
      params,
      signature,
      priority: 'high'
    };
    
    // Submit the transaction
    const result = await sdk.submitGaslessSwap(swapRequest);
    
    // Verify submission was successful
    expect(result.status).toBe('submitted');
    expect(result.transactionHash).toBeDefined();
  });
});
