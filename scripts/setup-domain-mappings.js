// scripts/setup-domain-mappings.js
//
// Teaches a deployed ConnextAdapter which Connext domain belongs to which chain.
//
//   CONNEXT_ADAPTER=0x... CONNEXT_DOMAIN_MAPPINGS='{"11155420":1869640549}' \
//   npx hardhat run scripts/setup-domain-mappings.js --network sepolia
//
// or point CONNEXT_DOMAIN_MAPPINGS_FILE at a JSON file:
//   { "11155420": 1869640549, "11155111": 1936027759 }
//
// Domain ids are Connext's own numbering; they are read from the adapter after
// the write so the script fails loudly if the contract rejected a value.
const { ethers } = require('hardhat');
const { loadConfig, requireAddress, apply } = require('./lib/cross-chain-config');

async function main() {
  const adapterAddress = requireAddress('CONNEXT_ADAPTER', process.env.CONNEXT_ADAPTER);
  const mappings = loadConfig('CONNEXT_DOMAIN_MAPPINGS', 'CONNEXT_DOMAIN_MAPPINGS_FILE');

  if (!mappings || Object.keys(mappings).length === 0) {
    throw new Error(
      'Nothing to do: set CONNEXT_DOMAIN_MAPPINGS (JSON) or CONNEXT_DOMAIN_MAPPINGS_FILE'
    );
  }

  const [signer] = await ethers.getSigners();
  const adapter = await ethers.getContractAt('ConnextAdapter', adapterAddress, signer);
  console.log(`ConnextAdapter ${adapterAddress} on chain ${(await ethers.provider.getNetwork()).chainId}`);

  for (const [chainId, domain] of Object.entries(mappings)) {
    const numericChainId = Number(chainId);
    const numericDomain = Number(domain);
    if (!Number.isInteger(numericChainId) || !Number.isInteger(numericDomain)) {
      throw new Error(`Invalid mapping ${chainId} -> ${domain}`);
    }

    const current = await adapter.chainToDomain(numericChainId);
    await apply({
      label: `chainToDomain[${numericChainId}]`,
      current: current.toString(),
      desired: numericDomain,
      send: () => adapter.setDomainMapping(numericChainId, numericDomain)
    });

    const applied = await adapter.chainToDomain(numericChainId);
    if (Number(applied) !== numericDomain) {
      throw new Error(
        `chainToDomain[${numericChainId}] is ${applied} after the update, expected ${numericDomain}`
      );
    }
  }

  console.log('Domain mappings are in place.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
