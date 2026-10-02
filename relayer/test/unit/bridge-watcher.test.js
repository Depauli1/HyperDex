/**
 * The cross-chain watcher: request shape, status handling and retry safety.
 *
 * These tests run against the local JSON-RPC chain in test/utils/fake-chain.js.
 * ethers does the real work - contract objects built from
 * relayer/abi/BridgeRouter.json, real RLP-encoded and signed transactions, real
 * revert decoding - so the assertions are about the watcher's behaviour against
 * the actual contract interface rather than against a hand-written stub.
 *
 * The old suite seeded a six-field request (`amount/user/fee`) that does not
 * exist on-chain, keyed adapters by `formatBytes32String('HOP')` while the code
 * looked up `'HOP'`, and passed two arguments to a three-argument
 * `completeBridge`. All three are corrected here.
 */
const { ethers } = require('ethers');
const BridgeWatcher = require('../../src/services/bridge-watcher');
const { normaliseRequest, revertName, RequestStatus } = require('../../src/services/bridge-watcher');
const BridgeRouterABI = require('../../abi/BridgeRouter.json');
const { createChain } = require('../utils/fake-chain');

const SOURCE_ROUTER = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const DEST_ROUTER = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TOKEN = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RELAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const REQUEST_ID = ethers.utils.formatBytes32String('REQ-1');

// The custom errors the watcher reacts to, declared exactly as in
// contracts/BridgeRouter.sol (they take no arguments).
const CUSTOM_ERRORS = ['error AlreadyRecorded()', 'error InvalidStatus()'];

// NB: the struct's `id` is a uint256 counter; REQUEST_ID is the bytes32 key the
// router files it under (`bridgeRequests[requestId]`).
function buildRequest(overrides = {}) {
  return {
    id: 1,
    srcChainId: 1,
    dstChainId: 10,
    token: TOKEN,
    amount: ethers.utils.parseEther('5'),
    user: USER,
    deadline: 1893456000,
    fee: ethers.utils.parseEther('0.01'),
    ...overrides
  };
}

/**
 * Boots a chain that answers the way the real router does: `getBridgeRequest`
 * returns the stored request plus its status, and writes are accepted unless a
 * test arms a revert.
 */
async function makeWatcher({
  request = buildRequest(),
  sourceStatus = RequestStatus.Initiated,
  destStatus = RequestStatus.None,
  sourceAccounts = ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
  recordInboundReverts = null,
  completeBridgeReverts = null,
  observer
} = {}) {
  const abi = [...BridgeRouterABI, ...CUSTOM_ERRORS];
  const chain = await createChain({
    contracts: {
      [SOURCE_ROUTER]: abi,
      [DEST_ROUTER]: abi,
      __errorAbi: abi
    }
  });

  chain.onCall(SOURCE_ROUTER, 'getBridgeRequest', () => [request, sourceStatus]);
  chain.onCall(DEST_ROUTER, 'getBridgeRequest', () => [request, destStatus]);
  chain.onCall(DEST_ROUTER, 'recordInbound', () => {
    if (recordInboundReverts) throw chain.revert(recordInboundReverts);
    return undefined;
  });
  chain.onCall(DEST_ROUTER, 'completeBridge', () => {
    if (completeBridgeReverts) throw chain.revert(completeBridgeReverts);
    return undefined;
  });

  const provider = new ethers.providers.JsonRpcProvider(chain.url);
  const wallet = new ethers.Wallet(RELAYER_KEY, provider);

  const watcher = new BridgeWatcher({
    sourceProvider: provider,
    destProvider: provider,
    wallet,
    sourceRouterAddress: SOURCE_ROUTER,
    destRouterAddress: DEST_ROUTER,
    adapters: { 10: observer || { fetchProof: async () => '0x' } },
    srcChainId: 1,
    dstChainId: 10,
    confirmations: 0
  });

  return { chain, provider, wallet, watcher };
}

