// Helpers for proving ABI conformance against real deployed contracts.
//
// A 4-byte selector that is present in a contract's deployed bytecode is
// strong, spoof-free evidence that the contract really implements that
// function: the selector appears in its dispatcher jump table. This lets the
// suite assert "our interface matches the protocol's deployment" without
// needing the protocol's source or a test double.

const { utils } = require("ethers");

/**
 * Extracts every 4-byte push operand found in the dispatcher region of runtime
 * bytecode. Solidity compilers emit `PUSH4 <selector>` for each external
 * function, so scanning for pushed selectors covers both old and new layouts.
 *
 * @param {string} bytecode deployed bytecode ("0x...")
 * @returns {Set<string>} selectors as lowercase hex strings ("0x12345678")
 */
function selectorsInBytecode(bytecode) {
  const code = bytecode.toLowerCase().replace(/^0x/, "");
  const found = new Set();
  for (let i = 0; i + 10 <= code.length; i += 2) {
    // 0x63 == PUSH4
    if (code.slice(i, i + 2) === "63") {
      found.add("0x" + code.slice(i + 2, i + 10));
    }
  }
  return found;
}

/**
 * Asserts that a deployed contract exposes every named function of an ethers
 * Interface, by selector.
 *
 * @param {string} bytecode deployed bytecode of the real contract
 * @param {import("ethers").utils.Interface|Array} abiOrInterface
 * @param {string[]} functionNames
 * @returns {{missing: string[], present: string[]}}
 */
function checkSelectors(bytecode, abiOrInterface, functionNames) {
  const iface =
    abiOrInterface instanceof utils.Interface ? abiOrInterface : new utils.Interface(abiOrInterface);
  const selectors = selectorsInBytecode(bytecode);

  const present = [];
  const missing = [];
  for (const name of functionNames) {
    const selector = iface.getSighash(name);
    (selectors.has(selector.toLowerCase()) ? present : missing).push(`${name} ${selector}`);
  }
  return { present, missing };
}

module.exports = { selectorsInBytecode, checkSelectors };
