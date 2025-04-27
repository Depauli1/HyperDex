const BridgeWatcher = require('../../src/services/bridge-watcher');
const { ethers } = require('ethers');

describe('BridgeWatcher', () => {
  it('handles BridgeOutbound and calls completeBridge', async () => {
    // Mocks
    const fakeSourceContract = { on: jest.fn() };
    const fakeDestContract = { completeBridge: jest.fn().mockResolvedValue({ hash: '0xabc' }) };
    const fakeProvider = { waitForTransaction: jest.fn().mockResolvedValue() };
    const dummyAdapter = { fetchProof: jest.fn().mockResolvedValue('0x1234') };

    const adapters = new Map();
    const adapterKey = ethers.utils.formatBytes32String('HOP');
    adapters.set(adapterKey, dummyAdapter);

    // Dummy request
    const id = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const req = { id, adapterKey, user: '0xuser', amount: ethers.BigNumber.from(100), fee: 10 };

    // Instantiate watcher with injected mocks
    const watcher = new BridgeWatcher({
      sourceProvider: fakeProvider,
      destProvider: fakeProvider,
      wallet: {},
      sourceRouterAddress: '0x0',
      destRouterAddress: '0x0',
      adapters,
      srcChainId: 1,
      dstChainId: 2,
      token: '0xtoken',
      confirmations: 1,
      sourceContract: fakeSourceContract,
      destContract: fakeDestContract
    });

    // Register event handlers
    await watcher.start();

    // Seed request
    watcher.requests.set(id, req);

    // Get handler registered for BridgeOutbound
    expect(fakeSourceContract.on).toHaveBeenCalledWith('BridgeOutbound', expect.any(Function));
    const outboundHandler = fakeSourceContract.on.mock.calls
      .find(call => call[0] === 'BridgeOutbound')[1];

    // Simulate event invocation
    const event = { transactionHash: '0xtxhash' };
    await outboundHandler(id, event);

    // Assertions
    expect(fakeProvider.waitForTransaction).toHaveBeenCalledWith('0xtxhash', 1);
    expect(dummyAdapter.fetchProof).toHaveBeenCalledWith('0xtxhash');
    expect(fakeDestContract.completeBridge).toHaveBeenCalledWith(
      {
        id,
        srcChainId: 1,
        dstChainId: 2,
        token: '0xtoken',
        amount: req.amount,
        user: req.user,
        deadline: 0,
        fee: req.fee
      },
      '0x1234',
      adapterKey
    );
  });
});
