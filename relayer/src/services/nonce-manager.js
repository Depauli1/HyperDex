const { ethers } = require('ethers');

/**
 * Manages transaction nonces to avoid collisions and ensure proper sequencing
 */
class NonceManager {
  /**
   * Initialize the nonce manager
   * @param {ethers.providers.Provider} provider - Ethereum provider
   * @param {ethers.Wallet} wallet - Wallet used for sending transactions
   */
  constructor(provider, wallet) {
    this.provider = provider;
    this.wallet = wallet;
    this.nonceCache = new Map(); // address -> next nonce
    this.reservations = new Map(); // txId -> { address, nonce }
    this.usedNonces = new Map(); // address -> Set of used nonces
    this.failedNonces = new Map(); // address -> Set of failed nonces (available for reuse)
    this.lockPromises = new Map(); // address -> Promise (for concurrency control)
  }

  /**
   * Get the next available nonce for an address
   * @param {string} address - Ethereum address
   * @returns {Promise<number>} - The next available nonce
   */
  async getNextNonce(address) {
    const targetAddress = ethers.utils.getAddress(address || this.wallet.address);
    
    // Initialize lock if it doesn't exist
    if (!this.lockPromises.has(targetAddress)) {
      this.lockPromises.set(targetAddress, Promise.resolve());
    }
    
    // Get exclusive access to nonce
    const lockPromise = this.lockPromises.get(targetAddress);
    let releaseLock;
    
    const newLockPromise = new Promise(resolve => {
      releaseLock = resolve;
    });
    
    try {
      // Wait for lock
      await lockPromise;
      
      // Update lock
      this.lockPromises.set(targetAddress, newLockPromise);
      
      // Check for failed nonces that can be reused
      if (this.failedNonces.has(targetAddress) && this.failedNonces.get(targetAddress).size > 0) {
        const failedNoncesSet = this.failedNonces.get(targetAddress);
        const nonce = Math.min(...failedNoncesSet);
        failedNoncesSet.delete(nonce);
        
        // Initialize or update used nonces for this address
        if (!this.usedNonces.has(targetAddress)) {
          this.usedNonces.set(targetAddress, new Set());
        }
        this.usedNonces.get(targetAddress).add(nonce);
        
        return nonce;
      }
      
      // Get or initialize nonce
      const nonce = await this.getNonce(targetAddress);
      return nonce;
    } finally {
      // Release lock
      releaseLock();
    }
  }

  /**
   * Get a nonce for an address, incrementing the cached nonce
   * @param {string} address - Ethereum address
   * @returns {Promise<number>} - The next nonce
   */
  async getNonce(address) {
    try {
      const targetAddress = ethers.utils.getAddress(address || this.wallet.address);
      
      // Initialize nonce if not in cache
      if (!this.nonceCache.has(targetAddress)) {
        const networkNonce = await this.provider.getTransactionCount(targetAddress, 'pending');
        this.nonceCache.set(targetAddress, networkNonce);
      }
      
      // Initialize usedNonces if it doesn't exist
      if (!this.usedNonces.has(targetAddress)) {
        this.usedNonces.set(targetAddress, new Set());
      }
      
      // Get and increment nonce
      const nonce = this.nonceCache.get(targetAddress);
      this.nonceCache.set(targetAddress, nonce + 1);
      
      // Record this nonce as used
      this.usedNonces.get(targetAddress).add(nonce);
      
      return nonce;
    } catch (error) {
      throw new Error(`Failed to get next nonce: ${error.message}`);
    }
  }

  /**
   * Reserve a specific nonce for a transaction
   * @param {string} address - Ethereum address 
   * @param {string} txId - Transaction ID
   * @param {number} [specificNonce] - Optional specific nonce to reserve
   * @returns {Promise<number>} - The reserved nonce
   */
  async reserveNonce(address, txId, specificNonce = null) {
    try {
      const targetAddress = ethers.utils.getAddress(address || this.wallet.address);
      
      // Use provided nonce or get next available nonce
      let nonce;
      if (specificNonce !== null) {
        nonce = specificNonce;
        
        // If a specific nonce is provided, update the nonce cache if needed
        if (!this.nonceCache.has(targetAddress)) {
          // Initialize from network
          const networkNonce = await this.provider.getTransactionCount(targetAddress, 'pending');
          this.nonceCache.set(targetAddress, networkNonce);
        }
        
        // Update the nonceCache if the specific nonce is higher than current value
        const currentNonce = this.nonceCache.get(targetAddress);
        if (specificNonce >= currentNonce) {
          this.nonceCache.set(targetAddress, specificNonce + 1);
        }
      } else {
        nonce = await this.getNextNonce(targetAddress);
      }
      
      // Store reservation
      this.reservations.set(txId, { address: targetAddress, nonce });
      
      // Mark this nonce as used
      if (!this.usedNonces.has(targetAddress)) {
        this.usedNonces.set(targetAddress, new Set());
      }
      this.usedNonces.get(targetAddress).add(nonce);
      
      return nonce;
    } catch (error) {
      throw new Error(`Failed to reserve nonce: ${error.message}`);
    }
  }

  /**
   * Release a reserved nonce
   * @param {string} txId - Transaction ID
   */
  async releaseNonce(txId) {
    if (this.reservations.has(txId)) {
      const { address, nonce } = this.reservations.get(txId);
      
      // Remove from reservations
      this.reservations.delete(txId);
      
      // Add to failed nonces for potential reuse
      if (!this.failedNonces.has(address)) {
        this.failedNonces.set(address, new Set());
      }
      this.failedNonces.get(address).add(nonce);
      
      // Remove from used nonces if present
      if (this.usedNonces.has(address)) {
        this.usedNonces.get(address).delete(nonce);
      }
    }
  }

  /**
   * Mark a transaction as failed to allow nonce reuse
   * @param {string} txId - Transaction ID
   */
  async markTransactionFailed(txId) {
    await this.releaseNonce(txId);
  }

  /**
   * Reset nonce counter to network-confirmed value
   * @param {string} address - Ethereum address
   * @returns {Promise<number>} - The new nonce value
   */
  async resetNonce(address) {
    try {
      const targetAddress = ethers.utils.getAddress(address || this.wallet.address);
      
      // Get latest nonce from network
      const networkNonce = await this.provider.getTransactionCount(targetAddress, 'pending');
      
      // Reset cache
      this.nonceCache.set(targetAddress, networkNonce);
      
      // Clear all nonce-related data for this address
      if (this.usedNonces.has(targetAddress)) {
        this.usedNonces.set(targetAddress, new Set());
      }
      
      if (this.failedNonces.has(targetAddress)) {
        this.failedNonces.set(targetAddress, new Set());
      }
      
      // Clear any reservations for this address
      for (const [txId, reservation] of this.reservations.entries()) {
        if (reservation.address === targetAddress) {
          this.reservations.delete(txId);
        }
      }
      
      return networkNonce;
    } catch (error) {
      throw new Error(`Failed to reset nonce: ${error.message}`);
    }
  }
}

module.exports = NonceManager;
