const { ethers } = require('ethers');
const logger = require('./logger');
const { 
  GAS_PRICE_BUFFER_PERCENT, 
  MAX_GAS_PRICE, 
  PRIORITY_LEVELS 
} = require('../config/constants');

// Economic model and time-sensitivity parameters
const GAS_PRICE_ECONOMIC_MODEL = process.env.GAS_PRICE_ECONOMIC_MODEL || 'legacy';
const TIME_SENSITIVITY_INTERVAL_MS = process.env.GAS_PRICE_TIME_SENSITIVITY_INTERVAL_MS ? parseInt(process.env.GAS_PRICE_TIME_SENSITIVITY_INTERVAL_MS) : 60000;
const TIME_SENSITIVITY_INCREMENT_PERCENT = process.env.GAS_PRICE_TIME_SENSITIVITY_INCREMENT_PERCENT ? parseFloat(process.env.GAS_PRICE_TIME_SENSITIVITY_INCREMENT_PERCENT) : 10;

/**
 * Gas price oracle to get optimal gas prices based on network conditions
 */
class GasPriceOracle {
  constructor(provider) {
    this.provider = provider;
    this.lastFetchTime = 0;
    this.cachedGasPrice = null;
    this.cacheValidityMs = 30000; // 30 seconds
  }

  /**
   * Get current gas price with caching for efficiency
   * 
   * @returns {Promise<BigNumber>} - Current gas price in wei
   */
  async getGasPrice() {
    const now = Date.now();
    
    // Use cached value if available and still fresh
    if (this.cachedGasPrice && (now - this.lastFetchTime < this.cacheValidityMs)) {
      return this.cachedGasPrice;
    }
    
    try {
      // Get raw gas price based on economic model
      let rawGasPrice;
      if (GAS_PRICE_ECONOMIC_MODEL.toLowerCase() === 'eip1559') {
        const feeData = await this.provider.getFeeData();
        rawGasPrice = feeData.maxFeePerGas || feeData.gasPrice;
      } else {
        rawGasPrice = await this.provider.getGasPrice();
      }
      // Add buffer for smoother confirmations
      const bufferedGasPrice = rawGasPrice.mul(100 + GAS_PRICE_BUFFER_PERCENT).div(100);
      // Ensure gas price doesn't exceed maximum
      this.cachedGasPrice = bufferedGasPrice.gt(MAX_GAS_PRICE)
        ? ethers.BigNumber.from(MAX_GAS_PRICE)
        : bufferedGasPrice;
        
      this.lastFetchTime = now;
      return this.cachedGasPrice;
    } catch (error) {
      logger.error(`Failed to fetch gas price: ${error.message}`);
      
      // Fallback to last known price or estimate
      if (this.cachedGasPrice) {
        return this.cachedGasPrice;
      }
      
      // If no cached value, use a reasonable default
      return ethers.utils.parseUnits("50", "gwei");
    }
  }

  /**
   * Get gas price adjusted for a specific priority level
   * 
   * @param {string} priority - Priority level (LOW, MEDIUM, HIGH, URGENT)
   * @returns {Promise<BigNumber>} - Priority-adjusted gas price
   */
  async getGasPriceForPriority(priority = 'MEDIUM') {
    const now = Date.now();
    const baseGasPrice = await this.getGasPrice();
    let timeSensitiveGasPrice = baseGasPrice;
    if (TIME_SENSITIVITY_INTERVAL_MS > 0) {
      const elapsed = now - this.lastFetchTime;
      const intervals = Math.floor(elapsed / TIME_SENSITIVITY_INTERVAL_MS);
      if (intervals > 0) {
        const bumpMultiplier = 1 + (TIME_SENSITIVITY_INCREMENT_PERCENT / 100) * intervals;
        timeSensitiveGasPrice = baseGasPrice.mul(Math.floor(bumpMultiplier * 100)).div(100);
      }
    }
    const multiplier = PRIORITY_LEVELS[priority] || PRIORITY_LEVELS.MEDIUM;
    const adjustedGasPrice = timeSensitiveGasPrice.mul(Math.floor(multiplier * 100)).div(100);
    return adjustedGasPrice.gt(MAX_GAS_PRICE)
      ? ethers.BigNumber.from(MAX_GAS_PRICE)
      : adjustedGasPrice;
  }
}

module.exports = { GasPriceOracle };
