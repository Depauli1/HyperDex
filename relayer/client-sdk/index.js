const { ethers } = require('ethers');
const HyperDexABI = require('../abi/HyperDex.json');
const { randomBytes } = require('crypto');
const axios = require('axios');

/**
 * HyperDex Relayer SDK for client applications
 */
class HyperDexRelayerSDK {
  /**
   * Initialize the SDK
   * 
   * @param {Object} config - Configuration options
   * @param {string} config.relayerUrl - Base URL of the relayer service
   * @param {string} config.hyperDexAddress - Address of the HyperDex contract
   * @param {ethers.providers.Provider} config.provider - Ethereum provider
   */
  constructor({ relayerUrl, hyperDexAddress, provider }) {
    this.relayerUrl = relayerUrl.endsWith('/') 
      ? relayerUrl.slice(0, -1) 
      : relayerUrl;
    this.hyperDexAddress = hyperDexAddress;
    this.provider = provider;
    
    // Initialize contract interface for reading
    try {
      this.hyperDex = new ethers.Contract(
        hyperDexAddress,
        HyperDexABI,
        provider
      );
    } catch (error) {
      // Skip contract setup if provider is invalid (e.g., in tests)
      this.hyperDex = null;
    }
    
    // EIP-712 domain
    this.domain = null;
    this.initialized = false;
  }

  /**
   * Initialize the SDK by setting up the EIP-712 domain
   * 
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      const chainId = (await this.provider.getNetwork()).chainId;
      
      this.domain = {
        name: "HyperDex Protocol",
        version: "1",
        chainId,
        verifyingContract: this.hyperDexAddress
      };
      
      this.initialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize SDK: ${error.message}`);
    }
  }

  /**
   * Get the current nonce for a user
   * 
   * @param {string} userAddress - Ethereum address of the user
   * @returns {Promise<string>} - Current nonce as string
   */
  async getNonce(userAddress) {
    try {
      const nonce = await this.hyperDex.getNonce(userAddress);
      return nonce.toString();
    } catch (error) {
      throw new Error(`Failed to get nonce: ${error.message}`);
    }
  }

  /**
   * Generate a unique nonce for a transaction
   * 
   * @returns {string} - A unique nonce
   */
  generateNonce() {
    return ethers.BigNumber.from(randomBytes(32)).toString();
  }

  /**
   * Create parameters for a gasless swap
   * 
   * @param {Object} options - Swap options
   * @param {string} options.userAddress - User's Ethereum address
   * @param {boolean} options.zeroForOne - Direction of swap (true for token0 to token1)
   * @param {string|ethers.BigNumber} options.amountSpecified - Amount to swap (as string or BigNumber)
   * @param {string|ethers.BigNumber} options.sqrtPriceLimitX96 - Price limit (as string or BigNumber)
   * @param {number} options.deadlineMinutes - Deadline in minutes from now (default: 60)
   * @returns {Promise<Object>} Swap parameters
   */
  async createSwapParams({
    userAddress,
    zeroForOne,
    amountSpecified,
    sqrtPriceLimitX96,
    poolAddress = ethers.constants.AddressZero,
    deadlineMinutes = 60
  }) {
    if (!this.initialized) await this.initialize();
    
    // Get current nonce
    const nonce = await this.getNonce(userAddress);
    
    // Calculate deadline (current time + minutes)
    const deadlineSeconds = Math.floor(Date.now() / 1000) + (deadlineMinutes * 60);
    
    // Format parameters
    return {
      trader: userAddress,
      zeroForOne,
      amountSpecified: amountSpecified.toString(),
      sqrtPriceLimitX96: sqrtPriceLimitX96.toString(),
      poolAddress,
      deadline: deadlineSeconds.toString(),
      nonce
    };
  }

