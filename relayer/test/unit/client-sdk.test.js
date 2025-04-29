const { ethers } = require('ethers');
const HyperDexRelayerSDK = require('./client-sdk.mock');
const { expect } = require('chai');
const sinon = require('sinon');
const { getTestWallets } = require('../utils/test-utils');

describe('HyperDex Relayer Client SDK', () => {
  let sdk;
  let wallets;
  let provider;

  before(async () => {
    provider = new ethers.providers.JsonRpcProvider();
    wallets = getTestWallets(provider);

    sdk = new HyperDexRelayerSDK({
      baseUrl: 'http://localhost:3000',
      chainId: 31337,
      hyperdexAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    });
  });

  it('initializes with correct configuration', () => {
    expect(sdk).to.exist;
    expect(sdk.config.baseUrl).to.equal('http://localhost:3000');
    expect(sdk.config.chainId).to.equal(31337);
    expect(sdk.config.hyperdexAddress).to.equal('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });

  it('creates signature for gasless swap', async () => {
    // Create a spy on the signer's _signTypedData method
    const signSpy = sinon.spy(wallets.trader, '_signTypedData');

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
    expect(signSpy).to.have.been.calledWith(
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

  it('submits gasless swap to relayer', async () => {
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
    expect(result).to.exist;
    expect(result.status).to.equal('submitted');
    expect(result.transactionHash).to.exist;
    expect(result.transactionHash.startsWith('0x')).to.be.true;
  });

  it('submits and waits for gasless swap confirmation', async () => {
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
    expect(result).to.exist;
    expect(result.status).to.equal('confirmed');
    expect(result.transactionHash).to.exist;
    expect(result.blockNumber).to.exist;
  });

  it('handles relayer API errors', async () => {
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
    try {
      await sdk.submitGaslessSwap(swapParams);
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).to.equal('Invalid signature');
    }
  });

  it('handles network errors gracefully', async () => {
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
    try {
      await sdk.submitGaslessSwap(swapParams);
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).to.match(/network error/i);
    }
  });

  it('generates unique nonce for each transaction', async () => {
    // Generate nonces
    const nonce1 = await sdk.generateNonce();

    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));

    const nonce2 = await sdk.generateNonce();

    // Verify nonces are different
    expect(nonce1).to.not.equal(nonce2);
    expect(typeof nonce1).to.equal('string');
    expect(typeof nonce2).to.equal('string');
  });

  it('checks relayer health status', async () => {
    // Check health
    const health = await sdk.getHealth();

    // Verify response structure
    expect(health).to.exist;
    expect(health.status).to.equal('healthy');
    expect(health.version).to.exist;
    expect(health.uptime).to.exist;
  });

  it('constructs complete swap transaction with signature', async () => {
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
    expect(signature).to.exist;
    expect(signature.startsWith('0x')).to.be.true;

    // Construct complete transaction
    const swapRequest = {
      params,
      signature,
      priority: 'high'
    };

    // Submit the transaction
    const result = await sdk.submitGaslessSwap(swapRequest);

    // Verify submission was successful
    expect(result.status).to.equal('submitted');
    expect(result.transactionHash).to.exist;
  });
});
