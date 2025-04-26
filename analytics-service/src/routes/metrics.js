const express = require('express');
const express = require('express');
const router = express.Router();
const { getMetrics } = require('../services/chainEvents');

// GET price impact (placeholder)
router.get('/price-impact', (req, res) => {
  const { priceImpact } = getMetrics();
  res.json({ priceImpact });
});

// GET slippage predictions
router.get('/slippage', (req, res) => {
  const { slippage } = getMetrics();
  res.json({ slippage });
});

// GET capital efficiency metrics
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
