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
  // Unref MemoryStore interval to avoid blocking tests
  if (defaultLimiter.store?.clearInterval?.unref) {
    defaultLimiter.store.clearInterval.unref();
  }

  // More restrictive rate limit for admin/analytics endpoints
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: RATE_LIMITS?.ADMIN || 30,
    standardHeaders: true,
    message: { error: 'Too many admin requests, please try again later' }
  });
  if (adminLimiter.store?.clearInterval?.unref) {
    adminLimiter.store.clearInterval.unref();
  }

  // Destructure dbService for tier-based rate limiting
  const { dbService } = services;
  // Tier-based rate limiters
  const tierLimiters = {
    default: rateLimit({
      windowMs: 60 * 1000,
      max: RATE_LIMITS.DEFAULT,
      standardHeaders: true,
      message: { error: 'Too many requests, please try again later' }
    }),
    premium: rateLimit({
      windowMs: 60 * 1000,
      max: RATE_LIMITS.PREMIUM,
      standardHeaders: true,
      message: { error: 'Too many requests, please try again later' }
    }),
    unlimited: (req, res, next) => next()
  };
  // Unref tier limiter store intervals
  Object.values(tierLimiters).forEach(limiter => {
    if (limiter?.store?.clearInterval?.unref) {
      limiter.store.clearInterval.unref();
    }
  });
  // Middleware to apply user tier limits based on trader address or param
  function tierBasedLimiter(req, res, next) {
    const address = req.body.trader || req.params.address;
    // Fallback to default if no address or getUserTier not available
    if (!address || typeof dbService.getUserTier !== 'function') {
      return defaultLimiter(req, res, next);
    }
    dbService.getUserTier(address)
      .then(tier => {
        const limiter = tierLimiters[tier] || tierLimiters.default;
        limiter(req, res, next);
      })
      .catch(err => {
        logger.error(`Error retrieving user tier: ${err.message}`);
        defaultLimiter(req, res, next);
      });
  }

  // Create router
  const router = express.Router();
  
  // Health check endpoint (no rate limit)
  router.get('/health', statusController.healthCheck);
  
  // Status routes with default rate limit
  router.get('/status/:txHash', defaultLimiter, statusController.getTransactionStatus);
  router.get('/status/stats', defaultLimiter, statusController.getSystemStats);
  
  // Swap routes with validation middleware
  router.post('/swap/gasless', tierBasedLimiter, validateSwapParams, swapController.submitGaslessSwap);
  
  // Transaction history routes
  router.get('/history/trader/:address', 
             tierBasedLimiter, 
             validateAddress('address'), 
             historyController.getTraderHistory);
  
  // Webhook registration and management
  router.post('/webhooks/register', 
              tierBasedLimiter, 
              webhookController.registerWebhook);
  
  router.get('/webhooks/trader/:address', 
             tierBasedLimiter, 
             validateAddress('address'),
             webhookController.getTraderWebhooks);
  
  router.put('/webhooks/:id', 
             tierBasedLimiter, 
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
