/**
 * Shared configuration and helpers for the cross-chain setup scripts.
 *
 * Every script is idempotent and refuses to run against a partially configured
 * deployment: it reads the current on-chain value first and only sends a
 * transaction when something actually changes. `DRY_RUN=1` prints the plan
 * without sending anything.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/** Reads a JSON config file if the path is set, otherwise the env variable. */
function loadConfig(envVar, fileVar) {
  const file = process.env[fileVar];
  if (file) {
    const resolved = path.isAbsolute(file) ? file : path.join(ROOT, file);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }
  const raw = process.env[envVar];
  if (!raw) return null;
  return JSON.parse(raw);
}

function requireAddress(name, value) {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a valid address (got ${value || 'nothing'})`);
  }
  return value;
}

function isDryRun() {
  return process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
}

/**
 * Sends a transaction unless the desired value is already on-chain.
 *
 * @param {Object} options
 * @param {string} options.label human readable description
 * @param {*} options.current current on-chain value
 * @param {*} options.desired value to write
 * @param {Function} options.send async () => tx
 * @returns {Promise<'skipped'|'sent'>}
 */
async function apply({ label, current, desired, send }) {
  const same = String(current).toLowerCase() === String(desired).toLowerCase();
  if (same) {
    console.log(`  = ${label} already set`);
    return 'skipped';
  }
  console.log(`  → ${label}: ${current} -> ${desired}`);
  if (isDryRun()) {
    console.log('    (dry run, not sent)');
    return 'skipped';
  }
  const tx = await send();
  await tx.wait();
  console.log(`    confirmed in ${tx.hash}`);
  return 'sent';
}

module.exports = { ROOT, loadConfig, requireAddress, isDryRun, apply };
