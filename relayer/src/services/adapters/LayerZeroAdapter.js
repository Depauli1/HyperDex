const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const IBridgeAdapter = require('./IBridgeAdapter');

const LayerZeroAdapterABI = require('../../../abi/LayerZeroAdapter.json');

/**
 * Off-chain observer for the LayerZero route.
 *
 * The origin-side `endpoint.send` is issued by the on-chain adapter. Here the
 * watcher only needs the delivery signal: `LayerZeroAdapter.verifiedMessages`
 * is set by `lzReceive`, which the deployed endpoint alone can call, so polling
 * it is a real check that the message arrived and passed the trusted-remote
 * check on the destination chain.
 */
class LayerZeroAdapter extends IBridgeAdapter {
  /**
   * @param {Object} config
   * @param {ethers.providers.Provider} config.destinationProvider provider for the destination chain
   * @param {string} config.adapterAddress LayerZeroAdapter deployed on the destination chain
   * @param {Object} [config.chainIdMapping] chain id -> LayerZero endpoint id
   * @param {Number|string} [config.nativeFee] fee (wei) quoted by `endpoint.estimateFees`
   */
  constructor(config = {}) {
    super(config);
    this.destinationProvider = config.destinationProvider || config.sourceProvider;
    this.adapterAddress = config.adapterAddress;
    this.chainIdMapping = config.chainIdMapping || {};
    this.nativeFee = config.nativeFee !== undefined ? config.nativeFee : config.relayerFee;
    this.pollMs = config.pollMs || 15_000;
    this.timeoutMs = config.timeoutMs || 30 * 60 * 1000;

    if (!ethers.utils.isAddress(this.adapterAddress || '')) {
      throw new Error('LayerZeroAdapter requires the destination adapter address');
    }
    if (!this.destinationProvider) {
      throw new Error('LayerZeroAdapter requires a destination provider');
    }

    this.adapter = new ethers.Contract(
      this.adapterAddress,
      LayerZeroAdapterABI,
      this.destinationProvider
    );

    logger.info(`LayerZeroAdapter observer initialised for adapter ${this.adapterAddress}`);
  }

  /** LayerZero endpoint id for a chain id, from configuration. */
  getLzChainId(chainId) {
    const lzChainId = this.chainIdMapping[chainId];
    if (lzChainId === undefined) {
      throw new Error(`LayerZeroAdapter: missing chain mapping for chain ${chainId}`);
    }
    return lzChainId;
  }

  /** Fee the router must forward; the on-chain adapter calls `estimateFees`. */
  async quoteFees(request) {
    this.getLzChainId(request.dstChainId);
    if (this.nativeFee === undefined) {
      throw new Error(
        'LayerZeroAdapter: nativeFee is not configured (read it from LayerZeroAdapter.quoteFees on-chain)'
      );
    }
    return ethers.BigNumber.from(this.nativeFee);
  }

  /** True once the endpoint has delivered and authenticated the message. */
  async isVerified(requestId) {
    return this.adapter.verifiedMessages(requestId);
  }

  /**
   * Polls the on-chain flag set by `lzReceive`.
   *
   * @param {string} requestId BridgeRouter request id
   * @param {Object} [options] { timeoutMs, pollMs }
   * @returns {Promise<boolean>} true when verified, false on timeout
   */
  async waitForDelivery(requestId, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const pollMs = options.pollMs || this.pollMs;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.isVerified(requestId)) {
        logger.info(`LayerZero verified ${requestId}`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    logger.warn(`Timed out waiting for LayerZero to verify ${requestId}`);
    return false;
  }

  /** LayerZero proves delivery on-chain via `lzReceive`; no extra proof bytes. */
  async fetchProof() {
    return '0x';
  }
}

module.exports = LayerZeroAdapter;
