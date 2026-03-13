exports.up = function (knex) {
  return knex.schema.createTable('licenses', (t) => {
    t.increments('id').primary();
    t.string('license_key_hash', 64).notNullable().unique();
    t.string('customer_email', 255);
    t.string('customer_name', 255);
    t.string('plan', 50).notNullable().defaultTo('starter');
    t.string('status', 50).notNullable().defaultTo('active');
    t.timestamp('expires_at');
    t.string('bound_installation_id', 100);
    t.timestamp('bound_at');
    t.timestamp('last_verified_at');
    t.text('notes');
    t.jsonb('metadata');
    t.timestamps(true, true);

    t.index('status');
    t.index('customer_email');
    t.index('bound_installation_id');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('licenses');
};
