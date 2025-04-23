const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getDomainSeparator } = require('../utils/signature');

// Import ABI definitions
const HyperDexABI = require('../../abi/HyperDex.json');
const HyperDexFactoryABI = require('../../abi/HyperDexFactory.json');
const HyperDexPoolABI = require('../../abi/HyperDexPool.json');

/**
 * Contract service handles loading and interacting with smart contracts
 */
class ContractService {
  /**
   * Initialize contract service
   * 
   * @param {ethers.providers.Provider} provider - Ethereum provider
   * @param {ethers.Wallet} wallet - Relayer wallet
   */
  constructor(provider, wallet) {
    this.provider = provider;
    this.wallet = wallet;
    this.contracts = {};
    this.domains = {};
    this.poolCache = null;
  }

  /**
   * Load HyperDex contract instance
   * 
   * @param {string} address - Contract address
   * @returns {Promise<ethers.Contract>} Contract instance
   */
  async loadHyperDex(address) {
    try {
      logger.info(`Loading HyperDex contract at ${address}`);
      
      // Create contract instance
      const contract = new ethers.Contract(
        address,
        HyperDexABI,
        this.wallet
      );
      
      // Store in cache
      this.contracts.hyperDex = contract;
      
      // Get EIP-712 domain for this contract
      const network = await this.provider.getNetwork();
      this.domains.hyperDex = getDomainSeparator(address, network.chainId);
      
      // Verify we're authorized as a relayer
      const relayerAddress = await contract.relayer();
      const walletAddress = await this.wallet.getAddress();
      
      if (relayerAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        logger.warn(`Wallet address ${walletAddress} is not authorized as relayer (current relayer: ${relayerAddress})`);
      } else {
        logger.info(`Wallet is authorized as relayer for HyperDex`);
      }
      
      return contract;
    } catch (error) {
      logger.error(`Failed to load HyperDex contract: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load factory contract
   * 
   * @param {string} address - Contract address
   * @returns {Promise<ethers.Contract>} Contract instance
   */
  async loadFactory(address) {
    try {
      logger.info(`Loading HyperDexFactory contract at ${address}`);
      
      const contract = new ethers.Contract(
        address,
        HyperDexFactoryABI,
        this.wallet
      );
      
      this.contracts.factory = contract;
      return contract;
    } catch (error) {
      logger.error(`Failed to load factory contract: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get pool contract instance
   * 
   * @param {string} address - Pool address
   * @returns {ethers.Contract} Pool contract instance
   */
  getPoolContract(address) {
    // Check cache first
    if (this.contracts[`pool-${address}`]) {
      return this.contracts[`pool-${address}`];
    }
    
    // Create new instance if not cached
    const contract = new ethers.Contract(
      address,
      HyperDexPoolABI,
      this.wallet
    );
    
    // Cache it
    this.contracts[`pool-${address}`] = contract;
    return contract;
  }

  /**
   * Get pool address from factory
   * 
   * @param {string} token0 - Token 0 address
   * @param {string} token1 - Token 1 address
   * @param {number} fee - Fee tier
   * @returns {Promise<string>} Pool address
   */
  async getPoolAddress(token0, token1, fee) {
    if (!this.contracts.factory) {
      throw new Error('Factory contract not loaded');
    }
    
    // Ensure tokens are in correct order
    if (token0.toLowerCase() > token1.toLowerCase()) {
      [token0, token1] = [token1, token0];
    }
    
    try {
      const poolAddress = await this.contracts.factory.getPool(token0, token1, fee);
      if (poolAddress === ethers.constants.AddressZero) {
        throw new Error(`Pool does not exist for ${token0}/${token1} with fee ${fee}`);
      }
      return poolAddress;
    } catch (error) {
      logger.error(`Failed to get pool address: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current nonce for a user
   * 
   * @param {string} userAddress - User address
   * @returns {Promise<ethers.BigNumber>} Current nonce
   */
  async getNonce(userAddress) {
    if (!this.contracts.hyperDex) {
      throw new Error('HyperDex contract not loaded');
    }
    
    try {
      return await this.contracts.hyperDex.getNonce(userAddress);
    } catch (error) {
      logger.error(`Failed to get nonce for ${userAddress}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Execute a gasless swap transaction
   * 
   * @param {Object} params - Swap parameters
   * @param {string} params.trader - Trader address
   * @param {boolean} params.zeroForOne - Direction of swap
   * @param {string} params.amountSpecified - Amount to swap
   * @param {string} params.sqrtPriceLimitX96 - Price limit
   * @param {string} params.poolAddress - Pool address
   * @param {number} params.deadline - Swap deadline timestamp
   * @param {string} params.nonce - Unique nonce
   * @param {string} signature - EIP-712 signature
   * @param {Object} options - Additional options
   * @param {string} options.gasLimit - Optional gas limit
   * @param {string} options.gasPrice - Optional gas price
   * @returns {Promise<ethers.providers.TransactionResponse>} Transaction response
   */
  async executeGaslessSwap(params, signature, options = {}) {
    if (!this.contracts.hyperDex) {
      throw new Error('HyperDex contract not loaded');
    }
    
    try {
      // Ensure pool contract is available and valid
      const poolContract = this.getPoolContract(params.poolAddress);
      
      logger.info(`Executing gasless swap for ${params.trader}, amount: ${params.amountSpecified}, pool: ${params.poolAddress}`);
      
      // Prepare transaction options
      const txOptions = {};
      if (options.gasLimit) {
        txOptions.gasLimit = options.gasLimit;
      }
      if (options.gasPrice) {
        txOptions.gasPrice = ethers.utils.parseUnits(options.gasPrice.toString(), 'gwei');
      }
      
      // Execute the swap
      const tx = await this.contracts.hyperDex.swapExactInputSingleViaRelayer(
        {
          trader: params.trader,
          zeroForOne: params.zeroForOne,
          amountSpecified: params.amountSpecified,
          sqrtPriceLimitX96: params.sqrtPriceLimitX96,
          poolAddress: params.poolAddress,
          deadline: params.deadline,
          nonce: params.nonce
        },
        signature,
        txOptions
      );
      
      logger.info(`Gasless swap submitted: ${tx.hash}`);
      return tx;
    } catch (error) {
      logger.error(`Failed to execute gasless swap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get the EIP-712 domain for HyperDex
   * 
   * @returns {Object} EIP-712 domain
   */
  getHyperDexDomain() {
    if (!this.domains.hyperDex) {
      throw new Error('HyperDex domain not initialized');
    }
    return this.domains.hyperDex;
  }

  /**
   * Get a pool from tokens and fee
   * 
   * @param {string} tokenA - Token A address
   * @param {string} tokenB - Token B address
   * @param {number} fee - Fee tier
   * @returns {Promise<ethers.Contract>} Pool contract
   */
  async getPool(tokenA, tokenB, fee) {
    try {
      // Cache key to avoid duplicate lookups
      const cacheKey = `${tokenA}:${tokenB}:${fee}`;
      
      // Check cache first
      if (this.poolCache && this.poolCache.has(cacheKey)) {
        return this.poolCache.get(cacheKey);
      }
      
      // Get pool address from factory
      const poolAddress = await this.getPoolAddress(tokenA, tokenB, fee);
      
      // Get pool contract
      const pool = this.getPoolContract(poolAddress);
      
      // Cache the pool
      if (!this.poolCache) {
        this.poolCache = new Map();
      }
      this.poolCache.set(cacheKey, pool);
      
      return pool;
    } catch (error) {
      logger.error(`Error getting pool for tokens ${tokenA} and ${tokenB}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Execute a gasless swap directly on a pool contract
   * 
   * @param {ethers.Contract} pool - Pool contract instance
   * @param {Object} params - Swap parameters
   * @param {string} signature - EIP-712 signature
   * @returns {Promise<Array>} Swap results [amount0, amount1]
   */
  async executePoolGaslessSwap(pool, params, signature, options = {}) {
    try {
      logger.info(`Executing gasless swap directly on pool ${pool.address}`);
      
      // Prepare transaction options
      const txOptions = {};
      if (options.gasLimit) {
        txOptions.gasLimit = options.gasLimit;
      }
      if (options.gasPrice) {
        txOptions.gasPrice = ethers.utils.parseUnits(options.gasPrice.toString(), 'gwei');
      }
      
      // Execute the swap directly on the pool
      return await pool.gaslessSwap(params, signature, txOptions);
    } catch (error) {
      logger.error(`Failed to execute pool gasless swap: ${error.message}`);
      throw error;
    }
  }
}

module.exports = { ContractService };
