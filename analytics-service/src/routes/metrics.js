const express = require('express');

const router = express.Router();
const { getMetrics } = require('../services/chainEvents');

// GET realised price impact of the most recent swap, in percent
router.get('/price-impact', (req, res) => {
  const { priceImpact } = getMetrics();
  res.json({ priceImpact });
});

// GET realised slippage of the most recent swap, in basis points
router.get('/slippage', (req, res) => {
  const { slippage } = getMetrics();
  res.json({ slippage });
});

// GET liquidity utilisation of the most recent swap
router.get('/efficiency', (req, res) => {
  const { efficiency } = getMetrics();
  res.json({ efficiency });
});

// GET Chainlink aggregator prices
router.get('/oracle-prices', (req, res) => {
  const { aggregatorPrices } = getMetrics();
  res.json({ aggregatorPrices });
});

module.exports = router;
