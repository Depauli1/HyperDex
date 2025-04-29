# Cross-Chain Bridge Implementation

Detailed, production-ready plan to integrate a gasless cross-chain swap bridge into HyperDex.

## Overview
- Modular adapter pattern supporting multiple protocols (Connext, LayerZero, etc.)
- Seamless, gasless UX via EIP-712 meta-transactions and relayer
- Strong safety: pausability, caps, idempotency, timeouts

## Components

- **BridgeRequest** struct: unique `id`, `srcChainId`/`dstChainId`, `token`, `amount`, `user`, `deadline`, `fee`
- **BridgeRouter.sol**: central contract routing requests, escrows funds, invokes adapters, tracks status
- **IBridgeAdapter.sol**: interface for protocol adapters (`quoteFees`, `bridgeOut`, `bridgeIn`)
- **Off-chain Relayer/Watcher**: listens to events, confirms finality, calls `bridgeIn`
- **FeeController**: provides dynamic fees + cooldowns for bridge actions

## Data & Event Flow
1. User signs a cross-chain swap payload via EIP-712
2. Relayer calls `BridgeRouter.initiateBridge(...)`
3. Router escrows tokens + fee, emits `BridgeInitiated`, calls `adapter.bridgeOut`
4. Off-chain watcher observes event, waits for confirmations, fetches proof
5. Watcher calls `adapter.bridgeIn(...)` on destination chain
6. Router marks request complete, emits `BridgeCompleted`

## Phases & Timeline
| Phase             | Duration | Deliverables                                |
|-------------------|---------:|---------------------------------------------|
| **Design**        | 1–2 wks  | `BridgeRequest`, `BridgeRouter` spec, `IBridgeAdapter` |
| **Core Build**    | 2–3 wks  | Connext & LayerZero adapters, testnet integration  |
| **Optimization**  | 1–2 wks  | Route selection, fee normalization           |
| **Security Audit**| 1 wk     | Hardening, timeouts, refund & pause logic    |
| **UX & Monitoring**| 1 wk    | Dashboard, alerts, front-end integration     |
| **Rollout**       | 1 wk     | Phased mainnet launch, beta cohort, docs     |

## Technical Considerations
- **Atomicity** via escrows + idempotent calls
- **MEV & Slippage Protection**: enforce bounds, timestamps
- **Gas Optimization**: minimal adapter logic, batched events
- **Finality Handling**: N-block confirmations, protocol proofs

## Risk Management
- **Timeouts & Auto-refunds** if `bridgeIn` not invoked in time
- **Circuit Breakers**: per-adapter volume caps + emergency pause
- **Reorg Protection**: on-chain replay guards + confirmations
- **Audits & Bug Bounty** for all new components

## Bridge Adapter Details
The HyperDex relayer uses a modular adapter pattern for cross-chain bridging. Each supported protocol (e.g., Connext, LayerZero) is implemented as a JavaScript class adapter with a common interface. This enables easy extension and robust integration.

### Adapter Classes
- **ConnextAdapter**: Handles bridging via the Connext protocol. Implements `bridgeOut`, `fetchProof`, and `bridgeIn` methods. Uses ethers.js for contract calls and proof serialization.
- **LayerZeroAdapter**: Handles messaging and bridging via LayerZero. Implements `bridgeOut`, `fetchProof`, `bridgeIn`, and `quoteFees` methods. Uses ethers.js for contract calls and ABI encoding.

Adapters are injected into the relayer and bridge watcher. They are responsible for:
- Sending cross-chain messages or tokens (`bridgeOut`)
- Fetching on-chain proofs (`fetchProof`)
- Completing inbound bridge requests (`bridgeIn`)
- (LayerZero) Quoting native fees (`quoteFees`)

**Example usage:**
```js
const { Contract } = require('ethers');
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
Adapters can be swapped or extended to support new protocols with minimal changes to the relayer core.

See `src/services/adapters/ConnextAdapter.js` and `src/services/adapters/LayerZeroAdapter.js` for implementation details.

## Next Steps
1. Scaffold `IBridgeAdapter.sol` & `BridgeRouter.sol`
2. Implement Connext & LayerZero adapters
3. Extend off-chain relayer/watcher for proof handling
4. Develop unit + integration tests
