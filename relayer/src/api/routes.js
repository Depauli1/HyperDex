const express = require('express');
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/constants');
const { validateSwapParams } = require('./middleware/validation');
const logger = require('../utils/logger');
const { validateAddress } = require('./middleware/address-validation');

/**
 * Configure and setup all API routes
 * 
 * @param {Object} services - Service dependencies
 * @returns {Express.Router} Configured Express router
 */
module.exports = function(services) {
  // Create controllers with dependencies
  const swapController = require('./controllers/swap-controller')(services);
  const statusController = require('./controllers/status-controller')(services);
  const historyController = require('./controllers/history-controller')(services);
  const webhookController = require('./controllers/webhook-controller')(services);
  const analyticsController = require('./controllers/analytics-controller')(services);

  // Setup rate limiting
  const defaultLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: RATE_LIMITS?.DEFAULT || 100,
    standardHeaders: true,
    message: { error: 'Too many requests, please try again later' }
  });

  // More restrictive rate limit for admin/analytics endpoints
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: RATE_LIMITS?.ADMIN || 30,
    standardHeaders: true,
    message: { error: 'Too many admin requests, please try again later' }
  });

  // Create router
  const router = express.Router();
  
  // Health check endpoint (no rate limit)
  router.get('/health', statusController.healthCheck);
  
  // Status routes with default rate limit
  router.get('/status/:txHash', defaultLimiter, statusController.getTransactionStatus);
  router.get('/status/stats', defaultLimiter, statusController.getSystemStats);
  
  // Swap routes with validation middleware
  router.post('/swap/gasless', defaultLimiter, validateSwapParams, swapController.submitGaslessSwap);
  
  // Transaction history routes
  router.get('/history/trader/:address', 
             defaultLimiter, 
             validateAddress('address'), 
             historyController.getTraderHistory);
  
  // Webhook registration and management
  router.post('/webhooks/register', 
              defaultLimiter, 
              webhookController.registerWebhook);
  
  router.get('/webhooks/trader/:address', 
             defaultLimiter, 
             validateAddress('address'),
             webhookController.getTraderWebhooks);
  
  router.put('/webhooks/:id', 
             defaultLimiter, 
             webhookController.updateWebhook);
  
  // Analytics endpoints (admin/monitoring only)
  router.get('/analytics/gas-prices', 
             adminLimiter, 
             analyticsController.getGasPriceHistory);
  
  router.get('/analytics/usage', 
             adminLimiter, 
             analyticsController.getUsageStats);
  
  // Add 404 handler for API routes
  router.use((req, res) => {
    logger.warn(`404 - API route not found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Route not found' });
  });
  
  return router;
};
