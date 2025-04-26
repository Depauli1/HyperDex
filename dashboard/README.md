# Dashboard UI
![CI](https://github.com/depauli/HyperDex/actions/workflows/ci.yml/badge.svg)
![Coverage](https://img.shields.io/badge/coverage-jest-lightgrey)

React-based analytics dashboard for HyperDex.

## Setup
```bash
cd dashboard
npm install
npm start
```

- Ensure `REACT_APP_ANALYTICS_URL` points to your analytics service (default http://localhost:4000)
- Opens at `http://localhost:3000`

## Testing & Coverage
```bash
cd dashboard
npm test -- --watchAll=false
npm run coverage
```

Coverage report generated in `coverage/lcov-report/index.html`
