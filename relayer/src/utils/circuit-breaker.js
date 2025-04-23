/**
 * Circuit breaker to automatically pause service under abnormal conditions
 */
const logger = require('./logger');
const { EventEmitter } = require('events');
const { ethers } = require('ethers');

class CircuitBreaker extends EventEmitter {
  /**
   * Create a circuit breaker instance
   * 
   * @param {Object} options - Configuration options
   * @param {number} options.maxGasPriceGwei - Maximum gas price threshold in Gwei
   * @param {number} options.providerFailureThreshold - Number of provider failures before tripping
   * @param {number} options.resetTimeoutMs - Timeout in ms before auto-reset after tripping
   * @param {number} options.halfOpenTimeMs - Time in ms to stay in half-open state
   */
  constructor(options = {}) {
    super();
    this.options = {
      maxGasPriceGwei: options.maxGasPriceGwei || 
                      Number(process.env.CIRCUIT_BREAKER_MAX_GAS_GWEI || 500),
      providerFailureThreshold: options.providerFailureThreshold || 
                               Number(process.env.CIRCUIT_BREAKER_PROVIDER_FAILURES || 5),
      resetTimeoutMs: options.resetTimeoutMs || 
                     Number(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS || 300000), // 5 minutes
      halfOpenTimeMs: options.halfOpenTimeMs || 
                     Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS || 60000) // 1 minute
    };
    
    // Circuit state
    this.state = 'closed'; // closed (normal), open (paused), half-open (testing)
    this.providerFailures = 0;
    this.lastGasPrice = null;
    this.resetTimer = null;
    this.stateChangeTime = Date.now();
    
    logger.info('Circuit breaker initialized with settings:', {
      maxGasPriceGwei: this.options.maxGasPriceGwei,
      providerFailureThreshold: this.options.providerFailureThreshold,
      resetTimeoutMs: this.options.resetTimeoutMs,
      halfOpenTimeMs: this.options.halfOpenTimeMs
    });
  }
  
  /**
   * Check if circuit is closed (service can operate normally)
   * 
   * @returns {boolean} Whether circuit is closed
   */
  isClosed() {
    return this.state === 'closed';
  }
  
  /**
   * Check if circuit allows operations (either closed or half-open for testing)
   * 
   * @returns {boolean} Whether operations are allowed
   */
  allowsOperations() {
    return this.state === 'closed' || (
      this.state === 'half-open' && 
      (Date.now() - this.stateChangeTime) < this.options.halfOpenTimeMs
    );
  }
  
  /**
   * Record a provider failure
   * 
   * @returns {boolean} Whether circuit has tripped open
   */
  recordProviderFailure() {
    this.providerFailures++;
    logger.warn(`Circuit breaker: Provider failure count: ${this.providerFailures}/${this.options.providerFailureThreshold}`);
    
    if (this.state === 'closed' && this.providerFailures >= this.options.providerFailureThreshold) {
      this._tripOpen('Excessive provider failures');
      return true;
    }
    
    return false;
  }
  
  /**
   * Reset provider failure count
   */
  resetProviderFailures() {
    if (this.providerFailures > 0) {
      logger.info('Circuit breaker: Resetting provider failure count');
      this.providerFailures = 0;
    }
  }
  
  /**
   * Check gas price against threshold
   * 
   * @param {ethers.BigNumber|string|number} gasPrice - Current gas price in wei
   * @returns {boolean} Whether circuit has tripped open
   */
  checkGasPrice(gasPrice) {
    // Convert to BigNumber if not already
    const gasPriceBN = ethers.BigNumber.isBigNumber(gasPrice) 
      ? gasPrice 
      : ethers.BigNumber.from(String(gasPrice));
    
    // Convert to Gwei for comparison
    const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPriceBN, 'gwei'));
    this.lastGasPrice = gasPriceGwei;
    
    if (this.state === 'closed' && gasPriceGwei > this.options.maxGasPriceGwei) {
      this._tripOpen(`Gas price too high: ${gasPriceGwei} Gwei (max: ${this.options.maxGasPriceGwei} Gwei)`);
      return true;
    }
    
    return false;
  }
  
  /**
   * Manually open circuit breaker
   * 
   * @param {string} reason - Reason for opening circuit
   */
  open(reason = 'Manual open') {
    if (this.state !== 'open') {
      this._tripOpen(reason);
    }
  }
  
  /**
   * Manually close circuit breaker
   * 
   * @param {string} reason - Reason for closing circuit
   */
  close(reason = 'Manual close') {
    if (this.state !== 'closed') {
      this._reset(reason);
    }
  }
  
  /**
   * Get current circuit breaker status
   * 
   * @returns {Object} Circuit breaker status
   */
  getStatus() {
    return {
      state: this.state,
      stateChangeTime: new Date(this.stateChangeTime).toISOString(),
      stateAge: Date.now() - this.stateChangeTime,
      providerFailures: this.providerFailures,
      providerFailureThreshold: this.options.providerFailureThreshold,
      lastGasPrice: this.lastGasPrice,
      maxGasPriceGwei: this.options.maxGasPriceGwei
    };
  }
  
  /**
   * Trip circuit open (pause service)
   * 
   * @param {string} reason - Reason for tripping circuit
   * @private
   */
  _tripOpen(reason) {
    if (this.state === 'open') return;
    
    logger.warn(`Circuit breaker: OPEN - ${reason}`);
    this.state = 'open';
    this.stateChangeTime = Date.now();
    
    // Emit event
    this.emit('open', { reason, timestamp: new Date() });
    
    // Set auto-reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    
    this.resetTimer = setTimeout(() => {
      this._toHalfOpen('Auto-reset timeout reached');
    }, this.options.resetTimeoutMs);
  }
  
  /**
   * Set circuit to half-open state for testing
   * 
   * @param {string} reason - Reason for half-open state
   * @private
   */
  _toHalfOpen(reason) {
    if (this.state === 'half-open') return;
    
    logger.info(`Circuit breaker: HALF-OPEN - ${reason}`);
    this.state = 'half-open';
    this.stateChangeTime = Date.now();
    
    // Emit event
    this.emit('half-open', { reason, timestamp: new Date() });
  }
  
  /**
   * Reset circuit to closed state (resume normal operation)
   * 
   * @param {string} reason - Reason for resetting circuit
   * @private
   */
  _reset(reason) {
    logger.info(`Circuit breaker: CLOSED - ${reason}`);
    this.state = 'closed';
    this.stateChangeTime = Date.now();
    this.providerFailures = 0;
    
    // Clear any pending reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    
    // Emit event
    this.emit('close', { reason, timestamp: new Date() });
  }
  
  /**
   * Record a successful operation in half-open state
   * 
   * @param {string} operationType - Type of operation that succeeded
   */
  recordSuccess(operationType) {
    if (this.state === 'half-open') {
      logger.info(`Circuit breaker: Successful operation in half-open state: ${operationType}`);
      this._reset('Successful operation in half-open state');
    }
  }
  
  /**
   * Record a failed operation in half-open state
   * 
   * @param {string} operationType - Type of operation that failed
   * @param {Error} error - Error that occurred
   */
  recordFailure(operationType, error) {
    if (this.state === 'half-open') {
      logger.warn(`Circuit breaker: Failed operation in half-open state: ${operationType}`, error);
      this._tripOpen(`Failed operation in half-open state: ${error.message}`);
    }
  }
}

module.exports = CircuitBreaker;
