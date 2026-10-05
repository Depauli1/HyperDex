/**
 * Cross-chain watcher.
 *
 * This is the single bridge watcher in the repository. It used to exist twice:
 * `BridgeWatcher.js` (wired into the service, but it subscribed to an event
 * shape that matched nothing and fabricated `id: 0, deadline: 0` when building
 * the completion call) and `bridge-watcher.js` (unit tested against an ABI that
 * the contracts do not implement). Both are gone; this file implements the flow
 * the contracts actually expose, and reads its ABIs from `relayer/abi/`, which
 * is generated from the compiled contracts.
 *
 * The flow, matching `BridgeRouter`:
 *
 *   1. Source chain: `BridgeInitiated(requestId, user, srcChainId, dstChainId,
 *      token, amount, fee)` is emitted by `initiateBridge`, which has already
 *      escrowed the tokens and handed them to the protocol adapter.
 *   2. This watcher waits for `confirmations` blocks, then reads the *full*
 *      request from the source router with `getBridgeRequest(requestId)`. The
 *      event alone is not enough: `id` and `deadline` are not indexed in it, and
 *      guessing them (as the old watcher did) produced requests the destination
 *      chain could not validate.
 *   3. Destination chain: `recordInbound(request, requestId)` stores the request
 *      locally (this is what makes `completeBridge` reachable at all), then
 *      `completeBridge(request, requestId, proof)` releases the funds through
 *      the protocol adapter, which only pays out against the protocol's own
 *      delivery proof (`xReceive` for Connext, `lzReceive` for LayerZero).
 *
 * Both calls are idempotent at the contract level: `recordInbound` reverts
 * `AlreadyRecorded` and `completeBridge` reverts `InvalidStatus`, so a watcher
 * restart cannot double-pay.
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');

const BridgeRouterABI = require('../../abi/BridgeRouter.json');

const RequestStatus = {
  None: 0,
  Initiated: 1,
  Completed: 2,
  Failed: 3,
  Refunding: 4
};

const bridgeRouterInterface = new ethers.utils.Interface(BridgeRouterABI);

/**
 * Name of the custom error a revert carries, or null when the failure was not a
 * BridgeRouter custom error.
 *
 * Decoding the selector is what makes the watcher's retry logic reliable: ethers
 * surfaces custom errors as raw revert data, so matching on the message text
 * alone would miss them (and would break the moment a revert reason is worded
 * differently in a different client).
 *
 * @param {Error} error
 * @returns {string|null}
 */
function revertName(error) {
  const data = findRevertData(error);
  if (!data) return null;
  try {
    return bridgeRouterInterface.parseError(data).name;
  } catch (err) {
    return null;
  }
}

/**
 * Digs the revert payload out of an ethers error.
 *
 * Providers nest it differently depending on the failure: a plain revert puts it
 * on `error.data`, a gas-estimation failure on `error.error.error.data`, and a
 * forwarding JSON-RPC proxy only inside `error.body`. All three are handled.
 *
 * @param {Error} error
 * @param {number} [depth]
 * @returns {string|null} 0x-prefixed revert data
 */
function findRevertData(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) return null;

  if (typeof error.data === 'string' && error.data.startsWith('0x') && error.data.length >= 10) {
    return error.data;
  }

  if (typeof error.body === 'string') {
    try {
      const body = JSON.parse(error.body);
      const nested = findRevertData(body.error || body, depth + 1);
      if (nested) return nested;
    } catch (err) {
      /* not JSON */
    }
  }

  return findRevertData(error.error, depth + 1);
}

/**
 * Converts the struct returned by `BridgeRouter.getBridgeRequest` into the plain
 * object the contract ABI expects for a `BridgeRequest` argument.
 *
 * ethers returns Solidity structs as array-like objects that also carry named
 * fields; normalising here keeps the rest of the watcher free of that detail
 * and gives the unit tests a pure function to assert on.
 *
 * @param {Object|Array} chainStruct result of `getBridgeRequest`
 * @returns {{id: string, srcChainId: string, dstChainId: string, token: string,
 *            amount: string, user: string, deadline: string, fee: string}}
 */
function normaliseRequest(chainStruct) {
  if (!chainStruct) {
    throw new Error('normaliseRequest: no request returned by the router');
  }
  const get = (name, index) => {
    const value = chainStruct[name] !== undefined ? chainStruct[name] : chainStruct[index];
    if (value === undefined) {
      throw new Error(`normaliseRequest: missing field ${name}`);
    }
    return value.toString();
  };
  return {
    id: get('id', 0),
    srcChainId: get('srcChainId', 1),
    dstChainId: get('dstChainId', 2),
    token: chainStruct.token !== undefined ? chainStruct.token : chainStruct[3],
    amount: get('amount', 4),
    user: chainStruct.user !== undefined ? chainStruct.user : chainStruct[5],
    deadline: get('deadline', 6),
    fee: get('fee', 7)
  };
}