describe('BridgeWatcher', () => {
  it('binds to the real BridgeRouter ABI', () => {
    const functions = BridgeRouterABI.filter((e) => e.type === 'function').map((e) => e.name);
    expect(functions).toEqual(
      expect.arrayContaining(['initiateBridge', 'recordInbound', 'completeBridge', 'getBridgeRequest'])
    );
    const events = BridgeRouterABI.filter((e) => e.type === 'event').map((e) => e.name);
    expect(events).toContain('BridgeInitiated');
  });

  it('decodes the on-chain struct, including the fields the event omits', () => {
    const decoded = normaliseRequest(buildRequest());
    expect(decoded.id).toBe('1');
    expect(decoded.amount).toBe(ethers.utils.parseEther('5').toString());
    expect(decoded.user).toBe(USER);
    expect(decoded.deadline).toBe('1893456000');
    expect(decoded.fee).toBe(ethers.utils.parseEther('0.01').toString());
  });

  it('normalises an unnamed on-chain struct by position', () => {
    // The ABI's tuple components are unnamed, so ethers returns a plain array.
    const positional = [
      7,
      1,
      10,
      TOKEN,
      ethers.utils.parseEther('3'),
      USER,
      1893456000,
      ethers.utils.parseEther('0.03')
    ];
    const decoded = normaliseRequest(positional);
    expect(decoded.id).toBe('7');
    expect(decoded.dstChainId).toBe('10');
    expect(decoded.token).toBe(TOKEN);
    expect(decoded.amount).toBe(ethers.utils.parseEther('3').toString());
    expect(decoded.user).toBe(USER);
    expect(decoded.fee).toBe(ethers.utils.parseEther('0.03').toString());
  });

  it('rejects a struct with no request', () => {
    expect(() => normaliseRequest(null)).toThrow(/no request returned by the router/);
  });

  it('decodes a custom error from raw revert data', () => {
    const iface = new ethers.utils.Interface(CUSTOM_ERRORS);
    const error = new Error('execution reverted');
    error.data = iface.encodeErrorResult('AlreadyRecorded', []);
    expect(revertName(error)).toBe('AlreadyRecorded');
  });

  it('finds revert data buried in a gas-estimation error', () => {
    const iface = new ethers.utils.Interface(CUSTOM_ERRORS);
    const data = iface.encodeErrorResult('InvalidStatus', []);
    const error = new Error('cannot estimate gas');
    error.code = 'UNPREDICTABLE_GAS_LIMIT';
    error.error = { reason: 'processing response error', error: { code: 3, data } };
    expect(revertName(error)).toBe('InvalidStatus');
  });

  it('returns null for a revert that is not a router custom error', () => {
    const error = new Error('execution reverted');
    error.data = ethers.utils.id('Error(string)').slice(0, 10);
    expect(revertName(error)).toBeNull();
  });

  it('reads the full request from the source router and completes it on the destination', async () => {
    const { chain, watcher } = await makeWatcher();
    try {
      const result = await watcher.handleInitiated(REQUEST_ID, {});

      expect(result.completed).toBe(true);
      const methods = chain.sent.map((tx) => tx.method);
      // recordInbound must come first: without it completeBridge reverts InvalidStatus.
      expect(methods).toEqual(['recordInbound', 'completeBridge']);

      const [recorded, completed] = chain.sent;
      expect(recorded.to).toBe(DEST_ROUTER);
      expect(completed.to).toBe(DEST_ROUTER);

      // The recorded request is the one read from the source chain, and the
      // completion carries the same request id and proof.
      const iface = new ethers.utils.Interface(BridgeRouterABI);
      const recordArgs = iface.decodeFunctionData('recordInbound', recorded.data);
      const [request, requestId] = recordArgs;
      expect(request[0].toString()).toBe('1');
      expect(request[2].toString()).toBe('10');
      expect(request[3]).toBe(TOKEN);
      expect(request[4].toString()).toBe(ethers.utils.parseEther('5').toString());
      expect(request[5]).toBe(USER);
      expect(request[6].toString()).toBe('1893456000');
      expect(requestId).toBe(REQUEST_ID);

      const completeArgs = iface.decodeFunctionData('completeBridge', completed.data);
      expect(completeArgs[1]).toBe(REQUEST_ID);
      expect(completeArgs[2]).toBe('0x');
    } finally {
      await chain.close();
    }
  });

  it('skips requests already recorded on the destination chain', async () => {
    const { chain, watcher } = await makeWatcher({ destStatus: RequestStatus.Initiated });
    try {
      const result = await watcher.handleInitiated(REQUEST_ID, {});
      expect(result.completed).toBe(true);
      expect(chain.sent.map((tx) => tx.method)).toEqual(['completeBridge']);
    } finally {
      await chain.close();
    }
  });

  it('tolerates a concurrent AlreadyRecorded revert', async () => {
    const { chain, watcher } = await makeWatcher({ recordInboundReverts: 'AlreadyRecorded' });
    try {
      const result = await watcher.handleInitiated(REQUEST_ID, {});

      // The revert surfaces during gas estimation, so no recordInbound
      // transaction is broadcast - and the watcher carries on to completion,
      // because someone else already recorded it.
      expect(result.completed).toBe(true);
      expect(chain.sent.map((tx) => tx.method)).toEqual(['completeBridge']);
    } finally {
      await chain.close();
    }
  });

  it('does not touch the destination chain for a request not in Initiated state', async () => {
    const { chain, watcher } = await makeWatcher({ sourceStatus: RequestStatus.Completed });
    try {
      const result = await watcher.handleInitiated(REQUEST_ID, {});
      expect(result).toEqual({ skipped: 'not-recorded' });
      expect(chain.sent).toHaveLength(0);
    } finally {
      await chain.close();
    }
  });

  it('ignores transfers bound for another chain', async () => {
    const { chain, watcher } = await makeWatcher({
      request: buildRequest({ dstChainId: 137 })
    });
    try {
      const result = await watcher.handleInitiated(REQUEST_ID, {});
      expect(result).toEqual({ skipped: 'wrong-destination' });
      expect(chain.sent).toHaveLength(0);
    } finally {
      await chain.close();
    }
  });

  it('reports an already-completed destination request without failing', async () => {
    const { chain, watcher } = await makeWatcher({
      destStatus: RequestStatus.Initiated,
      completeBridgeReverts: 'InvalidStatus'
    });
    try {
      const result = await watcher.handleInitiated(REQUEST_ID, {});
      expect(result).toEqual({ completed: false, reason: 'already-completed' });
    } finally {
      await chain.close();
    }
  });

  it('refuses to work without a destination observer', async () => {
    const { chain, watcher } = await makeWatcher();
    try {
      watcher.adapters = {};
      await expect(watcher.handleInitiated(REQUEST_ID, {})).rejects.toThrow(
        /No adapter observer configured for destination chain 10/
      );
    } finally {
      await chain.close();
    }
  });

  it('asks the observer for the proof the router must carry', async () => {
    const fetchProof = jest.fn().mockResolvedValue('0xdeadbeef');
    const { chain, watcher } = await makeWatcher({ observer: { fetchProof } });
    try {
      await watcher.handleInitiated(REQUEST_ID, {});
      const [requestArg, idArg] = fetchProof.mock.calls[0];
      expect(idArg).toBe(REQUEST_ID);
      expect(requestArg).toEqual(
        expect.objectContaining({
          id: '1',
          dstChainId: '10',
          token: TOKEN,
          user: USER,
          deadline: '1893456000'
        })
      );

      const iface = new ethers.utils.Interface(BridgeRouterABI);
      const completeArgs = iface.decodeFunctionData('completeBridge', chain.sent[1].data);
      expect(completeArgs[2]).toBe('0xdeadbeef');
    } finally {
      await chain.close();
    }
  });

  it('waits for confirmations before reading the request', async () => {
    const { chain, watcher, provider } = await makeWatcher();
    try {
      const waited = [];
      watcher.sourceProvider = {
        ...provider,
        waitForTransaction: async (hash, confirmations) => {
          waited.push([hash, confirmations]);
          return { status: 1 };
        }
      };

      await watcher.handleInitiated(REQUEST_ID, { transactionHash: '0x' + 'cd'.repeat(32) });
      expect(waited).toEqual([['0x' + 'cd'.repeat(32), 0]]);
    } finally {
      await chain.close();
    }
  });
});
