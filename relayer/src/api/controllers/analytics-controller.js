/**
 * Analytics controller for system metrics and statistics
 */
const logger = require('../../utils/logger');

/**
 * Create analytics controller
 * 
 * @param {Object} services - Service dependencies
 * @returns {Object} Controller methods
 */
module.exports = function(services) {
  const { dbService } = services;
  
  return {
    /**
     * Get gas price history data
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async getGasPriceHistory(req, res) {
      try {
        const { days = 7, networkName } = req.query;
        
        logger.info(`Fetching gas price history for the last ${days} days`);
        
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days, 10));
        
        // Query parameters
        const params = {
          startDate,
          endDate
        };
        
        if (networkName) {
          params.networkName = networkName;
        }
        
        // Get gas price history from database
        const gasPrices = await dbService.getGasPriceHistory(params);
        
        // Format response with network grouping
        const networkData = {};
        
        for (const entry of gasPrices) {
          if (!networkData[entry.networkName]) {
            networkData[entry.networkName] = [];
          }
          
          networkData[entry.networkName].push({
            timestamp: entry.timestamp,
            baseGasPrice: entry.baseGasPrice,
            chainId: entry.chainId
          });
        }
        
        res.json({
          period: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            days: parseInt(days, 10)
          },
          networks: networkData
        });
      } catch (error) {
        logger.error(`Error fetching gas price history: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve gas price history' });
      }
    },
    
    /**
     * Get API usage statistics
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async getUsageStats(req, res) {
      try {
        const { days = 7, endpoint } = req.query;
        
        logger.info(`Fetching API usage statistics for the last ${days} days`);
        
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days, 10));
        
        // Query parameters
        const params = {
          startDate,
          endDate
        };
        
        if (endpoint) {
          params.endpoint = endpoint;
        }
        
        // Get usage stats from database
        const usageStats = await dbService.getUsageStats(params);
        
        // Aggregate stats by endpoint and day
        const dailyStats = {};
        const endpointTotals = {};
        
        for (const stat of usageStats) {
          // Ensure timestamp is Date
          const ts = stat.timestamp instanceof Date ? stat.timestamp : new Date(stat.timestamp);
          const day = ts.toISOString().split('T')[0];
          
          // Initialize day in dailyStats if not exists
          if (!dailyStats[day]) {
            dailyStats[day] = {};
          }
          
          // Initialize endpoint in day if not exists
          if (!dailyStats[day][stat.endpoint]) {
            dailyStats[day][stat.endpoint] = {
              count: 0,
              successCount: 0,
              failureCount: 0,
              avgResponseTime: 0
            };
          }
          
          // Initialize endpoint in totals if not exists
          if (!endpointTotals[stat.endpoint]) {
            endpointTotals[stat.endpoint] = {
              count: 0,
              successCount: 0,
              failureCount: 0,
              avgResponseTime: 0
            };
          }
          
          // Update daily stats
          const dayEndpoint = dailyStats[day][stat.endpoint];
          dayEndpoint.count++;
          if (stat.success) dayEndpoint.successCount++;
          else dayEndpoint.failureCount++;
          
          // Update running average for response time
          const oldAvg = dayEndpoint.avgResponseTime;
          const oldCount = dayEndpoint.count - 1;
          dayEndpoint.avgResponseTime = oldCount > 0 
            ? (oldAvg * oldCount + stat.responseTimeMs) / dayEndpoint.count 
            : stat.responseTimeMs;
          
          // Update endpoint totals
          const endpointTotal = endpointTotals[stat.endpoint];
          endpointTotal.count++;
          if (stat.success) endpointTotal.successCount++;
          else endpointTotal.failureCount++;
          
          // Update running average for response time in totals
          const oldTotalAvg = endpointTotal.avgResponseTime;
          const oldTotalCount = endpointTotal.count - 1;
          endpointTotal.avgResponseTime = oldTotalCount > 0
            ? (oldTotalAvg * oldTotalCount + stat.responseTimeMs) / endpointTotal.count
            : stat.responseTimeMs;
        }
        
        res.json({
          period: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            days: parseInt(days, 10)
          },
          dailyStats,
          endpointTotals
        });
      } catch (error) {
        logger.error(`Error fetching usage statistics: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve usage statistics' });
      }
    }
  };
};
