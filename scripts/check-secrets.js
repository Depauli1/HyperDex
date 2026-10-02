#!/usr/bin/env node
/**
 * Dependency-free secret scanner for git-tracked files.
 *
 * It exists because a funded-looking private key and a keystore password were
 * committed in be77730 and sat on the public `main` branch. `.gitignore` only
 * prevents *new* files from being added; it does nothing about what is already
 * tracked, and it does not stop a secret pasted into a source file.
 *
 * Usage:
 *   node scripts/check-secrets.js              # scan the working tree
 *   node scripts/check-secrets.js <rev>        # scan a specific revision
 *
 * Exits 1 on any finding, so it can gate CI and a pre-commit hook.
 */
const { execSync } = require("child_process");

const rev = process.argv[2];

// --- Rules -------------------------------------------------------------------
// Each rule is deliberately narrow. A 64-hex string alone would flag test
// vectors and hashes, so it must sit next to a secret-ish name.
const RULES = [
  {
    id: "private-key-assignment",
    re: /\b[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|SIGNING_KEY|DEPLOYER_KEY)[A-Z0-9_]*\s*[:=]\s*["']?(?:0x)?[0-9a-fA-F]{64}\b/gi,
    message: "hex private key assigned to a key-like variable",
  },
  {
    id: "hex-private-key-in-quotes",
    re: /(?:private[_ ]?key|secret[_ ]?key|signing[_ ]?key)["']?\s*[:=]\s*["'](?:0x)?[0-9a-fA-F]{64}["']/gi,
    message: "hex private key in a quoted value",
  },
  {
    // A bare "12 lowercase words in a row" rule matches ordinary English prose,
    // so require the phrase to be a single quoted string. A real seed phrase is
    // always stored that way.
    id: "mnemonic",
    re: /(["'])([a-z]{3,10}(?:\s+[a-z]{3,10}){11,23})\1/g,
    message: "possible 12- or 24-word mnemonic in a quoted string",
    contextual: /mnemonic|seed[_ ]?phrase/i,
  },
  {
    id: "keystore-password",
    re: /\b(?:KEYSTORE_PASSWORD|WALLET_PASSWORD)\s*[:=]\s*["']?([^\s"']{4,})/gi,
    message: "keystore/wallet password in plaintext",
  },
];

// Public fixtures that are not secrets. These are the well-known accounts of
// every local Hardhat/Anvil node; they are printed in the Hardhat docs and hold
// nothing on any real network.
const PUBLIC_TEST_KEYS = new Set(
  [
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  ].map((k) => k.toLowerCase())
);

/** A value that is a reference to the environment, not a literal secret. */
function isEnvReference(value) {
  return /^(process\.env\.|os\.environ|\$\{|\benv\.|\bENV\[)/.test(value.trim());
}

// --- Scan --------------------------------------------------------------------

function listFiles() {
  const cmd = rev
    ? `git ls-tree -r --name-only ${rev}`
    : "git ls-files --cached";
  return execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean)
    // Binary and generated artefacts are noise here.
    .filter((f) => !/\.(png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip|gz|lock|snap)$/i.test(f))
    .filter((f) => !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f))
    // The samples exist to show the expected shape with placeholder values.
    .filter((f) => !/\.(sample|example|template)$/i.test(f) && !/\.env\.(sample|example)$/.test(f));
}

function readFile(path) {
  try {
    return rev
      ? execSync(`git show ${rev}:"${path}"`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      : require("fs").readFileSync(path, "utf8");
  } catch {
    return null; // deleted, binary, or unreadable
  }
}

/** Placeholder values that are obviously not real secrets. */
function isPlaceholder(value) {
  return /^(x{8,}|0{8,}|f{8,}|1{8,}|your[_-]|change[_-]?me|placeholder|example|dummy|test|xxx)/i.test(
    value
  );
}

const findings = [];

for (const file of listFiles()) {
  const content = readFile(file);
  if (content === null) continue;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      const context = content.split("\n")[line - 1] || "";
      if (rule.contextual && !rule.contextual.test(content)) continue;

      // Pull the secret-looking token out of the match for the placeholder test.
      const secretish = (match[0].match(/[0-9a-fA-F]{64}|[^\s"']{4,}$/) || [match[0]])[0];
      if (isPlaceholder(secretish)) continue;
      if (isEnvReference(secretish)) continue;
      if (PUBLIC_TEST_KEYS.has(secretish.toLowerCase().replace(/^0x/, ""))) continue;

      findings.push({ file, line, rule: rule.id, message: rule.message, context: context.trim() });
    }
  }

  // An encrypted keystore is not itself a secret, but committing one alongside
  // the password that opens it is the failure mode we hit, so flag it.
  if (/keystore|wallet/i.test(file) && /"crypto"\s*:\s*\{/.test(content)) {
    findings.push({
      file,
      line: 1,
      rule: "committed-keystore",
      message: "encrypted keystore committed to the repository",
      context: "(keystore JSON)",
    });
  }
}

// --- Report ------------------------------------------------------------------

const target = rev ? `revision ${rev}` : "the working tree";

if (findings.length === 0) {
  console.log(`check-secrets: no findings in ${target} (scanned ${listFiles().length} files).`);
  process.exit(0);
}

console.error(`check-secrets: ${findings.length} finding(s) in ${target}\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.message}`);
  console.error(`      ${f.context.replace(/[0-9a-fA-F]{16,}/g, (m) => m.slice(0, 6) + "…")}`);
}
console.error(
  "\nIf this is a real secret: rotate it first. Removing it from the working tree\n" +
    "does not remove it from history, and history can be scraped from a public repo\n" +
    "long before anyone notices. See docs/SECRET_ROTATION.md."
);
process.exit(1);
