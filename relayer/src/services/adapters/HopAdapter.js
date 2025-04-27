const { ethers } = require('ethers');
const IBridgeAdapter = require('./IBridgeAdapter');

/**
 * Hop adapter (skeleton).
 * Implements bridgeOut, fetchProof, and bridgeIn for the Hop protocol.
 */
class HopAdapter extends IBridgeAdapter {
  constructor(config) {
    super(config);
    this.config = config;
    this.sourceProvider = config.sourceProvider;
    // Initialize Hop bridge contract
    this.bridge = new ethers.Contract(config.bridgeAddress, config.bridgeABI, config.wallet);
    // default slippage settings
    this.amountOutMin = config.amountOutMin ?? 0;
    this.relayerAddress = config.relayerAddress;
  }

  async bridgeOut(request) {
    const { dstChainId, user, amount, deadline, fee } = request;
    const tx = await this.bridge.sendToL2(
      dstChainId,
      user,
      amount,
      this.amountOutMin,
      deadline,
      this.relayerAddress || user,
      fee,
      { value: fee }
    );
    return tx;
  }

  async fetchProof(txHash) {
    // Simplified proof: return txHash bytes for on-chain adapter verification
    return ethers.utils.arrayify(txHash);
  }

  async bridgeIn(request, proof) {
    // No off-chain actions needed; on-chain router completes the bridgeIn
    return null;
  }
}

module.exports = HopAdapter;