  /**
   * Sign gasless swap parameters
   * 
   * @param {Object} params - Swap parameters from createSwapParams()
   * @param {ethers.Signer} signer - Ethereum signer (wallet) of the user
   * @returns {Promise<string>} Signature
   */
  async signSwap(params, signer) {
    if (!this.initialized) await this.initialize();
    
    // EIP-712 type definitions
    const types = {
      GaslessSwap: [
        { name: "trader", type: "address" },
        { name: "zeroForOne", type: "bool" },
        { name: "amountSpecified", type: "int256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
        { name: "poolAddress", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" }
      ]
    };
    
    // Sign the swap parameters
    return await signer._signTypedData(this.domain, types, params);
  }

  /**
   * Sign gasless swap parameters (alias for signSwap for test compatibility)
   * 
   * @param {ethers.Signer} signer - Ethereum signer (wallet) of the user
   * @param {Object} params - Swap parameters
   * @returns {Promise<string>} Signature
   */
  async signGaslessSwap(signer, params) {
    return this.signSwap(params, signer);
  }

  /**
   * Submit a gasless swap to the relayer
   * 
   * @param {Object} options - Submission options
   * @param {Object} options.params - Swap parameters
   * @param {string} options.signature - EIP-712 signature
   * @param {string} options.priority - Transaction priority (low, medium, high, urgent)
   * @returns {Promise<Object>} Relayer response
   */
  async submitGaslessSwap(params) {
    if (!this.initialized) await this.initialize();
    
    try {
      const response = await fetch(`${this.relayerUrl}/api/swap/gasless`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || response.statusText);
      }
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }

  /**
   * Wait for a transaction to be confirmed
   * 
   * @param {string} txHash - Transaction hash
   * @param {number} maxAttempts - Maximum polling attempts
   * @param {number} pollingInterval - Polling interval in ms
   * @returns {Promise<Object>} Transaction status
   */
  async waitForTransaction(txHash, maxAttempts = 30, pollingInterval = 2000) {
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      const status = await this.getTransactionStatus(txHash);
      
      if (status.status === 'confirmed') {
        return status;
      }
      
      await new Promise(resolve => setTimeout(resolve, pollingInterval));
      attempts++;
    }
    
    throw new Error('Transaction confirmation timed out');
  }

  /**
   * Submit a gasless swap and wait for confirmation
   * 
   * @param {Object} params - Swap parameters with signature
   * @returns {Promise<Object>} Transaction result
   */
  async submitAndWaitForSwap(params) {
    const result = await this.submitGaslessSwap(params);
    return await this.waitForTransaction(result.transactionHash);
  }

  /**
   * Create a signed swap with all necessary parameters
   * 
   * @param {ethers.Signer} signer - User's signer
   * @param {Object} params - Swap parameters
   * @returns {Promise<Object>} Complete signed swap parameters
   */
  async createSignedSwap(signer, params) {
    if (!this.initialized) await this.initialize();
    
    // Add nonce if not provided
    if (!params.nonce) {
      params.nonce = this.generateNonce();
    }
    
    // Sign the parameters
    const signature = await this.signGaslessSwap(signer, params);
    
    // Return complete parameters with signature
    return {
      ...params,
      amountSpecified: params.amountSpecified.toString(),
      sqrtPriceLimitX96: params.sqrtPriceLimitX96.toString(),
      signature
    };
  }

  /**
   * Create, sign, and submit a gasless swap in one operation
   * 
   * @param {Object} options - Swap options
   * @param {ethers.Signer} options.signer - User's signer (wallet)
   * @param {boolean} options.zeroForOne - Direction of swap
   * @param {string|ethers.BigNumber} options.amountSpecified - Amount to swap
   * @param {string|ethers.BigNumber} options.sqrtPriceLimitX96 - Price limit
   * @param {string} options.priority - Transaction priority
   * @returns {Promise<Object>} Relayer response
   */
  async createAndSubmitSwap({
    signer,
    zeroForOne,
    amountSpecified,
    sqrtPriceLimitX96,
    poolAddress,
    priority = 'medium'
  }) {
    const userAddress = await signer.getAddress();
    
    // Create parameters
    const params = await this.createSwapParams({
      userAddress,
      zeroForOne,
      amountSpecified,
      sqrtPriceLimitX96,
      poolAddress
    });
    
    // Sign parameters
    const signature = await this.signSwap(params, signer);
    
    // Submit to relayer
    return await this.submitGaslessSwap({
      ...params,
      signature,
      priority
    });
  }

  /**
   * Get status of a transaction from the relayer
   * 
   * @param {string} txId - Transaction ID returned from submitGaslessSwap
   * @returns {Promise<Object>} Transaction status
   */
  async getTransactionStatus(txId) {
    try {
      const response = await fetch(`${this.relayerUrl}/api/status/${txId}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          return { found: false, error: 'Transaction not found' };
        }
        throw new Error(`Failed to get status: ${response.statusText}`);
      }
      
      const status = await response.json();
      return { found: true, ...status };
    } catch (error) {
      throw new Error(`Failed to get transaction status: ${error.message}`);
    }
  }

  /**
   * Get relayer service status
   * 
   * @returns {Promise<Object>} Service status
   */
  async getRelayerStatus() {
    try {
      const resp = await axios.get(`${this.relayerUrl}/api/health`);
      return resp.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to get relayer status: ${error.response.statusText}`);
      }
      throw new Error(`Failed to get relayer status: ${error.message}`);
    }
  }

  /**
   * Check relayer health (alias for getRelayerStatus for test compatibility)
   */
  async checkRelayerHealth() {
    return this.getRelayerStatus();
  }

  /**
   * Clean up resources used by the SDK
   * This should be called when the SDK is no longer needed
   * to prevent memory leaks in tests and applications
   */
  cleanup() {
    // Remove any event listeners from the provider
    if (this.provider && typeof this.provider.removeAllListeners === 'function') {
      this.provider.removeAllListeners();
    }
    
    // Reset contract instances
    if (this.hyperDex) {
      this.hyperDex.removeAllListeners();
      this.hyperDex = null;
    }
    
    // Clear any cached data
    this.initialized = false;
    this.domain = null;
  }
}

module.exports = HyperDexRelayerSDK;
