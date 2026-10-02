/**
 * Relayer-side EIP-712 verification.
 *
 * Real wallets, real signatures, real digests - the only thing absent is a
 * chain, which is not needed to check a signature. The cross-language half of
 * this contract (the JavaScript digest matching `HyperDex.hashGaslessSwap`) is
 * asserted in the Hardhat suite, test/Eip712Conformance.test.js.
 *
 * The previous version of this file exercised a `passAll` option that skipped
 * verification entirely, which is how a broken domain survived in the first
 * place; that option no longer exists.
 */
const { ethers } = require('ethers');
const {
  verifyGaslessSwap,
  recoverGaslessSwapSigner,
  hashGaslessSwap,
  toStruct,
  SignatureError
} = require('../../src/utils/signature');
const { GASLESS_SWAP_TYPES, gaslessSwapDomain } = require('../../src/config/eip712');

const CHAIN_ID = 31337;
const VERIFYING_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const deployment = { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT };

const trader = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const stranger = new ethers.Wallet(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
);

function makeParams(overrides = {}) {
  return {
    pool: '0x9A676e781A523b5d0C0e43731313A708CB607508',
    trader: trader.address,
    zeroForOne: true,
    amountSpecified: ethers.utils.parseEther('1').toString(),
    sqrtPriceLimitX96: '4295128740',
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: '1',
    ...overrides
  };
}

describe('gasless swap signatures', () => {
  it('signs with the contract domain, not a look-alike', () => {
    const domain = gaslessSwapDomain(CHAIN_ID, VERIFYING_CONTRACT);
    expect(domain).toEqual({
      name: 'HyperDex',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT
    });
    expect(domain.name).not.toBe('HyperDex Protocol');
  });

  it('describes the struct with pool first', () => {
    expect(GASLESS_SWAP_TYPES.GaslessSwap.map((f) => `${f.type} ${f.name}`)).toEqual([
      'address pool',
      'address trader',
      'bool zeroForOne',
      'int256 amountSpecified',
      'uint160 sqrtPriceLimitX96',
      'uint256 deadline',
      'uint256 nonce'
    ]);
  });

  it('rejects the legacy parameter name instead of silently signing nothing', () => {
    const { pool, ...withoutPool } = makeParams();
    expect(() => toStruct({ ...withoutPool, poolAddress: pool })).toThrow(/pool/);
  });

  it('validates a correct signature', async () => {
    const params = makeParams();
    const signature = await trader._signTypedData(
      gaslessSwapDomain(CHAIN_ID, VERIFYING_CONTRACT),
      GASLESS_SWAP_TYPES,
      toStruct(params)
    );

    expect(verifyGaslessSwap(params, signature, deployment)).toBe(true);
    expect(recoverGaslessSwapSigner(params, signature, deployment)).toBe(trader.address);
  });

  it('produces the digest the contract expects', async () => {
    const params = makeParams();
    const signature = await trader._signTypedData(
      gaslessSwapDomain(CHAIN_ID, VERIFYING_CONTRACT),
      GASLESS_SWAP_TYPES,
      toStruct(params)
    );

    const digest = hashGaslessSwap(params, deployment);
    expect(ethers.utils.recoverAddress(digest, signature)).toBe(trader.address);
  });

  it('rejects a signature from a different account', async () => {
    const params = makeParams();
    const signature = await stranger._signTypedData(
      gaslessSwapDomain(CHAIN_ID, VERIFYING_CONTRACT),
      GASLESS_SWAP_TYPES,
      toStruct(params)
    );

    expect(() => verifyGaslessSwap(params, signature, deployment)).toThrow(
      /Signature does not match trader/
    );
  });

  it('rejects a signature made for another contract or chain', async () => {
    const params = makeParams();
    const signature = await trader._signTypedData(
      gaslessSwapDomain(CHAIN_ID, '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'),
      GASLESS_SWAP_TYPES,
      toStruct(params)
    );

    expect(() => verifyGaslessSwap(params, signature, deployment)).toThrow(SignatureError);
  });

  it('rejects tampered parameters', async () => {
    const params = makeParams();
    const signature = await trader._signTypedData(
      gaslessSwapDomain(CHAIN_ID, VERIFYING_CONTRACT),
      GASLESS_SWAP_TYPES,
      toStruct(params)
    );

    const tampered = { ...params, amountSpecified: ethers.utils.parseEther('100').toString() };
    expect(() => verifyGaslessSwap(tampered, signature, deployment)).toThrow(
      /Signature does not match trader/
    );
  });

  it('rejects an expired deadline', async () => {
    const params = makeParams({ deadline: Math.floor(Date.now() / 1000) - 1 });
    const signature = await trader._signTypedData(
      gaslessSwapDomain(CHAIN_ID, VERIFYING_CONTRACT),
      GASLESS_SWAP_TYPES,
      toStruct(params)
    );

    expect(() => verifyGaslessSwap(params, signature, deployment)).toThrow(/deadline has expired/);
  });

  it('rejects malformed signatures', async () => {
    const params = makeParams();
    for (const bad of ['', '0x', '0x1234', 'not-a-signature', '0x' + '11'.repeat(64)]) {
      expect(() => verifyGaslessSwap(params, bad, deployment)).toThrow(/Invalid signature format/);
    }
  });

  it('reports a stable error code for callers to map to HTTP statuses', () => {
    try {
      verifyGaslessSwap(makeParams({ deadline: 1 }), '0x' + '22'.repeat(65), deployment);
      throw new Error('expected verifyGaslessSwap to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SignatureError);
      expect(error.code).toBe('DEADLINE_EXPIRED');
    }
  });
});
