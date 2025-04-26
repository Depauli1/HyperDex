# HyperDex Roadmap

A concise, phase-based plan for gasless swaps, analytics, dynamic fees, security, and cross-chain integration.

| Phase                     | Scope                                                | Timeline |
|---------------------------|------------------------------------------------------|---------:|
| **1. Gasless Swap Relayer**    | End-to-end gasless swap flow (Sepolia tests, relayer & UX) | Week 1   |
| **2. Analytics Dashboard**     | Live price impact, slippage predictions & efficiency metrics | Week 3   |
| **3. Dynamic Fee Module**      | On-chain FeeController adjusting fees by volatility & depth | Week 4   |
| **4. Security Audit**          | Third-party audit + bug bounty                         | Week 6   |
| **5. Cross-Chain Bridge**       | Integrate minimal bridge adapter (Hop, Connext)        | Week 8   |

## Next Steps & Risks

- **Oracle Accuracy**: ensure reliable TWAP/Chainlink feeds
- **Scalability**: backend caching, rate-limiting
- **Governance & Safety**: fee caps, cooldowns, emergency pause
- **Modular Bridge**: flexible adapters for different protocols

*Location: `docs/ROADMAP.md` for easy reference.*
