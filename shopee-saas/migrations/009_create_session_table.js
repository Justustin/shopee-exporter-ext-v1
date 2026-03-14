exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('session');
  if (exists) return;

  await knex.schema.createTable('session', (t) => {
    t.string('sid').primary();
    t.json('sess').notNullable();
    t.timestamp('expire', { useTz: false }).notNullable();
  });

  await knex.schema.alterTable('session', (t) => {
    t.index(['expire'], 'IDX_session_expire');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('session');
};
