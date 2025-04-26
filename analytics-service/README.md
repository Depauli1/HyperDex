# Analytics Service

Express + Ethers.js + Socket.io based service to stream on-chain swap events and expose metrics.
![CI](https://github.com/depauli/HyperDex/actions/workflows/ci.yml/badge.svg)
![Coverage](https://img.shields.io/badge/coverage-nyc-lightgrey)

## Setup

```bash
cd analytics-service
npm install
npm run dev
```

- Configure `.env` from `.env.sample`
- Runs on `http://localhost:4000`

## Testing & Coverage

```bash
cd analytics-service
npm test
npm run coverage
```

Coverage report generated in `coverage/lcov-report/index.html`
