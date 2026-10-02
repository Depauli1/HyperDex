# HyperDex

A concentrated-liquidity DEX for the Hyperliquid EVM, built around **gasless swaps**: the
trader signs an EIP-712 message and an off-chain relayer submits it, so the trader never
needs gas tokens. On top of the AMM sit a dynamic fee module, a cross-chain bridge with
pluggable protocol adapters, and an analytics stack.

Target networks are configured in [`hardhat.config.js`](hardhat.config.js): the HyperEVM
testnet (`https://rpc.hyperliquid-testnet.xyz/evm`, chain id 998) and Sepolia.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Solidity sources (Hardhat, solc 0.8.20) |
| `contracts/HyperDexPool.sol` | Concentrated-liquidity pool |
| `contracts/HyperDexFactory.sol` | Pool registry, fee tiers, protocol fees, analytics |
| `contracts/HyperDexPoolDeployer.sol` | Holds the pool creation code and performs CREATE2 deployment |
| `contracts/HyperDex.sol` | Relayer gateway for gasless swaps |
| `contracts/BridgeRouter.sol` | Escrows and routes cross-chain requests |
| `contracts/adapters/` | Bridge protocol adapters (Connext, LayerZero, Hop) |
| `contracts/FeeController.sol` | Chainlink-driven dynamic fee |
| `contracts/vendor/` | Fixed-point and tick math |
| `relayer/` | Node service that submits signed swaps and watches bridges |
| `analytics-service/` | Express + ethers + socket.io metrics API (port 4000) |
| `dashboard/` | React analytics UI (port 3000) |
| `e2e/` | Playwright end-to-end tests |
| `docs/` | Roadmap and cross-chain design |

## Build and test

```bash
npm install
npx hardhat compile
npx hardhat test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) compiles and tests the contracts
and runs the analytics, dashboard and e2e suites.

## Gasless swaps

The trader signs once, against the **pool's** EIP-712 domain:

```
GaslessSwap(
  address pool,             // binds the signature to one specific pool
  address trader,
  bool    zeroForOne,
  int256  amountSpecified,
  uint160 sqrtPriceLimitX96,
  uint256 deadline,
  uint256 nonce
)
```

`HyperDex.sol` verifies that signature, routes to `params.pool`, and forwards it. The pool
verifies the identical digest again before moving funds and enforces a strict per-trader
nonce. Neither the relayer nor the gateway is trusted with the swap contents.

Relayers are authorised per pool through `HyperDexFactory.setPoolRelayer`, which is the only
sanctioned path — `HyperDexPool.setRelayerAuthorization` accepts the factory as its sole
caller.

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

`LICENSE` is Apache-2.0, but two things in the tree are not compatible with that and need a
decision before any mainnet use:

- `contracts/vendor/TickMath.sol`, `BitMath.sol` and `FixedPoint96.sol` declare
  `GPL-2.0-or-later`. GPL-2.0-only code cannot be combined with Apache-2.0.
- `@uniswap/v3-core` is `BUSL-1.1`, and the npm package ships **only** `contracts/interfaces`
  and `contracts/libraries` as Solidity source — the Pool and Factory are published solely as
  precompiled artifacts. There is therefore no audited `UniswapV3Pool.sol` in this dependency
  to build on, and BUSL-1.1 restricts production use.

## Known issues

The AMM's concentrated-liquidity accounting is still a partial reimplementation of Uniswap v3
and remains incorrect. Open, in the accounting core:

- **Swap direction is inverted** — `zeroForOne: true` currently credits the trader with
  token0 instead of debiting it.
- **No swap fee is applied** — `fee` is stored but never used in any arithmetic, so LPs earn
  nothing.
- **`sqrtPriceLimitX96` is written straight into `sqrtPriceX96`** instead of acting as a
  slippage bound, so the caller sets the resulting price.
- **Tick accounting only grows** — `liquidityGross` is incremented on burn instead of
  decremented, and `_getNextInitializedTick` has no call sites, so there is no tick crossing
  and effectively one constant-liquidity band.
- **`mint` amounts are wrong** — `_calculateTokenAmounts` omits the `Q96` scaling on
  `amount0`, which is materially wrong away from a price of 1.
- **`_updateTVL` overflows** — it computes `uint256(sqrtPriceX96) ** 2`, which exceeds
  `uint256` for large prices, and calls `decimals()` so it reverts on non-standard tokens.

Fixed and covered by regression tests in `test/HyperDexPool.test.js` and
`test/HyperDex.test.js`: signature verification on `gaslessSwap`, the duplicated swap
execution, real CREATE2 pool deployment, per-pool routing, relayer authorisation on
`completeBridge`, and the bridge adapter interfaces.
