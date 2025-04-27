const { ethers } = require('ethers');
const IBridgeAdapter = require('./IBridgeAdapter');

/**
 * LayerZero adapter.
 * Implements bridgeOut, fetchProof, and quoteFees for LayerZero messaging.
 */
class LayerZeroAdapter extends IBridgeAdapter {
  constructor(config) {
    super(config);
    this.config = config;
    this.endpoint = new ethers.Contract(
      config.endpointAddress,
      config.endpointABI,
      config.wallet
    );
    this.chainIdMapping = config.chainIdMapping || {};
    this.adapterParams = config.adapterParams || '0x';
    this.zroPaymentAddress = config.zroPaymentAddress;
    this.refundAddress = config.refundAddress;
    this.remoteContractAddress = config.remoteContractAddress;
  }

  /**
   * Estimate native fee for sending a message via LayerZero.
   */
  async quoteFees(request) {
    const dstChain = this.chainIdMapping[request.dstChainId];
    if (!dstChain) throw new Error(`No chainId mapping for destination ${request.dstChainId}`);
    const [nativeFee] = await this.endpoint.estimateFees(
      dstChain,
      this.remoteContractAddress,
      '0x',
      false,
      this.adapterParams
    );
    return nativeFee;
  }

  /**
   * Initiate cross-chain message to destination contract.
   */
  async bridgeOut(request) {
    const dstChain = this.chainIdMapping[request.dstChainId];
    if (!dstChain) throw new Error(`No chainId mapping for destination ${request.dstChainId}`);
    // Encode call to completeBridge on destination router
    const payload = ethers.utils.defaultAbiCoder.encode(
      ['bytes32','uint256','uint256','address','uint256','uint256','uint256','uint256'],
      [
        request.id,
        request.srcChainId,
        request.dstChainId,
        request.token,
        request.amount,
        request.user,
        request.deadline,
        request.fee
      ]
    );
    const tx = await this.endpoint.send(
      dstChain,
      this.remoteContractAddress,
      payload,
      this.refundAddress,
      this.zroPaymentAddress,
      this.adapterParams,
      { value: request.fee }
    );
    return tx;
  }

  /**
   * For consistency, return the txHash bytes as "proof".
   */
  async fetchProof(txHash) {
    return ethers.utils.arrayify(txHash);
  }

  /**
   * No off-chain actions needed; on-chain router handles the inbound.
   */
  async bridgeIn(request, proof) {
    return null;
  }
}

module.exports = LayerZeroAdapter;
