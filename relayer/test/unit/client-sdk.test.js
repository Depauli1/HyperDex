/**
 * The client SDK, tested as shipped.
 *
 * This suite used to load a hand-written `client-sdk.mock.js` and assert that
 * the mock behaved like the mock - it could not have caught the domain-name
 * mismatch that made every SDK signature unusable on-chain. It now signs with
 * real wallets and posts to a real HTTP server.
 */
const http = require('http');
const { ethers } = require('ethers');
const HyperDexRelayerSDK = require('../../client-sdk');
const { verifyGaslessSwap, hashGaslessSwap } = require('../../src/utils/signature');
const HyperDexABI = require('../../abi/HyperDex.json');
const { createChain } = require('../utils/fake-chain');

const HYPERDEX = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const POOL = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const USER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CHAIN_ID = 31337;

async function startRelayerStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      requests.push(parsed);
      handler(parsed, res);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function makeSdk({ nonce = 7, relayerHandler } = {}) {
  const chain = await createChain({
    chainId: CHAIN_ID,
    contracts: { [HYPERDEX]: HyperDexABI }
  });
  chain.onStaticCall(HYPERDEX, 'getNonce', ethers.BigNumber.from(nonce));

  const provider = new ethers.providers.JsonRpcProvider(chain.url);
  const user = new ethers.Wallet(USER_KEY, provider);

  const relayer = await startRelayerStub(
    relayerHandler ||
      ((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transactionHash: '0x' + '12'.repeat(32), status: 'submitted' }));
      })
  );

  const sdk = new HyperDexRelayerSDK({
    relayerUrl: relayer.url,
    hyperDexAddress: HYPERDEX,
    provider
  });
  await sdk.initialize();

  return { chain, provider, user, relayer, sdk };
}

describe('HyperDexRelayerSDK', () => {
  it('initializes the EIP-712 domain the contract actually uses', async () => {
    const { chain, relayer, sdk } = await makeSdk();
    try {
      expect(sdk.domain).toEqual({
        name: 'HyperDex',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: HYPERDEX
      });
      expect(sdk.initialized).toBe(true);
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('builds the signed struct with `pool` (not `poolAddress`)', async () => {
    const { chain, relayer, sdk, user } = await makeSdk();
    try {
      const params = await sdk.createSwapParams({
        userAddress: user.address,
        zeroForOne: true,
        amountSpecified: ethers.utils.parseEther('1'),
        sqrtPriceLimitX96: '4295128740',
        pool: POOL
      });

      expect(Object.keys(params)).toEqual([
        'pool',
        'trader',
        'zeroForOne',
        'amountSpecified',
        'sqrtPriceLimitX96',
        'deadline',
        'nonce'
      ]);
      expect(params.nonce).toBe('7'); // read from the contract, not invented
      expect(params.pool).toBe(POOL);
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('refuses to invent a nonce', async () => {
    const { chain, relayer, sdk } = await makeSdk();
    try {
      expect(() => sdk.generateNonce()).toThrow(/call getNonce/);
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('signs a swap the relayer and the contract both accept', async () => {
    const { chain, relayer, sdk, user } = await makeSdk();
    try {
      const params = await sdk.createSwapParams({
        userAddress: user.address,
        zeroForOne: false,
        amountSpecified: ethers.utils.parseEther('2'),
        sqrtPriceLimitX96: '1461446703485210103287273052203988822378723970341',
        pool: POOL
      });

      const signature = await sdk.signSwap(params, user);

      const deployment = { chainId: CHAIN_ID, verifyingContract: HYPERDEX };
      // The relayer's verification passes...
      expect(verifyGaslessSwap(params, signature, deployment)).toBe(true);
      // ...and the digest is the contract's digest.
      expect(ethers.utils.recoverAddress(hashGaslessSwap(params, deployment), signature)).toBe(
        user.address
      );
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('createSignedSwap attaches the signature and the sequence nonce', async () => {
    const { chain, relayer, sdk, user } = await makeSdk();
    try {
      const signed = await sdk.createSignedSwap(user, {
        pool: POOL,
        trader: user.address,
        zeroForOne: true,
        amountSpecified: ethers.utils.parseEther('1'),
        sqrtPriceLimitX96: '4295128740',
        deadline: Math.floor(Date.now() / 1000) + 600
      });

      expect(signed.nonce).toBe('7');
      expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(
        verifyGaslessSwap(signed, signed.signature, {
          chainId: CHAIN_ID,
          verifyingContract: HYPERDEX
        })
      ).toBe(true);
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('posts the signed swap to the relayer', async () => {
    const { chain, relayer, sdk, user } = await makeSdk();
    try {
      const params = await sdk.createSwapParams({
        userAddress: user.address,
        zeroForOne: true,
        amountSpecified: ethers.utils.parseEther('1'),
        sqrtPriceLimitX96: '4295128740',
        pool: POOL
      });
      const signature = await sdk.signSwap(params, user);

      const result = await sdk.submitGaslessSwap({ ...params, signature });
      expect(result.status).toBe('submitted');

      expect(relayer.requests).toHaveLength(1);
      const { method, url, body } = relayer.requests[0];
      expect(method).toBe('POST');
      expect(url).toBe('/api/swap/gasless');
      expect(body.signature).toBe(signature);
      expect(body.pool).toBe(POOL);
      expect(body.trader).toBe(user.address);
      expect(body.nonce).toBe('7');
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('surfaces a relayer rejection verbatim', async () => {
    const { chain, relayer, sdk, user } = await makeSdk({
      relayerHandler: (req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Signature does not match trader' }));
      }
    });
    try {
      await expect(sdk.submitGaslessSwap({ trader: user.address })).rejects.toThrow(
        'Signature does not match trader'
      );
    } finally {
      await relayer.close();
      await chain.close();
    }
  });

  it('reports a missing transaction instead of throwing', async () => {
    const { chain, relayer, sdk } = await makeSdk({
      relayerHandler: (req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    try {
      expect(await sdk.getTransactionStatus('0x' + '34'.repeat(32))).toEqual({
        found: false,
        error: 'Transaction not found'
      });
    } finally {
      await relayer.close();
      await chain.close();
    }
  });
});
