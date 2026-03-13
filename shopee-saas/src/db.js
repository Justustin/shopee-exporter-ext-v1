const knex = require('knex');
const config = require('./config');
const knexConfig = require('../knexfile');

const env = config.nodeEnv === 'production' ? 'production' : 'development';
const db = knex(knexConfig[env]);

module.exports = db;
