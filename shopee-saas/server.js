const config = require('./src/config');
const app = require('./src/app');
const logger = require('./src/utils/logger');
const scheduler = require('./src/jobs/scheduler');

const port = config.port;

try {
  config.validateRuntimeConfig();
} catch (error) {
  logger.error(`Startup configuration error: ${error.message}`);
  process.exit(1);
}

app.listen(port, () => {
  logger.info(`Shopee SaaS server running on port ${port}`);
  scheduler.start();
});
