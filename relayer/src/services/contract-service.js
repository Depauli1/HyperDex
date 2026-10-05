const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getActiveProvider, executeWithProvider } = require('./provider');

// ABIs are generated from the compiled contracts by
// `node scripts/export-relayer-abis.js` and checked for freshness by
// test/RelayerAbiFreshness.test.js. They are never written by hand: the inline
// fragments this file used to carry had already drifted from the contracts
// (`GaslessSwapParams` without `pool`, a `swap(tokenIn, tokenOut, ...)` method
// that no v3 pool has).
const HyperDexABI = require('../../abi/HyperDex.json');
const FactoryABI = require('../../abi/HyperDexFactory.json');
const PoolABI = require('../../abi/UniswapV3Pool.json');

/**
 * Service to interact with HyperDex smart contracts.
 */
class ContractService {
  constructor({ provider, wallet, hyperDexAddress, factoryAddress }) {
    if (!provider || !wallet || !hyperDexAddress) {
      throw new Error('Missing required parameters for ContractService');
    }

    this.provider = provider;
    this.wallet = wallet;
    this.hyperDexAddress = hyperDexAddress;
    this.factoryAddress = factoryAddress || ethers.constants.AddressZero;

    const activeProvider = getActiveProvider(provider);
    this.hyperDex = new ethers.Contract(hyperDexAddress, HyperDexABI, wallet);
    this.hyperDexRead = new ethers.Contract(hyperDexAddress, HyperDexABI, activeProvider);

    this.factory = factoryAddress
      ? new ethers.Contract(factoryAddress, FactoryABI, activeProvider)
      : null;

    this.poolCache = new Map();

    logger.info(`ContractService initialized with HyperDex at ${hyperDexAddress}`);
  }

  /**
   * Resolves the pool for a token pair and fee tier through the registry.
   *
   * @param {string} tokenA first token address
   * @param {string} tokenB second token address
   * @param {number} fee fee tier (e.g. 3000 for 0.3%)
   * @returns {Promise<ethers.Contract>} a pool contract bound to the wallet
   */
  async getPool(tokenA, tokenB, fee = 3000) {
    if (!ethers.utils.isAddress(tokenA) || !ethers.utils.isAddress(tokenB)) {
      throw new Error('getPool requires two valid token addresses');
    }
    if (!this.factory) {
      throw new Error('No factory address configured; cannot resolve pools');
    }

    const tokens = [tokenA, tokenB].sort();
    const cacheKey = `${tokens[0]}_${tokens[1]}_${fee}`;
    if (this.poolCache.has(cacheKey)) {
      return this.poolCache.get(cacheKey);
    }

    const poolAddress = await executeWithProvider(this.provider, async () =>
      this.factory.getPool(tokenA, tokenB, fee)
    );

    if (!poolAddress || poolAddress === ethers.constants.AddressZero) {
      throw new Error(`No pool found for tokens ${tokenA} and ${tokenB} at fee ${fee}`);
    }

    const activeProvider = getActiveProvider(this.provider);
    const pool = new ethers.Contract(poolAddress, PoolABI, this.wallet);
    pool.readOnly = new ethers.Contract(poolAddress, PoolABI, activeProvider);

    this.poolCache.set(cacheKey, pool);
    return pool;
  }

  /**
   * Submits a trader-signed gasless swap to the gateway.
   *
   * The relayer cannot alter the swap: direction, amount, price bound, deadline
   * and pool are all inside the signed payload and re-checked by the contract.
   *
   * @param {Object} params pool, trader, zeroForOne, amountSpecified,
   *                        sqrtPriceLimitX96, deadline, nonce
   * @param {string} signature the trader's EIP-712 signature
   * @returns {Promise<ethers.providers.TransactionResponse>}
   */
  async executeGaslessSwap(params, signature) {
    const struct = this._validateSwapParams(params);

    try {
      // ethers maps a plain object onto the tuple by field name, so the struct
      // members are passed explicitly and in the contract's order.
      const tx = await this.hyperDex.executeGaslessSwap(struct, signature);
      logger.info(
        `Submitted gasless swap for trader ${struct.trader} via relayer ${this.wallet.address}: ${tx.hash}`
      );
      return tx;
    } catch (error) {
      logger.error(`Error executing gasless swap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validates and normalises gasless swap parameters into the contract struct.
   *
   * @param {Object} params
   * @returns {{pool: string, trader: string, zeroForOne: boolean,
   *            amountSpecified: string, sqrtPriceLimitX96: string,
   *            deadline: string, nonce: string}}
   * @private
   */
  _validateSwapParams(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('Swap parameters are required');
    }

    const required = [
      'pool',
      'trader',
      'amountSpecified',
      'sqrtPriceLimitX96',
      'deadline',
      'nonce'
    ];
    for (const field of required) {
      if (params[field] === undefined || params[field] === null) {
        const hint =
          field === 'pool' && params.poolAddress !== undefined
            ? ' (the signed field is `pool`; `poolAddress` is not part of the EIP-712 struct)'
            : '';
        throw new Error(`Missing required parameter: ${field}${hint}`);
      }
    }

    if (!ethers.utils.isAddress(params.pool)) {
      throw new Error(`Invalid pool address: ${params.pool}`);
    }
    if (!ethers.utils.isAddress(params.trader)) {
      throw new Error(`Invalid trader address: ${params.trader}`);
    }

    const struct = {
      pool: params.pool,
      trader: params.trader,
      zeroForOne: Boolean(params.zeroForOne),
      amountSpecified: ethers.BigNumber.from(params.amountSpecified).toString(),
      sqrtPriceLimitX96: ethers.BigNumber.from(params.sqrtPriceLimitX96).toString(),
      deadline: ethers.BigNumber.from(params.deadline).toString(),
      nonce: ethers.BigNumber.from(params.nonce).toString()
    };

    if (struct.amountSpecified === '0') {
      throw new Error('amountSpecified must be non-zero');
    }

    return struct;
  }

  /** Current nonce the gateway expects for a trader. */
  async getNonce(trader) {
    if (!ethers.utils.isAddress(trader)) {
      throw new Error(`Invalid trader address: ${trader}`);
    }
    return executeWithProvider(this.provider, async () => this.hyperDexRead.getNonce(trader));
  }

  /** Removes every listener this service attached. */
  async cleanup() {
    if (this.hyperDex && this.hyperDex.removeAllListeners) {
      this.hyperDex.removeAllListeners();
    }
    if (this.hyperDexRead && this.hyperDexRead.removeAllListeners) {
      this.hyperDexRead.removeAllListeners();
    }
    if (this.factory && this.factory.removeAllListeners) {
      this.factory.removeAllListeners();
    }
    for (const pool of this.poolCache.values()) {
      if (pool.removeAllListeners) pool.removeAllListeners();
      if (pool.readOnly && pool.readOnly.removeAllListeners) pool.readOnly.removeAllListeners();
    }
    this.poolCache.clear();
  }
}

module.exports = ContractService;
