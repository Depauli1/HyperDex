const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'hyperdex-relayer' },
  transports: [
    // Console output
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'test'
        ? winston.format.simple()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
    }),
    // File output for errors
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error' 
    }),
    // All logs
    new winston.transports.File({ 
      filename: 'combined.log' 
    })
  ]
});

// Add extra console logging only in non-production non-test
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

module.exports = logger;
