const { ethers } = require('ethers');
const IBridgeAdapter = require('./IBridgeAdapter');

/**
 * Connext adapter (skeleton).
 * Implements bridgeOut, fetchProof, and bridgeIn for the Connext protocol.
 */
class ConnextAdapter extends IBridgeAdapter {
  constructor(config) {
    super(config);
    this.config = config;
    this.sourceProvider = config.sourceProvider;
    // Use stub or safely instantiate Connext contract
    if (config.connext) {
      this.connext = config.connext;
    } else {
      try {
        this.connext = new ethers.Contract(
          config.connextAddress,
          config.connextABI,
          config.wallet
        );
      } catch (err) {
        this.connext = null;
      }
    }
    // Domain mapping: chainId => domainId
    this.domainMapping = config.domainMapping || {};
    this.slippage = config.slippage ?? 30;
    this.callData = config.callData ?? '0x';
    this.delegate = config.delegate;
  }

  async bridgeOut(request) {
    const { dstChainId, user, token, amount, fee } = request;
    const destinationDomain = this.domainMapping[dstChainId];
    if (!destinationDomain) {
      throw new Error(`ConnextAdapter: missing domain mapping for chain ${dstChainId}`);
    }
    const delegate = this.delegate ?? user;
    const tx = await this.connext.xcall(
      destinationDomain,
      user,
      token,
      delegate,
      amount,
      this.slippage,
      this.callData,
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

module.exports = ConnextAdapter;
