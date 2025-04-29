const { ethers, utils } = require('ethers');
const ConnextAdapter = require('../../src/services/adapters/ConnextAdapter');

describe('ConnextAdapter', () => {
  const dummyWallet = {};
  const config = {
    connextAddress: '0xC',
    connextABI: [],
    wallet: dummyWallet,
    domainMapping: { 2: 22 },
    slippage: 5,
    callData: '0x01',
    delegate: '0xD'
  };
  let adapter;

  beforeEach(() => {
    adapter = new ConnextAdapter(config);
    adapter.connext = {
      xcall: jest.fn().mockResolvedValue({ hash: '0xabc' })
    };
  });

  it('calls xcall with correct args and returns the tx', async () => {
    const req = { dstChainId: 2, user: '0xU', token: '0xT', amount: 100, fee: 10 };
    const tx = await adapter.bridgeOut(req);
    expect(adapter.connext.xcall).toHaveBeenCalledWith(
      22,
      '0xU',
      '0xT',
      '0xD',
      100,
      5,
      '0x01',
      { value: 10 }
    );
    expect(tx).toEqual({ hash: '0xabc' });
  });

  it('throws error when domain mapping is missing', async () => {
    await expect(
      adapter.bridgeOut({ dstChainId: 3, user: '', token: '', amount: 0, fee: 0 })
    ).rejects.toThrow('ConnextAdapter: missing domain mapping for chain 3');
  });

  it('fetchProof returns byte array of txHash', async () => {
    const proof = await adapter.fetchProof('0x1234');
    expect(proof).toEqual(utils.arrayify('0x1234'));
  });

  it('bridgeIn returns null', async () => {
    const res = await adapter.bridgeIn({}, []);
    expect(res).toBeNull();
  });
});
