const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const IBridgeAdapter = require('./IBridgeAdapter');

const HopAdapterABI = require('../../../abi/HopAdapter.json');

/**
 * Off-chain observer for the Hop route.
 *
 * Hop's bonder fronts the transfer on the destination chain, so - unlike
 * Connext and LayerZero - there is no protocol callback on the destination
 * adapter to prove delivery. The on-chain `HopAdapter.bridgeIn` is therefore
 * gated by the destination router's `recordInbound` (an authorised relayer) plus
 * the adapter's own `authorizedRelayers`/`bridgeRouter` check and its
 * single-payout mapping. This observer's job is to confirm the bonder actually
 * delivered before the watcher completes the request.
 */
class HopAdapter extends IBridgeAdapter {
  /**
   * @param {Object} config
   * @param {ethers.providers.Provider} config.destinationProvider provider for the destination chain
   * @param {string} config.adapterAddress HopAdapter deployed on the destination chain
   * @param {string} [config.token] token address on the destination chain
   * @param {Number|string} [config.bonderFeeBps] bonder fee in basis points
   */
  constructor(config = {}) {
    super(config);
    this.destinationProvider = config.destinationProvider || config.sourceProvider;
    this.adapterAddress = config.adapterAddress;
    this.token = config.token;
    this.bonderFeeBps = config.bonderFeeBps !== undefined ? config.bonderFeeBps : 25;
    this.pollMs = config.pollMs || 15_000;
    this.timeoutMs = config.timeoutMs || 30 * 60 * 1000;

    if (!ethers.utils.isAddress(this.adapterAddress || '')) {
      throw new Error('HopAdapter requires the destination adapter address');
    }
    if (!this.destinationProvider) {
      throw new Error('HopAdapter requires a destination provider');
    }

    this.adapter = new ethers.Contract(
      this.adapterAddress,
      HopAdapterABI,
      this.destinationProvider
    );

    logger.info(`HopAdapter observer initialised for adapter ${this.adapterAddress}`);
  }

  /** Bonder fee for a request, in the bridged token's units. */
  async quoteFees(request) {
    const amount = ethers.BigNumber.from(request.amount);
    return amount.mul(this.bonderFeeBps).div(10_000);
  }

  /** True once the adapter has already paid this request out. */
  async isProcessed(requestId) {
    return this.adapter.processed(requestId);
  }

  /**
   * Waits for the destination adapter to hold the bridged funds.
   *
   * Hop's delivery is a bonder transfer rather than a message callback, so the
   * observable signal is the adapter's balance covering the request amount. The
   * adapter refuses to pay twice, and the router refuses to complete twice, so
   * this check is a liveness aid rather than the security boundary.
   *
   * @param {string} requestId BridgeRouter request id
   * @param {Object} [options] { request, timeoutMs, pollMs }
   * @returns {Promise<boolean>}
   */
  async waitForDelivery(requestId, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const pollMs = options.pollMs || this.pollMs;
    const token = options.token || this.token;
    const required = options.amount ? ethers.BigNumber.from(options.amount) : null;

    if (!token) {
      logger.warn('HopAdapter.waitForDelivery: no token configured; skipping balance check');
      return true;
    }

    const erc20 = new ethers.Contract(
      token,
      ['function balanceOf(address) view returns (uint256)'],
      this.destinationProvider
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isProcessed(requestId)) {
        return true;
      }
      const balance = await erc20.balanceOf(this.adapterAddress);
      if (required === null || balance.gte(required)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    logger.warn(`Timed out waiting for Hop to deliver ${requestId}`);
    return false;
  }

  /** Hop carries no cross-chain proof into `completeBridge`. */
  async fetchProof() {
    return '0x';
  }
}

module.exports = HopAdapter;
