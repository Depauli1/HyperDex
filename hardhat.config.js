const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require("@nomicfoundation/hardhat-toolbox");

const fs = require("fs");

// Uniswap v3 core is written for 0.7.6. Hardhat resolves `overrides` by exact
// source name (internal/solidity/compilation-job.ts), so enumerate the vendored
// files rather than using a glob. This keeps the audited math at its own
// compiler version instead of porting it to 0.8.
function listSolFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listSolFiles(full)
      : entry.name.endsWith(".sol")
      ? [path.relative(__dirname, full).split(path.sep).join("/")]
      : [];
  });
}

const V3_SOLC = { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } };
const overrides = {};
for (const dir of ["contracts/vendor/v3-core", "contracts/test"]) {
  for (const source of listSolFiles(path.join(__dirname, dir))) {
    overrides[source] = V3_SOLC;
  }
}

/** @type import('hardhat/config').HardhatUserConfig */

// Accounts are only wired up when a key is present, so `compile` and `test`
// work on a clean checkout and in CI without any secrets.
const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  // Multi-compiler form is mandatory here: Hardhat's config resolution drops
  // `overrides` entirely when the solidity config carries a top-level `version`
  // (internal/core/config/config-resolution.ts, normalizeSolidityConfig).
  solidity: {
    compilers: [{ version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 } } }],
    overrides
  },
  networks: {
    hardhat: {},
    hyperEvmTestnet: {
      url: "https://rpc.hyperliquid-testnet.xyz/evm",
      chainId: 998,
      accounts
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test"
  },
  mocha: {
    timeout: 120000
  }
};