const { ethers } = require('ethers');
const logger = require('../utils/logger');

/**
 * Load relayer wallet from environment or keystore
 * 
 * @param {ethers.providers.Provider} provider - Ethereum provider
 * @returns {Promise<ethers.Wallet>} Configured wallet instance
 */
async function loadWallet(provider) {
  try {
    let wallet;
    
    // Check for private key in environment (not recommended for production)
    if (process.env.PRIVATE_KEY) {
      logger.info('Loading wallet from environment private key');
      wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    } 
    // Check for encrypted JSON keystore
    else if (process.env.KEYSTORE_PATH) {
      if (!process.env.KEYSTORE_PASSWORD) {
        throw new Error('KEYSTORE_PASSWORD is required when using KEYSTORE_PATH');
      }
      
      logger.info(`Loading wallet from keystore: ${process.env.KEYSTORE_PATH}`);
      // In production, would require user input or secure secret manager
      const fs = require('fs');
      const keystore = fs.readFileSync(process.env.KEYSTORE_PATH, 'utf8');
      wallet = await ethers.Wallet.fromEncryptedJson(keystore, process.env.KEYSTORE_PASSWORD);
      wallet = wallet.connect(provider);
    } 
    // Create a new wallet for development (not recommended for production)
    else {
      logger.warn('No wallet configuration found, creating random wallet (FOR DEVELOPMENT ONLY)');
      wallet = ethers.Wallet.createRandom().connect(provider);
    }
    
    const address = await wallet.getAddress();
    logger.info(`Wallet loaded with address: ${address}`);
    
    // Skip balance check in test environment
    if (process.env.NODE_ENV !== 'test') {
      try {
        const balance = await provider.getBalance(address);
        logger.info(`Wallet balance: ${ethers.utils.formatEther(balance)} ETH`);
        if (balance.isZero()) {
          logger.warn('Wallet has zero balance - transactions will fail!');
        }
      } catch (balanceError) {
        logger.warn(`Failed to get wallet balance: ${balanceError.message}`);
      }
    } else {
      logger.warn('Skipping balance check in test environment');
    }
    
    return wallet;
  } catch (error) {
    logger.error(`Failed to load wallet: ${error.message}`);
    throw error;
  }
}

module.exports = { loadWallet };
