/**
 * Database service for transaction history and analytics
 */
let Sequelize, DataTypes, Op;
// Skip Sequelize loading in test mode to avoid missing module errors
if (process.env.NODE_ENV !== 'test') {
  ({ Sequelize, DataTypes, Op } = require('sequelize'));
}
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');

class DatabaseService {
  /**
   * Initialize database connection
   * 
   * @param {Object} options - Configuration options
   * @param {string} options.databaseUrl - PostgreSQL connection URL for production
   * @param {string} options.databasePath - Path to SQLite database file for development
   */
  constructor(options = {}) {
    this.options = options;
    this.initialized = false;
    this.sequelize = null;
    this.models = {};
  }

  /**
   * Initialize the database connection and models
   */
  async initialize() {
    if (this.initialized) return;

    try {
      this.sequelize = this._createConnection();
      this._defineModels();
      await this._syncModels();
      this.initialized = true;
      logger.info('Database connection established successfully');
    } catch (error) {
      logger.error(`Database initialization error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a database connection based on environment
   * 
   * @private
   * @returns {Sequelize} Sequelize instance
   */
  _createConnection() {
    // For production, use PostgreSQL or another database
    if (process.env.NODE_ENV === 'production' && this.options.databaseUrl) {
      logger.info('Connecting to production database');
      return new Sequelize(this.options.databaseUrl, {
        logging: process.env.SQL_LOGGING === 'true' ? console.log : false,
        dialectOptions: {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      });
    } 
    
    // For development or test, use SQLite
    const dbPath = this.options.databasePath || 
                  process.env.DATABASE_PATH || 
                  path.join(process.cwd(), 'data', 'relayer.sqlite');
    
    // Ensure the directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    logger.info(`Using SQLite database at ${dbPath}`);
    return new Sequelize({
      dialect: 'sqlite',
      storage: dbPath,
      logging: process.env.SQL_LOGGING === 'true' ? console.log : false
    });
  }

  /**
   * Define database models
   * 
   * @private
   */
  _defineModels() {
    // Transaction model - tracks all gasless swaps
    this.models.Transaction = this.sequelize.define('Transaction', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      trader: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true
      },
      poolAddress: {
        type: DataTypes.STRING,
        allowNull: false
      },
      amountSpecified: {
        type: DataTypes.STRING,
        allowNull: false
      },
      zeroForOne: {
        type: DataTypes.BOOLEAN,
        allowNull: false
      },
      sqrtPriceLimitX96: {
        type: DataTypes.STRING,
        allowNull: false
      },
      deadline: {
        type: DataTypes.BIGINT,
        allowNull: false
      },
      nonce: {
        type: DataTypes.STRING,
        allowNull: false
      },
      signature: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      status: {
        type: DataTypes.ENUM('pending', 'submitted', 'confirmed', 'failed'),
        defaultValue: 'pending',
        allowNull: false,
        index: true
      },
      transactionHash: {
        type: DataTypes.STRING,
        allowNull: true,
        index: true
      },
      blockNumber: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      gasPrice: {
        type: DataTypes.STRING,
        allowNull: true
      },
      gasUsed: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      priority: {
        type: DataTypes.STRING,
        allowNull: true
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      retryCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false
      },
      amount0: {
        type: DataTypes.STRING,
        allowNull: true
      },
      amount1: {
        type: DataTypes.STRING,
        allowNull: true
      },
      submittedAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      confirmedAt: {
        type: DataTypes.DATE,
        allowNull: true
      }
    });

    // Usage statistics model - tracks API usage per trader
    this.models.UsageStat = this.sequelize.define('UsageStat', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      trader: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true
      },
      endpoint: {
        type: DataTypes.STRING,
        allowNull: false
      },
      method: {
        type: DataTypes.STRING,
        allowNull: false
      },
      responseTime: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      statusCode: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      ipAddress: {
        type: DataTypes.STRING,
        allowNull: true
      },
      userAgent: {
        type: DataTypes.STRING,
        allowNull: true
      },
      timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false
      }
    });

    // Gas price history - tracks gas prices for analytics
    this.models.GasPriceHistory = this.sequelize.define('GasPriceHistory', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      networkName: {
        type: DataTypes.STRING,
        allowNull: false
      },
      chainId: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      baseGasPrice: {
        type: DataTypes.STRING,
        allowNull: false
      },
      priorityFeeWei: {
        type: DataTypes.STRING,
        allowNull: true
      },
      timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false
      }
    });

    // Webhook registrations for users
    this.models.Webhook = this.sequelize.define('Webhook', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      trader: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true
      },
      url: {
        type: DataTypes.STRING,
        allowNull: false
      },
      secret: {
        type: DataTypes.STRING,
        allowNull: true
      },
      events: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'transaction_confirmed,transaction_failed'
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false
      },
      lastSuccess: {
        type: DataTypes.DATE,
        allowNull: true
      },
      lastFailure: {
        type: DataTypes.DATE,
        allowNull: true
      },
      failureCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false
      }
    });

    // Define User model for rate limiting
    this.models.User = this.sequelize.define('User', {
      address: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
      },
      tier: {
        type: DataTypes.ENUM('default','premium','unlimited'),
        allowNull: false,
        defaultValue: 'default'
      }
    });

    logger.info('Database models defined');
  }

  /**
   * Sync models with the database
   * 
   * @private
   */
  async _syncModels() {
    const forceSync = process.env.FORCE_DB_SYNC === 'true';
    await this.sequelize.sync({ force: forceSync });
    logger.info(`Database models synced. Force: ${forceSync}`);
  }

  /**
   * Store a new transaction in the database
   * 
   * @param {Object} transaction - Transaction data
   * @returns {Object} Created transaction record
   */
  async createTransaction(transaction) {
    if (!this.initialized) await this.initialize();
    
    try {
      // If flat transaction (unit tests), pass through directly
      if (!transaction.params) {
        return await this.models.Transaction.create(transaction);
      }
      const result = await this.models.Transaction.create({
        trader: transaction.params.trader,
        poolAddress: transaction.params.poolAddress,
        amountSpecified: transaction.params.amountSpecified.toString(),
        zeroForOne: transaction.params.zeroForOne,
        sqrtPriceLimitX96: transaction.params.sqrtPriceLimitX96.toString(),
        deadline: transaction.params.deadline,
        nonce: transaction.params.nonce,
        signature: transaction.signature,
        status: transaction.status || 'pending',
        transactionHash: transaction.transactionHash,
        priority: transaction.priority,
        submittedAt: new Date()
      });
      logger.debug(`Transaction stored in database with ID ${result.id}`);
      return result;
    } catch (error) {
      logger.error(`Error creating transaction record: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update an existing transaction
   * 
   * @param {string} id - Transaction ID
   * @param {Object} data - Data to update
   * @returns {Object} Updated transaction
   */
  async updateTransaction(id, data) {
    if (!this.initialized) await this.initialize();
    
    try {
      const transaction = await this.models.Transaction.findByPk(id);
      if (!transaction) {
        throw new Error(`Transaction with ID ${id} not found`);
      }
      
      await transaction.update(data);
      logger.debug(`Transaction ${id} updated with status ${data.status || 'unchanged'}`);
      
      return transaction;
    } catch (error) {
      logger.error(`Error updating transaction ${id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update a transaction by transaction hash
   * 
   * @param {string} txHash - Transaction hash
   * @param {Object} data - Data to update
   * @returns {Object} Updated transaction
   */
  async updateTransactionByHash(txHash, data) {
    if (!this.initialized) await this.initialize();
    
    try {
      const transaction = await this.models.Transaction.findOne({
        where: { transactionHash: txHash }
      });
      
      if (!transaction) {
        throw new Error(`Transaction with hash ${txHash} not found`);
      }
      
      await transaction.update(data);
      logger.debug(`Transaction ${txHash} updated with status ${data.status || 'unchanged'}`);
      
      return transaction;
    } catch (error) {
      logger.error(`Error updating transaction ${txHash}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get transaction by ID or hash
   * 
   * @param {string} idOrHash - Transaction ID or hash
   * @returns {Object} Transaction record
   */
  async getTransaction(idOrHash) {
    if (!this.initialized) await this.initialize();
    
    try {
      // Try to find by ID first
      let transaction = await this.models.Transaction.findByPk(idOrHash);
      
      // If not found, try by hash
      if (!transaction) {
        transaction = await this.models.Transaction.findOne({
          where: { transactionHash: idOrHash }
        });
      }
      
      return transaction;
    } catch (error) {
      logger.error(`Error retrieving transaction ${idOrHash}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all transactions by trader address
   * 
   * @param {string} trader - Trader address
   * @param {Object} options - Query options
   * @returns {Array} Transaction records
   */
  async getTransactionsByTrader(trader, options = {}) {
    if (!this.initialized) await this.initialize();
    
    try {
      const { limit = 100, offset = 0, status } = options;
      const where = { trader };
      
      if (status) {
        where.status = status;
      }
      
      const transactions = await this.models.Transaction.findAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']]
      });
      
      return transactions;
    } catch (error) {
      logger.error(`Error retrieving transactions for trader ${trader}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get pending transactions that need to be retried
   * 
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Array} Transaction records
   */
  async getPendingTransactions(maxRetries = 3) {
    if (!this.initialized) await this.initialize();
    
    try {
      const transactions = await this.models.Transaction.findAll({
        where: {
          status: {
            [Op.or]: ['pending', 'submitted']
          },
          retryCount: {
            [Op.lt]: maxRetries
          },
          createdAt: {
            [Op.gt]: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
          }
        },
        order: [['createdAt', 'ASC']]
      });
      
      return transactions;
    } catch (error) {
      logger.error(`Error retrieving pending transactions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Log API usage
   * 
   * @param {Object} data - Usage data
   * @returns {Object} Created record
   */
  async logUsage(data) {
    if (!this.initialized) await this.initialize();
    
    try {
      return await this.models.UsageStat.create(data);
    } catch (error) {
      logger.error(`Error logging API usage: ${error.message}`);
      // Don't throw, just log the error since this is non-critical
      return null;
    }
  }

  /**
   * Record gas price history
   * 
   * @param {Object} data - Gas price data
   * @returns {Object} Created record
   */
  async recordGasPrice(data) {
    if (!this.initialized) await this.initialize();
    
    try {
      return await this.models.GasPriceHistory.create(data);
    } catch (error) {
      logger.error(`Error recording gas price: ${error.message}`);
      // Don't throw, just log the error since this is non-critical
      return null;
    }
  }

  /**
   * Register a webhook for a trader
   * 
   * @param {Object} data - Webhook data
   * @returns {Object} Created webhook
   */
  async registerWebhook(data) {
    if (!this.initialized) await this.initialize();
    
    try {
      return await this.models.Webhook.create(data);
    } catch (error) {
      logger.error(`Error registering webhook: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get webhooks for a trader
   * 
   * @param {string} trader - Trader address
   * @param {boolean} activeOnly - Only return active webhooks
   * @returns {Array} Webhook records
   */
  async getWebhooks(trader, activeOnly = true) {
    if (!this.initialized) await this.initialize();
    
    try {
      const where = { trader };
      if (activeOnly) {
        where.active = true;
      }
      
      return await this.models.Webhook.findAll({ where });
    } catch (error) {
      logger.error(`Error retrieving webhooks for trader ${trader}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update webhook status
   * 
   * @param {string} id - Webhook ID
   * @param {Object} data - Data to update
   * @returns {Object} Updated webhook
   */
  async updateWebhook(id, data) {
    if (!this.initialized) await this.initialize();
    
    try {
      const webhook = await this.models.Webhook.findByPk(id);
      if (!webhook) {
        throw new Error(`Webhook with ID ${id} not found`);
      }
      
      await webhook.update(data);
      return webhook;
    } catch (error) {
      logger.error(`Error updating webhook ${id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get transaction count by status
   * 
   * @param {string} status - Transaction status
   * @returns {number} Count of transactions with the given status
   */
  async getTransactionCountByStatus(status) {
    if (!this.initialized) await this.initialize();
    
    try {
      const count = await this.models.Transaction.count({
        where: { status }
      });
      
      return count;
    } catch (error) {
      logger.error(`Error getting transaction count for status ${status}: ${error.message}`);
      return 0; // Return 0 instead of throwing to prevent health check failures
    }
  }

  /**
   * Get user tier for rate limiting.
   * Creates user record with default tier if not exists.
   * @param {string} address - User address
   * @returns {string} Tier name: default, premium, or unlimited
   */
  async getUserTier(address) {
    if (!this.initialized) await this.initialize();
    try {
      const [user] = await this.models.User.findOrCreate({
        where: { address },
        defaults: { tier: 'default' }
      });
      return user.tier;
    } catch (error) {
      logger.error(`Error retrieving user tier for ${address}: ${error.message}`);
      return 'default';
    }
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.sequelize) {
      try {
        await this.sequelize.close();
        logger.info('Database connection closed');
      } catch (error) {
        logger.error(`Error closing database connection: ${error.message}`);
      }
    }
  }
}

module.exports = DatabaseService;
