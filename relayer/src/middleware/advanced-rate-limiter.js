/**
 * Advanced rate limiting middleware with IP-based tracking and tier-based quotas
 */
const { RateLimiterMemory, RateLimiterRedis } = require('rate-limiter-flexible');
const Redis = require('ioredis');
const logger = require('../utils/logger');

/**
 * IP-based rate limiter with tiered access levels
 */
class AdvancedRateLimiter {
  /**
   * Create a new advanced rate limiter
   * 
   * @param {Object} options - Configuration options
   * @param {Object} options.redis - Redis connection options (optional)
   * @param {DatabaseService} options.dbService - Database service for user tiers
   * @param {Object} options.tiers - Rate limit settings by tier
   */
  constructor(options = {}) {
    this.options = options;
    this.dbService = options.dbService;
    
    // Define rate limit tiers
    this.tiers = options.tiers || {
      default: { points: 100, duration: 60 }, // 100 requests per minute
      premium: { points: 300, duration: 60 }, // 300 requests per minute
      unlimited: { points: 9999, duration: 60 } // Practically unlimited
    };
    
    // Initialize Redis if provided
    if (options.redis) {
      try {
        this.redisClient = new Redis(options.redis);
        logger.info('Redis client connected for rate limiting');
      } catch (error) {
        logger.error(`Failed to connect to Redis: ${error.message}`);
        logger.warn('Falling back to in-memory rate limiting');
      }
    }
    
    // Create rate limiters for each endpoint type
    this.initRateLimiters();
    
    // Cache user tiers to reduce database lookups
    this.userTierCache = new Map();
    this.userTierCacheTTL = options.userTierCacheTTL || 300000; // 5 minutes
    
    logger.info('Advanced rate limiter initialized');
  }
  
  /**
   * Initialize rate limiters for different endpoint types
   */
  initRateLimiters() {
    // IP-based limiter for all requests
    this.ipLimiter = this.createLimiter('ip', {
      points: this.tiers.default.points,
      duration: this.tiers.default.duration,
      blockDuration: 300, // 5 minutes block if limit is reached
      keyPrefix: 'rl:ip'
    });
    
    // Endpoint-specific limiters
    this.endpointLimiters = {
      // Swap endpoints get special limits
      swap: this.createLimiter('swap', {
        points: Math.floor(this.tiers.default.points / 2), // Stricter limits for swaps
        duration: this.tiers.default.duration,
        keyPrefix: 'rl:swap'
      }),
      
      // Admin endpoints get the strictest limits
      admin: this.createLimiter('admin', {
        points: Math.floor(this.tiers.default.points / 5), // Very strict for admin endpoints
        duration: this.tiers.default.duration,
        keyPrefix: 'rl:admin'
      })
    };
  }
  
  /**
   * Create a rate limiter instance
   * 
   * @param {string} name - Limiter name
   * @param {Object} options - Rate limiter options
   * @returns {RateLimiterMemory|RateLimiterRedis} Rate limiter instance
   */
  createLimiter(name, options) {
    if (this.redisClient) {
      logger.info(`Creating Redis-backed rate limiter: ${name}`);
      return new RateLimiterRedis({
        storeClient: this.redisClient,
        ...options
      });
    } else {
      logger.info(`Creating memory-backed rate limiter: ${name}`);
      return new RateLimiterMemory(options);
    }
  }
  
  /**
   * Get user tier from database or cache
   * 
   * @param {string} address - User wallet address
   * @returns {Promise<string>} User tier name
   */
  async getUserTier(address) {
    // Check cache first
    const cachedTier = this.userTierCache.get(address);
    if (cachedTier && cachedTier.expiresAt > Date.now()) {
      return cachedTier.tier;
    }
    
    // Get from database if available
    if (this.dbService && this.dbService.getUserTier) {
      try {
        const tier = await this.dbService.getUserTier(address);
        if (tier) {
          // Store in cache
          this.userTierCache.set(address, {
            tier,
            expiresAt: Date.now() + this.userTierCacheTTL
          });
          return tier;
        }
      } catch (error) {
        logger.error(`Error getting user tier: ${error.message}`);
      }
    }
    
    // Default to basic tier
    return 'default';
  }
  
