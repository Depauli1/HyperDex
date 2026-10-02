/**
 * The LayerZero route on the JavaScript side.
 *
 * As with Connext, the protocol call (`endpoint.send`) is made by the on-chain
 * adapter; this class observes the destination-chain flag that the endpoint sets
 * through `lzReceive`. See connext-adapter.test.js for the design note.
 */
const { ethers } = require('ethers');
const LayerZeroAdapter = require('../../src/services/adapters/LayerZeroAdapter');
const LayerZeroAdapterABI = require('../../abi/LayerZeroAdapter.json');

describe('LayerZeroAdapter observer', () => {
  const adapterAddress = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
  const chainIdMapping = { 2: 10102, 11155111: 40161 };

  function makeAdapter(overrides = {}) {
    return new LayerZeroAdapter({
      destinationProvider: new ethers.providers.JsonRpcProvider('http://127.0.0.1:1'),
      adapterAddress,
      chainIdMapping,
      nativeFee: '2000',
      ...overrides
    });
  }

  it('requires the destination adapter address', () => {
    expect(() => makeAdapter({ adapterAddress: undefined })).toThrow(
      /requires the destination adapter address/
    );
  });

  it('binds to the real adapter ABI', () => {
    const functions = LayerZeroAdapterABI.filter((e) => e.type === 'function').map((e) => e.name);
    expect(functions).toContain('bridgeOut');
    expect(functions).toContain('bridgeIn');
    expect(functions).toContain('verifiedMessages');
    expect(functions).toContain('lzReceive');
  });

  it('maps a chain id to a LayerZero endpoint id', () => {
    expect(makeAdapter().getLzChainId(11155111)).toBe(40161);
  });

  it('refuses to quote for a chain with no endpoint mapping', async () => {
    await expect(makeAdapter().quoteFees({ dstChainId: 3 })).rejects.toThrow(
      'LayerZeroAdapter: missing chain mapping for chain 3'
    );
  });

  it('quotes the configured native fee', async () => {
    const fee = await makeAdapter().quoteFees({ dstChainId: 2 });
    expect(fee.toString()).toBe('2000');
  });

  it('refuses to quote when no native fee is configured', async () => {
    await expect(
      makeAdapter({ nativeFee: undefined }).quoteFees({ dstChainId: 2 })
    ).rejects.toThrow(/nativeFee is not configured/);
  });

  it('carries no extra proof: the endpoint proves delivery on-chain', async () => {
    expect(await makeAdapter().fetchProof()).toBe('0x');
  });

  it('reads the on-chain verification flag', async () => {
    const adapter = makeAdapter();
    adapter.adapter = { verifiedMessages: jest.fn().mockResolvedValue(true) };
    expect(await adapter.isVerified('0x' + '44'.repeat(32))).toBe(true);
  });

  it('polls until the message is verified', async () => {
    const adapter = makeAdapter();
    let calls = 0;
    adapter.adapter = {
      verifiedMessages: jest.fn(async () => {
        calls += 1;
        return calls >= 2;
      })
    };

    expect(await adapter.waitForDelivery('0x' + '55'.repeat(32), { pollMs: 1 })).toBe(true);
    expect(calls).toBe(2);
  });

  it('gives up after the timeout', async () => {
    const adapter = makeAdapter({ timeoutMs: 20 });
    adapter.adapter = { verifiedMessages: jest.fn().mockResolvedValue(false) };

    expect(await adapter.waitForDelivery('0x' + '66'.repeat(32), { pollMs: 5 })).toBe(false);
  });
});
