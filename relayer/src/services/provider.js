const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ProviderManager = require('../utils/provider-manager');

/**
 * Initialize and configure the blockchain provider
 * 
 * @returns {ethers.providers.Provider | ProviderManager} Configured provider or provider manager
 */
function initializeProvider() {
  try {
    // Initialize array for storing multiple RPC URLs
    const rpcUrls = [];

    // Test environment: use static network config to skip auto network detection
    if (process.env.NODE_ENV === 'test') {
      const url = process.env.ETHEREUM_RPC_URL || 'http://localhost:8545';
      logger.info(`Test mode: connecting to RPC: ${url}`);
      rpcUrls.push(url);

      if (process.env.ETHEREUM_FALLBACK_RPC_URL) {
        rpcUrls.push(process.env.ETHEREUM_FALLBACK_RPC_URL);
        logger.info(`Test mode: added fallback RPC: ${process.env.ETHEREUM_FALLBACK_RPC_URL}`);
      }

      const providerManager = new ProviderManager(rpcUrls, {
        healthCheckIntervalMs: 60000, // Check every minute in test mode
        maxRetries: 3,
        retryDelayMs: 1000
      });

      // For backward compatibility, add the block event listener
      providerManager.getProvider().on('block', (blockNumber) => {
        logger.debug(`New block: ${blockNumber}`);
      });

      return providerManager;
    }

    // Get provider based on environment
    if (process.env.ETHEREUM_RPC_URL) {
      logger.info(`Connecting to custom RPC: ${process.env.ETHEREUM_RPC_URL}`);
      rpcUrls.push(process.env.ETHEREUM_RPC_URL);

      // Add fallback RPC URLs if available
      if (process.env.ETHEREUM_FALLBACK_RPC_URL) {
        rpcUrls.push(process.env.ETHEREUM_FALLBACK_RPC_URL);
        logger.info(`Added fallback RPC: ${process.env.ETHEREUM_FALLBACK_RPC_URL}`);
      }

      if (process.env.ETHEREUM_FALLBACK_RPC_URL_2) {
        rpcUrls.push(process.env.ETHEREUM_FALLBACK_RPC_URL_2);
        logger.info(`Added second fallback RPC: ${process.env.ETHEREUM_FALLBACK_RPC_URL_2}`);
      }
    } else if (process.env.INFURA_PROJECT_ID) {
      logger.info(`Connecting to Infura (network: ${process.env.ETHEREUM_NETWORK || 'mainnet'})`);
      // Add Infura endpoints
      const network = process.env.ETHEREUM_NETWORK || 'mainnet';
      rpcUrls.push(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`);

      // Add any backup providers
      if (process.env.ALCHEMY_API_KEY) {
        rpcUrls.push(`https://eth-${network}.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`);
        logger.info(`Added Alchemy as fallback provider for ${network}`);
      }
    } else if (process.env.ALCHEMY_API_KEY) {
      logger.info(`Connecting to Alchemy (network: ${process.env.ETHEREUM_NETWORK || 'mainnet'})`);
      const network = process.env.ETHEREUM_NETWORK || 'mainnet';
      rpcUrls.push(`https://eth-${network}.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`);

      // Add any backup providers
      if (process.env.INFURA_PROJECT_ID) {
        rpcUrls.push(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`);
        logger.info(`Added Infura as fallback provider for ${network}`);
      }
    } else {
      // Fallback to local provider for development
      logger.warn('No provider configuration found, using default localhost:8545');
      rpcUrls.push('http://localhost:8545');
    }

    // Make sure we have at least one RPC URL
    if (rpcUrls.length === 0) {
      logger.error('No RPC URLs configured');
      throw new Error('Provider configuration error: No RPC URLs provided');
    }

    // Create provider manager with the collected RPC URLs
    const providerManager = new ProviderManager(rpcUrls, {
      healthCheckIntervalMs: process.env.PROVIDER_HEALTH_CHECK_INTERVAL_MS || 30000,
      maxRetries: process.env.PROVIDER_MAX_RETRIES || 3,
      retryDelayMs: process.env.PROVIDER_RETRY_DELAY_MS || 1000
    });

    // For backward compatibility, add the block event listener
    providerManager.getProvider().on('block', (blockNumber) => {
      logger.debug(`New block: ${blockNumber}`);
    });

    logger.info(`Provider Manager initialized with ${rpcUrls.length} RPC endpoints`);
    return providerManager;
  } catch (error) {
    logger.error(`Failed to initialize provider: ${error.message}`);
    throw error;
  }
}

/**
 * Get the active provider from a provider manager or return the provider directly
 * 
 * @param {ProviderManager|ethers.providers.Provider} providerOrManager - Provider or provider manager
 * @returns {ethers.providers.Provider} The active provider
 */
function getActiveProvider(providerOrManager) {
  if (providerOrManager instanceof ProviderManager) {
    return providerOrManager.getProvider();
  }
  return providerOrManager;
}

/**
 * Execute a method with provider failover if using a ProviderManager
 * 
 * @param {ProviderManager|ethers.providers.Provider} providerOrManager - Provider or provider manager
 * @param {Function} method - Method to execute that takes a provider as its argument
 * @returns {Promise<any>} Result from the method execution
 */
async function executeWithProvider(providerOrManager, method) {
  if (providerOrManager instanceof ProviderManager) {
    return providerOrManager.executeWithProvider(method);
  }
  return method(providerOrManager);
}

/**
 * Clean up provider resources
 * 
 * @param {ProviderManager|ethers.providers.Provider} providerOrManager - Provider or provider manager
 */
function cleanupProvider(providerOrManager) {
  if (providerOrManager instanceof ProviderManager) {
    providerOrManager.cleanup();
  } else if (providerOrManager && providerOrManager.removeAllListeners) {
    providerOrManager.removeAllListeners();
  }
}

module.exports = { 
  initializeProvider,
  getActiveProvider,
  executeWithProvider,
  cleanupProvider
};
