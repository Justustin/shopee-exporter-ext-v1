exports.up = function (knex) {
  return knex.schema.createTable('order_items', (t) => {
    t.increments('id').primary();
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.string('item_name', 500);
    t.string('sku', 255);
    t.integer('quantity').defaultTo(0);
    t.bigInteger('unit_price').defaultTo(0);
    t.bigInteger('subtotal').defaultTo(0);
    t.index('order_id');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('order_items');
};
