/**
 * The Connext route on the JavaScript side.
 *
 * Design note: protocol calls are made by the on-chain adapter
 * (`ConnextAdapter.bridgeOut` -> `IConnext.xcall`), not from here. This class is
 * an observer - it reads the on-chain delivery flag that Connext's own
 * `xReceive` sets. The tests below therefore cover what the observer owns
 * (configuration, fee quoting, proof shape) and assert that the functions it
 * calls really exist in the ABI generated from the compiled adapter.
 *
 * The fictional `xcTransfer` API the old version of this class called is gone;
 * it does not exist on Connext.
 */
const { ethers } = require('ethers');
const ConnextAdapter = require('../../src/services/adapters/ConnextAdapter');
const ConnextAdapterABI = require('../../abi/ConnextAdapter.json');

describe('ConnextAdapter observer', () => {
  const adapterAddress = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
  const domainMapping = { 2: 22, 11155111: 1936027759 };

  function makeAdapter(overrides = {}) {
    return new ConnextAdapter({
      destinationProvider: new ethers.providers.JsonRpcProvider('http://127.0.0.1:1'),
      adapterAddress,
      domainMapping,
      relayerFee: '1000',
      ...overrides
    });
  }

  it('requires the destination adapter address', () => {
    expect(() => makeAdapter({ adapterAddress: undefined })).toThrow(
      /requires the destination adapter address/
    );
  });

  it('binds to the real adapter ABI', () => {
    const functions = ConnextAdapterABI.filter((e) => e.type === 'function').map((e) => e.name);
    expect(functions).toContain('bridgeOut');
    expect(functions).toContain('bridgeIn');
    expect(functions).toContain('delivered');
    // Connext's own entry points, used by the on-chain adapter.
    expect(functions).toContain('xReceive');
  });

  it('maps a chain id to a Connext domain id', () => {
    expect(makeAdapter().getDomainId(11155111)).toBe(1936027759);
  });

  it('refuses to quote for a chain with no domain mapping', async () => {
    await expect(makeAdapter().quoteFees({ dstChainId: 3 })).rejects.toThrow(
      'ConnextAdapter: missing domain mapping for chain 3'
    );
  });

  it('quotes the configured relayer fee', async () => {
    const fee = await makeAdapter().quoteFees({ dstChainId: 2 });
    expect(fee.toString()).toBe('1000');
  });

  it('refuses to quote when no relayer fee is configured', async () => {
    await expect(
      makeAdapter({ relayerFee: undefined }).quoteFees({ dstChainId: 2 })
    ).rejects.toThrow('ConnextAdapter: relayerFee is not configured');
  });

  it('carries no extra proof: Connext proves delivery on-chain', async () => {
    expect(await makeAdapter().fetchProof()).toBe('0x');
  });

  it('reads the on-chain delivery flag', async () => {
    const adapter = makeAdapter();
    adapter.adapter = { delivered: jest.fn().mockResolvedValue(true) };
    expect(await adapter.isDelivered('0x' + '11'.repeat(32))).toBe(true);
    expect(adapter.adapter.delivered).toHaveBeenCalledWith('0x' + '11'.repeat(32));
  });

  it('polls until the transfer is delivered', async () => {
    const adapter = makeAdapter();
    let calls = 0;
    adapter.adapter = {
      delivered: jest.fn(async () => {
        calls += 1;
        return calls >= 3;
      })
    };

    const delivered = await adapter.waitForDelivery('0x' + '22'.repeat(32), { pollMs: 1 });
    expect(delivered).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up after the timeout', async () => {
    const adapter = makeAdapter({ timeoutMs: 20 });
    adapter.adapter = { delivered: jest.fn().mockResolvedValue(false) };

    expect(await adapter.waitForDelivery('0x' + '33'.repeat(32), { pollMs: 5 })).toBe(false);
  });
});
