const logger = require('../../utils/logger');
const { ethers } = require('ethers');
const os = require('os');

/**
 * Controller for status-related endpoints
 * 
 * @param {Object} services - Service dependencies 
 * @returns {Object} Controller methods
 */
module.exports = function(services) {
  const { mempoolManager, wallet, providerManager, dbService } = services;
  
  return {
    /**
     * Health check endpoint
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async healthCheck(req, res) {
      try {
        // Get provider health status
        const providerHealth = await providerManager.getHealthStatus();
        
        // Check database connection
        let dbHealth = false;
        try {
          await dbService.sequelize.authenticate();
          dbHealth = true;
        } catch (error) {
          logger.error(`Database health check failed: ${error.message}`);
        }
        
        // Get latest block number from healthy provider
        let blockNumber = null;
        try {
          blockNumber = await providerManager.executeWithProvider(provider => 
            provider.getBlockNumber()
          );
        } catch (error) {
          logger.warn(`Failed to get latest block number: ${error.message}`);
        }
        
        // Determine overall status
        const healthy = providerHealth.hasHealthyProvider && dbHealth;
        const status = healthy ? 'ok' : 'degraded';
        
        res.status(healthy ? 200 : 503).json({
          status,
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          version: process.env.npm_package_version || '1.0.0',
          blockNumber,
          services: {
            provider: providerHealth,
            database: { connected: dbHealth }
          }
        });
      } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        res.status(500).json({
          status: 'error',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    },
    
    /**
     * Get detailed system statistics
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async getSystemStats(req, res) {
      try {
        // Get mempool statistics
        const mempoolStats = mempoolManager.getStats();
        
        // Get provider health
        const providerHealth = await providerManager.getHealthStatus();
        
        // Get system resource usage
        const systemStats = {
          cpuUsage: process.cpuUsage(),
          memoryUsage: process.memoryUsage(),
          freeMemory: os.freemem(),
          totalMemory: os.totalmem(),
          loadAverage: os.loadavg(),
          uptime: process.uptime()
        };
        
        // Get database statistics if available
        let dbStats = { connected: false };
        try {
          if (dbService.sequelize) {
            await dbService.sequelize.authenticate();
            dbStats.connected = true;
            
            // Get transaction counts by status
            const pendingCount = await dbService.getTransactionCountByStatus('pending');
            const submittedCount = await dbService.getTransactionCountByStatus('submitted');
            const confirmedCount = await dbService.getTransactionCountByStatus('confirmed');
            const failedCount = await dbService.getTransactionCountByStatus('failed');
            
            dbStats.transactions = {
              pending: pendingCount,
              submitted: submittedCount,
              confirmed: confirmedCount,
              failed: failedCount,
              total: pendingCount + submittedCount + confirmedCount + failedCount
            };
          }
        } catch (error) {
          logger.error(`Failed to get database stats: ${error.message}`);
        }
        
        // Return comprehensive stats
        res.json({
          timestamp: new Date().toISOString(),
          version: process.env.npm_package_version || '1.0.0',
          mempool: mempoolStats,
          providers: providerHealth,
          system: systemStats,
          database: dbStats
        });
      } catch (error) {
        logger.error(`Error fetching system stats: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve system statistics' });
      }
    },
    
    /**
     * Get specific transaction status
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async getTransactionStatus(req, res) {
      const { txHash } = req.params;
      
      // Validate txHash format
      if (!txHash || !txHash.match(/^0x[a-fA-F0-9]{64}$/)) {
        return res.status(400).json({ error: 'Invalid transaction hash' });
      }
      
      try {
        const status = await mempoolManager.getTransactionStatus(txHash);
        
        if (!status) {
          return res.status(404).json({ error: 'Transaction not found' });
        }
        
        res.status(200).json(status);
      } catch (error) {
        logger.error(`Error getting transaction status: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve transaction status' });
      }
    }
  };
};
