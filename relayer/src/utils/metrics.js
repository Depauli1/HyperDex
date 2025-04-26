/**
 * Metrics collection using Prometheus
 */
const promClient = require('prom-client');
const logger = require('./logger');
const { ethers } = require('ethers');

// Create a registry
const register = new promClient.Registry();

// Add default metrics (memory, CPU, etc.), skip in test to prevent open intervals
let defaultMetricsInterval;
if (process.env.NODE_ENV !== 'test') {
  defaultMetricsInterval = promClient.collectDefaultMetrics({ register });
  // Unref interval so it doesn't block process exit
  if (defaultMetricsInterval && typeof defaultMetricsInterval.unref === 'function') {
    defaultMetricsInterval.unref();
  }
}

// Create custom metrics
const metrics = {
  // Transaction metrics
  transactionsTotal: new promClient.Counter({
    name: 'hyperdex_transactions_total',
    help: 'Total number of transactions processed',
    labelNames: ['status', 'type'],
    registers: [register]
  }),
  
  transactionDuration: new promClient.Histogram({
    name: 'hyperdex_transaction_duration_seconds',
    help: 'Transaction processing duration in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 180, 300],
    labelNames: ['status', 'type'],
    registers: [register]
  }),
  
  // Provider metrics
  providerRequests: new promClient.Counter({
    name: 'hyperdex_provider_requests_total',
    help: 'Number of requests to RPC providers',
    labelNames: ['provider', 'method', 'status'],
    registers: [register]
  }),
  
  providerRequestDuration: new promClient.Histogram({
    name: 'hyperdex_provider_request_duration_seconds',
    help: 'Provider request duration in seconds',
    buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10],
    labelNames: ['provider', 'method'],
    registers: [register]
  }),
  
  // Gas price metrics
  currentGasPrice: new promClient.Gauge({
    name: 'hyperdex_current_gas_price_gwei',
    help: 'Current gas price in Gwei',
    labelNames: ['priority'],
    registers: [register]
  }),
  
  // API metrics
  httpRequestsTotal: new promClient.Counter({
    name: 'hyperdex_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'endpoint', 'status'],
    registers: [register]
  }),
  
  httpRequestDuration: new promClient.Histogram({
    name: 'hyperdex_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    labelNames: ['method', 'endpoint'],
    registers: [register]
  }),
  
  // Mempool metrics
  mempoolSize: new promClient.Gauge({
    name: 'hyperdex_mempool_size',
    help: 'Number of transactions in mempool',
    labelNames: ['priority'],
    registers: [register]
  }),
  
  // Database metrics
  dbQueryDuration: new promClient.Histogram({
    name: 'hyperdex_db_query_duration_seconds',
    help: 'Database query duration in seconds',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    labelNames: ['operation', 'model'],
    registers: [register]
  }),
  
  // Webhook metrics
  webhookDeliveryTotal: new promClient.Counter({
    name: 'hyperdex_webhook_delivery_total',
    help: 'Total webhook delivery attempts',
    labelNames: ['status'],
    registers: [register]
  }),
  
  webhookDeliveryDuration: new promClient.Histogram({
    name: 'hyperdex_webhook_delivery_duration_seconds',
    help: 'Webhook delivery duration in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    labelNames: ['status'],
    registers: [register]
  })
};

/**
 * Get metrics in Prometheus format
 * 
 * @returns {Promise<string>} Metrics in Prometheus format
 */
async function getMetrics() {
  try {
    return await register.metrics();
  } catch (error) {
    logger.error(`Error collecting metrics: ${error.message}`);
    return '';
  }
}

/**
 * Update mempool metrics from current state
 * 
 * @param {MempoolManager} mempoolManager - Mempool manager instance
 */
function updateMempoolMetrics(mempoolManager) {
  try {
    const stats = mempoolManager.getStats();
    
    // Update queue sizes
    metrics.mempoolSize.set({ priority: 'high' }, stats.queueSizes.high);
    metrics.mempoolSize.set({ priority: 'medium' }, stats.queueSizes.medium);
    metrics.mempoolSize.set({ priority: 'low' }, stats.queueSizes.low);
    
    // Could add more detailed metrics here
  } catch (error) {
    logger.error(`Error updating mempool metrics: ${error.message}`);
  }
}

/**
 * Update gas price metrics
 * 
 * @param {Object} gasPrices - Current gas prices
 */
function updateGasPriceMetrics(gasPrices) {
  try {
    if (gasPrices.high) {
      metrics.currentGasPrice.set({ priority: 'high' }, Number(ethers.utils.formatUnits(gasPrices.high, 'gwei')));
    }
    if (gasPrices.medium) {
      metrics.currentGasPrice.set({ priority: 'medium' }, Number(ethers.utils.formatUnits(gasPrices.medium, 'gwei')));
    }
    if (gasPrices.low) {
      metrics.currentGasPrice.set({ priority: 'low' }, Number(ethers.utils.formatUnits(gasPrices.low, 'gwei')));
    }
  } catch (error) {
    logger.error(`Error updating gas price metrics: ${error.message}`);
  }
}

/**
 * Express middleware to track HTTP requests
 */
function httpMetricsMiddleware(req, res, next) {
  const startTime = Date.now();
  const { method, path } = req;
  
  // Record end of request
  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    
    metrics.httpRequestsTotal.inc({
      method,
      endpoint: path,
      status: res.statusCode
    });
    
    metrics.httpRequestDuration.observe({
      method,
      endpoint: path
    }, duration);
  });
  
  next();
}

/**
 * Record transaction metrics
 * 
 * @param {string} type - Transaction type
 * @param {string} status - Transaction status
 * @param {number} duration - Transaction duration in seconds
 */
function recordTransaction(type, status, duration) {
  metrics.transactionsTotal.inc({ type, status });
  if (duration) {
    metrics.transactionDuration.observe({ type, status }, duration);
  }
}

/**
 * Record provider request metrics
 * 
 * @param {string} provider - Provider name/URL
 * @param {string} method - RPC method name
 * @param {string} status - Request status (success/error)
 * @param {number} duration - Request duration in seconds
 */
function recordProviderRequest(provider, method, status, duration) {
  metrics.providerRequests.inc({ provider, method, status });
  if (duration) {
    metrics.providerRequestDuration.observe({ provider, method }, duration);
  }
}

/**
 * Record database operation metrics
 * 
 * @param {string} operation - Database operation type
 * @param {string} model - Database model name
 * @param {number} duration - Operation duration in seconds
 */
function recordDbQuery(operation, model, duration) {
  metrics.dbQueryDuration.observe({ operation, model }, duration);
}

/**
 * Record webhook delivery metrics
 * 
 * @param {string} status - Delivery status
 * @param {number} duration - Delivery duration in seconds
 */
function recordWebhookDelivery(status, duration) {
  metrics.webhookDeliveryTotal.inc({ status });
  if (duration) {
    metrics.webhookDeliveryDuration.observe({ status }, duration);
  }
}

module.exports = {
  register,
  metrics,
  getMetrics,
  updateMempoolMetrics,
  updateGasPriceMetrics,
  httpMetricsMiddleware,
  recordTransaction,
  recordProviderRequest,
  recordDbQuery,
  recordWebhookDelivery
};
