/**
 * Canonical EIP-712 definition for HyperDex gasless swaps.
 *
 * This file is the single source of truth on the JavaScript side and MUST match
 * `contracts/HyperDex.sol`:
 *
 *   constructor() EIP712("HyperDex", "1")
 *   GaslessSwap(address pool,address trader,bool zeroForOne,int256 amountSpecified,
 *               uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)
 *
 * `test/eip712.test.js` asserts the digest produced from this definition equals
 * the digest the deployed contract computes (`HyperDex.hashGaslessSwap`), so any
 * drift fails the build instead of silently producing signatures the contract
 * rejects with `InvalidSignature`.
 */

const { ethers } = require('ethers');

const DOMAIN_NAME = 'HyperDex';
const DOMAIN_VERSION = '1';
const DOMAIN_SALT = ethers.constants.HashZero;

/** EIP-712 struct definition, field order included. */
const GASLESS_SWAP_TYPES = {
  GaslessSwap: [
    { name: 'pool', type: 'address' },
    { name: 'trader', type: 'address' },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountSpecified', type: 'int256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ]
};

/**
 * Builds the EIP-712 domain for a deployment.
 *
 * @param {number|string} chainId chain the gateway is deployed on
 * @param {string} verifyingContract HyperDex gateway address
 * @returns {{name: string, version: string, chainId: number, verifyingContract: string}}
 */
function gaslessSwapDomain(chainId, verifyingContract) {
  if (!ethers.utils.isAddress(verifyingContract)) {
    throw new Error(`gaslessSwapDomain: invalid verifyingContract ${verifyingContract}`);
  }
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`gaslessSwapDomain: invalid chainId ${chainId}`);
  }
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: id,
    verifyingContract
  };
}

/**
 * Splits a `GaslessSwapParams` object into the exact struct the contract hashes.
 *
 * @param {Object} params pool, trader, zeroForOne, amountSpecified,
 *                        sqrtPriceLimitX96, deadline, nonce
 * @returns {Object} the seven struct members, in contract order
 */
function toStruct(params) {
  const required = [
    'pool',
    'trader',
    'zeroForOne',
    'amountSpecified',
    'sqrtPriceLimitX96',
    'deadline',
    'nonce'
  ];
  for (const field of required) {
    if (params[field] === undefined || params[field] === null) {
      throw new Error(`toStruct: missing field ${field}`);
    }
  }
  if (!ethers.utils.isAddress(params.pool)) {
    throw new Error(`toStruct: invalid pool address ${params.pool}`);
  }
  if (!ethers.utils.isAddress(params.trader)) {
    throw new Error(`toStruct: invalid trader address ${params.trader}`);
  }
  return {
    pool: params.pool,
    trader: params.trader,
    zeroForOne: Boolean(params.zeroForOne),
    amountSpecified: ethers.BigNumber.from(params.amountSpecified).toString(),
    sqrtPriceLimitX96: ethers.BigNumber.from(params.sqrtPriceLimitX96).toString(),
    deadline: ethers.BigNumber.from(params.deadline).toString(),
    nonce: ethers.BigNumber.from(params.nonce).toString()
  };
}

/**
 * The digest a trader signs. Equivalent to `HyperDex.hashGaslessSwap(params)`.
 *
 * @param {Object} params struct members (see `toStruct`)
 * @param {{chainId: number|string, verifyingContract: string}} deployment
 * @returns {string} 32-byte digest
 */
function hashGaslessSwap(params, deployment) {
  return ethers.utils._TypedDataEncoder.hash(
    gaslessSwapDomain(deployment.chainId, deployment.verifyingContract),
    GASLESS_SWAP_TYPES,
    toStruct(params)
  );
}

/** Signs `params` with an ethers signer. */
async function signGaslessSwap(signer, params, deployment) {
  return signer._signTypedData(
    gaslessSwapDomain(deployment.chainId, deployment.verifyingContract),
    GASLESS_SWAP_TYPES,
    toStruct(params)
  );
}

module.exports = {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  DOMAIN_SALT,
  GASLESS_SWAP_TYPES,
  gaslessSwapDomain,
  toStruct,
  hashGaslessSwap,
  signGaslessSwap
};
