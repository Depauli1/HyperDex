// scripts/deploy.js
const { ethers } = require("hardhat");

// Chain and adapter configurations
const chainConfigs = {
  // Ethereum Mainnet
  1: {
    connextDomain: 6648936,
    layerZeroId: 101,
    name: "Ethereum"
  },
  // Optimism
  10: {
    connextDomain: 1869640809,
    layerZeroId: 111,
    name: "Optimism"
  },
  // BNB Chain
  56: {
    connextDomain: 6450786,
    layerZeroId: 102,
    name: "BNB Chain"
  },
  // Polygon
  137: {
    connextDomain: 1886350457,
    layerZeroId: 109,
    name: "Polygon"
  },
  // Arbitrum
  42161: {
    connextDomain: 1634886255,
    layerZeroId: 110,
    name: "Arbitrum"
  },
  // Avalanche
  43114: {
    connextDomain: 1634734819,
    layerZeroId: 106,
    name: "Avalanche"
  }
};

// Layer Zero Endpoint addresses
const layerZeroEndpoints = {
  1: "0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675", // Ethereum
  10: "0x3c2269811836af69497E5F486A85D7316753cf62", // Optimism
  56: "0x3c2269811836af69497E5F486A85D7316753cf62", // BNB Chain
  137: "0x3c2269811836af69497E5F486A85D7316753cf62", // Polygon
  42161: "0x3c2269811836af69497E5F486A85D7316753cf62", // Arbitrum
  43114: "0x3c2269811836af69497E5F486A85D7316753cf62", // Avalanche
};

// Connext addresses
const connextAddresses = {
  1: "0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6", // Ethereum
  10: "0x8f7492DE823025b4CfaAB1D34c58963F2af5DEDA", // Optimism
  56: "0xCd401c10afa37d641d2F594852DA94C700e4F2CE", // BNB Chain
  137: "0x11984dc4465481512eb5b777E44061C158CF2259", // Polygon
  42161: "0xEE9deC2712cCE65174B561151701Bf54b99C24C8", // Arbitrum
  43114: "0x69766e7dB2aad29726cc4f979491C29005128B15", // Avalanche
};

// Token mappings example
// This would be defined for actual tokens you want to support
const tokenMappings = {
  // USDC on Ethereum
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": {
    10: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", // USDC on Optimism
    56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC on BNB Chain
    137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC on Polygon
    42161: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC on Arbitrum
    43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"  // USDC on Avalanche
  },
  // WETH on Ethereum
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
    10: "0x4200000000000000000000000000000000000006", // WETH on Optimism
    56: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", // WETH on BNB Chain
    137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH on Polygon
    42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
    43114: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB"  // WETH on Avalanche
  }
};

// Deploy all contracts for a given chain
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  
  // Get the current chain ID
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Deploying to chain: ${chainConfigs[chainId]?.name || chainId}`);
  
  if (!chainConfigs[chainId]) {
    console.error("Chain not supported");
    return;
  }
  
  // Check if we have endpoints configured
  if (!layerZeroEndpoints[chainId]) {
    console.error("LayerZero endpoint not configured for this chain");
    return;
  }
  
  if (!connextAddresses[chainId]) {
    console.error("Connext address not configured for this chain");
    return;
  }
  
  // 1. Deploy BridgeRouter
  const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
  const bridgeRouter = await BridgeRouter.deploy();
  await bridgeRouter.deployed();
  console.log("BridgeRouter deployed to:", bridgeRouter.address);
  
  // Define the relayer address (this would be your own relayer service)
  const relayerAddress = deployer.address; // Change this to your actual relayer address
  
  // 2. Initialize BridgeRouter
  await bridgeRouter.initialize(deployer.address, relayerAddress, chainId);
  console.log("BridgeRouter initialized");
  
  // 3. Deploy ConnextAdapter
  const ConnextAdapter = await ethers.getContractFactory("ConnextAdapter");
  const connextAdapter = await ConnextAdapter.deploy(
    connextAddresses[chainId],
    bridgeRouter.address
  );
  await connextAdapter.deployed();
  console.log("ConnextAdapter deployed to:", connextAdapter.address);
  
  // 4. Deploy LayerZeroAdapter
  const LayerZeroAdapter = await ethers.getContractFactory("LayerZeroAdapter");
  const layerZeroAdapter = await LayerZeroAdapter.deploy(
    layerZeroEndpoints[chainId],
    bridgeRouter.address
  );
  await layerZeroAdapter.deployed();
  console.log("LayerZeroAdapter deployed to:", layerZeroAdapter.address);
  
  // 5. Register adapters with BridgeRouter
  await bridgeRouter.registerAdapter(connextAdapter.address);
  await bridgeRouter.registerAdapter(layerZeroAdapter.address);
  console.log("Adapters registered with BridgeRouter");
  
  // 6. Configure Connext domain mappings
  for (const [targetChainId, config] of Object.entries(chainConfigs)) {
    if (targetChainId != chainId && config.connextDomain) {
      await connextAdapter.setDomainMapping(parseInt(targetChainId), config.connextDomain);
      console.log(`Configured Connext domain mapping: Chain ${targetChainId} -> Domain ${config.connextDomain}`);
    }
  }
  
  // 7. Configure LayerZero chain mappings
  for (const [targetChainId, config] of Object.entries(chainConfigs)) {
    if (targetChainId != chainId && config.layerZeroId) {
      await layerZeroAdapter.setChainMapping(parseInt(targetChainId), config.layerZeroId);
      console.log(`Configured LayerZero chain mapping: Chain ${targetChainId} -> LZ ID ${config.layerZeroId}`);
    }
  }
  
  // 8. Set adapter for each destination chain
  // For this example, let's use Connext for Optimism/Polygon and LayerZero for Arbitrum/Avalanche
  const connextChains = [10, 56, 137]; // Optimism, BNB Chain, Polygon
  const layerZeroChains = [42161, 43114]; // Arbitrum, Avalanche
  
  for (const targetChainId of connextChains) {
    if (targetChainId != chainId) {
      await bridgeRouter.setAdapterForChain(targetChainId, connextAdapter.address);
      console.log(`Set Connext adapter for chain ${targetChainId}`);
    }
  }
  
  for (const targetChainId of layerZeroChains) {
    if (targetChainId != chainId) {
      await bridgeRouter.setAdapterForChain(targetChainId, layerZeroAdapter.address);
      console.log(`Set LayerZero adapter for chain ${targetChainId}`);
    }
  }
  
  // 9. Configure token mappings
  // This would be done for actual tokens you want to support
  // For example, USDC across different chains
  for (const [sourceToken, mappings] of Object.entries(tokenMappings)) {
    // Add the token as supported
    await bridgeRouter.addSupportedToken(sourceToken);
    console.log(`Added supported token: ${sourceToken}`);
    
    // Configure mappings to each destination chain
    for (const [targetChainId, targetToken] of Object.entries(mappings)) {
      if (parseInt(targetChainId) != chainId) {
        await bridgeRouter.addTokenMapping(sourceToken, parseInt(targetChainId), targetToken);
        console.log(`Configured token mapping: ${sourceToken} -> ${targetToken} on chain ${targetChainId}`);
      }
    }
  }
  
  // 10. Set LayerZero trusted remotes if we have deployed on other chains already
  // This would require the address of the LayerZeroAdapter on the target chain
  // For a first deployment, this would be done later once all chains are deployed
  
  console.log("Deployment complete!");
  
  // Return all deployed contract addresses
  return {
    bridgeRouter: bridgeRouter.address,
    connextAdapter: connextAdapter.address,
    layerZeroAdapter: layerZeroAdapter.address
  };
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });