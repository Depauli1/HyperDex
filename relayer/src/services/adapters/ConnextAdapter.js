const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const IBridgeAdapter = require('./IBridgeAdapter');

const ConnextAdapterABI = require('../../../abi/ConnextAdapter.json');

/**
 * Off-chain observer for the Connext route.
 *
 * The origin-side call is made by the on-chain adapter (`bridgeOut` ->
 * `Connext.xcall`), so nothing here fabricates a protocol call. What the watcher
 * needs from this class is the delivery signal: `ConnextAdapter.delivered`
 * is set by Connext's own `xReceive` callback, so polling it is the real,
 * spoof-resistant way to know the funds have arrived on the destination domain.
 *
 * The method this file used to call, `xcTransfer`, does not exist on Connext:
 * `relayer/src/config/connext-abi.json` has contained the real `xcall` ABI all
 * along, and the on-chain adapter now uses it.
 */
class ConnextAdapter extends IBridgeAdapter {
  /**
   * @param {Object} config
   * @param {ethers.providers.Provider} config.destinationProvider provider for the destination chain
   * @param {string} config.adapterAddress ConnextAdapter deployed on the destination chain
   * @param {Object} [config.domainMapping] chain id -> Connext domain id
   * @param {Number} [config.relayerFee] fee (wei) the origin router must forward
   */
  constructor(config = {}) {
    super(config);
    this.destinationProvider = config.destinationProvider || config.sourceProvider;
    this.adapterAddress = config.adapterAddress;
    this.domainMapping = config.domainMapping || {};
    this.relayerFee = config.relayerFee !== undefined ? config.relayerFee : config.relayerFeeWei;
    this.pollMs = config.pollMs || 15_000;
    this.timeoutMs = config.timeoutMs || 30 * 60 * 1000;

    if (!ethers.utils.isAddress(this.adapterAddress || '')) {
      throw new Error('ConnextAdapter requires the destination adapter address');
    }
    if (!this.destinationProvider) {
      throw new Error('ConnextAdapter requires a destination provider');
    }

    this.adapter = new ethers.Contract(
      this.adapterAddress,
      ConnextAdapterABI,
      this.destinationProvider
    );

    logger.info(`ConnextAdapter observer initialised for adapter ${this.adapterAddress}`);
  }

  /** Connext domain id for a chain id, from configuration. */
  getDomainId(chainId) {
    const domain = this.domainMapping[chainId];
    if (domain === undefined) {
      throw new Error(`ConnextAdapter: missing domain mapping for chain ${chainId}`);
    }
    return domain;
  }

  /**
   * The relayer fee is quoted off-chain (Connext relayer API) and configured
   * here; the on-chain adapter forwards exactly this value to `xcall`.
   */
  async quoteFees(request) {
    this.getDomainId(request.dstChainId);
    if (this.relayerFee === undefined) {
      throw new Error('ConnextAdapter: relayerFee is not configured');
    }
    return ethers.BigNumber.from(this.relayerFee);
  }

  /** True once Connext has delivered the transfer to the on-chain adapter. */
  async isDelivered(requestId) {
    return this.adapter.delivered(requestId);
  }

  /**
   * Polls the on-chain delivery flag set by Connext's `xReceive`.
   *
   * @param {string} requestId BridgeRouter request id
   * @param {Object} [options] { timeoutMs, pollMs }
   * @returns {Promise<boolean>} true when delivered, false on timeout
   */
  async waitForDelivery(requestId, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const pollMs = options.pollMs || this.pollMs;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.isDelivered(requestId)) {
        logger.info(`Connext delivered ${requestId}`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    logger.warn(`Timed out waiting for Connext to deliver ${requestId}`);
    return false;
  }

  /**
   * Connext proves delivery on-chain through `xReceive`, so `completeBridge`
   * needs no extra bytes.
   */
  async fetchProof() {
    return '0x';
  }
}

module.exports = ConnextAdapter;
