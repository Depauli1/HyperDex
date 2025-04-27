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

## Next Steps
1. Scaffold `IBridgeAdapter.sol` & `BridgeRouter.sol`
2. Implement Connext & LayerZero adapters
3. Extend off-chain relayer/watcher for proof handling
4. Develop unit + integration tests
