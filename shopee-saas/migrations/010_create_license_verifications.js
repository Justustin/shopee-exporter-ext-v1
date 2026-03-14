exports.up = async function (knex) {
  await knex.schema.createTable('license_verifications', (t) => {
    t.increments('id').primary();
    t.integer('license_id').unsigned().references('id').inTable('licenses').onDelete('SET NULL');
    t.string('license_key_hash', 64);
    t.string('store_key', 191);
    t.string('store_name', 255);
    t.string('build_tag', 120);
    t.string('profile_email', 255);
    t.string('result_code', 80).notNullable();
    t.boolean('success').notNullable().defaultTo(false);
    t.text('error_message');
    t.jsonb('metadata');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['license_id', 'created_at'], 'idx_license_verifications_license_created');
    t.index(['result_code'], 'idx_license_verifications_result_code');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('license_verifications');
};