  /**
   * Get the limit for a tier
   * 
   * @param {string} tier - Tier name
   * @returns {Object} Rate limit settings
   */
  getTierLimit(tier) {
    return this.tiers[tier] || this.tiers.default;
  }
  
  /**
   * Get middleware for advanced rate limiting
   * 
   * @param {string} endpointType - Endpoint type (swap, admin, etc.)
   * @returns {Function} Express middleware
   */
  getMiddleware(endpointType = 'default') {
    return async (req, res, next) => {
      // Get client IP
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      
      try {
        // Track endpoint type for more specific limits
        const endpointLimiter = 
          this.endpointLimiters[endpointType] || 
          this.ipLimiter;
        
        // Check IP-based rate limit first
        try {
          await this.ipLimiter.consume(ip);
        } catch (rateLimitError) {
          // IP is rate limited
          logger.warn(`IP rate limit exceeded: ${ip}, endpoint: ${req.path}`);
          return res.status(429).json({
            error: 'Rate limit exceeded',
            retryAfter: Math.ceil(rateLimitError.msBeforeNext / 1000) || 60
          });
        }
        
        // If we have an authentication token or ETH address, apply tier-based limits
        let userAddress = null;
        
        // Check authorization header for authenticated requests
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          userAddress = await this.verifyToken(token);
        }
        
        // Check for wallet address in request body
        if (!userAddress && req.body && req.body.trader) {
          userAddress = req.body.trader;
        }
        
        if (userAddress) {
          // Get user tier
          const tier = await this.getUserTier(userAddress);
          const tierLimit = this.getTierLimit(tier);
          
          // Create user-specific limiter with their tier settings
          const userLimiter = this.createLimiter(`user:${userAddress}`, {
            points: tierLimit.points,
            duration: tierLimit.duration,
            keyPrefix: `rl:user:${endpointType}`
          });
          
          try {
            await userLimiter.consume(userAddress);
          } catch (rateLimitError) {
            // User is rate limited
            logger.warn(`User rate limit exceeded: ${userAddress}, tier: ${tier}, endpoint: ${req.path}`);
            return res.status(429).json({
              error: 'Rate limit exceeded for your account tier',
              retryAfter: Math.ceil(rateLimitError.msBeforeNext / 1000) || 60,
              tier
            });
          }
        } else {
          // User is not authenticated, check endpoint-specific limit
          try {
            await endpointLimiter.consume(ip);
          } catch (rateLimitError) {
            // Endpoint limit reached
            logger.warn(`Endpoint rate limit exceeded: ${ip}, endpoint: ${endpointType}`);
            return res.status(429).json({
              error: `Rate limit exceeded for ${endpointType} endpoint`,
              retryAfter: Math.ceil(rateLimitError.msBeforeNext / 1000) || 60
            });
          }
        }
        
        // All rate limits passed, proceed to next middleware
        next();
      } catch (error) {
        logger.error(`Rate limiting error: ${error.message}`);
        // Let the request proceed in case of rate limiter errors
        next();
      }
    };
  }
  
  /**
   * Verify authentication token
   * 
   * @param {string} token - Authentication token 
   * @returns {Promise<string|null>} User ETH address or null if invalid
   */
  async verifyToken(token) {
    if (this.dbService && this.dbService.verifyAuthToken) {
      try {
        return await this.dbService.verifyAuthToken(token);
      } catch (error) {
        logger.error(`Token verification error: ${error.message}`);
      }
    }
    return null;
  }
  
  /**
   * Clean up resources
   */
  async cleanup() {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
        logger.info('Redis client for rate limiting closed');
      } catch (error) {
        logger.error(`Error closing Redis client: ${error.message}`);
      }
    }
    
    this.userTierCache.clear();
  }
}

module.exports = AdvancedRateLimiter;