class BridgeWatcher {
  /**
   * @param {Object} options
   * @param {ethers.providers.Provider} options.sourceProvider provider for the chain that emits BridgeInitiated
   * @param {ethers.providers.Provider} options.destProvider provider for the destination chain
   * @param {ethers.Wallet} options.wallet signer on the destination chain (must be an authorised relayer)
   * @param {string} options.sourceRouterAddress BridgeRouter on the source chain
   * @param {string} options.destRouterAddress BridgeRouter on the destination chain
   * @param {Object} options.adapters map of destination chain id -> adapter observer
   * @param {Number} options.srcChainId source chain id
   * @param {Number} options.dstChainId destination chain id
   * @param {Number} [options.confirmations] block confirmations to wait for
   * @param {Object} [options.settings] per-network overrides ({ gasLimit, gasPrice })
   */
  constructor({
    sourceProvider,
    destProvider,
    wallet,
    sourceRouterAddress,
    destRouterAddress,
    adapters,
    srcChainId,
    dstChainId,
    confirmations = 12,
    settings = {}
  }) {
    if (!sourceProvider || !destProvider || !wallet) {
      throw new Error('BridgeWatcher requires source and destination providers plus a wallet');
    }
    if (!ethers.utils.isAddress(sourceRouterAddress) || !ethers.utils.isAddress(destRouterAddress)) {
      throw new Error('BridgeWatcher requires both router addresses');
    }

    this.sourceProvider = sourceProvider;
    this.destProvider = destProvider;
    this.wallet = wallet;
    this.sourceRouterAddress = sourceRouterAddress;
    this.destRouterAddress = destRouterAddress;
    this.adapters = adapters || {};
    this.srcChainId = Number(srcChainId);
    this.dstChainId = Number(dstChainId);
    this.confirmations = confirmations;
    this.settings = settings;

    this.sourceRouter = new ethers.Contract(sourceRouterAddress, BridgeRouterABI, sourceProvider);
    this.destRouter = new ethers.Contract(destRouterAddress, BridgeRouterABI, wallet);

    this.started = false;
  }

  /** Subscribes to BridgeInitiated on the source chain. */
  async start() {
    if (this.started) return;
    this.started = true;

    this.sourceRouter.on(
      'BridgeInitiated',
      (requestId, user, srcChainId, dstChainId, token, amount, fee, event) => {
        // Never let a handler rejection become an unhandled promise rejection.
        this.handleInitiated(requestId, event).catch((error) =>
          logger.error(`Bridge watcher failed for ${requestId}: ${error.message}`)
        );
        logger.info(
          `BridgeInitiated ${requestId}: ${user} ${amount} ${token} -> chain ${dstChainId} (fee ${fee}, src ${srcChainId})`
        );
      }
    );

    logger.info(
      `BridgeWatcher watching ${this.sourceRouterAddress} for transfers to chain ${this.dstChainId}`
    );
  }

  async stop() {
    if (this.sourceRouter && this.sourceRouter.removeAllListeners) {
      this.sourceRouter.removeAllListeners('BridgeInitiated');
    }
    this.started = false;
  }

  /**
   * Handles one source-chain event: waits for finality, rebuilds the request and
   * completes it on the destination chain.
   *
   * @param {string} requestId id assigned by `initiateBridge`
   * @param {Object} event the ethers event (needs `transactionHash`/`blockNumber`)
   */
  async handleInitiated(requestId, event) {
    if (event && event.transactionHash) {
      await this.sourceProvider.waitForTransaction(event.transactionHash, this.confirmations);
    }

    const onChain = await this.sourceRouter.getBridgeRequest(requestId);
    const request = normaliseRequest(onChain[0]);
    const status = Number(onChain[1].toString());

    if (request.dstChainId !== String(this.dstChainId)) {
      logger.warn(
        `Ignoring ${requestId}: destined for chain ${request.dstChainId}, watching ${this.dstChainId}`
      );
      return { skipped: 'wrong-destination' };
    }

    const adapter = this.adapters[this.dstChainId] || this.adapters[String(this.dstChainId)];
    if (!adapter) {
      throw new Error(`No adapter observer configured for destination chain ${this.dstChainId}`);
    }

    const proof = adapter.fetchProof ? await adapter.fetchProof(request, requestId) : '0x';

    const recorded = await this.ensureRecorded(request, requestId, status);
    if (!recorded) {
      return { skipped: 'not-recorded' };
    }

    return this.complete(request, requestId, proof);
  }

  /**
   * Records the inbound request on the destination router if it is not already
   * known there. Returns true when the request is (now) recorded.
   */
  async ensureRecorded(request, requestId, sourceStatus) {
    if (Number(sourceStatus) !== RequestStatus.Initiated) {
      logger.warn(`Request ${requestId} is not in Initiated state on the source chain`);
      return false;
    }

    const [, destStatus] = await this.destRouter.getBridgeRequest(requestId);
    if (Number(destStatus.toString()) !== RequestStatus.None) {
      // Already recorded (or further along) - a restart, or a second watcher.
      return true;
    }

    try {
      const tx = await this.destRouter.recordInbound(request, requestId, this.settings);
      await tx.wait();
      logger.info(`recordInbound ${requestId} confirmed: ${tx.hash}`);
      return true;
    } catch (error) {
      const name = revertName(error);
      if (name === 'AlreadyRecorded' || /AlreadyRecorded/.test(error.message)) {
        return true;
      }
      throw error;
    }
  }

  /** Releases the funds on the destination chain. */
  async complete(request, requestId, proof) {
    try {
      const tx = await this.destRouter.completeBridge(request, requestId, proof, this.settings);
      const receipt = await tx.wait();
      logger.info(`completeBridge ${requestId} confirmed in ${receipt.transactionHash}`);
      return { completed: true, transactionHash: receipt.transactionHash };
    } catch (error) {
      const name = revertName(error);
      if (
        name === 'InvalidStatus' ||
        name === 'AlreadyCompleted' ||
        /InvalidStatus|AlreadyCompleted/.test(error.message)
      ) {
        logger.info(`Request ${requestId} was already completed`);
        return { completed: false, reason: 'already-completed' };
      }
      throw error;
    }
  }
}

module.exports = BridgeWatcher;
module.exports.normaliseRequest = normaliseRequest;
module.exports.revertName = revertName;
module.exports.findRevertData = findRevertData;
module.exports.RequestStatus = RequestStatus;
