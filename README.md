# HyperDex

A concentrated-liquidity DEX for the Hyperliquid EVM, built around **gasless swaps**: the
trader signs an EIP-712 message and an off-chain relayer submits it, so the trader never
needs gas tokens. On top of the AMM sit a dynamic fee module, a cross-chain bridge with
pluggable protocol adapters, and an analytics stack.

The AMM itself is the **audited Uniswap v3 core**, vendored under
`contracts/vendor/v3-core/` and compiled at its own solc version (0.7.6). HyperDex adds the
gasless-swap gateway, the registry and the bridge on top of it; it does not re-implement the
swap, tick or liquidity math.

Target networks are configured in [`hardhat.config.js`](hardhat.config.js): the HyperEVM
testnet (`https://rpc.hyperliquid-testnet.xyz/evm`, chain id 998) and Sepolia.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Solidity sources (Hardhat; solc 0.8.20, plus 0.7.6 for the vendored v3 core) |
| `contracts/vendor/v3-core/` | Authentic Uniswap v3 core v1.0.0 — pool, factory, deployer, libraries |
| `contracts/HyperDexFactory.sol` | Registry over `UniswapV3Factory`: pool tracking, fee tiers, protocol fees, analytics |
| `contracts/HyperDex.sol` | Relayer gateway for gasless swaps; implements the v3 swap callback |
| `contracts/BridgeRouter.sol` | Escrows and routes cross-chain requests |
| `contracts/adapters/` | Bridge protocol adapters (Connext, LayerZero, Hop) |
| `contracts/FeeController.sol` | Chainlink-driven dynamic fee |
| `contracts/mocks/` | Test doubles only (mock ERC20s, mock Chainlink feed, mock bridge protocols) |
| `contracts/test/` | Uniswap's own test callee/token harness, used to drive the pool in tests |
| `relayer/` | Node service that submits signed swaps and watches bridges |
| `analytics-service/` | Express + ethers + socket.io metrics API (port 4000) |
| `dashboard/` | React analytics UI (port 3000) |
| `e2e/` | Playwright end-to-end tests |
| `docs/` | Roadmap and cross-chain design |

## Build and test

```bash
npm install
npm run compile   # hardhat compile
npm test          # hardhat test
```

The project uses two solc versions: 0.8.20 for HyperDex's own contracts and 0.7.6 for the
vendored v3 core. `hardhat.config.js` pins the vendored files via `solidity.overrides`.
Because Hardhat silently drops `overrides` when the solidity config carries a top-level
`version`, the config uses the multi-compiler `compilers: [...]` form — do not "simplify" it
back to `version:`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) compiles and tests the contracts
and runs the analytics, dashboard and e2e suites.

## Gasless swaps

The trader signs once, against the **gateway's** EIP-712 domain (`HyperDex`, version `1`):

```
GaslessSwap(
  address pool,             // binds the signature to one specific pool
  address trader,
  bool    zeroForOne,
  int256  amountSpecified,  // positive = exact input
  uint160 sqrtPriceLimitX96,
  uint256 deadline,
  uint256 nonce
)
```

`HyperDex.sol` verifies the signature against a strict per-trader nonce, confirms the pool is
one this protocol deployed, then calls `IUniswapV3Pool.swap` with the trader as the recipient.
Mid-swap the pool calls back into `uniswapV3SwapCallback`, which pulls the input token from
the trader and pays the pool. The callback first checks `factory.isPool(msg.sender)`, so an
arbitrary contract cannot fake a callback and drain a trader's approval.

The relayer is a single address set by the owner via `HyperDex.setRelayer`. It pays gas but
never controls the swap contents — direction, amount, price bound, deadline and pool are all
inside the signed payload.

## Cross-chain bridge

`BridgeRouter` resolves the adapter for the **destination** chain
(`bridgeAdapters[dstChainId]`), which is what lets Connext and LayerZero serve different
destinations from one router. The router escrows the tokens, allows the adapter exactly what
it needs, and calls `bridgeOut`. An off-chain watcher confirms finality and calls
`completeBridge`, which only an authorised relayer may invoke; the adapter releases the funds
to the user exactly once. See [`docs/CROSS_CHAIN_IMPLEMENTATION.md`](docs/CROSS_CHAIN_IMPLEMENTATION.md).

## Configuration

Copy the templates and fill in real values. Never commit the result:

```bash
cp analytics-service/.env.sample analytics-service/.env
cp dashboard/.env.sample          dashboard/.env
cp relayer/.env.example           relayer/.env
```

`.env`, `.env.*` and `relayer/keystore/*.json` are gitignored. Keys that were committed in
earlier revisions must be treated as compromised and rotated — removing them from tracking
does not remove them from history.

## Licensing

`LICENSE` is Apache-2.0. The vendored Uniswap v3 core is licensed under BUSL-1.1 with a
Change Date of **2023-04-01** and a Change License of **GPL-2.0-or-later**. That date has
passed, so the vendored code is now GPL-2.0-or-later; the `"license": "BUSL-1.1"` field in
the `@uniswap/v3-core` npm package is stale 2021 metadata.

GPL-2.0-**or-later** permits electing GPL-3.0, which is compatible with Apache-2.0 — so the
tree can be made consistent, but it needs an explicit decision from the maintainers and a
`LICENSE` update. Shipping this as pure Apache-2.0 is not correct.

## Audit status

All ten findings from the earlier audit are now resolved. The AMM-level ones (inverted swap
direction, no fee charged, caller-set resulting price, tick accounting that only grew, no tick
crossing, mis-scaled mint amounts, and the overflowing `_updateTVL`) were fixed by **deleting
the hand-written `HyperDexPool.sol`** and building on the audited `UniswapV3Pool` instead.
TVL is no longer computed on-chain; `HyperDexFactory.updatePoolAnalytics` is the only writer
and it is restricted to a configured updater.

Regressions are pinned by reference values in `test/UniswapV3Pool.test.js`, computed
independently in `test/helpers/v3.js`. That reference TickMath is itself checked against the
on-chain implementation in `test/TickMathReference.test.js`.

### Still open

- **Committed private keys must be rotated.** Removing `.env` files from tracking does not
  remove them from git history.
- **The licence decision above** has not been made.
- **No position manager is vendored.** Tests provision liquidity through Uniswap's own
  `TestUniswapV3Callee`; production minting needs `@uniswap/v3-periphery`'s
  `NonfungiblePositionManager`, whose Solidity source is not shipped in its npm package.
- `relayer/`, `analytics-service/` and `dashboard/` are outside the contract test suite.
