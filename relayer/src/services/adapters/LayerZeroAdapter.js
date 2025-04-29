const { ethers } = require('ethers');
const logger = require('../../utils/logger');

/**
 * LayerZero adapter for the bridge relayer
 * Handles cross-chain operations via LayerZero protocol
 */
class LayerZeroAdapter {
  /**
   * Initialize the LayerZero adapter
   * @param {Object} options - Configuration options
   * @param {string} options.endpointAddress - LayerZero endpoint address
   * @param {Object} options.endpointABI - LayerZero endpoint ABI
   * @param {Object} options.wallet - Ethers.js wallet
   * @param {Object} options.chainIdMapping - Mapping of Ethereum chain IDs to LayerZero chain IDs
   * @param {string} options.adapterParams - Adapter parameters for LayerZero (gas limit, etc.)
   * @param {string} options.zroPaymentAddress - Address for ZRO token payment (usually zero address)
   * @param {string} options.remoteContractAddress - Address of the contract on the remote chain
   */
  constructor(options) {
    this.endpointAddress = options.endpointAddress;
    this.endpointABI = options.endpointABI;
    this.wallet = options.wallet;
    this.chainIdMapping = options.chainIdMapping || {};
    this.adapterParams = options.adapterParams || '0x';
    this.zroPaymentAddress = options.zroPaymentAddress || ethers.constants.AddressZero;
    this.remoteContractAddress = options.remoteContractAddress;
    
    // Create contract instance if provider is available
    if (this.wallet && this.wallet.provider) {
      this.endpoint = new ethers.Contract(
        this.endpointAddress,
        this.endpointABI,
        this.wallet
      );
    }
    
    logger.info(`LayerZeroAdapter initialized with endpoint ${this.endpointAddress}`);
  }

  /**
   * Gets the LayerZero chain ID for a given Ethereum chain ID
   * @param {number} chainId - Ethereum chain ID
   * @returns {number} - LayerZero chain ID
   */
  getLzChainId(chainId) {
    const lzChainId = this.chainIdMapping[chainId];
    if (!lzChainId) {
      throw new Error(`No LayerZero mapping found for chain ID: ${chainId}`);
    }
    return lzChainId;
  }

  /**
   * Estimates the fees for a LayerZero transaction
   * @param {Object} request - The bridge request
   * @returns {Promise<string>} - The estimated fee as a hex string
   */
  async quoteFees(request) {
    const dstChainId = this.getLzChainId(request.dstChainId);
    
    // Create payload similar to what would be sent
    const payload = ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint256', 'uint256', 'address', 'uint256', 'uint256'],
      [
        request.user, 
        request.srcChainId,
        request.dstChainId,
        request.token,
        request.amount,
        request.deadline
      ]
    );
    
    // Estimate the fee
    const [nativeFee, zroFee] = await this.endpoint.estimateFees(
      dstChainId,
      this.remoteContractAddress,
      payload,
      false, // Don't pay in ZRO
      this.adapterParams
    );
    
    return nativeFee;
  }

  /**
   * Handles an outbound bridge request
   * @param {Object} request - The bridge request
   * @param {string} requestId - The unique ID of the request
   * @returns {Promise<string>} - The LayerZero message ID (or transaction hash)
   */
  async bridgeOut(request, requestId) {
    const dstChainId = this.getLzChainId(request.dstChainId);
    
    logger.info(`Initiating LayerZero message for request ${requestId} to chain ${dstChainId}`);
    
    // Note: In a real implementation, the contract would handle this
    // This is just a reference for how the contract interaction would work
    
    // Create a unique message identifier
    const messageId = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'uint16', 'address', 'uint256'],
        [requestId, dstChainId, request.user, request.amount]
      )
    );
    
    // Encode the payload with request data and ID
    const payload = ethers.utils.defaultAbiCoder.encode(
      ['tuple(uint256,uint256,uint256,address,uint256,address,uint256,uint256)', 'bytes32'],
      [
        [
          request.id,
          request.srcChainId,
          request.dstChainId,
          request.token,
          request.amount,
          request.user,
          request.deadline,
          request.fee
        ],
        requestId
      ]
    );
    
    // Destination address as bytes (in a real scenario this would be the adapter on the other chain)
    const dstAddress = ethers.utils.defaultAbiCoder.encode(
      ['address'],
      [this.remoteContractAddress]
    );
    
    // Send the message via LayerZero
    const tx = await this.endpoint.send(
      dstChainId,
      dstAddress,
      payload,
      this.wallet.address, // refund address
      this.zroPaymentAddress,
      this.adapterParams,
      { value: request.fee }
    );
    
    const receipt = await tx.wait();
    
    logger.info(`LayerZero message sent with tx hash: ${receipt.transactionHash}`);
    
    // Return the message ID
    return messageId;
  }

  /**
   * Waits for a LayerZero message to be delivered
   * @param {string} messageId - The message ID to monitor
   * @param {number} dstChainId - The destination chain ID
   * @returns {Promise<boolean>} - True if delivered successfully
   */
  async waitForMessageDelivery(messageId, dstChainId) {
    logger.info(`Waiting for LayerZero message ${messageId} delivery to chain ${dstChainId}`);
    
    // In a real implementation, this would:
    // 1. Check the destination chain for the delivered message
    // 2. Wait for a sufficient number of confirmations
    // 3. Return success/failure status
    
    // For this scaffold, we'll simulate delivery
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    logger.info(`Message ${messageId} delivered to chain ${dstChainId}`);
    
    return true;
  }

  /**
   * Fetches the proof for a LayerZero message
   * @param {Object} request - The bridge request
   * @param {string} requestId - The unique request ID
   * @param {string} messageId - The LayerZero message ID
   * @returns {Promise<string>} - The proof data (empty for LayerZero as proof is handled internally)
   */
  async fetchProof(request, requestId, messageId) {
    // LayerZero handles proof verification internally,
    // so we don't need to provide additional proof data
    // However, our BridgeRouter interface expects a proof, so we return an empty one
    return '0x';
  }

  /**
   * Completes the bridge on the destination chain
   * @param {Object} request - The bridge request
   * @param {string} requestId - The unique request ID
   * @param {string} proof - The proof data (unused for LayerZero)
   * @param {Object} bridgeRouter - The BridgeRouter contract instance
   * @returns {Promise<Object>} - The transaction receipt
   */
  async bridgeIn(request, requestId, proof, bridgeRouter) {
    logger.info(`Completing bridge on destination chain for request ${requestId}`);
    
    // For LayerZero, the message is delivered automatically to the receiver contract
    // But our architecture requires explicit completion via BridgeRouter
    
    // Call the BridgeRouter's completeBridge function
    const tx = await bridgeRouter.completeBridge(
      request,
      requestId,
      proof || '0x',
      { gasLimit: 500000 }
    );
    
    const receipt = await tx.wait();
    
    logger.info(`Bridge completed with tx hash: ${receipt.transactionHash}`);
    
    return receipt;
  }
}

module.exports = LayerZeroAdapter;
