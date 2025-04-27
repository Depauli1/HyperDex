require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const setupRoutes = require('./api/routes');
const ContractService = require('./services/contract-service');
const NonceManager = require('./services/nonce-manager');
const MempoolManager = require('./services/mempool-manager');
let DatabaseService;
if (process.env.NODE_ENV === 'test') {
  DatabaseService = class {
    constructor(options) {
      this.sequelize = { authenticate: async () => {} };
    }
    async initialize() {}
    async close() {}
    async getPendingTransactions() { return []; }
    async addPendingTransaction(tx) { return; }
    async removePendingTransaction(txId) { return; }
  };
} else {
  DatabaseService = require('./services/database');
}
const ProviderManager = require('./utils/provider-manager');
const metrics = require('./utils/metrics');
const CircuitBreaker = require('./utils/circuit-breaker');
const signatureUtils = require('./utils/signature');
const logger = require('./utils/logger');
const { ethers } = require('ethers');
const BridgeWatcher = require('./services/bridge-watcher');
const ConnextAdapter = require('./services/adapters/ConnextAdapter');
const LayerZeroAdapter = require('./services/adapters/LayerZeroAdapter');
// Import GasPriceOracle for metrics endpoint
const { GasPriceOracle } = require('./utils/gas');
const fs = require('fs');
const path = require('path');
// Stub KeyManager in test environment to avoid missing keystore modules
let KeyManager;
if (process.env.NODE_ENV === 'test') {
  // Use valid relayer private key from test-utils in test environment
  const { TEST_ACCOUNTS } = require('../test/utils/test-utils');
  KeyManager = class {
    constructor(options) {}
    async initialize() {}
    getCurrentKey() { return process.env.PRIVATE_KEY || TEST_ACCOUNTS.relayer.privateKey; }
    getStatus() { return { configured: true, nextRotation: null }; }
    async cleanup() {}
  };
} else {
  KeyManager = require('./services/key-manager');
}

// DEBUG: Print environment variables for keystore
console.log('DEBUG ENV:', {
  KEYSTORE_PATH: process.env.KEYSTORE_PATH,
  KEYSTORE_PASSWORD: process.env.KEYSTORE_PASSWORD,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  NODE_ENV: process.env.NODE_ENV,
  CWD: process.cwd(),
});

