const winston = require('winston');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

if (config.nodeEnv === 'production') {
  const logsDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  transports.push(
    new winston.transports.File({ filename: path.join(logsDir, 'app.log') }),
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' })
  );
}

const logger = winston.createLogger({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports,
});

module.exports = logger;
