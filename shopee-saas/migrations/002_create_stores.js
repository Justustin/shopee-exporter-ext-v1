exports.up = function (knex) {
  return knex.schema.createTable('stores', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('shop_id').notNullable();
    t.string('shop_name', 255);
    t.string('region', 10).defaultTo('ID');
    t.text('access_token');
    t.text('refresh_token');
    t.timestamp('token_expires_at');
    t.timestamp('last_sync_at');
    t.bigInteger('last_synced_update_time'); // unix timestamp
    t.string('last_synced_order_sn', 100);
    t.uuid('sync_lock_id').nullable();
    t.timestamp('sync_lock_at').nullable();
    t.boolean('is_active').defaultTo(true);
    t.timestamps(true, true);
    t.unique(['user_id', 'shop_id']);
    t.index('user_id');
    t.index(['token_expires_at'], 'idx_stores_token_expiry');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('stores');
};
