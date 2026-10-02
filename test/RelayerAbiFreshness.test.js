// The relayer consumes the ABIs in relayer/abi/, which are generated from the
// compiled artifacts by scripts/export-relayer-abis.js. This test fails when a
// contract changes but the exported ABI was not regenerated - the drift that
// previously left the relayer calling a `GaslessSwapParams` without `pool`.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const CONTRACTS = [
  { name: "HyperDex", source: "contracts/HyperDex.sol" },
  { name: "HyperDexFactory", source: "contracts/HyperDexFactory.sol" },
  { name: "BridgeRouter", source: "contracts/BridgeRouter.sol" },
  { name: "ConnextAdapter", source: "contracts/adapters/ConnextAdapter.sol" },
  { name: "LayerZeroAdapter", source: "contracts/adapters/LayerZeroAdapter.sol" },
  { name: "HopAdapter", source: "contracts/adapters/HopAdapter.sol" },
  { name: "UniswapV3Pool", source: "contracts/vendor/v3-core/UniswapV3Pool.sol" },
  { name: "UniswapV3Factory", source: "contracts/vendor/v3-core/UniswapV3Factory.sol" }
];

describe("Relayer ABI freshness", function () {
  for (const { name, source } of CONTRACTS) {
    it(`${name}.json matches the compiled artifact`, function () {
      const artifactPath = path.join(ROOT, "artifacts", source, `${name}.json`);
      const exportedPath = path.join(ROOT, "relayer", "abi", `${name}.json`);

      expect(fs.existsSync(artifactPath), `missing artifact ${artifactPath}; run npx hardhat compile`)
        .to.equal(true);
      expect(fs.existsSync(exportedPath), `missing exported ABI ${exportedPath}`).to.equal(true);

      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const exported = JSON.parse(fs.readFileSync(exportedPath, "utf8"));

      expect(exported).to.deep.equal(
        artifact.abi,
        `${name}.json is stale - run: npx hardhat compile && node scripts/export-relayer-abis.js`
      );
    });
  }

  it("describes the gasless swap struct with pool as its first field", function () {
    const abi = JSON.parse(fs.readFileSync(path.join(ROOT, "relayer", "abi", "HyperDex.json"), "utf8"));
    const fn = abi.find((entry) => entry.name === "executeGaslessSwap");
    const fields = fn.inputs[0].components.map((c) => `${c.type} ${c.name}`);
    expect(fields).to.deep.equal([
      "address pool",
      "address trader",
      "bool zeroForOne",
      "int256 amountSpecified",
      "uint160 sqrtPriceLimitX96",
      "uint256 deadline",
      "uint256 nonce"
    ]);
  });
});
