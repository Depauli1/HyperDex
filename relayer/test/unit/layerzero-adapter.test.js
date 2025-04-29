const { ethers, utils } = require('ethers');
const LayerZeroAdapter = require('../../src/services/adapters/LayerZeroAdapter');
const sinon = require('sinon');

describe('LayerZeroAdapter', () => {
  const config = {
    endpointAddress: '0xE',
    endpointABI: [],
    wallet: {},
    chainIdMapping: { 1: 1001 },
    adapterParams: '0x0102',
    zroPaymentAddress: '0xZRO',
    refundAddress: '0xREF',
    remoteContractAddress: '0xRC'
  };
  let adapter;

  beforeEach(() => {
    sinon.restore();
    adapter = Object.create(LayerZeroAdapter.prototype);
    Object.assign(adapter, {
      config,
      endpoint: {
        estimateFees: sinon.stub().resolves([ethers.BigNumber.from(123), ethers.BigNumber.from(0)]),
        send: sinon.stub().resolves({ hash: '0xdead' })
      },
      chainIdMapping: config.chainIdMapping,
      adapterParams: config.adapterParams,
      zroPaymentAddress: config.zroPaymentAddress,
      refundAddress: config.refundAddress,
      remoteContractAddress: config.remoteContractAddress
    });
  });

  it('quoteFees returns native fee from endpoint.estimateFees', async () => {
    const req = { dstChainId: 1 };
    const fee = await adapter.quoteFees(req);
    sinon.assert.calledWith(adapter.endpoint.estimateFees,
      1001,
      config.remoteContractAddress,
      '0x',
      false,
      config.adapterParams
    );
    expect(fee).toEqual(ethers.BigNumber.from(123));
  });

  it('bridgeOut calls send with correct params and returns tx', async () => {
    const req = {
      id: '0x0000000000000000000000000000000000000000000000000000000000000049', // bytes32 hex string
      srcChainId: 1,
      dstChainId: 1,
      token: '0x0000000000000000000000000000000000000000',
      amount: 10,
      user: '0x0000000000000000000000000000000000000001',
      deadline: 200,
      fee: ethers.BigNumber.from(50)
    };
    const tx = await adapter.bridgeOut(req);
    sinon.assert.calledWith(adapter.endpoint.send,
      1001,
      config.remoteContractAddress,
      sinon.match.any,
      config.refundAddress,
      config.zroPaymentAddress,
      config.adapterParams,
      { value: req.fee }
    );
    expect(tx).toEqual({ hash: '0xdead' });
  });

  it('fetchProof returns byte array of txHash', async () => {
    const proof = await adapter.fetchProof('0xbeef');
    expect(proof).toEqual(utils.arrayify('0xbeef'));
  });

  it('bridgeIn returns null', async () => {
    const res = await adapter.bridgeIn({}, []);
    expect(res).toBeNull();
  });
});
