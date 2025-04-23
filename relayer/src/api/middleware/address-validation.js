/**
 * Middleware for validating Ethereum addresses
 */
const { ethers } = require('ethers');
const logger = require('../../utils/logger');

/**
 * Validate that a route parameter is a valid Ethereum address
 * 
 * @param {string} paramName - Name of the route parameter to validate
 * @returns {function} Express middleware
 */
function validateAddress(paramName) {
  return function(req, res, next) {
    try {
      const address = req.params[paramName];
      
      if (!address) {
        return res.status(400).json({ 
          error: `Missing ${paramName} parameter` 
        });
      }
      
      // Check if address is valid Ethereum address
      if (!ethers.utils.isAddress(address)) {
        logger.warn(`Invalid address format: ${address}`);
        return res.status(400).json({ 
          error: `Invalid ${paramName} format. Must be a valid Ethereum address.` 
        });
      }
      
      // Convert to checksum address
      req.params[paramName] = ethers.utils.getAddress(address);
      next();
    } catch (error) {
      logger.error(`Address validation error: ${error.message}`);
      res.status(400).json({ error: 'Invalid address format' });
    }
  };
}

module.exports = {
  validateAddress
};
