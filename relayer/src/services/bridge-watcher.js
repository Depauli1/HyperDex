require('dotenv').config();
const { ethers } = require('ethers');
const logger = require('../utils/logger');

// Minimal ABI for BridgeRouter
const BridgeRouterABI = [
  'event BridgeInitiated(bytes32 indexed id, bytes32 indexed adapterKey, address indexed user, uint256 amount, uint256 fee)',
  'event BridgeOutbound(bytes32 indexed id)',
  'function completeBridge(tuple(bytes32 id,uint256 srcChainId,uint256 dstChainId,address token,uint256 amount,address user,uint256 deadline,uint256 fee) req,bytes proof,bytes32 adapterKey) external'
];

// BridgeWatcher handles cross-chain bridge events and proof submission
class BridgeWatcher {
  /**
   * @param sourceProvider ethers.Provider for source chain
   * @param destProvider ethers.Provider for destination chain
   * @param wallet ethers.Wallet connected to destProvider
   * @param sourceRouterAddress Address of BridgeRouter on source chain
   * @param destRouterAddress Address of BridgeRouter on destination chain
   * @param adapters Map of adapterKey (bytes32) to IBridgeAdapter instances
   * @param srcChainId Source chain id
   * @param dstChainId Destination chain id
   * @param token Native token address being bridged
   * @param confirmations Number of block confirmations to wait
   */
  constructor({ sourceProvider, destProvider, wallet, sourceRouterAddress, destRouterAddress, adapters, srcChainId, dstChainId, token, confirmations = 12, sourceContract, destContract }) {
    this.sourceProvider = sourceProvider;
    this.destProvider = destProvider;
    // allow injecting mocks for testing
    this.sourceContract = sourceContract || new ethers.Contract(sourceRouterAddress, BridgeRouterABI, sourceProvider);
    this.destContract = destContract || new ethers.Contract(destRouterAddress, BridgeRouterABI, wallet);
    this.adapters = adapters;
    this.srcChainId = srcChainId;
    this.dstChainId = dstChainId;
    this.token = token;
    this.confirmations = confirmations;
    this.requests = new Map();
  }

  /**
   * Start listening to bridge events and handle completion
   */
  async start() {
    // Track initiated requests with adapterKey
    this.sourceContract.on('BridgeInitiated', (id, adapterKey, user, amount, fee) => {
      logger.info(`BridgeInitiated: id=${id}, adapterKey=${adapterKey}, user=${user}, amount=${amount}`);
      this.requests.set(id, { id, adapterKey, user, amount, fee });
    });

    // On outbound, wait for finality, fetch proof, and call completeBridge
    this.sourceContract.on('BridgeOutbound', async (...args) => {
      const event = args[args.length - 1];
      const id = args[0];
      const req = this.requests.get(id);
      if (!req) {
        logger.warn(`Unknown request id ${id}`);
        return;
      }
      logger.info(`BridgeOutbound: id=${id}, txHash=${event.transactionHash}`);
      // wait for confirmations
      await this.sourceProvider.waitForTransaction(event.transactionHash, this.confirmations);
      const adapter = this.adapters.get(req.adapterKey);
      if (!adapter) {
        logger.error(`No adapter found for key ${req.adapterKey}`);
        return;
      }
      try {
        // fetch cross-chain proof
        const proof = await adapter.fetchProof(event.transactionHash);
        // build completeBridge request tuple
        const bridgeReq = {
          id: req.id,
          srcChainId: this.srcChainId,
          dstChainId: this.dstChainId,
          token: this.token,
          amount: req.amount,
          user: req.user,
          deadline: 0,
          fee: req.fee
        };
        const tx = await this.destContract.completeBridge(
          bridgeReq,
          proof,
          req.adapterKey
        );
        logger.info(`completeBridge tx sent: ${tx.hash}`);
      } catch (err) {
        logger.error(`Error completing bridge for id=${id}: ${err.message}`);
      }
    });
  }
}

module.exports = BridgeWatcher;
