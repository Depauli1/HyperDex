# HyperDex Relayer Service

This project implements a professional relayer service for HyperDex's gasless swaps, allowing users to perform token swaps without needing ETH for gas fees.

## Architecture Overview

The relayer service consists of several core components:

- **API Gateway**: Entry point for client requests, handling validation and rate limiting
- **Transaction Processing**: Validates signatures and parameters before execution
- **Mempool Management**: Prioritizes and schedules transactions efficiently
- **Gas Price Management**: Optimizes gas costs based on network conditions
- **Monitoring**: Tracks system performance and transaction statuses

## Getting Started

### Prerequisites

- Node.js v14+
- Access to an Ethereum node (Infura, Alchemy, or your own)
- A funded relayer wallet

### Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and configure your environment:
   ```
   cp .env.example .env
   ```
4. Edit `.env` with your specific configuration settings
5. Create the ABI directory and add contract ABIs:
   ```
   mkdir -p abi
   # Copy your contract ABIs to the abi directory
   ```

### Running the Service

```
npm start
```

For development with auto-restart:
```
npm run dev
```

## API Endpoints

### Submit Gasless Swap

`POST /api/v1/swap`

Request body:
```json
{
  "params": {
    "trader": "0x...",
    "zeroForOne": true,
    "amountSpecified": "1000000000000000000",
    "sqrtPriceLimitX96": "4295128740",
    "deadline": "1681843200",
    "nonce": "0"
  },
  "signature": "0x...",
  "priority": "medium"
}
```

### Check Transaction Status

`GET /api/v1/status/transaction/:txId`

### Relayer Status

`GET /api/v1/status`

## Bridge Adapter Architecture

The relayer integrates modular bridge adapters for cross-chain operations. Currently supported adapters:

- **ConnextAdapter**: Handles bridging via the Connext protocol. Implements `bridgeOut`, `fetchProof`, and `bridgeIn` methods.
- **LayerZeroAdapter**: Handles messaging and bridging via LayerZero. Implements `bridgeOut`, `fetchProof`, `bridgeIn`, and `quoteFees` methods.

Adapters are instantiated with injected configuration and contracts, and are used by the relayer for cross-chain proof and message handling. See `src/services/adapters/ConnextAdapter.js` and `src/services/adapters/LayerZeroAdapter.js` for details.

### Example Adapter Usage

```javascript
const { Contract, utils } = require('ethers');
const ConnextAdapter = require('./src/services/adapters/ConnextAdapter');
const LayerZeroAdapter = require('./src/services/adapters/LayerZeroAdapter');

const connext = new Contract(connextAddress, connextABI, wallet);
const connextAdapter = new ConnextAdapter({
  connext,
  domainMapping: { '11155111': 1735353714 },
  wallet,
  connextAddress,
  connextABI
});

const layerZeroAdapter = new LayerZeroAdapter({
  endpointAddress,
  endpointABI,
  wallet,
  chainIdMapping: { '11155111': 10121 },
  adapterParams: '0x',
  zroPaymentAddress,
  refundAddress,
  remoteContractAddress
});
```

Adapters can be injected into the relayer and used by the bridge watcher service for event-driven cross-chain operations.

## Client SDK

A JavaScript client SDK is included to simplify integration with frontend applications. See `client-sdk/index.js` for usage:

```javascript
const { ethers } = require('ethers');
const HyperDexRelayerSDK = require('./client-sdk');

async function performGaslessSwap() {
  // Initialize provider and wallet
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  const signer = provider.getSigner();
  
  // Initialize SDK
  const sdk = new HyperDexRelayerSDK({
    relayerUrl: 'https://relayer.hyperdex.io',
    hyperDexAddress: '0x123...',
    provider
  });
  
  // Create and submit a swap
  const result = await sdk.createAndSubmitSwap({
    signer,
    zeroForOne: true,
    amountSpecified: ethers.utils.parseEther('1.0'),
    sqrtPriceLimitX96: '4295128740',
    priority: 'high'
  });
  
  console.log('Transaction submitted:', result);
  
  // Check transaction status
  const status = await sdk.getTransactionStatus(result.txId);
  console.log('Transaction status:', status);
}

## Deployment Recommendations

For production use, consider:

1. Using multiple relayers behind a load balancer for redundancy
2. Securing relayer private keys using a Hardware Security Module (HSM)
3. Setting up monitoring and alerting systems
4. Implementing a database for transaction history and analytics
5. Using a separate service for key management

## Configuration Options

See `.env.example` for available configuration options including:

- Provider connection settings
- Wallet configuration
- Gas price settings
- Contract addresses
- Rate limiting parameters

## License

This project is licensed under the MIT License - see the LICENSE file for details.
