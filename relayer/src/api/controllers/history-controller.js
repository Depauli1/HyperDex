/**
 * Transaction history controller
 */
const logger = require('../../utils/logger');

/**
 * Create history controller
 * 
 * @param {Object} services - Service dependencies
 * @returns {Object} Controller methods
 */
module.exports = function(services) {
  const { dbService } = services;
  
  return {
    /**
     * Get transaction history for a trader
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async getTraderHistory(req, res) {
      try {
        const { address } = req.params;
        const { limit = 50, offset = 0, status } = req.query;
        
        logger.info(`Fetching transaction history for trader ${address}`);
        
        // Format options
        const options = {
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10)
        };
        
        if (status) {
          options.status = status;
        }
        
        // Get transactions from database
        const transactions = await dbService.getTransactionsByTrader(address, options);
        
        // Format response
        const formattedTransactions = transactions.map(tx => ({
          id: tx.id,
          poolAddress: tx.poolAddress,
          amountSpecified: tx.amountSpecified,
          zeroForOne: tx.zeroForOne,
          status: tx.status,
          transactionHash: tx.transactionHash,
          blockNumber: tx.blockNumber,
          gasPrice: tx.gasPrice,
          gasUsed: tx.gasUsed,
          createdAt: tx.createdAt,
          confirmedAt: tx.confirmedAt
        }));
        
        res.json({
          trader: address,
          count: formattedTransactions.length,
          transactions: formattedTransactions
        });
      } catch (error) {
        logger.error(`Error fetching trader history: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve transaction history' });
      }
    }
  };
};
