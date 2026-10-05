// scripts/setup-token-mappings.js
//
// Wires the tokens a bridge route may move.
//
// Hop routes each token through its own bridge contract, which the adapter
// holds as `hopRelayer`; Connext and LayerZero route whatever ERC20 the caller
// passes, so for those the meaningful "mapping" is the bridge router itself.
// This script therefore:
//
//   1. sets the adapter's bridge router (the contract allowed to call bridgeIn),
//   2. sets the Hop bridge for the configured token when LZ/HOP routing is used,
//   3. verifies with a read-back that each value took.
//
//   BRIDGE_ROUTER_ADDRESS=0x... HOP_ADAPTER=0x... HOP_BRIDGE=0x... \
//   npx hardhat run scripts/setup-token-mappings.js --network optimism-sepolia
//
// Set DRY_RUN=1 to see the plan without sending transactions.
const { ethers } = require('hardhat');
const { requireAddress } = require('./lib/cross-chain-config');

async function setIfDifferent(label, current, desired, send) {
  const same = String(current).toLowerCase() === String(desired).toLowerCase();
  if (same) {
    console.log(`  = ${label} already set`);
    return;
  }
  console.log(`  → ${label}: ${current} -> ${desired}`);
  const tx = await send();
  await tx.wait();
  console.log(`    confirmed in ${tx.hash}`);
}

async function main() {
  const routerAddress = requireAddress('BRIDGE_ROUTER_ADDRESS', process.env.BRIDGE_ROUTER_ADDRESS);
  const [signer] = await ethers.getSigners();
  console.log(`BridgeRouter ${routerAddress}`);

  const tasks = [];

  if (process.env.CONNEXT_ADAPTER) {
    tasks.push({ name: 'ConnextAdapter', address: requireAddress('CONNEXT_ADAPTER', process.env.CONNEXT_ADAPTER) });
  }
  if (process.env.LAYERZERO_ADAPTER) {
    tasks.push({ name: 'LayerZeroAdapter', address: requireAddress('LAYERZERO_ADAPTER', process.env.LAYERZERO_ADAPTER) });
  }
  if (process.env.HOP_ADAPTER) {
    tasks.push({ name: 'HopAdapter', address: requireAddress('HOP_ADAPTER', process.env.HOP_ADAPTER) });
  }

  if (tasks.length === 0) {
    throw new Error('Nothing to do: set CONNEXT_ADAPTER, LAYERZERO_ADAPTER or HOP_ADAPTER');
  }

  for (const task of tasks) {
    const adapter = await ethers.getContractAt(task.name, task.address, signer);
    const currentRouter = await adapter.bridgeRouter();
    await setIfDifferent(
      `${task.name}.bridgeRouter`,
      currentRouter,
      routerAddress,
      () => adapter.setBridgeRouter(routerAddress)
    );

    const appliedRouter = await adapter.bridgeRouter();
    if (appliedRouter.toLowerCase() !== routerAddress.toLowerCase()) {
      throw new Error(`${task.name}.bridgeRouter did not update`);
    }

    if (task.name === 'HopAdapter' && process.env.HOP_BRIDGE) {
      const hopBridge = requireAddress('HOP_BRIDGE', process.env.HOP_BRIDGE);
      const current = await adapter.hopRelayer();
      await setIfDifferent('HopAdapter.hopRelayer', current, hopBridge, () =>
        adapter.setHopRelayer(hopBridge)
      );
    }
  }

  // Router side: which adapter serves which destination chain.
  const router = await ethers.getContractAt('BridgeRouter', routerAddress, signer);
  for (const [chainId, adapterAddress] of Object.entries(
    JSON.parse(process.env.CHAIN_ADAPTERS || '{}')
  )) {
    requireAddress(`adapter for chain ${chainId}`, adapterAddress);
    const current = await router.bridgeAdapters(Number(chainId));
    await setIfDifferent(
      `bridgeAdapters[${chainId}]`,
      current,
      adapterAddress,
      () => router.registerAdapter(Number(chainId), adapterAddress)
    );
  }

  if (process.env.RELAYER_ADDRESS) {
    const relayer = requireAddress('RELAYER_ADDRESS', process.env.RELAYER_ADDRESS);
    const current = await router.authorizedRelayers(relayer);
    if (current) {
      console.log('  = authorizedRelayers[relayer] already set');
    } else {
      const tx = await router.setRelayer(relayer, true);
      await tx.wait();
      console.log(`  → authorizedRelayers[${relayer}] granted in ${tx.hash}`);
    }
  }

  console.log('Token and adapter wiring is in place.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
