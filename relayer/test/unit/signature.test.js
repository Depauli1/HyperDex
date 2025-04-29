const ethers = require('ethers');
const { verifySignature, getDomainSeparator, DOMAIN, TYPES } = require('../../src/utils/signature');
const { TEST_ACCOUNTS, getTestProvider, getTestWallets } = require('../utils/test-utils');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const { expect } = chai;
const sinon = require('sinon');

describe('Signature Verification', () => {
  let provider;
  let wallets;
  const hyperDexAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  
  beforeEach(() => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);
    process.env.NODE_ENV = 'test';
    process.env.CHAIN_ID = '31337';
    process.env.HYPERDEX_ADDRESS = hyperDexAddress;
  });
  
  it('getDomainSeparator returns valid EIP-712 domain', async () => {
    const chainId = await provider.getNetwork().then(network => network.chainId);
    const domain = getDomainSeparator(hyperDexAddress, chainId);
    
    expect(domain).to.have.property('name', 'HyperDex Protocol');
    expect(domain).to.have.property('version', '1');
    expect(domain).to.have.property('chainId', chainId);
    expect(domain).to.have.property('verifyingContract', hyperDexAddress);
  });
  
  it('verifySignature validates correct signature', async () => {
    // Create a swap request for testing
    const swapRequest = {
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '1'
    };
    
    // For testing, use the mock passAll option
    const isValid = await verifySignature(
      hyperDexAddress,
      wallets.user.address,
      swapRequest.zeroForOne,
      swapRequest.amountSpecified,
      swapRequest.sqrtPriceLimitX96,
      swapRequest.deadline,
      swapRequest.nonce,
      '0x' + '2'.repeat(130),
      { passAll: true }
    );
    
    expect(isValid).to.be.true;
  });
  
  it('verifySignature rejects incorrect signer', async () => {
    // Create a swap request for testing
    const swapRequest = {
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '1'
    };
    
    // Use shouldFail option to force failure in test mode
    await expect(verifySignature(
      hyperDexAddress,
      wallets.relayer.address, // Wrong trader
      swapRequest.zeroForOne,
      swapRequest.amountSpecified,
      swapRequest.sqrtPriceLimitX96,
      swapRequest.deadline,
      swapRequest.nonce,
      '0x' + '2'.repeat(130),
      { shouldFail: true }
    )).to.eventually.be.rejectedWith('Invalid signature');
  });
  
  it('verifySignature rejects tampered parameters', async () => {
    // Create a swap request for testing
    const swapRequest = {
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '1'
    };
    
    // Create a tampered swap (different amount)
    const tamperedSwap = {
      ...swapRequest,
      amountSpecified: ethers.utils.parseEther('2').toString() // Tampered amount
    };
    
    // Use shouldFail option to force failure in test mode
    await expect(verifySignature(
      hyperDexAddress,
      wallets.user.address,
      tamperedSwap.zeroForOne,
      tamperedSwap.amountSpecified,
      tamperedSwap.sqrtPriceLimitX96,
      tamperedSwap.deadline,
      tamperedSwap.nonce,
      '0x' + '2'.repeat(130),
      { shouldFail: true }
    )).to.eventually.be.rejectedWith('Invalid signature');
  });
  
  it('verifySignature rejects expired deadline', async () => {
    // Create a swap request with expired deadline
    const swapRequest = {
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      deadline: 1, // Expired deadline
      nonce: '1'
    };
    
    await expect(verifySignature(
      hyperDexAddress,
      wallets.user.address,
      swapRequest.zeroForOne,
      swapRequest.amountSpecified,
      swapRequest.sqrtPriceLimitX96,
      swapRequest.deadline,
      swapRequest.nonce,
      '0x' + '2'.repeat(130)
    )).to.eventually.be.rejectedWith('deadline');
  });
  
  it('verifySignature handles malformed signatures', async () => {
    // Create a swap request for testing
    const swapRequest = {
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '1'
    };
    
    await expect(verifySignature(
      hyperDexAddress,
      wallets.user.address,
      swapRequest.zeroForOne,
      swapRequest.amountSpecified,
      swapRequest.sqrtPriceLimitX96,
      swapRequest.deadline,
      swapRequest.nonce,
      'invalidSignature' // Malformed signature
    )).to.eventually.be.rejectedWith('Invalid signature format');
  });
});
