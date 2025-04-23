require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const setupRoutes = require('./api/routes');
const ContractService = require('./services/contract-service');
const NonceManager = require('./services/nonce-manager');
const MempoolManager = require('./services/mempool-manager');
const DatabaseService = require('./services/database');
const ProviderManager = require('./utils/provider-manager');
const metrics = require('./utils/metrics');
const CircuitBreaker = require('./utils/circuit-breaker');
const signatureUtils = require('./utils/signature');
const logger = require('./utils/logger');
const { ethers } = require('ethers');
const KeyManager = require('./services/key-manager');

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
    
    const providerManager = new ProviderManager({
      rpcUrls,
      healthCheckIntervalMs: process.env.PROVIDER_HEALTH_CHECK_INTERVAL_MS || 30000,
      timeout: process.env.PROVIDER_TIMEOUT_MS || 10000
    });
    
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
      providerManager,
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
    const PORT = process.env.PORT || 3000;
    
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
        
        // Get latest gas prices for metrics
        const gasPriceOracle = new GasPriceOracle(providerManager.getProvider());
        const gasPrices = {
          low: await gasPriceOracle.getGasPriceForPriority('LOW'),
          medium: await gasPriceOracle.getGasPriceForPriority('MEDIUM'),
          high: await gasPriceOracle.getGasPriceForPriority('HIGH')
        };
        metrics.updateGasPriceMetrics(gasPrices);
        
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
      logger.info(`HyperDex Relayer running on port ${PORT}`);
    });
    
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
        
        logger.info('Cleanup complete, exiting process');
        process.exit(0);
      });
      
      // Force exit after 10 seconds if graceful shutdown fails
      setTimeout(() => {
        logger.error('Forced exit: Could not close connections in time');
        process.exit(1);
      }, 10000);
    };
    
    // Listen for termination signals
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

startServer();
