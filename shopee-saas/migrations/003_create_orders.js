exports.up = async function (knex) {
  await knex.schema.createTable('orders', (t) => {
    t.increments('id').primary();
    t.integer('store_id').unsigned().notNullable().references('id').inTable('stores').onDelete('CASCADE');
    t.string('order_sn', 100).notNullable();
    t.string('order_id', 100);
    t.string('income_invoice_id', 100);
    t.string('buyer_name', 255);
    t.string('order_status', 50);
    t.string('payment_method', 100);
    t.timestamp('create_time');
    t.timestamp('update_time');
    t.integer('total_quantity').defaultTo(0);

    // Financial fields (BIGINT, in Rupiah - no decimals)
    t.bigInteger('order_total').defaultTo(0);
    t.bigInteger('admin_fee').defaultTo(0);
    t.bigInteger('service_fee').defaultTo(0);
    t.bigInteger('transaction_fee').defaultTo(0);
    t.bigInteger('shipping_fee').defaultTo(0);
    t.bigInteger('shipping_fee_rebate').defaultTo(0);
    t.bigInteger('buyer_shipping_fee').defaultTo(0);
    t.bigInteger('shopee_shipping_rebate').defaultTo(0);
    t.bigInteger('voucher_from_shopee').defaultTo(0);
    t.bigInteger('voucher_from_seller').defaultTo(0);
    t.bigInteger('coins').defaultTo(0);
    t.bigInteger('order_income').defaultTo(0);
    t.bigInteger('net_income').defaultTo(0);

    // Sync metadata
    t.boolean('escrow_synced').defaultTo(false);
    t.timestamp('escrow_updated_at').nullable();
    t.jsonb('raw_escrow');
    t.timestamp('synced_at').defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.unique(['store_id', 'order_sn']);
    t.index(['store_id', 'create_time'], 'idx_orders_store_create');
    t.index(['store_id', 'update_time'], 'idx_orders_store_update');
  });
  await knex.raw(`
    CREATE INDEX idx_orders_escrow_backlog
    ON orders (store_id, create_time DESC)
    WHERE escrow_synced = false
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_orders_escrow_backlog');
  await knex.schema.dropTableIfExists('orders');
};
