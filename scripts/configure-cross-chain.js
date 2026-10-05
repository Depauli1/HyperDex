// scripts/configure-cross-chain.js
//
// CLI wrapper around scripts/lib/configure.js. Points a deployed stack at its
// peers: adapters registered on the BridgeRouter, the relayer authorised,
// Connext domains, LayerZero chain ids and trusted remotes, and the Hop bridge.
//
// Configuration comes from one JSON file per environment:
//
// {
//   "bridgeRouter": "0x...",
//   "relayer": "0x...",
//   "adapters": { "10": "0x...connext", "137": "0x...layerzero" },
//   "connext": { "adapter": "0x...", "domains": { "10": 1869640549 } },
//   "layerzero": {
//     "adapter": "0x...",
//     "chains": { "10": 111 },
//     "trustedRemotes": { "111": "0x...peerAdapter" }
//   },
//   "hop": { "adapter": "0x...", "bridge": "0x..." }
// }
//
//   CROSS_CHAIN_CONFIG=cross-chain.sepolia.json DRY_RUN=1 \
//   npx hardhat run scripts/configure-cross-chain.js --network sepolia
//
// The script is idempotent and re-reads every value it writes.
const fs = require('fs');
const path = require('path');
const { ethers, network } = require('hardhat');

const { ROOT } = require('./lib/cross-chain-config');
const { configure } = require('./lib/configure');

function readConfig() {
  const file = process.env.CROSS_CHAIN_CONFIG;
  if (!file) {
    throw new Error(
      'Set CROSS_CHAIN_CONFIG to the JSON file describing this deployment (see the header of this script)'
    );
  }
  const resolved = path.isAbsolute(file) ? file : path.join(ROOT, file);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

async function main() {
  const config = readConfig();
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  const summary = await configure({
    ethers,
    config,
    networkName: network.name,
    dryRun
  });

  console.log(
    `Cross-chain configuration complete: ${summary.changes} change(s), ${summary.skipped} already in place.`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
