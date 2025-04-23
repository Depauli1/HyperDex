const { ethers } = require('ethers');
const logger = require('../../utils/logger');

/**
 * Validate gasless swap parameters
 * 
 * @param {Express.Request} req - Express request object
 * @param {Express.Response} res - Express response object
 * @param {Express.NextFunction} next - Express next function
 */
function validateSwapParams(req, res, next) {
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
    
    // Check required fields
    if (!signature) {
      return res.status(400).json({ error: 'Missing required field: signature' });
    }
    
    const requiredParams = [
      'trader',
      'zeroForOne',
      'amountSpecified',
      'sqrtPriceLimitX96',
      'deadline',
      'nonce'
    ];
    
    // Check required swap parameters
    for (const param of requiredParams) {
      if (req.body[param] === undefined) {
        return res.status(400).json({ error: `Missing required parameter: ${param}` });
      }
    }
    
    // Validate address format
    if (!ethers.utils.isAddress(trader)) {
      return res.status(400).json({ error: 'Invalid trader address format' });
    }
    
    // Validate poolAddress if provided
    if (poolAddress && !ethers.utils.isAddress(poolAddress)) {
      return res.status(400).json({ error: 'Invalid pool address format' });
    }
    
    // Validate numeric values
    try {
      // Check if amountSpecified is a valid BigNumber
      ethers.BigNumber.from(amountSpecified);
      
      // Check if sqrtPriceLimitX96 is a valid BigNumber
      ethers.BigNumber.from(sqrtPriceLimitX96);
      
      // Check if deadline is a valid BigNumber
      const deadlineBN = ethers.BigNumber.from(deadline);
      
      // Check if deadline has expired
      const now = Math.floor(Date.now() / 1000);
      if (deadlineBN.lt(now)) {
        return res.status(400).json({ error: 'Transaction deadline has expired' });
      }
      
      // Check if nonce is a valid BigNumber
      ethers.BigNumber.from(nonce);
    } catch (error) {
      return res.status(400).json({ error: `Invalid numeric parameter: ${error.message}` });
    }
    
    // Validate signature format
    if (!ethers.utils.isHexString(signature)) {
      return res.status(400).json({ error: 'Invalid signature format' });
    }
    
    // All validation passed
    next();
  } catch (error) {
    logger.error(`Validation error: ${error.message}`);
    res.status(400).json({ error: 'Invalid request format' });
  }
}

module.exports = {
  validateSwapParams
};
