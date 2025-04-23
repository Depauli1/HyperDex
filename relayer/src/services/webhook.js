/**
 * Webhook notification service
 */
const axios = require('axios');
const logger = require('../utils/logger');
const { metrics } = require('../utils/metrics');
const { v4: uuidv4 } = require('uuid');

class WebhookService {
  /**
   * Initialize webhook service
   * 
   * @param {Object} options - Service options
   * @param {DatabaseService} options.dbService - Database service instance
   * @param {number} options.maxRetries - Maximum number of retries for failed deliveries
   * @param {number} options.timeoutMs - Webhook request timeout in milliseconds
   * @param {number} options.maxBatchSize - Maximum number of webhooks to process in parallel
   */
  constructor(options = {}) {
    this.dbService = options.dbService;
    this.maxRetries = options.maxRetries || Number(process.env.WEBHOOK_RETRY_COUNT || 3);
    this.timeoutMs = options.timeoutMs || Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
    this.maxBatchSize = options.maxBatchSize || Number(process.env.WEBHOOK_MAX_BATCH_SIZE || 10);
    this.pendingDeliveries = new Map();
    
    // Create axios instance for webhook delivery
    this.http = axios.create({
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HyperDex-Relayer-Webhook'
      }
    });
    
    logger.info('Webhook service initialized', {
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
      maxBatchSize: this.maxBatchSize
    });
  }
  
  /**
   * Deliver a transaction event notification to registered webhooks
   * 
   * @param {string} eventType - Event type (swap_submitted, swap_confirmed, swap_failed)
   * @param {string} trader - Trader address
   * @param {Object} eventData - Event data to deliver
   */
  async deliverEvent(eventType, trader, eventData) {
    if (!this.dbService) {
      logger.warn('Webhook delivery skipped: No database service available');
      return;
    }
    
    try {
      // Find all active webhooks for this trader that subscribe to this event
      const webhooks = await this.dbService.getWebhooksByEvent(trader, eventType);
      
      if (webhooks.length === 0) {
        logger.debug(`No webhooks found for trader ${trader} and event ${eventType}`);
        return;
      }
      
      logger.info(`Delivering ${eventType} event to ${webhooks.length} webhooks for trader ${trader}`);
      
      // Build notification payload
      const notification = {
        id: uuidv4(),
        eventType,
        trader,
        timestamp: new Date().toISOString(),
        data: eventData
      };
      
      // Deliver to each webhook
      const promises = webhooks.map(webhook => 
        this._deliverToWebhook(webhook, notification)
      );
      
      // Process in batches to avoid overwhelming connections
      for (let i = 0; i < promises.length; i += this.maxBatchSize) {
        const batch = promises.slice(i, i + this.maxBatchSize);
        await Promise.all(batch);
      }
    } catch (error) {
      logger.error(`Error delivering webhooks for event ${eventType}: ${error.message}`);
    }
  }
  
  /**
   * Deliver a notification to a specific webhook
   * 
   * @param {Object} webhook - Webhook registration
   * @param {Object} notification - Notification payload
   * @private
   */
  async _deliverToWebhook(webhook, notification) {
    const deliveryId = uuidv4();
    const startTime = Date.now();
    
    try {
      logger.debug(`Delivering webhook notification to ${webhook.callbackUrl}`);
      
      // Track this delivery
      this.pendingDeliveries.set(deliveryId, {
        webhookId: webhook.id,
        notification,
        startTime,
        retryCount: 0
      });
      
      // Make the request
      const response = await this.http.post(webhook.callbackUrl, {
        webhook_id: webhook.id,
        delivery_id: deliveryId,
        ...notification
      });
      
      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      metrics.recordWebhookDelivery('success', duration);
      
      // Log success
      logger.info(`Successfully delivered webhook notification to ${webhook.callbackUrl}`, {
        statusCode: response.status,
        duration: `${duration}s`
      });
      
      // Remove from pending deliveries
      this.pendingDeliveries.delete(deliveryId);
      
      // Record delivery in database if available
      if (this.dbService.logWebhookDelivery) {
        await this.dbService.logWebhookDelivery({
          id: deliveryId,
          webhookId: webhook.id,
          payload: JSON.stringify(notification),
          statusCode: response.status,
          responseTime: duration * 1000,
          success: true,
          timestamp: new Date()
        }).catch(err => logger.error(`Error logging webhook delivery: ${err.message}`));
      }
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      metrics.recordWebhookDelivery('failed', duration);
      
      // Get current delivery record
      const delivery = this.pendingDeliveries.get(deliveryId);
      
      if (delivery && delivery.retryCount < this.maxRetries) {
        // Schedule retry with exponential backoff
        const retryCount = delivery.retryCount + 1;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s delay
        
        logger.warn(`Webhook delivery failed, retry ${retryCount}/${this.maxRetries} in ${delay}ms: ${error.message}`);
        
        // Update retry count
        this.pendingDeliveries.set(deliveryId, {
          ...delivery,
          retryCount,
          lastError: error.message
        });
        
        // Schedule retry
        setTimeout(() => {
          this._retryDelivery(webhook, notification, deliveryId);
        }, delay);
      } else {
        // Max retries reached or no delivery found, log failure
        logger.error(`Webhook delivery failed after ${delivery ? delivery.retryCount : 0} retries: ${error.message}`);
        
        // Remove from pending
        this.pendingDeliveries.delete(deliveryId);
        
        // Record failure in database
        if (this.dbService.logWebhookDelivery) {
          await this.dbService.logWebhookDelivery({
            id: deliveryId,
            webhookId: webhook.id,
            payload: JSON.stringify(notification),
            statusCode: error.response?.status || 0,
            responseTime: duration * 1000,
            success: false,
            errorMessage: error.message,
            timestamp: new Date()
          }).catch(err => logger.error(`Error logging webhook delivery: ${err.message}`));
        }
      }
    }
  }
  
  /**
   * Retry a webhook delivery
   * 
   * @param {Object} webhook - Webhook registration
   * @param {Object} notification - Notification payload
   * @param {string} deliveryId - Delivery ID
   * @private
   */
  async _retryDelivery(webhook, notification, deliveryId) {
    const delivery = this.pendingDeliveries.get(deliveryId);
    if (!delivery) return;
    
    try {
      logger.debug(`Retrying webhook delivery ${deliveryId}, attempt ${delivery.retryCount}`);
      
      // Make the request
      const response = await this.http.post(webhook.callbackUrl, {
        webhook_id: webhook.id,
        delivery_id: deliveryId,
        retry_count: delivery.retryCount,
        ...notification
      });
      
      // Record metrics
      const duration = (Date.now() - delivery.startTime) / 1000;
      metrics.recordWebhookDelivery('success_retry', duration);
      
      // Log success
      logger.info(`Successfully delivered webhook notification on retry ${delivery.retryCount}`, {
        statusCode: response.status,
        duration: `${duration}s`
      });
      
      // Remove from pending deliveries
      this.pendingDeliveries.delete(deliveryId);
      
      // Record successful retry in database
      if (this.dbService.logWebhookDelivery) {
        await this.dbService.logWebhookDelivery({
          id: deliveryId,
          webhookId: webhook.id,
          payload: JSON.stringify(notification),
          statusCode: response.status,
          responseTime: duration * 1000,
          success: true,
          retryCount: delivery.retryCount,
          timestamp: new Date()
        }).catch(err => logger.error(`Error logging webhook delivery: ${err.message}`));
      }
    } catch (error) {
      // Get updated delivery record
      const updatedDelivery = this.pendingDeliveries.get(deliveryId);
      
      if (updatedDelivery && updatedDelivery.retryCount < this.maxRetries) {
        // Schedule another retry with exponential backoff
        const retryCount = updatedDelivery.retryCount + 1;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s delay
        
        logger.warn(`Webhook retry ${updatedDelivery.retryCount} failed, next retry in ${delay}ms: ${error.message}`);
        
        // Update retry count
        this.pendingDeliveries.set(deliveryId, {
          ...updatedDelivery,
          retryCount,
          lastError: error.message
        });
        
        // Schedule retry
        setTimeout(() => {
          this._retryDelivery(webhook, notification, deliveryId);
        }, delay);
      } else {
        // Max retries reached or no delivery found, log failure
        logger.error(`Webhook delivery failed after ${updatedDelivery ? updatedDelivery.retryCount : 0} retries: ${error.message}`);
        
        // Remove from pending
        this.pendingDeliveries.delete(deliveryId);
        
        // Record final failure in database
        if (this.dbService.logWebhookDelivery) {
          const duration = (Date.now() - (updatedDelivery?.startTime || Date.now())) / 1000;
          
          await this.dbService.logWebhookDelivery({
            id: deliveryId,
            webhookId: webhook.id,
            payload: JSON.stringify(notification),
            statusCode: error.response?.status || 0,
            responseTime: duration * 1000,
            success: false,
            errorMessage: error.message,
            retryCount: updatedDelivery?.retryCount || 0,
            timestamp: new Date()
          }).catch(err => logger.error(`Error logging webhook delivery: ${err.message}`));
        }
      }
    }
  }
  
  /**
   * Get pending webhook deliveries count
   * 
   * @returns {number} Number of pending deliveries
   */
  getPendingCount() {
    return this.pendingDeliveries.size;
  }
  
  /**
   * Clean up service resources
   */
  async cleanup() {
    logger.info(`Cleaning up webhook service (${this.pendingDeliveries.size} pending deliveries)`);
    this.pendingDeliveries.clear();
  }
}

module.exports = WebhookService;
