const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ConnextAdapter = require('./adapters/ConnextAdapter');
const LayerZeroAdapter = require('./adapters/LayerZeroAdapter');

/**
 * BridgeWatcher service that monitors for bridge events and completes cross-chain transactions
 */
class BridgeWatcher {
  /**
   * Initialize the bridge watcher
   * @param {Object} options - Configuration options
   * @param {Object} options.providers - Map of chain ID to ethers.js provider
   * @param {Object} options.wallets - Map of chain ID to ethers.js wallet
   * @param {Object} options.bridgeRouterAddresses - Map of chain ID to BridgeRouter contract address
   * @param {Object} options.bridgeRouterABI - BridgeRouter contract ABI
   * @param {Object} options.adapters - Adapter configurations by protocol and chain
   * @param {number} options.confirmations - Number of confirmations to wait before processing
   * @param {Object} options.networkSettings - Settings for each network (gas price, etc.)
   */
  constructor(options) {
    this.providers = options.providers || {};
    this.wallets = options.wallets || {};
    this.bridgeRouterAddresses = options.bridgeRouterAddresses || {};
    this.bridgeRouterABI = options.bridgeRouterABI;
    this.adapterConfigs = options.adapters || {};
    this.confirmations = options.confirmations || 1;
    this.networkSettings = options.networkSettings || {};
    
    // Initialize contract instances for each chain
    this.bridgeRouters = {};
    this.initialized = false;
    this.adapters = {
      connext: {},
      layerZero: {}
    };
    
    // Store pending transfers
    this.pendingTransfers = new Map();
    
    logger.info('BridgeWatcher initialized');
  }

  /**
   * Initialize the watcher service
   */
  async initialize() {
    if (this.initialized) return;
    
    // Initialize contracts for each chain
    for (const chainId in this.providers) {
      const provider = this.providers[chainId];
      const wallet = this.wallets[chainId];
      const routerAddress = this.bridgeRouterAddresses[chainId];
      
      if (provider && wallet && routerAddress) {
        this.bridgeRouters[chainId] = new ethers.Contract(
          routerAddress,
          this.bridgeRouterABI,
          wallet
        );
        
        logger.info(`Initialized BridgeRouter on chain ${chainId}: ${routerAddress}`);
      }
    }
    
    // Initialize protocol adapters for each chain
    for (const protocol in this.adapterConfigs) {
      for (const chainId in this.adapterConfigs[protocol]) {
        const config = this.adapterConfigs[protocol][chainId];
        
        if (protocol === 'connext') {
          this.adapters.connext[chainId] = new ConnextAdapter({
            ...config,
            wallet: this.wallets[chainId]
          });
        } else if (protocol === 'layerZero') {
          this.adapters.layerZero[chainId] = new LayerZeroAdapter({
            ...config,
            wallet: this.wallets[chainId]
          });
        }
      }
    }
    
    this.initialized = true;
    logger.info('BridgeWatcher fully initialized');
  }

  /**
   * Start watching for bridge events
   */
  async startWatching() {
    await this.initialize();
    
    // For each chain, subscribe to BridgeInitiated events
    for (const chainId in this.bridgeRouters) {
      const router = this.bridgeRouters[chainId];
      const provider = this.providers[chainId];
      
      logger.info(`Starting to watch BridgeInitiated events on chain ${chainId}`);
      
      // Subscribe to BridgeInitiated events
      router.on('BridgeInitiated', async (requestId, user, srcChainId, dstChainId, token, amount, fee) => {
        logger.info(`Detected BridgeInitiated event on chain ${chainId}:
          requestId: ${requestId}
          user: ${user}
          srcChain: ${srcChainId.toString()}
          dstChain: ${dstChainId.toString()}
          token: ${token}
          amount: ${ethers.utils.formatEther(amount)}
          fee: ${ethers.utils.formatEther(fee)}
        `);
        
        // Get the transaction that emitted this event
        const filter = router.filters.BridgeInitiated(requestId);
        const events = await router.queryFilter(filter);
        const event = events[0];
        
        // Wait for confirmations
        await event.getTransaction();
        const receipt = await event.getTransactionReceipt();
        const currentBlock = await provider.getBlockNumber();
        
        if (currentBlock - receipt.blockNumber < this.confirmations) {
          logger.info(`Waiting for ${this.confirmations} confirmations. Current: ${currentBlock - receipt.blockNumber}`);
          // In production, you would wait for confirmations before proceeding
          // For this example, we'll continue processing
        }
        
        // Get the request details from the event
        const request = {
          id: 0, // We would get this from contract storage or event
          srcChainId: srcChainId.toString(),
          dstChainId: dstChainId.toString(),
          token,
          amount,
          user,
          deadline: 0, // We would get this from contract storage or event
          fee
        };
        
        // Process the bridge request
        await this.processBridgeRequest(request, requestId, chainId);
      });
      
      logger.info(`Watching for BridgeInitiated events on chain ${chainId}`);
    }
  }

