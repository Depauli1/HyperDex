import { ethers } from 'ethers';
import {
  GASLESS_SWAP_TYPEHASH,
  GASLESS_SWAP_TYPES,
  buildMintParams,
  deadlineFromMinutes,
  encodeGaslessSwap,
  encodeInitiateBridge,
  gaslessSwapTypedData,
  priceLimitFromPercent,
  toStruct
} from './hyperdex';

const POOL = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const TRADER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN0 = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const TOKEN1 = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
const ROUTER = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

const baseSwap = {
  pool: POOL,
  trader: TRADER,
  zeroForOne: true,
  amountSpecified: ethers.utils.parseEther('1').toString(),
  sqrtPriceLimitX96: '4295128740',
  deadline: 1893456000,
  nonce: '3'
};

describe('gasless swap payloads', () => {
  it('pins the struct to the contract typehash', () => {
    // The same constant appears in contracts/HyperDex.sol and in the relayer's
    // config/eip712.js; if any of the three drifts, this fails.
    const expected = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(
        'GaslessSwap(address pool,address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)'
      )
    );
    expect(GASLESS_SWAP_TYPEHASH).toBe(expected);
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

  it('keeps pool first and rejects the legacy field name', () => {
    expect(Object.keys(toStruct(baseSwap))).toEqual([
      'pool',
      'trader',
      'zeroForOne',
      'amountSpecified',
      'sqrtPriceLimitX96',
      'deadline',
      'nonce'
    ]);

    const { pool, ...rest } = baseSwap;
    expect(() => toStruct({ ...rest, poolAddress: pool })).toThrow(/pool must be a valid address/);
  });

  it('rejects a zero amount and bad addresses', () => {
    expect(() => toStruct({ ...baseSwap, amountSpecified: '0' })).toThrow(/non-zero/);
    expect(() => toStruct({ ...baseSwap, trader: 'nope' })).toThrow(/valid address/);
  });

  it('encodes calldata the contract can decode', () => {
    const struct = toStruct(baseSwap);
    const signature = '0x' + 'ab'.repeat(65);
    const data = encodeGaslessSwap(struct, signature);

    const iface = new ethers.utils.Interface([
      'function executeGaslessSwap((address pool,address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce) params, bytes signature)'
    ]);
    const [decoded, decodedSignature] = iface.decodeFunctionData('executeGaslessSwap', data);
    expect(decoded[0]).toBe(POOL);
    expect(decoded[1]).toBe(TRADER);
    expect(decoded[3].toString()).toBe(baseSwap.amountSpecified);
    expect(decoded[6].toString()).toBe('3');
    expect(decodedSignature).toBe(signature);
  });

  it('builds a signable EIP-712 payload', () => {
    const typed = gaslessSwapTypedData(baseSwap, {
      chainId: 11155111,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    });

    expect(typed.primaryType).toBe('GaslessSwap');
    expect(typed.domain).toEqual({
      name: 'HyperDex',
      version: '1',
      chainId: 11155111,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    });

    // Wallets require EIP712Domain among the types...
    expect(Object.keys(typed.types)).toEqual(['EIP712Domain', 'GaslessSwap']);

    // ...and the payload must verify against the trader that signed it.
    const wallet = ethers.Wallet.createRandom();
    const message = { ...typed.message, trader: wallet.address };
    const digest = ethers.utils._TypedDataEncoder.hash(typed.domain, GASLESS_SWAP_TYPES, message);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);

    return wallet
      ._signTypedData(typed.domain, GASLESS_SWAP_TYPES, message)
      .then((signature) => {
        expect(ethers.utils.recoverAddress(digest, signature)).toBe(wallet.address);
      });
  });
});

describe('bridge payloads', () => {
  it('encodes initiateBridge and sends the adapter fee as msg.value', () => {
    const { data, value } = encodeInitiateBridge({
      id: 0,
      srcChainId: 11155111,
      dstChainId: 10,
      token: TOKEN0,
      amount: ethers.utils.parseEther('5').toString(),
      user: TRADER,
      deadline: 1893456000,
      fee: ethers.utils.parseEther('0.01').toString()
    });

    const iface = new ethers.utils.Interface([
      'function initiateBridge((uint256 id,uint256 srcChainId,uint256 dstChainId,address token,uint256 amount,address user,uint256 deadline,uint256 fee) request, bytes proof) payable'
    ]);
    const [request] = iface.decodeFunctionData('initiateBridge', data);
    expect(request[2].toString()).toBe('10');
    expect(request[3]).toBe(TOKEN0);
    expect(request[4].toString()).toBe(ethers.utils.parseEther('5').toString());
    expect(value.toString()).toBe(ethers.utils.parseEther('0.01').toString());
    expect(data.startsWith(iface.getSighash('initiateBridge'))).toBe(true);
  });
});

describe('liquidity payloads', () => {
  it('derives minimum amounts from the accepted slippage', () => {
    const params = buildMintParams(
      {
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 3000,
        tickLower: -887220,
        tickUpper: 887220,
        amount0Desired: ethers.utils.parseEther('2').toString(),
        amount1Desired: ethers.utils.parseEther('1').toString(),
        recipient: TRADER,
        deadline: 1893456000
      },
      100 // 1%
    );

    expect(params.amount0Min).toBe(ethers.utils.parseEther('1.98').toString());
    expect(params.amount1Min).toBe(ethers.utils.parseEther('0.99').toString());
    expect(params.recipient).toBe(TRADER);
  });

  it('rejects an inverted range and a bad recipient', () => {
    const base = {
      token0: TOKEN0,
      token1: TOKEN1,
      tickLower: 100,
      tickUpper: -100,
      amount0Desired: '1',
      amount1Desired: '1',
      recipient: TRADER,
      deadline: 1893456000
    };
    expect(() => buildMintParams(base)).toThrow(/tickLower/);
    expect(() => buildMintParams({ ...base, tickLower: -1, recipient: 'nope' })).toThrow(
      /recipient/
    );
  });
});

describe('form helpers', () => {
  it('turns minutes into a unix deadline', () => {
    expect(deadlineFromMinutes(20, 1_700_000_000_000)).toBe(1_700_001_200);
  });

  it('computes a positive price limit or refuses', () => {
    expect(priceLimitFromPercent(100, 5)).toBeCloseTo(95);
    expect(priceLimitFromPercent(100, 150)).toBeNull();
  });
});
