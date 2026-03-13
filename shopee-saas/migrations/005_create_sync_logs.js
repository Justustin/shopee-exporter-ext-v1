exports.up = function (knex) {
  return knex.schema.createTable('sync_logs', (t) => {
    t.increments('id').primary();
    t.integer('store_id').unsigned().notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.uuid('sync_run_id').notNullable();
    t.string('job_type', 50).notNullable();
    t.string('status', 50).notNullable();
    t.integer('orders_synced').defaultTo(0);
    t.text('error_message');
    t.timestamp('started_at').defaultTo(knex.fn.now());
    t.timestamp('finished_at');
    t.index(['store_id', 'started_at']);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('sync_logs');
};