  /**
   * Process a new bridge request
   * @param {Object} request - The bridge request details
   * @param {string} requestId - The unique request ID
   * @param {string} sourceChainId - The chain ID where the request originated
   */
  async processBridgeRequest(request, requestId, sourceChainId) {
    logger.info(`Processing bridge request ${requestId} from chain ${sourceChainId} to chain ${request.dstChainId}`);
    
    // Determine which protocol to use
    // For demo purposes, we'll use Connext for odd chain IDs and LayerZero for even
    const protocol = parseInt(request.dstChainId) % 2 === 0 ? 'layerZero' : 'connext';
    
    try {
      // Get the appropriate adapter
      let adapter;
      if (protocol === 'connext' && this.adapters.connext[sourceChainId]) {
        adapter = this.adapters.connext[sourceChainId];
      } else if (protocol === 'layerZero' && this.adapters.layerZero[sourceChainId]) {
        adapter = this.adapters.layerZero[sourceChainId];
      } else {
        throw new Error(`No adapter available for protocol ${protocol} on chain ${sourceChainId}`);
      }
      
      // 1. Initiate the bridge via the protocol (simulation only, in reality this is done by the contract)
      logger.info(`Initiating ${protocol} bridge for request ${requestId}`);
      const transferId = await adapter.bridgeOut(request, requestId);
      
      // 2. Add to pending transfers
      this.pendingTransfers.set(requestId, {
        request,
        sourceChainId,
        protocol,
        transferId,
        timestamp: Date.now()
      });
      
      // 3. Schedule completion (in a production system, this would listen for events or use a queue)
      setTimeout(() => this.completeTransfer(requestId), 10000);
      
    } catch (error) {
      logger.error(`Error processing bridge request ${requestId}:`, error);
    }
  }

  /**
   * Complete a pending transfer on the destination chain
   * @param {string} requestId - The unique request ID
   */
  async completeTransfer(requestId) {
    const pendingTransfer = this.pendingTransfers.get(requestId);
    if (!pendingTransfer) {
      logger.warn(`No pending transfer found for request ID ${requestId}`);
      return;
    }
    
    const { request, sourceChainId, protocol, transferId } = pendingTransfer;
    const destChainId = request.dstChainId;
    
    logger.info(`Completing transfer for request ${requestId} on destination chain ${destChainId}`);
    
    try {
      // Get the destination chain router
      const destRouter = this.bridgeRouters[destChainId];
      if (!destRouter) {
        throw new Error(`No BridgeRouter available for chain ${destChainId}`);
      }
      
      // Get the appropriate adapter for the destination chain
      let adapter;
      if (protocol === 'connext' && this.adapters.connext[destChainId]) {
        adapter = this.adapters.connext[destChainId];
      } else if (protocol === 'layerZero' && this.adapters.layerZero[destChainId]) {
        adapter = this.adapters.layerZero[destChainId];
      } else {
        throw new Error(`No adapter available for protocol ${protocol} on chain ${destChainId}`);
      }
      
      // 1. Fetch the proof from the source chain
      logger.info(`Fetching proof for transfer ${transferId}`);
      const proof = await adapter.fetchProof(request, requestId, transferId);
      
      // 2. Call bridgeIn on the destination chain
      logger.info(`Calling bridgeIn on chain ${destChainId} for request ${requestId}`);
      const receipt = await adapter.bridgeIn(request, requestId, proof, destRouter);
      
      logger.info(`Bridge completed for request ${requestId} on chain ${destChainId} with tx ${receipt.transactionHash}`);
      
      // 3. Remove from pending transfers
      this.pendingTransfers.delete(requestId);
      
    } catch (error) {
      logger.error(`Error completing transfer for request ${requestId}:`, error);
    }
  }

  /**
   * Stop watching for bridge events
   */
  stopWatching() {
    // Remove all event listeners
    for (const chainId in this.bridgeRouters) {
      this.bridgeRouters[chainId].removeAllListeners('BridgeInitiated');
    }
    
    logger.info('Stopped watching for bridge events');
  }

  /**
   * Clean up expired pending transfers
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  cleanupPendingTransfers(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    
    for (const [requestId, transfer] of this.pendingTransfers.entries()) {
      if (now - transfer.timestamp > maxAgeMs) {
        logger.info(`Removing expired pending transfer for request ${requestId}`);
        this.pendingTransfers.delete(requestId);
      }
    }
  }
}

module.exports = BridgeWatcher; 