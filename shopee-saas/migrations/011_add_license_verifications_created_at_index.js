exports.up = async function (knex) {
  await knex.schema.alterTable('license_verifications', (t) => {
    t.index(['created_at'], 'idx_license_verifications_created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('license_verifications', (t) => {
    t.dropIndex(['created_at'], 'idx_license_verifications_created_at');
  });
};
