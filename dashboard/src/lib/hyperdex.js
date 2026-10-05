/**
 * Protocol payloads the dashboard signs and sends.
 *
 * Everything here is pure: it turns form values into the exact calldata and
 * EIP-712 payloads the contracts expect. Keeping it out of the components means
 * the encoders can be tested without a browser or a wallet.
 *
 * The struct definition mirrors `contracts/HyperDex.sol` and
 * `relayer/src/config/eip712.js`. The dashboard cannot import from the relayer
 * package (create-react-app restricts imports outside src/), so
 * `test/protocol.test.js` pins the type hash to the same constant the contract
 * uses: any drift fails the dashboard suite.
 */
import { ethers } from 'ethers';

// keccak256("GaslessSwap(address pool,address trader,bool zeroForOne,int256
// amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)")
export const GASLESS_SWAP_TYPEHASH =
  '0x' +
  ethers.utils
    .keccak256(
      ethers.utils.toUtf8Bytes(
        'GaslessSwap(address pool,address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)'
      )
    )
    .slice(2);

export const GASLESS_SWAP_TYPES = {
  GaslessSwap: [
    { name: 'pool', type: 'address' },
    { name: 'trader', type: 'address' },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountSpecified', type: 'int256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ]
};

export const DOMAIN_NAME = 'HyperDex';
export const DOMAIN_VERSION = '1';

/** Redisplays a plain object in the struct's field order. */
export function toStruct(values) {
  const struct = {
    pool: values.pool,
    trader: values.trader,
    zeroForOne: Boolean(values.zeroForOne),
    amountSpecified: ethers.BigNumber.from(values.amountSpecified).toString(),
    sqrtPriceLimitX96: ethers.BigNumber.from(values.sqrtPriceLimitX96).toString(),
    deadline: ethers.BigNumber.from(values.deadline).toString(),
    nonce: ethers.BigNumber.from(values.nonce).toString()
  };

  for (const field of ['pool', 'trader']) {
    if (!ethers.utils.isAddress(struct[field])) {
      throw new Error(`${field} must be a valid address`);
    }
  }
  if (struct.amountSpecified === '0') {
    throw new Error('amountSpecified must be non-zero');
  }
  return struct;
}

/** Builds the EIP-712 payload for `eth_signTypedData_v4`. */
export function gaslessSwapTypedData(values, { chainId, verifyingContract }) {
  const struct = toStruct(values);
  return {
    types: { EIP712Domain: domainFields(), ...GASLESS_SWAP_TYPES },
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract },
    primaryType: 'GaslessSwap',
    message: struct
  };
}

function domainFields() {
  return [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
  ];
}

const HYPERDEX_ABI = [
  'function executeGaslessSwap((address pool,address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce) params, bytes signature)'
];

const ROUTER_ABI = [
  'function initiateBridge((uint256 id,uint256 srcChainId,uint256 dstChainId,address token,uint256 amount,address user,uint256 deadline,uint256 fee) request, bytes proof) payable'
];

/**
 * Calldata for `HyperDex.executeGaslessSwap`.
 * The relayer sends this; the dashboard shows it and uses it when the user
 * prefers to pay their own gas.
 */
export function encodeGaslessSwap(struct, signature) {
  const iface = new ethers.utils.Interface(HYPERDEX_ABI);
  return iface.encodeFunctionData('executeGaslessSwap', [toStruct(struct), signature]);
}

/**
 * Calldata for `BridgeRouter.initiateBridge`. `request.fee` belongs to the
 * request (the adapter is given exactly that much); `value` is the msg.value the
 * caller must send with the transaction.
 */
export function encodeInitiateBridge(request) {
  const iface = new ethers.utils.Interface(ROUTER_ABI);
  const struct = {
    id: ethers.BigNumber.from(request.id).toString(),
    srcChainId: ethers.BigNumber.from(request.srcChainId).toString(),
    dstChainId: ethers.BigNumber.from(request.dstChainId).toString(),
    token: request.token,
    amount: ethers.BigNumber.from(request.amount).toString(),
    user: request.user,
    deadline: ethers.BigNumber.from(request.deadline).toString(),
    fee: ethers.BigNumber.from(request.fee || 0).toString()
  };
  const data = iface.encodeFunctionData('initiateBridge', [struct, '0x']);
  return { data, value: ethers.BigNumber.from(request.fee || 0) };
}

const POSITION_MANAGER_ABI = [
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)'
];

/**
 * `INonfungiblePositionManager.mint` parameters.
 * `slippageBps` (default 0.5%) sets the min amounts the user accepts.
 */
export function buildMintParams(
  { token0, token1, fee = 3000, tickLower, tickUpper, amount0Desired, amount1Desired, recipient, deadline },
  slippageBps = 50
) {
  if (!ethers.utils.isAddress(recipient)) {
    throw new Error('recipient must be a valid address');
  }
  if (Number(tickLower) >= Number(tickUpper)) {
    throw new Error('tickLower must be below tickUpper');
  }

  const slip = ethers.BigNumber.from(10_000 - Number(slippageBps));
  return {
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired: ethers.BigNumber.from(amount0Desired).toString(),
    amount1Desired: ethers.BigNumber.from(amount1Desired).toString(),
    amount0Min: ethers.BigNumber.from(amount0Desired).mul(slip).div(10_000).toString(),
    amount1Min: ethers.BigNumber.from(amount1Desired).mul(slip).div(10_000).toString(),
    recipient,
    deadline: ethers.BigNumber.from(deadline).toString()
  };
}

export function encodeMint(params) {
  const iface = new ethers.utils.Interface(POSITION_MANAGER_ABI);
  return iface.encodeFunctionData('mint', [params]);
}

/** Non-negative price bound for a swap, from a decimal percentage. */
export function priceLimitFromPercent(price, percent) {
  const limit = Number(price) * (1 - Number(percent) / 100);
  return limit > 0 ? limit : null;
}

/** Deadline from "minutes from now", as the struct expects (unix seconds). */
export function deadlineFromMinutes(minutes, now = Date.now()) {
  return Math.floor(now / 1000) + Math.round(Number(minutes) * 60);
}
