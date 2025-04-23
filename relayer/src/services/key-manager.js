const fs = require('fs');
const logger = require('../utils/logger');

/**
 * KeyManager handles secure key loading and rotation
 */
class KeyManager {
  /**
   * @param {Object} options
   * @param {string} options.keystorePath - Path to encrypted JSON keystore
   * @param {string} options.keystorePassword - Password for keystore
   * @param {number} options.rotationInterval - Rotation interval in ms
   */
  constructor(options = {}) {
    this.keystorePath = options.keystorePath || process.env.KEYSTORE_PATH;
    this.keystorePassword = options.keystorePassword || process.env.KEYSTORE_PASSWORD;
    this.rotationInterval = options.rotationInterval || parseInt(process.env.KEY_ROTATION_INTERVAL_MS) || 86400000;
    this.currentKey = null;
    this.rotationTimeout = null;
  }

  /** Initialize manager and schedule rotation */
  async initialize() {
    this.currentKey = await this.loadKey();
    logger.info('KeyManager initialized');
    this.scheduleRotation();
  }

  /** Load key from keystore or env */
  async loadKey() {
    // Encrypted JSON keystore
    if (this.keystorePath) {
      if (!this.keystorePassword) {
        throw new Error('KEYSTORE_PASSWORD is required when using KEYSTORE_PATH');
      }
      logger.info(`Loading key from keystore: ${this.keystorePath}`);
      const keystore = fs.readFileSync(this.keystorePath, 'utf8');
      const { ethers } = require('ethers');
      const wallet = await ethers.Wallet.fromEncryptedJson(keystore, this.keystorePassword);
      return wallet.privateKey;
    }

    // Fallback: environment private key
    if (process.env.PRIVATE_KEY) {
      logger.info('Loading private key from environment');
      const key = process.env.PRIVATE_KEY.startsWith('0x')
        ? process.env.PRIVATE_KEY
        : '0x' + process.env.PRIVATE_KEY;
      return key;
    }

    throw new Error('No key configuration found');
  }

  /** Schedule next rotation */
  scheduleRotation() {
    if (this.rotationInterval > 0) {
      this.rotationTimeout = setTimeout(async () => {
        try {
          await this.rotateKey();
        } catch (err) {
          logger.error(`Key rotation failed: ${err.message}`);
        }
        this.scheduleRotation();
      }, this.rotationInterval);
      logger.info(`Next key rotation in ${this.rotationInterval} ms`);
    }
  }

  /** Force key rotation immediately */
  async rotateKey() {
    logger.info('Rotating key...');
    this.currentKey = await this.loadKey();
    logger.info('Key rotation complete');
  }

  /** Get the current private key */
  getCurrentKey() {
    return this.currentKey;
  }

  /** Get rotation status */
  getStatus() {
    const next = this.rotationTimeout ? Date.now() + this.rotationInterval : null;
    return { configured: !!this.currentKey, nextRotation: next };
  }

  /** Cleanup resources */
  async cleanup() {
    if (this.rotationTimeout) {
      clearTimeout(this.rotationTimeout);
    }
    logger.info('KeyManager cleanup complete');
  }
}

module.exports = KeyManager;
