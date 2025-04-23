/**
 * Mock implementation of the HyperDex Relayer SDK for testing
 */
class HyperDexRelayerSDKMock {
  constructor(config = {}) {
    this.config = {
      baseUrl: config.baseUrl || 'http://localhost:3000',
      version: config.version || 'v1',
      chainId: config.chainId || 31337,
      hyperdexAddress: config.hyperdexAddress || '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    };
    
    // Mock transaction cache
    this.transactions = new Map();
    
    // Mock state for testing
    this.shouldFailNextRequest = false;
    this.networkError = false;
    this.invalidSignature = false;
  }
  
  /**
   * Set the mock to return an API error on the next request
   */
  setNextRequestToFail() {
    this.shouldFailNextRequest = true;
  }
  
  /**
   * Set the mock to simulate a network error
   */
  setNetworkError(hasError) {
    this.networkError = hasError;
  }
  
  /**
   * Set the mock to return an invalid signature error
   */
  setInvalidSignature(invalid) {
    this.invalidSignature = invalid;
  }
  
  /**
   * Generate random transaction hash for testing
   * @returns {string} Random transaction hash
   */
  _generateTxHash() {
    return '0x' + '1'.repeat(64);
  }
  
  /**
   * Sign a gasless swap using the provided signer
   * 
   * @param {Object} signer - Ethers wallet or signer
   * @param {Object} params - Swap parameters
   * @returns {Promise<string>} EIP-712 signature
   */
  async signGaslessSwap(signer, params) {
    // Check if testing error cases
    if (this.invalidSignature) {
      return 'invalidSignature';
    }
    
    // In tests, actually call the signer's signTypedData method
    if (signer && typeof signer._signTypedData === 'function') {
      const domain = {
        name: 'HyperDex Protocol',
        version: '1',
        chainId: this.config.chainId,
        verifyingContract: this.config.hyperdexAddress
      };
      
      const types = {
        GaslessSwap: [
          { name: 'trader', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'nonce', type: 'uint256' }
        ]
      };
      
      return signer._signTypedData(domain, types, params);
    }
    
    // For non-wallet mock tests, return a mock signature
    return '0x' + '2'.repeat(130);
  }
  
  /**
   * Submit a gasless swap to the relayer
   * 
   * @param {Object} options - Submission options
   * @param {Object} options.params - Swap parameters
   * @param {string} options.signature - EIP-712 signature
   * @param {string} options.priority - Priority level (low, medium, high)
   * @returns {Promise<Object>} Response with transaction hash
   */
  async submitGaslessSwap({ params, signature, priority = 'medium' }) {
    // Simulate network error
    if (this.networkError) {
      throw new Error('Network error: Failed to connect to relayer API');
    }
    
    // Simulate API error
    if (this.shouldFailNextRequest) {
      this.shouldFailNextRequest = false; // Reset for next call
      throw new Error('Invalid signature');
    }
    
    // Validate parameters
    if (!params || !signature) {
      throw new Error('Missing required parameters');
    }
    
    // Generate mock transaction hash
    const txHash = this._generateTxHash();
    
    // Store in mock transactions cache
    this.transactions.set(txHash, {
      params,
      signature,
      priority,
      status: 'submitted',
      submittedAt: Date.now()
    });
    
    // Return mock response
    return {
      status: 'submitted',
      transactionHash: txHash
    };
  }
  
  /**
   * Get the status of a previously submitted transaction
   * 
   * @param {string} txHash - Transaction hash
   * @returns {Promise<Object>} Transaction status
   */
  async getTransactionStatus(txHash) {
    // Simulate network error
    if (this.networkError) {
      throw new Error('Network error: Failed to connect to relayer API');
    }
    
    // Check if transaction exists
    if (!this.transactions.has(txHash)) {
      throw new Error('Transaction not found');
    }
    
    const tx = this.transactions.get(txHash);
    
    // Return mock status response
    return {
      status: tx.status || 'pending',
      transactionHash: txHash,
      submittedAt: tx.submittedAt,
      priority: tx.priority
    };
  }
  
  /**
   * Submit and wait for a gasless swap to be confirmed
   * 
   * @param {Object} options - Submission options
   * @returns {Promise<Object>} Confirmed transaction
   */
  async submitAndWaitForGaslessSwap(options) {
    const response = await this.submitGaslessSwap(options);
    
    // Update status to confirmed for testing
    if (this.transactions.has(response.transactionHash)) {
      const tx = this.transactions.get(response.transactionHash);
      tx.status = 'confirmed';
      tx.confirmedAt = Date.now();
    }
    
    return {
      ...response,
      status: 'confirmed',
      blockNumber: 12345678,
      confirmedAt: Date.now()
    };
  }
  
  /**
   * Generate a unique nonce for a transaction
   * 
   * @returns {Promise<string>} Nonce
   */
  async generateNonce() {
    // Return a unique nonce using timestamp plus random value
    return (Math.floor(Date.now() / 1000) + Math.random()).toString();
  }
  
  /**
   * Check health status of the relayer
   * 
   * @returns {Promise<Object>} Health status
   */
  async getHealth() {
    if (this.networkError) {
      throw new Error('Network error: Failed to connect to relayer API');
    }
    
    return {
      status: 'healthy',
      version: '1.0.0',
      uptime: 123456
    };
  }
}

module.exports = HyperDexRelayerSDKMock;
