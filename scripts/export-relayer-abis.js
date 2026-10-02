#!/usr/bin/env node
/**
 * Exports the contract ABIs the relayer service consumes from the freshly
 * compiled Hardhat artifacts into relayer/abi/.
 *
 * These files were previously committed by hand and drifted from the contracts
 * (the relayer's ABI was still missing the `pool` field of
 * GaslessSwapParams). Run this after any change to a contract the relayer calls:
 *
 *   npx hardhat compile && node scripts/export-relayer-abis.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "relayer", "abi");

const CONTRACTS = [
  { name: "HyperDex", source: "contracts/HyperDex.sol" },
  { name: "HyperDexFactory", source: "contracts/HyperDexFactory.sol" },
  { name: "UniswapV3Pool", source: "contracts/vendor/v3-core/UniswapV3Pool.sol" },
  { name: "UniswapV3Factory", source: "contracts/vendor/v3-core/UniswapV3Factory.sol" }
];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const { name, source } of CONTRACTS) {
  const artifactPath = path.join(ROOT, "artifacts", source, `${name}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Missing artifact for ${name} at ${artifactPath}. Run "npx hardhat compile" first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const target = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, target)} (${artifact.abi.length} entries)`);
}
