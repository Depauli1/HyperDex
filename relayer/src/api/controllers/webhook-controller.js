/**
 * Webhook registration and management controller
 */
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');
const logger = require('../../utils/logger');

/**
 * Create webhook controller
 * 
 * @param {Object} services - Service dependencies
 * @returns {Object} Controller methods
 */
module.exports = function(services) {
  const { dbService, signatureUtils } = services;
  
  return {
    /**
     * Register a new webhook
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async registerWebhook(req, res) {
      try {
        const { trader, callbackUrl, events, signature } = req.body;
        
        // Validate required fields
        if (!trader || !callbackUrl || !events || !signature) {
          return res.status(400).json({ 
            error: 'Missing required fields: trader, callbackUrl, events, and signature are required' 
          });
        }
        
        // Validate trader address
        if (!ethers.utils.isAddress(trader)) {
          return res.status(400).json({ error: 'Invalid trader address' });
        }
        
        // Validate callback URL
        try {
          new URL(callbackUrl);
        } catch (error) {
          return res.status(400).json({ error: 'Invalid callback URL' });
        }
        
        // Validate events array
        if (!Array.isArray(events) || events.length === 0) {
          return res.status(400).json({ 
            error: 'Events must be a non-empty array of event types' 
          });
        }
        
        // Validate supported event types
        const supportedEvents = ['swap_submitted', 'swap_confirmed', 'swap_failed'];
        for (const event of events) {
          if (!supportedEvents.includes(event)) {
            return res.status(400).json({
              error: `Unsupported event type: ${event}. Supported events are: ${supportedEvents.join(', ')}`
            });
          }
        }
        
        // Verify signature
        const checksumAddr = ethers.utils.getAddress(trader);
        const message = `Register webhook for ${checksumAddr} at ${callbackUrl} for events: ${events.join(',')}`;
        
        const isValidSignature = await signatureUtils.verifySignature(
          checksumAddr,
          message,
          signature
        );
        
        if (!isValidSignature) {
          logger.warn(`Invalid signature for webhook registration from ${trader}`);
          return res.status(401).json({ error: 'Invalid signature' });
        }
        
        // Create webhook
        const webhook = await dbService.registerWebhook({
          id: uuidv4(),
          trader: checksumAddr,
          callbackUrl,
          events: events.join(','),
          active: true,
          createdAt: new Date()
        });
        
        logger.info(`Registered webhook for trader ${trader}`);
        
        res.status(201).json({
          id: webhook.id,
          trader: webhook.trader,
          callbackUrl: webhook.callbackUrl,
          events: webhook.events.split(','),
          active: webhook.active,
          createdAt: webhook.createdAt
        });
      } catch (error) {
        logger.error(`Error registering webhook: ${error.message}`);
        res.status(500).json({ error: 'Failed to register webhook' });
      }
    },
    
    /**
     * Get webhooks for a trader
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async getTraderWebhooks(req, res) {
      try {
        const { address } = req.params;
        const { activeOnly = 'true' } = req.query;
        
        logger.info(`Fetching webhooks for trader ${address}`);
        
        const webhooks = await dbService.getWebhooks(
          address, 
          activeOnly.toLowerCase() === 'true'
        );
        
        // Format response
        const formattedWebhooks = webhooks.map(hook => ({
          id: hook.id,
          callbackUrl: hook.callbackUrl,
          events: hook.events.split(','),
          active: hook.active,
          createdAt: hook.createdAt
        }));
        
        res.json({
          trader: address,
          count: formattedWebhooks.length,
          webhooks: formattedWebhooks
        });
      } catch (error) {
        logger.error(`Error fetching trader webhooks: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve webhooks' });
      }
    },
    
    /**
     * Update webhook status (enable/disable)
     * 
     * @param {Express.Request} req - Express request
     * @param {Express.Response} res - Express response
     */
    async updateWebhook(req, res) {
      try {
        const { id } = req.params;
        const { active, signature, trader } = req.body;
        
        // Validate required fields
        if (active === undefined || !signature || !trader) {
          return res.status(400).json({ 
            error: 'Missing required fields: active, signature, and trader are required' 
          });
        }
        
        // Verify signature
        const checksumAddr = ethers.utils.getAddress(trader);
        const message = `Update webhook ${id} active status to ${active}`;
        
        const isValidSignature = await signatureUtils.verifySignature(
          checksumAddr,
          message,
          signature
        );
        
        if (!isValidSignature) {
          logger.warn(`Invalid signature for webhook update from ${trader}`);
          return res.status(401).json({ error: 'Invalid signature' });
        }
        
        // Get webhook to verify ownership
        const webhook = await dbService.getWebhook(id);
        
        if (!webhook) {
          return res.status(404).json({ error: 'Webhook not found' });
        }
        
        // Check if requester is the webhook owner
        if (webhook.trader.toLowerCase() !== trader.toLowerCase()) {
          return res.status(403).json({ error: 'Not authorized to update this webhook' });
        }
        
        // Update webhook
        const updated = await dbService.updateWebhook(id, { active });
        
        logger.info(`Updated webhook ${id} active status to ${active}`);
        
        res.json({
          id: updated.id,
          trader: updated.trader,
          callbackUrl: updated.callbackUrl,
          events: updated.events.split(','),
          active: updated.active,
          updatedAt: updated.updatedAt
        });
      } catch (error) {
        logger.error(`Error updating webhook: ${error.message}`);
        res.status(500).json({ error: 'Failed to update webhook' });
      }
    }
  };
};
