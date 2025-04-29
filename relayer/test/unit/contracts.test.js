const { ethers } = require('ethers');
const { ContractService } = require('../../src/services/contracts');
const HyperDexABI = require('../../abi/HyperDex.json');
const HyperDexFactoryABI = require('../../abi/HyperDexFactory.json');
const HyperDexPoolABI = require('../../abi/HyperDexPool.json');
const { TEST_ACCOUNTS, getTestProvider, getTestWallets } = require('../utils/test-utils');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Contract Service', () => {
  let contractService;
  let provider;
  let wallets;
  let mockHyperDex;
  let mockFactory;

  beforeEach(() => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);

    // Create mock contract instances
    mockHyperDex = {
      address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      relayer: sinon.stub().resolves(TEST_ACCOUNTS.relayer.address),
      swapExactInputSingleViaRelayer: sinon.stub().resolves({
        wait: sinon.stub().resolves({
          status: 1,
          events: [{
            event: 'GaslessSwapExecuted',
            args: {
              trader: TEST_ACCOUNTS.user.address,
              amount0: ethers.utils.parseEther('1'),
              amount1: ethers.utils.parseEther('-0.9')
            }
          }]
        })
      })
    };

    mockFactory = {
      address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      getPool: sinon.stub().resolves('0x9A676e781A523b5d0C0e43731313A708CB607508')
    };

    // Mock ethers Contract constructor
    sinon.stub(ethers, 'Contract').callsFake((address, abi, signerOrProvider) => {
      if (abi === HyperDexABI) {
        return mockHyperDex;
      } else if (abi === HyperDexFactoryABI) {
        return mockFactory;
      } else if (abi === HyperDexPoolABI) {
        return {
          address: '0x9A676e781A523b5d0C0e43731313A708CB607508',
          fee: sinon.stub().resolves(3000), // 0.3%
          token0: sinon.stub().resolves('0xTokenA'),
          token1: sinon.stub().resolves('0xTokenB'),
          gaslessSwap: sinon.stub().resolves([
            ethers.utils.parseEther('1'),
            ethers.utils.parseEther('-0.9')
          ])
        };
      }
    });

    // Initialize contract service
    contractService = new ContractService(provider, wallets.relayer);

    // Pre-initialize the contracts
    contractService.loadHyperDex(mockHyperDex.address);
    contractService.loadFactory(mockFactory.address);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('initializes with correct contract instances', async () => {
    expect(contractService).to.be.ok;
    expect(contractService.contracts.hyperDex).to.be.ok;
    expect(contractService.contracts.factory).to.be.ok;
  });

  it('getPool loads and caches pool instances', async () => {
    // Get a pool that doesn't exist in cache yet
    const tokenA = '0xTokenA';
    const tokenB = '0xTokenB';
    const fee = 3000;

    const pool = await contractService.getPool(tokenA, tokenB, fee);

    // Verify Factory.getPool was called with correct parameters
    expect(mockFactory.getPool).to.have.been.calledWith(tokenA, tokenB, fee);

    // Verify pool was created and cached
    expect(pool).to.be.ok;
    expect(pool.address).to.equal('0x9A676e781A523b5d0C0e43731313A708CB607508');
    expect(contractService.poolCache.size).to.equal(1);

    // Get the same pool again
    await contractService.getPool(tokenA, tokenB, fee);

    // Factory.getPool should not be called again due to caching
    expect(mockFactory.getPool).to.have.been.calledOnce;
  });

  it('executeGaslessSwap correctly proxies the swap to HyperDex contract', async () => {
    // Create swap parameters
    const swapParams = {
      trader: TEST_ACCOUNTS.user.address,
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      poolAddress: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      deadline: Math.floor(Date.now() / 1000) + 3600, 
      nonce: '1'
    };

    const signature = '0xSampleSignature';

    // Execute the swap
    const receipt = await contractService.executeGaslessSwap(swapParams, signature);

    // Verify swap was executed
    expect(contractService.contracts.hyperDex.swapExactInputSingleViaRelayer).to.have.been.calledWith(
      swapParams, 
      signature,
      {}
    );

    // Verify receipt was returned
    expect(receipt).to.be.ok;
    expect(receipt.wait).to.be.ok;
  });

  it('executes direct pool swap for pools that support it', async () => {
    // Create swap parameters for direct pool swap
    const swapParams = {
      trader: TEST_ACCOUNTS.user.address,
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '0',
      poolAddress: '0x9A676e781A523b5d0C0e43731313A708CB607508',
      deadline: Math.floor(Date.now() / 1000) + 3600, 
      nonce: '1'
    };

    const signature = '0xSampleSignature';

    // Get pool instance first
    const pool = await contractService.getPool('0xTokenA', '0xTokenB', 3000);

    // Execute direct pool swap
    const result = await contractService.executePoolGaslessSwap(pool, swapParams, signature);

    // Verify pool.gaslessSwap was called
    expect(pool.gaslessSwap).to.have.been.calledWith(
      swapParams,
      signature,
      {}
    );

    // Verify amounts were returned
    expect(result).to.be.ok;
    expect(result.length).to.equal(2);
    expect(result[0].toString()).to.equal(ethers.utils.parseEther('1').toString());
    expect(result[1].toString()).to.equal(ethers.utils.parseEther('-0.9').toString());
  });

  it('throws error for invalid contract addresses', async () => {
    // Create service with invalid addresses
    const invalidService = new ContractService(provider, wallets.relayer);

    // Reset mock to throw on zero address
    sinon.stub(ethers, 'Contract').callsFake((address) => {
      if (address === ethers.constants.AddressZero) {
        throw new Error('Invalid contract address');
      }
    });

    // Expect initialization to throw
    await expect(
      invalidService.loadHyperDex(ethers.constants.AddressZero)
    ).to.be.rejectedWith(Error, 'Invalid contract address');
  });

  it('handles non-existent pools correctly', async () => {
    // Mock factory.getPool to return zero address (non-existent pool)
    mockFactory.getPool.resolves(ethers.constants.AddressZero);

    // Try to get a non-existent pool
    await expect(
      contractService.getPool('0xNonExistentTokenA', '0xNonExistentTokenB', 3000)
    ).to.be.rejected;
  });
});
