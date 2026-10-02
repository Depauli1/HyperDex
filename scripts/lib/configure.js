/**
 * Cross-chain wiring, as a library.
 *
 * The CLI wrapper is scripts/configure-cross-chain.js; keeping the logic here
 * means it can be exercised against a real in-process deployment in
 * test/CrossChainConfig.test.js instead of only during a live deployment.
 *
 * Every step reads the current value first and only sends a transaction when it
 * differs, so re-running is safe.
 */
const { requireAddress } = require('./cross-chain-config');

/**
 * @param {Object} options
 * @param {Object} options.ethers the hardhat ethers object (or an equivalent)
 * @param {Object} options.config deployment description (see the CLI header)
 * @param {string} [options.networkName]
 * @param {boolean} [options.dryRun]
 * @param {Function} [options.log]
 * @returns {Promise<{changes: number, skipped: number}>}
 */
async function configure({ ethers, config, networkName = '', dryRun = false, log = console.log }) {
  const summary = { changes: 0, skipped: 0 };

  async function setValue(label, current, desired, send) {
    if (String(current).toLowerCase() === String(desired).toLowerCase()) {
      log(`  = ${label} already set`);
      summary.skipped += 1;
      return;
    }
    log(`  → ${label}: ${current} -> ${desired}`);
    if (dryRun) {
      log('    (dry run, not sent)');
      summary.skipped += 1;
      return;
    }
    const tx = await send();
    await tx.wait();
    log(`    confirmed in ${tx.hash}`);
    summary.changes += 1;
  }

  const [deployer] = await ethers.getSigners();
  log(`Configuring ${networkName || 'network'} as ${deployer.address}`);

  const routerAddress = requireAddress('bridgeRouter', config.bridgeRouter);
  const router = await ethers.getContractAt('BridgeRouter', routerAddress, deployer);

  // 1. Adapters
  log('Adapters');
  for (const [chainId, adapterAddress] of Object.entries(config.adapters || {})) {
    requireAddress(`adapter for chain ${chainId}`, adapterAddress);
    const current = await router.bridgeAdapters(Number(chainId));
    await setValue(`bridgeAdapters[${chainId}]`, current, adapterAddress, () =>
      router.registerAdapter(Number(chainId), adapterAddress)
    );
    if (!dryRun) {
      const applied = await router.bridgeAdapters(Number(chainId));
      if (applied.toLowerCase() !== adapterAddress.toLowerCase()) {
        throw new Error(`bridgeAdapters[${chainId}] did not update`);
      }
    }
  }

  // 2. Relayer
  if (config.relayer) {
    log('Relayer');
    const relayer = requireAddress('relayer', config.relayer);
    const current = await router.authorizedRelayers(relayer);
    await setValue(`authorizedRelayers[${relayer}]`, current, true, () =>
      router.setRelayer(relayer, true)
    );
  }

  // 3. Connext
  if (config.connext) {
    log('Connext');
    const connext = await ethers.getContractAt(
      'ConnextAdapter',
      requireAddress('connext.adapter', config.connext.adapter),
      deployer
    );
    const currentRouter = await connext.bridgeRouter();
    await setValue('ConnextAdapter.bridgeRouter', currentRouter, routerAddress, () =>
      connext.setBridgeRouter(routerAddress)
    );

    for (const [chainId, domain] of Object.entries(config.connext.domains || {})) {
      const current = await connext.chainToDomain(Number(chainId));
      await setValue(`ConnextAdapter.chainToDomain[${chainId}]`, current, domain, () =>
        connext.setDomainMapping(Number(chainId), Number(domain))
      );
      if (!dryRun) {
        const applied = await connext.chainToDomain(Number(chainId));
        if (Number(applied) !== Number(domain)) {
          throw new Error(`ConnextAdapter.chainToDomain[${chainId}] did not update`);
        }
      }
    }
  }

  // 4. LayerZero
  if (config.layerzero) {
    log('LayerZero');
    const lz = await ethers.getContractAt(
      'LayerZeroAdapter',
      requireAddress('layerzero.adapter', config.layerzero.adapter),
      deployer
    );
    const currentRouter = await lz.bridgeRouter();
    await setValue('LayerZeroAdapter.bridgeRouter', currentRouter, routerAddress, () =>
      lz.setBridgeRouter(routerAddress)
    );

    for (const [chainId, lzChainId] of Object.entries(config.layerzero.chains || {})) {
      const current = await lz.chainToLzId(Number(chainId));
      await setValue(`LayerZeroAdapter.chainToLzId[${chainId}]`, current, lzChainId, () =>
        lz.setChainMapping(Number(chainId), Number(lzChainId))
      );
    }

    for (const [lzChainId, remote] of Object.entries(config.layerzero.trustedRemotes || {})) {
      requireAddress(`trusted remote for ${lzChainId}`, remote);
      const desired = ethers.utils.solidityPack(['address'], [remote]);
      const current = await lz.trustedRemoteLookup(Number(lzChainId));
      await setValue(`LayerZeroAdapter.trustedRemoteLookup[${lzChainId}]`, current, desired, () =>
        lz.setTrustedRemote(Number(lzChainId), desired)
      );
      if (!dryRun) {
        const applied = await lz.trustedRemoteLookup(Number(lzChainId));
        if (applied.toLowerCase() !== desired.toLowerCase()) {
          throw new Error(`LayerZeroAdapter.trustedRemoteLookup[${lzChainId}] did not update`);
        }
      }
    }
  }

  // 5. Hop
  if (config.hop) {
    log('Hop');
    const hop = await ethers.getContractAt(
      'HopAdapter',
      requireAddress('hop.adapter', config.hop.adapter),
      deployer
    );
    const currentRouter = await hop.bridgeRouter();
    await setValue('HopAdapter.bridgeRouter', currentRouter, routerAddress, () =>
      hop.setBridgeRouter(routerAddress)
    );

    if (config.hop.bridge) {
      requireAddress('hop.bridge', config.hop.bridge);
      const current = await hop.hopRelayer();
      await setValue('HopAdapter.hopRelayer', current, config.hop.bridge, () =>
        hop.setHopRelayer(config.hop.bridge)
      );
    }
  }

  return summary;
}

module.exports = { configure };
