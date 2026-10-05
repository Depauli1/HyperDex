/**
 * Interface implemented by the off-chain protocol observers.
 *
 * There is deliberately very little to implement. Delivery is proven on-chain:
 * `ConnextAdapter.xReceive` is only callable by the deployed Connext contract and
 * `LayerZeroAdapter.lzReceive` only by the deployed endpoint, and each sets a
 * per-request flag that `bridgeIn` requires before any tokens move. The watcher
 * therefore does not need to carry a proof across chains - it needs to know when
 * the protocol has delivered, and what to pass to `completeBridge`.
 *
 * A JavaScript adapter is responsible for:
 *   - `quoteFees(request)`: an off-chain estimate the router can be configured with
 *   - `waitForDelivery(requestId, options)`: poll the on-chain adapter's delivery flag
 *   - `fetchProof(request, requestId)`: the bytes `completeBridge` should carry
 *     (empty for every protocol implemented here, because the proof is on-chain)
 */
class IBridgeAdapter {
  /**
   * @param {Object} config protocol-specific configuration
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Estimates the fee the source-chain router must forward to the protocol.
   * @param {Object} request BridgeRequest { id, srcChainId, dstChainId, token, amount, user, deadline, fee }
   * @returns {Promise<ethers.BigNumber>}
   */
  async quoteFees() {
    throw new Error('quoteFees not implemented');
  }

  /**
   * Waits until the protocol has delivered the transfer to the destination
   * adapter, i.e. until the on-chain adapter will accept `bridgeIn`.
   *
   * @param {string} requestId BridgeRouter request id (bytes32)
   * @param {Object} [options] { timeoutMs, pollMs }
   * @returns {Promise<boolean>} true when delivery is proven on-chain
   */
  async waitForDelivery() {
    throw new Error('waitForDelivery not implemented');
  }

  /**
   * The proof bytes to hand to `completeBridge`.
   * @returns {Promise<string>} hex string
   */
  async fetchProof() {
    return '0x';
  }
}

module.exports = IBridgeAdapter;