async function startServer() {
  try {
    // Initialize database service
    logger.info('Initializing database service...');
    const dbService = new DatabaseService({
      databaseUrl: process.env.DATABASE_URL,
      databasePath: process.env.DATABASE_PATH
    });
    await dbService.initialize();
    
    // Initialize blockchain provider and wallet
    logger.info('Initializing provider manager...');
    const rpcUrls = process.env.ETHEREUM_RPC_URLS?.split(',') || 
                   [process.env.ETHEREUM_RPC_URL];
    
    const providerManager = new ProviderManager(
      rpcUrls,
      {
        healthCheckIntervalMs: process.env.PROVIDER_HEALTH_CHECK_INTERVAL_MS || 30000,
        maxRetries: parseInt(process.env.PROVIDER_MAX_RETRIES, 10) || 3,
        retryDelayMs: parseInt(process.env.PROVIDER_RETRY_DELAY_MS, 10) || 10000
      }
    );
    
    await providerManager.initialize();
    
    // Initialize key manager
    const keyManager = new KeyManager({
      keystorePath: process.env.KEYSTORE_PATH,
      keystorePassword: process.env.KEYSTORE_PASSWORD,
      rotationInterval: process.env.KEY_ROTATION_INTERVAL_MS
    });
    await keyManager.initialize();
    
    // Get primary provider for wallet
    const provider = providerManager.getProvider();
    const privateKey = keyManager.getCurrentKey();
    const wallet = new ethers.Wallet(privateKey, provider);
    
    // Initialize circuit breaker
    logger.info('Initializing circuit breaker...');
    const circuitBreaker = new CircuitBreaker({
      maxGasPriceGwei: process.env.MAX_GAS_PRICE_GWEI || 100,
      providerFailureThreshold: 5
    });
    
    // Set up circuit breaker event handlers
    circuitBreaker.on('open', (data) => {
      logger.warn(`Circuit breaker opened: ${data.reason}`);
      metrics.metrics.circuitBreakerTrips.inc();
    });
    
    circuitBreaker.on('close', (data) => {
      logger.info(`Circuit breaker closed: ${data.reason}`);
    });
    
    // Connect circuit breaker to provider manager for monitoring
    providerManager.on('providerError', () => {
      circuitBreaker.recordProviderFailure();
    });
    
    providerManager.on('providerSuccess', () => {
      circuitBreaker.resetProviderFailures();
    });
    
    // Initialize core services
    const contractService = new ContractService({
      provider: providerManager,
      wallet,
      hyperDexAddress: process.env.HYPERDEX_ADDRESS,
      factoryAddress: process.env.FACTORY_ADDRESS
    });
    
    const nonceManager = new NonceManager(providerManager.getProvider(), wallet);
    
    // Initialize mempool manager with database integration
    const mempoolManager = new MempoolManager(
      { wallet, nonceManager, contractService },
      { dbService, circuitBreaker }
    );
    
    // Initialize express app
    const app = express();
    // Determine port: dynamic port for tests, else honor PORT env var, else default
    const PORT = process.env.NODE_ENV === 'test'
      ? 0
      : (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
    
    // Write the selected port to a temp file for test discovery
    let portFile;
    if (process.env.NODE_ENV === 'test') {
      portFile = path.resolve(__dirname, '..', 'test', '.relayer-port');
    }
    
    // Middleware
    app.use(helmet());
    app.use(express.json());
    
    // Add metrics middleware
    app.use(metrics.httpMetricsMiddleware);
    
    // Add basic rate limiting
    const rateLimit = require('express-rate-limit');
    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again later'
    });
    app.use('/api', apiLimiter);
    
    // Serve a simple welcome message at root
    app.get('/', (req, res) => {
      res.send('HyperDex Relayer API is running. See /api for available endpoints.');
    });
    
    // Setup routes with dependencies
    app.use('/api', setupRoutes({
      providerManager,
      wallet,
      contractService,
      nonceManager,
      mempoolManager,
      signatureUtils,
      dbService
    }));
    
    // Expose health check under /api for E2E tests
    app.get('/api/health', async (req, res) => {
      try {
        const providerHealth = await providerManager.getHealthStatus();
        let dbHealth = false;
        try {
          await dbService.sequelize.authenticate();
          dbHealth = true;
        } catch (error) {
          logger.error(`Database health check failed: ${error.message}`);
        }
        const circuitBreakerStatus = circuitBreaker.getStatus();
        const circuitOpen = circuitBreakerStatus.state !== 'closed';
        const healthy = providerHealth.hasHealthyProvider && dbHealth && !circuitOpen;
        res.status(healthy ? 200 : 503).json({
          status: healthy ? 'ok' : 'degraded',
          timestamp: new Date().toISOString(),
          services: {
            provider: providerHealth,
            database: { connected: dbHealth },
            circuitBreaker: circuitBreakerStatus
          }
        });
      } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        res.status(500).json({ status: 'error', error: 'Health check failed' });
      }
    });
    
    // Health check endpoint
    app.get('/health', async (req, res) => {
      try {
        // Check provider health
        const providerHealth = await providerManager.getHealthStatus();
        
        // Check database connection
        let dbHealth = false;
        try {
          await dbService.sequelize.authenticate();
          dbHealth = true;
        } catch (error) {
          logger.error(`Database health check failed: ${error.message}`);
        }
        
        // Get circuit breaker status
        const circuitBreakerStatus = circuitBreaker.getStatus();
        const circuitOpen = circuitBreakerStatus.state !== 'closed';
        
        // Return health status
        const healthy = providerHealth.hasHealthyProvider && dbHealth && !circuitOpen;
        
        res.status(healthy ? 200 : 503).json({
          status: healthy ? 'ok' : 'degraded',
          timestamp: new Date().toISOString(),
          services: {
            provider: providerHealth,
            database: { connected: dbHealth },
            circuitBreaker: circuitBreakerStatus
          }
        });
      } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        res.status(500).json({ status: 'error', error: 'Health check failed' });
      }
    });
    
    // Metrics endpoint for Prometheus scraping
    app.get('/metrics', async (req, res) => {
      try {
        // Update real-time metrics before serving
        metrics.updateMempoolMetrics(mempoolManager);
        
        // Get provider health to update metrics
        const providerHealth = await providerManager.getHealthStatus();
        
        // Update gas price metrics in non-test environment
        if (process.env.NODE_ENV !== 'test') {
          const gasPriceOracle = new GasPriceOracle(providerManager.getProvider());
          const gasPrices = {
            low: await gasPriceOracle.getGasPriceForPriority('LOW'),
            medium: await gasPriceOracle.getGasPriceForPriority('MEDIUM'),
            high: await gasPriceOracle.getGasPriceForPriority('HIGH')
          };
          metrics.updateGasPriceMetrics(gasPrices);
        }
        
        // Get metrics in Prometheus format
        const prometheusMetrics = await metrics.getMetrics();
        
        // Send the metrics
        res.set('Content-Type', metrics.register.contentType);
        res.end(prometheusMetrics);
      } catch (error) {
        logger.error(`Error serving metrics: ${error.message}`);
        res.status(500).send('Error collecting metrics');
      }
    });
    
    // Circuit breaker management endpoint (admin only)
    app.post('/admin/circuit-breaker', (req, res) => {
      try {
        const { action, reason } = req.body;
        
        if (action === 'open') {
          circuitBreaker.open(reason || 'Manual open via API');
          res.json({ success: true, status: circuitBreaker.getStatus() });
        } else if (action === 'close') {
          circuitBreaker.close(reason || 'Manual close via API');
          res.json({ success: true, status: circuitBreaker.getStatus() });
        } else {
          res.status(400).json({ error: 'Invalid action. Must be "open" or "close".' });
        }
      } catch (error) {
        logger.error(`Error managing circuit breaker: ${error.message}`);
        res.status(500).json({ error: 'Failed to manage circuit breaker' });
      }
    });
    
    // Circuit breaker status endpoint
    app.get('/admin/circuit-breaker', (req, res) => {
      try {
        res.json({ status: circuitBreaker.getStatus() });
      } catch (error) {
        logger.error(`Error getting circuit breaker status: ${error.message}`);
        res.status(500).json({ error: 'Failed to get circuit breaker status' });
      }
    });
    
    // Key management endpoints (admin)
    app.post('/admin/key-rotate', async (req, res) => {
      try {
        await keyManager.rotateKey();
        res.json({ success: true, status: keyManager.getStatus() });
      } catch (error) {
        logger.error(`Key rotation failed: ${error.message}`);
        res.status(500).json({ error: 'Key rotation failed' });
      }
    });

    app.get('/admin/key-status', (req, res) => {
      res.json(keyManager.getStatus());
    });
    
    // Error handling middleware
    app.use((err, req, res, next) => {
      logger.error(`Error: ${err.message}`);
      res.status(500).json({ error: 'Internal server error' });
    });
    
    // Start server
    const server = app.listen(PORT, () => {
      // Initialize cross-chain watcher
      (async () => {
        try {
          const adapters = new Map();
          // Adapter keys (bytes32)
          const CONNEXT_KEY = ethers.utils.formatBytes32String('CONNEXT');
          const LAYERZERO_KEY = ethers.utils.formatBytes32String('LAYERZERO');
          // Instantiate adapters
          adapters.set(CONNEXT_KEY, new ConnextAdapter({
            sourceProvider: provider,
            connextAddress: process.env.CONNEXT_ADDRESS,
            connextABI: require('./config/connext-abi.json'),
            wallet,
            domainMapping: JSON.parse(process.env.CONNEXT_DOMAIN_MAPPING),
            slippage: Number(process.env.CONNEXT_SLIPPAGE) || 30,
            callData: process.env.CONNEXT_CALL_DATA || '0x',
            delegate: process.env.CONNEXT_DELEGATE
          }));
          adapters.set(LAYERZERO_KEY, new LayerZeroAdapter({
            endpointAddress: process.env.LAYERZERO_ENDPOINT_ADDRESS,
            endpointABI: require('./config/layerzero-abi.json'),
            wallet,
            chainIdMapping: JSON.parse(process.env.LAYERZERO_CHAIN_MAPPING),
            adapterParams: process.env.LAYERZERO_ADAPTER_PARAMS || '0x',
            zroPaymentAddress: process.env.LAYERZERO_ZRO_PAYMENT_ADDRESS || ethers.constants.AddressZero,
            refundAddress: process.env.LAYERZERO_REFUND_ADDRESS || wallet.address
          }));
          // Create watcher
          const watcher = new BridgeWatcher({
            sourceProvider: provider,
            destProvider: provider,
            wallet,
            sourceRouterAddress: process.env.BRIDGE_ROUTER_SOURCE,
            destRouterAddress: process.env.BRIDGE_ROUTER_DEST,
            adapters,
            srcChainId: Number(process.env.SRC_CHAIN_ID),
            dstChainId: Number(process.env.DST_CHAIN_ID),
            token: process.env.BRIDGE_TOKEN_ADDRESS,
            confirmations: Number(process.env.BRIDGE_CONFIRMATIONS) || 12
          });
          await watcher.start();
          logger.info('BridgeWatcher started');
        } catch (err) {
          logger.error(`BridgeWatcher init error: ${err.message}`);
        }
      })();
      (async () => {
        const actualPort = server.address().port;
        logger.info(`HyperDex Relayer running on port ${actualPort}`);
        // Write port to temp file for test discovery
        if (process.env.NODE_ENV === 'test' && portFile) {
          try {
            fs.writeFileSync(portFile, actualPort.toString(), 'utf8');
          } catch (e) {
            logger.error(`Failed to write relayer port file: ${e.message}`);
          }
          // Wait until file is actually written
          let wrotePort = false;
          for (let i = 0; i < 20; i++) {
            if (fs.existsSync(portFile)) {
              wrotePort = true;
              break;
            }
            await new Promise(r => setTimeout(r, 50));
          }
          if (!wrotePort) {
            logger.error('Port file was not written after 1s');
          }
        }
      })();
    });
    return server;
    
    // Handle graceful shutdown
    const gracefulShutdown = () => {
      logger.info('Received shutdown signal, closing server...');
      server.close(() => {
        logger.info('Server closed, cleaning up resources...');
        
        // Clean up provider resources
        if (providerManager.cleanup) {
          providerManager.cleanup();
        }
        
        // Clean up mempool manager
        if (mempoolManager.cleanup) {
          mempoolManager.cleanup();
        }
        
        // Clean up key manager
        if (keyManager.cleanup) {
          keyManager.cleanup();
        }
        
        // Close database connection
        if (dbService.close) {
          dbService.close();
        }
        
        // Cleanup: remove temp port file if present
        if (process.env.NODE_ENV === 'test' && portFile) {
          try { fs.unlinkSync(portFile); } catch (e) {}
        }
        
        logger.info('Cleanup complete, exiting process');
        process.exit(0);
      });
      
      // Force exit after 10 seconds if graceful shutdown fails
      const forceExitTimeout = setTimeout(() => {
        logger.error('Forced exit: Could not close connections in time');
        process.exit(1);
      }, 10000);
      // Prevent timer from keeping the event loop alive
      if (forceExitTimeout.unref) forceExitTimeout.unref();
    };
    
    // Listen for termination signals
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    if (process.env.NODE_ENV === 'test') {
      throw error;
    } else {
      process.exit(1);
    }
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
