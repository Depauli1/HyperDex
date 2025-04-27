class IBridgeAdapter {
  /**
   * @param {Object} config Adapter configuration (SDK clients, providers, wallet, etc.)
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Initiates bridging out of funds from the source chain.
   * @param {Object} request BridgeRequest { id, srcChainId, dstChainId, token, amount, user, deadline, fee }
   * @returns {Promise<ethers.providers.TransactionResponse>}
   */
  async bridgeOut(request) {
    throw new Error('bridgeOut not implemented');
  }

  /**
   * Fetches an on-chain proof for the outbound transaction.
   * @param {string} txHash The transaction hash of the outbound tx
   * @returns {Promise<Buffer|bytes>}
   */
  async fetchProof(txHash) {
    throw new Error('fetchProof not implemented');
  }

  /**
   * Completes bridging in of funds on the destination chain using the proof.
   * @param {Object} request The original BridgeRequest
   * @param {Buffer|bytes} proof The cross-chain proof
   * @returns {Promise<ethers.providers.TransactionResponse>}
   */
  async bridgeIn(request, proof) {
    throw new Error('bridgeIn not implemented');
  }
}

module.exports = IBridgeAdapter;
