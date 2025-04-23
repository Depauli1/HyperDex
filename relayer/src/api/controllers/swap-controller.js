const logger = require('../../utils/logger');
const { verifySignature } = require('../../utils/signature');

/**
 * Controller for swap-related endpoints
 * 
 * @param {Object} services - Service dependencies 
 * @returns {Object} Controller methods
 */
module.exports = function(services) {
  const { contractService, mempoolManager, signatureUtils } = services;
  
  return {
    /**
     * Handle gasless swap submission
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async submitGaslessSwap(req, res) {
      try {
        const {
          trader,
          zeroForOne,
          amountSpecified,
          sqrtPriceLimitX96,
          poolAddress,
          deadline,
          nonce,
          signature
        } = req.body;
        
        logger.info(`Received gasless swap request from ${trader}`);
        
        // Verify the signature using the imported utility
        const isValid = await signatureUtils.verifySignature(
          contractService.hyperDexAddress,
          trader,
          zeroForOne,
          amountSpecified,
          sqrtPriceLimitX96,
          poolAddress,
          deadline,
          nonce,
          signature,
          contractService.provider
        );
        
        if (!isValid) {
          logger.warn(`Signature verification failed for trader ${trader}`);
          return res.status(401).json({ error: 'Invalid signature' });
        }
        
        // Prepare swap parameters
        const swapParams = {
          trader,
          zeroForOne,
          amountSpecified,
          sqrtPriceLimitX96,
          poolAddress,
          deadline,
          nonce
        };
        
        // Execute the swap
        const tx = await contractService.executeGaslessSwap(swapParams, signature);
        
        // Return the transaction hash
        res.status(200).json({
          transactionHash: tx.hash,
          status: 'submitted'
        });
      } catch (error) {
        logger.error(`Error processing swap: ${error.message}`);
        
        // Check error type and return appropriate response
        if (error.message.includes('Invalid signature')) {
          return res.status(401).json({ error: 'Invalid signature' });
        } else if (error.message.includes('deadline')) {
          return res.status(400).json({ error: 'Transaction deadline expired' });
        } else if (error.message.includes('nonce')) {
          return res.status(400).json({ error: 'Invalid nonce' });
        } else {
          return res.status(500).json({ error: error.message });
        }
      }
    }
  };
};
