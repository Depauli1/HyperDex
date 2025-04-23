/**
 * Provider Manager for handling multiple RPC providers with automatic failover
 */
const { ethers } = require('ethers');
const logger = require('./logger');

class ProviderManager {
  /**
   * Initialize the provider manager with multiple RPC endpoints
   * 
   * @param {Array<string>} rpcUrls - Array of RPC URLs in priority order
   * @param {Object} options - Configuration options
   * @param {number} options.healthCheckIntervalMs - Interval for health checks in ms
   * @param {number} options.maxRetries - Maximum retries before giving up
   * @param {number} options.retryDelayMs - Delay between retries in ms
   */
  constructor(rpcUrls, options = {}) {
    if (!rpcUrls || !Array.isArray(rpcUrls) || rpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be provided');
    }

    this.rpcUrls = rpcUrls;
    this.providers = rpcUrls.map(url => new ethers.providers.JsonRpcProvider(url));
    this.activeProviderIndex = 0;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs || 30000; // 30 seconds
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 1000;
    this.providerHealth = rpcUrls.map(() => ({
      healthy: true,
      lastChecked: Date.now(),
      errorCount: 0,
      latency: 0
    }));

    // Start health check interval
    this.healthCheckInterval = setInterval(() => this.checkProviderHealth(), this.healthCheckIntervalMs);
    this.healthCheckInterval.unref(); // Don't prevent process exit
  }

  /**
   * Get the current active provider
   * 
   * @returns {ethers.providers.JsonRpcProvider} The active provider
   */
  getProvider() {
    return this.providers[this.activeProviderIndex];
  }

  /**
   * Execute a provider method with automatic retries and failover
   * 
   * @param {Function} method - Async function that takes a provider and executes a method
   * @returns {Promise<any>} - Result from the provider method
   */
  async executeWithProvider(method) {
    let retries = 0;
    let lastError = null;

    while (retries <= this.maxRetries) {
      const providerIndex = this.activeProviderIndex;
      const provider = this.providers[providerIndex];

      try {
        const startTime = Date.now();
        const result = await method(provider);
        
        // Update latency metric
        const endTime = Date.now();
        this.providerHealth[providerIndex].latency = endTime - startTime;
        
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(`Provider ${providerIndex} (${this.rpcUrls[providerIndex]}) error: ${error.message}`);
        
        // Mark this provider as potentially unhealthy
        this.providerHealth[providerIndex].errorCount++;
        
        // Try the next provider
        this.switchToNextHealthyProvider();
        
        // If we've gone through all providers, wait before retrying
        if (this.activeProviderIndex === providerIndex) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
        }
        
        retries++;
      }
    }

    throw new Error(`All providers failed after ${this.maxRetries} retries. Last error: ${lastError?.message}`);
  }

  /**
   * Switch to the next healthy provider
   */
  switchToNextHealthyProvider() {
    const startIndex = this.activeProviderIndex;
    let nextIndex = (startIndex + 1) % this.providers.length;
    
    // Loop through providers until we find a healthy one or come back to where we started
    while (nextIndex !== startIndex) {
      if (this.providerHealth[nextIndex].healthy) {
        logger.info(`Switching from provider ${startIndex} to ${nextIndex}`);
        this.activeProviderIndex = nextIndex;
        return;
      }
      nextIndex = (nextIndex + 1) % this.providers.length;
    }
    
    // If we couldn't find a healthy provider, reset the current one
    logger.warn('No healthy providers found, resetting the current provider');
    this.resetProvider(startIndex);
  }

  /**
   * Reset a provider by recreating it
   * 
   * @param {number} index - Provider index to reset
   */
  resetProvider(index) {
    if (index >= 0 && index < this.providers.length) {
      logger.info(`Resetting provider ${index} (${this.rpcUrls[index]})`);
      this.providers[index] = new ethers.providers.JsonRpcProvider(this.rpcUrls[index]);
      this.providerHealth[index].errorCount = 0;
      this.providerHealth[index].healthy = true;
    }
  }

  /**
   * Check the health of all providers
   */
  async checkProviderHealth() {
    for (let i = 0; i < this.providers.length; i++) {
      try {
        const startTime = Date.now();
        await this.providers[i].getBlockNumber();
        
        // Provider is healthy
        const endTime = Date.now();
        this.providerHealth[i] = {
          healthy: true,
          lastChecked: endTime,
          errorCount: 0,
          latency: endTime - startTime
        };
        
        logger.debug(`Provider ${i} (${this.rpcUrls[i]}) is healthy, latency: ${endTime - startTime}ms`);
      } catch (error) {
        // Provider is unhealthy
        this.providerHealth[i].healthy = false;
        this.providerHealth[i].lastChecked = Date.now();
        this.providerHealth[i].errorCount++;
        
        logger.warn(`Provider ${i} (${this.rpcUrls[i]}) is unhealthy: ${error.message}`);
        
        // If this is the active provider, switch to another one
        if (i === this.activeProviderIndex) {
          this.switchToNextHealthyProvider();
        }
        
        // After several failures, try resetting the provider
        if (this.providerHealth[i].errorCount > 5) {
          this.resetProvider(i);
        }
      }
    }
  }

  /**
   * Get health status of all providers
   * 
   * @returns {Array<Object>} Array of provider health statuses
   */
  getProvidersHealth() {
    return this.providerHealth.map((health, i) => ({
      url: this.rpcUrls[i].replace(/^(https?:\/\/[^:@\/]+):[^@\/]+@/, '$1:****@'), // Mask API keys
      active: i === this.activeProviderIndex,
      ...health
    }));
  }

  /**
   * Properly clean up resources
   */
  cleanup() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    // Remove all listeners
    for (const provider of this.providers) {
      if (provider.removeAllListeners) {
        provider.removeAllListeners();
      }
    }
  }
}

module.exports = ProviderManager;
