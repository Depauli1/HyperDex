/**
 * The Hop route on the JavaScript side.
 *
 * Hop has no destination-chain message callback: the bonder transfers the funds
 * and the on-chain `HopAdapter.bridgeIn` pays them out under the router's
 * `recordInbound` authorisation. The observer therefore watches the adapter's
 * balance and its `processed` flag.
 */
const { ethers } = require('ethers');
const HopAdapter = require('../../src/services/adapters/HopAdapter');
const HopAdapterABI = require('../../abi/HopAdapter.json');

describe('HopAdapter observer', () => {
  const adapterAddress = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';

  function makeAdapter(overrides = {}) {
    return new HopAdapter({
      destinationProvider: new ethers.providers.JsonRpcProvider('http://127.0.0.1:1'),
      adapterAddress,
      bonderFeeBps: 25,
      ...overrides
    });
  }

  it('requires the destination adapter address', () => {
    expect(() => makeAdapter({ adapterAddress: undefined })).toThrow(
      /requires the destination adapter address/
    );
  });

  it('binds to the real adapter ABI', () => {
    const functions = HopAdapterABI.filter((e) => e.type === 'function').map((e) => e.name);
    expect(functions).toContain('bridgeOut');
    expect(functions).toContain('bridgeIn');
    expect(functions).toContain('processed');
  });

  it('quotes the bonder fee in basis points of the bridged amount', async () => {
    const fee = await makeAdapter().quoteFees({ amount: ethers.utils.parseEther('100') });
    expect(fee.toString()).toBe(ethers.utils.parseEther('0.25').toString());
  });

  it('quotes a configurable bonder fee', async () => {
    const fee = await makeAdapter({ bonderFeeBps: 100 }).quoteFees({
      amount: ethers.utils.parseEther('1')
    });
    expect(fee.toString()).toBe(ethers.utils.parseEther('0.01').toString());
  });

  it('reports delivery once the adapter has processed the request', async () => {
    const adapter = makeAdapter();
    adapter.adapter = { processed: jest.fn().mockResolvedValue(true) };

    expect(await adapter.waitForDelivery('0x' + '77'.repeat(32), { pollMs: 1 })).toBe(true);
  });

  it('waits for the adapter balance when the request is not processed yet', async () => {
    const adapter = makeAdapter();
    adapter.adapter = { processed: jest.fn().mockResolvedValue(false) };
    adapter.destinationProvider = {
      ...adapter.destinationProvider,
      // A provider that returns a balance that grows past the requested amount.
      call: jest.fn().mockResolvedValue(
        ethers.utils.defaultAbiCoder.encode(
          ['uint256'],
          [ethers.utils.parseEther('2')]
        )
      )
    };

    const delivered = await adapter.waitForDelivery('0x' + '88'.repeat(32), {
      pollMs: 1,
      token: '0x0000000000000000000000000000000000000001',
      amount: ethers.utils.parseEther('1')
    });
    expect(delivered).toBe(true);
  });

  it('carries no extra proof: Hop funds arrive by bonder transfer', async () => {
    expect(await makeAdapter().fetchProof()).toBe('0x');
  });
});
