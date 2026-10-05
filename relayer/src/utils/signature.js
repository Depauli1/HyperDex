/**
 * Gasless-swap signature verification.
 *
 * The relayer verifies the trader's EIP-712 signature before submitting it, but
 * the authority is the contract: `HyperDex.executeGaslessSwap` recovers the
 * signer itself and reverts `InvalidSignature` if it does not match. This module
 * exists so the relayer can reject bad submissions early with a useful error,
 * using the exact same domain and struct (see `config/eip712.js`).
 */

const { ethers } = require('ethers');
const logger = require('./logger');
const {
  GASLESS_SWAP_TYPES,
  gaslessSwapDomain,
  hashGaslessSwap,
  toStruct
} = require('../config/eip712');

class SignatureError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SignatureError';
    this.code = code;
  }
}

/**
 * Recovers the signer of a gasless swap signature.
 *
 * @param {Object} params struct members (pool, trader, zeroForOne, ...)
 * @param {string} signature 65-byte signature
 * @param {{chainId: number|string, verifyingContract: string}} deployment
 * @returns {string} the recovered address
 * @throws {SignatureError} when the signature is malformed or unrecoverable
 */
function recoverGaslessSwapSigner(params, signature, deployment) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new SignatureError('Invalid signature format', 'INVALID_FORMAT');
  }
  let struct;
  let domain;
  try {
    struct = toStruct(params);
    domain = gaslessSwapDomain(deployment.chainId, deployment.verifyingContract);
  } catch (error) {
    throw new SignatureError(error.message, 'INVALID_PARAMS');
  }

  try {
    return ethers.utils.verifyTypedData(domain, GASLESS_SWAP_TYPES, struct, signature);
  } catch (error) {
    throw new SignatureError(`Signature recovery failed: ${error.message}`, 'INVALID_SIGNATURE');
  }
}

/**
 * Verifies that `signature` was produced by `params.trader` for this deployment.
 *
 * @returns {boolean} true when the signature is valid and fresh
 * @throws {SignatureError} with one of: INVALID_FORMAT, INVALID_PARAMS,
 *                          INVALID_SIGNATURE, SIGNER_MISMATCH, DEADLINE_EXPIRED
 */
function verifyGaslessSwap(params, signature, deployment) {
  const struct = toStruct(params);

  if (ethers.BigNumber.from(struct.deadline).lt(Math.floor(Date.now() / 1000))) {
    throw new SignatureError('Swap deadline has expired', 'DEADLINE_EXPIRED');
  }

  const recovered = recoverGaslessSwapSigner(params, signature, deployment);
  if (recovered.toLowerCase() !== struct.trader.toLowerCase()) {
    logger.warn(
      `Gasless swap signature mismatch: recovered=${recovered} expected=${struct.trader}`
    );
    throw new SignatureError('Signature does not match trader', 'SIGNER_MISMATCH');
  }
  return true;
}

module.exports = {
  SignatureError,
  verifyGaslessSwap,
  recoverGaslessSwapSigner,
  hashGaslessSwap,
  toStruct,
  GASLESS_SWAP_TYPES,
  gaslessSwapDomain
};
