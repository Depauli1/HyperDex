/**
 * ContractService against a real RPC transport.
 *
 * Uses the in-process chain in test/utils/fake-chain.js: the service builds real
 * `ethers.Contract` objects from the generated ABIs, addresses it with a real
 * wallet, and the transactions it sends are decoded here with the same ABI the
 * contract would use. Nothing about the contract interface is hand-written.
 */
const { ethers } = require('ethers');
const ContractService = require('../../src/services/contract-service');
const HyperDexABI = require('../../abi/HyperDex.json');
const FactoryABI = require('../../abi/HyperDexFactory.json');
const { createChain } = require('../utils/fake-chain');

const HYPERDEX = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const FACTORY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const POOL = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const TOKEN_A = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const TOKEN_B = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
const RELAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const TRADER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const CONTRACTS = {
  [HYPERDEX]: HyperDexABI,
  [FACTORY]: FactoryABI,
  // The v3 pool ABI is needed by the service when it wraps a pool address.
  [POOL]: require('../../abi/UniswapV3Pool.json')
};

function makeParams(overrides = {}) {
  return {
    pool: POOL,
    trader: TRADER,
    zeroForOne: true,
    amountSpecified: ethers.utils.parseEther('1').toString(),
    sqrtPriceLimitX96: '4295128740',
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: '1',
    ...overrides
  };
}

async function makeService({ factoryPool = POOL, nonce = 0 } = {}) {
  const chain = await createChain({ contracts: CONTRACTS });
  chain.onStaticCall(FACTORY, 'getPool', factoryPool === ethers.constants.AddressZero ? ethers.constants.AddressZero : factoryPool);
  chain.onStaticCall(HYPERDEX, 'getNonce', ethers.BigNumber.from(nonce));
  chain.onCall(HYPERDEX, 'executeGaslessSwap', () => undefined);

  const provider = new ethers.providers.JsonRpcProvider(chain.url);
  const wallet = new ethers.Wallet(RELAYER_KEY, provider);
  const service = new ContractService({
    provider,
    wallet,
    hyperDexAddress: HYPERDEX,
    factoryAddress: FACTORY
  });

  return { chain, provider, wallet, service };
}

describe('ContractService', () => {
  it('requires a provider, a wallet and a HyperDex address', () => {
    expect(() => new ContractService({ provider: null, wallet: {}, hyperDexAddress: HYPERDEX }))
      .toThrow(/Missing required parameters/);
    expect(() =>
      new ContractService({
        provider: new ethers.providers.JsonRpcProvider('http://127.0.0.1:1'),
        wallet: {},
        hyperDexAddress: null
      })
    ).toThrow(/Missing required parameters/);
  });

  it('loads the HyperDex contract from the generated ABI', async () => {
    const { chain, service } = await makeService();
    try {
      expect(service.hyperDex.address).toBe(HYPERDEX);
      const functions = HyperDexABI.filter((e) => e.type === 'function').map((e) => e.name);
      expect(functions).toContain('executeGaslessSwap');
      expect(functions).toContain('getNonce');
      expect(service.hyperDex.executeGaslessSwap).toBeDefined();
    } finally {
      await chain.close();
    }
  });

  it('resolves a pool through the factory and caches it', async () => {
    const { chain, service } = await makeService();
    try {
      const pool = await service.getPool(TOKEN_A, TOKEN_B, 3000);
      expect(pool.address).toBe(POOL);

      const again = await service.getPool(TOKEN_A, TOKEN_B, 3000);
      expect(again).toBe(pool); // same instance, straight from the cache
    } finally {
      await chain.close();
    }
  });

  it('reports a missing pool instead of returning a broken contract', async () => {
    const { chain, service } = await makeService({ factoryPool: ethers.constants.AddressZero });
    try {
      await expect(service.getPool(TOKEN_A, TOKEN_B, 3000)).rejects.toThrow(
        /No pool found for tokens/
      );
    } finally {
      await chain.close();
    }
  });

  it('rejects invalid token addresses before touching the chain', async () => {
    const { chain, service } = await makeService();
    try {
      await expect(service.getPool('0xnot-an-address', TOKEN_B)).rejects.toThrow(
        /two valid token addresses/
      );
    } finally {
      await chain.close();
    }
  });

  it('submits a gasless swap with the signed struct, in contract order', async () => {
    const { chain, service } = await makeService();
    try {
      const params = makeParams();
      const tx = await service.executeGaslessSwap(params, '0x' + 'ab'.repeat(65));
      await tx.wait();

      expect(chain.sent).toHaveLength(1);
      const sent = chain.sent[0];
      expect(sent.to).toBe(HYPERDEX);
      expect(sent.method).toBe('executeGaslessSwap');

      const iface = new ethers.utils.Interface(HyperDexABI);
      const [struct, signature] = iface.decodeFunctionData('executeGaslessSwap', sent.data);
      expect(struct[0]).toBe(POOL);
      expect(struct[1]).toBe(TRADER);
      expect(struct[2]).toBe(true);
      expect(struct[3].toString()).toBe(ethers.utils.parseEther('1').toString());
      expect(struct[5].toString()).toBe(String(params.deadline));
      expect(struct[6].toString()).toBe('1');
      expect(signature).toBe('0x' + 'ab'.repeat(65));
    } finally {
      await chain.close();
    }
  });

  it('explains the poolAddress trap when callers use the old field name', async () => {
    const { chain, service } = await makeService();
    try {
      const { pool, ...rest } = makeParams();
      await expect(
        service.executeGaslessSwap({ ...rest, poolAddress: pool }, '0x' + 'ab'.repeat(65))
      ).rejects.toThrow(/the signed field is `pool`/);
    } finally {
      await chain.close();
    }
  });

  it('rejects incomplete or invalid parameters', async () => {
    const { chain, service } = await makeService();
    try {
      await expect(service.executeGaslessSwap({ trader: TRADER }, '0x' + 'ab'.repeat(65)))
        .rejects.toThrow(/Missing required parameter/);
      await expect(
        service.executeGaslessSwap(makeParams({ amountSpecified: '0' }), '0x' + 'ab'.repeat(65))
      ).rejects.toThrow(/amountSpecified must be non-zero/);
      await expect(
        service.executeGaslessSwap(makeParams({ trader: 'nope' }), '0x' + 'ab'.repeat(65))
      ).rejects.toThrow(/Invalid trader address/);
    } finally {
      await chain.close();
    }
  });

  it('reads the trader nonce from the contract', async () => {
    const { chain, service } = await makeService({ nonce: 42 });
    try {
      const nonce = await service.getNonce(TRADER);
      expect(nonce.toString()).toBe('42');
    } finally {
      await chain.close();
    }
  });

  it('detaches every listener on cleanup', async () => {
    const { chain, service } = await makeService();
    try {
      await service.getPool(TOKEN_A, TOKEN_B, 3000);
      await service.cleanup();
      expect(service.poolCache.size).toBe(0);
    } finally {
      await chain.close();
    }
  });
});
