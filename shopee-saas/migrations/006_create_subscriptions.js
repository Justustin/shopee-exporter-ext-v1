exports.up = function (knex) {
  return knex.schema.createTable('subscriptions', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('plan', 50).notNullable().defaultTo('trial');
    t.string('status', 50).notNullable().defaultTo('active');
    t.timestamp('trial_ends_at');
    t.timestamp('paid_until');
    t.timestamps(true, true);
    t.index('user_id');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('subscriptions');
};
