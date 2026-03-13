exports.up = function (knex) {
  return knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('email', 255).unique().notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('name', 255);
    t.timestamps(true, true); // created_at, updated_at
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('users');
};
