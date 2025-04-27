const { ethers } = require('ethers');
const LayerZeroAdapter = require('../../src/services/adapters/LayerZeroAdapter');

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
    adapter = new LayerZeroAdapter(config);
    adapter.endpoint = {
      estimateFees: jest.fn().mockResolvedValue([ethers.BigNumber.from(123), ethers.BigNumber.from(0)]),
      send: jest.fn().mockResolvedValue({ hash: '0xdead' })
    };
  });

  it('quoteFees returns native fee from endpoint.estimateFees', async () => {
    const req = { dstChainId: 1 };
    const fee = await adapter.quoteFees(req);
    expect(adapter.endpoint.estimateFees).toHaveBeenCalledWith(
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
      id: '0xID',
      srcChainId: 1,
      dstChainId: 1,
      token: '0xTOK',
      amount: 10,
      user: '0xUSER',
      deadline: 200,
      fee: ethers.BigNumber.from(50)
    };
    const tx = await adapter.bridgeOut(req);
    expect(adapter.endpoint.send).toHaveBeenCalledWith(
      1001,
      config.remoteContractAddress,
      expect.any(String),
      config.refundAddress,
      config.zroPaymentAddress,
      config.adapterParams,
      { value: req.fee }
    );
    expect(tx).toEqual({ hash: '0xdead' });
  });

  it('fetchProof returns byte array of txHash', async () => {
    const proof = await adapter.fetchProof('0xbeef');
    expect(proof).toEqual(ethers.utils.arrayify('0xbeef'));
  });

  it('bridgeIn returns null', async () => {
    const res = await adapter.bridgeIn({}, []);
    expect(res).toBeNull();
  });
});
