const BridgeWatcher = require('../../src/services/bridge-watcher');
const { ethers } = require('ethers');
const { expect } = require('chai');
const sinon = require('sinon');

describe('BridgeWatcher', () => {
  let fakeSourceContract;
  let fakeDestContract;
  let fakeProvider;
  let dummyAdapter;
  let watcher;

  beforeEach(() => {
    // Mocks
    fakeSourceContract = { on: sinon.stub() };
    fakeDestContract = { completeBridge: sinon.stub().resolves({ hash: '0xabc' }) };
    fakeProvider = { waitForTransaction: sinon.stub().resolves() };
    dummyAdapter = { fetchProof: sinon.stub().resolves('0x1234') };

    const adapters = new Map();
    const adapterKey = ethers.utils.formatBytes32String('HOP');
    adapters.set(adapterKey, dummyAdapter);

    // Dummy request
    const id = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const req = { id, adapterKey, user: '0xuser', amount: ethers.BigNumber.from(100), fee: 10 };

    // Instantiate watcher with injected mocks
    watcher = new BridgeWatcher({
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
    watcher.start();
  });

  it('handles BridgeOutbound and calls completeBridge', async () => {
    // Seed request
    watcher.requests.set(watcher.requests.id, { id: watcher.requests.id, adapterKey: 'HOP', user: '0xuser', amount: ethers.BigNumber.from(100), fee: 10 });

    // Get handler registered for BridgeOutbound
    expect(fakeSourceContract.on).to.have.been.calledWith('BridgeOutbound', sinon.match.func);
    const outboundHandler = fakeSourceContract.on.args.find(call => call[0] === 'BridgeOutbound')[1];

    // Simulate event invocation
    const event = { transactionHash: '0xtxhash' };
    await outboundHandler(watcher.requests.id, event);

    // Assertions
    expect(fakeProvider.waitForTransaction).to.have.been.calledWith('0xtxhash', 1);
    expect(dummyAdapter.fetchProof).to.have.been.calledWith('0xtxhash');
    expect(fakeDestContract.completeBridge).to.have.been.calledWith(
      {
        id: watcher.requests.id,
        srcChainId: 1,
        dstChainId: 2,
        token: '0xtoken',
        amount: ethers.BigNumber.from(100),
        user: '0xuser',
        deadline: 0,
        fee: 10
      },
      '0x1234',
      'HOP'
    );
  });
});
