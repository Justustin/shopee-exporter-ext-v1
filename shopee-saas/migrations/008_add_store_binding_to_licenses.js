exports.up = async function (knex) {
  await knex.schema.alterTable('licenses', (t) => {
    t.integer('max_stores').notNullable().defaultTo(1);
  });

  await knex.schema.createTable('license_stores', (t) => {
    t.increments('id').primary();
    t.integer('license_id').unsigned().notNullable().references('id').inTable('licenses').onDelete('CASCADE');
    t.string('store_key', 191).notNullable();
    t.string('store_name', 255);
    t.timestamp('first_verified_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_verified_at').notNullable().defaultTo(knex.fn.now());
    t.jsonb('metadata');
    t.timestamps(true, true);

    t.unique(['license_id', 'store_key']);
    t.index(['license_id', 'store_name']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('license_stores');
  await knex.schema.alterTable('licenses', (t) => {
    t.dropColumn('max_stores');
  });
};
