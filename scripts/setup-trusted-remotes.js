// scripts/setup-trusted-remotes.js
//
// Registers the peer adapter on a deployed LayerZeroAdapter. Without a trusted
// remote the endpoint refuses to deliver messages from that chain, so inbound
// bridging silently does nothing.
//
//   LAYERZERO_ADAPTER=0x... LZ_CHAIN_MAPPINGS='{"11155420":10132}' \
//   LZ_TRUSTED_REMOTES='{"10132":"0xRemoteAdapter"}' \
//   npx hardhat run scripts/setup-trusted-remotes.js --network sepolia
//
// LayerZero v1 identifies chains with its own uint16 ids; they are configured
// here rather than guessed. The trusted remote is the *address* of the peer
// adapter on that chain - the script packs it into the bytes the endpoint
// expects (address, padded) and skips writing when it already matches.
const { ethers } = require('hardhat');
const {
  loadConfig,
  requireAddress,
  apply
} = require('./lib/cross-chain-config');

function packRemote(address) {
  return ethers.utils.solidityPack(['address'], [address]);
}

async function main() {
  const adapterAddress = requireAddress('LAYERZERO_ADAPTER', process.env.LAYERZERO_ADAPTER);
  const chainMappings = loadConfig('LZ_CHAIN_MAPPINGS', 'LZ_CHAIN_MAPPINGS_FILE');
  const remotes = loadConfig('LZ_TRUSTED_REMOTES', 'LZ_TRUSTED_REMOTES_FILE');

  if (!chainMappings && !remotes) {
    throw new Error(
      'Nothing to do: set LZ_CHAIN_MAPPINGS and/or LZ_TRUSTED_REMOTES (JSON or *_FILE)'
    );
  }

  const [signer] = await ethers.getSigners();
  const adapter = await ethers.getContractAt('LayerZeroAdapter', adapterAddress, signer);
  console.log(`LayerZeroAdapter ${adapterAddress}`);

  // The adapter must know which chain id maps to which LayerZero id before a
  // message can be routed; the trusted remote is the peer for that id.
  for (const [chainId, lzChainId] of Object.entries(chainMappings || {})) {
    const current = await adapter.chainToLzId(Number(chainId));
    await apply({
      label: `chainToLzId[${chainId}]`,
      current: current.toString(),
      desired: Number(lzChainId),
      send: () => adapter.setChainMapping(Number(chainId), Number(lzChainId))
    });
  }

  for (const [lzChainId, remoteAddress] of Object.entries(remotes || {})) {
    requireAddress(`trusted remote for ${lzChainId}`, remoteAddress);
    const desired = packRemote(remoteAddress);
    const current = await adapter.trustedRemoteLookup(Number(lzChainId));

    await apply({
      label: `trustedRemoteLookup[${lzChainId}]`,
      current,
      desired,
      send: () => adapter.setTrustedRemote(Number(lzChainId), desired)
    });

    const applied = await adapter.trustedRemoteLookup(Number(lzChainId));
    if (applied.toLowerCase() !== desired.toLowerCase()) {
      throw new Error(
        `trustedRemoteLookup[${lzChainId}] is ${applied} after the update, expected ${desired}`
      );
    }
  }

  console.log('Trusted remotes are in place.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
