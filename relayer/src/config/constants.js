/**
 * Application constants for the HyperDex relayer
 */

// Transaction settings
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const MAX_PENDING_TXS = 100;

// Gas settings
const GAS_PRICE_BUFFER_PERCENT = 200;
const GAS_LIMIT_BUFFER_PERCENT = 20;
const DEFAULT_GAS_LIMIT = 500000;
const MAX_GAS_PRICE = 5000e9; // 5000 Gwei in wei for Sepolia testnet

// Priority levels and their multipliers
const PRIORITY_LEVELS = {
  LOW: 1.1,
  MEDIUM: 1.3,
  HIGH: 1.5,
  URGENT: 2.0
};

// Rate limits (requests per minute)
const RATE_LIMITS = {
  DEFAULT: process.env.NODE_ENV === 'test' ? 1000 : 10,
  PREMIUM: process.env.NODE_ENV === 'test' ? 3000 : 30,
  ENTERPRISE: process.env.NODE_ENV === 'test' ? 10000 : 100
};

// Domain and type definitions for EIP-712 signatures
const EIP712_TYPES = {
  GaslessSwap: [
    { name: "trader", type: "address" },
    { name: "zeroForOne", type: "bool" },
    { name: "amountSpecified", type: "int256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" }
  ]
};

module.exports = {
  MAX_RETRIES,
  RETRY_DELAY_MS,
  MAX_PENDING_TXS,
  GAS_PRICE_BUFFER_PERCENT,
  GAS_LIMIT_BUFFER_PERCENT,
  DEFAULT_GAS_LIMIT,
  MAX_GAS_PRICE,
  PRIORITY_LEVELS,
  RATE_LIMITS,
  EIP712_TYPES
};
