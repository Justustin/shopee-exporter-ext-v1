const db = require('../db');

const CSV_HEADERS = [
  'Order ID', 'Order SN', 'Income Invoice ID', 'Buyer Name', 'Order Status',
  'Created', 'Payment Method', 'Product Name', 'SKU/Variant', 'Quantity',
  'Unit Price', 'Product Subtotal', 'Total Quantity', 'Order Total (Rp)',
  'Admin Fee (Rp)', 'Service Fee (Rp)', 'Transaction Fee (Rp)',
  'Shipping Fee (Rp)', 'Shipping Fee Rebate (Rp)', 'Buyer Shipping Fee (Rp)',
  'Shopee Shipping Rebate (Rp)', 'Voucher Shopee (Rp)', 'Voucher Seller (Rp)',
  'Coins (Rp)', 'Order Income (Rp)', 'Net Income (Rp)',
];

function escCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function escXml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeDateBoundary(value, endOfDay = false) {
  if (value instanceof Date) return value;
  const text = String(value || '').trim();
  if (!text) return null;
  return new Date(endOfDay ? `${text}T23:59:59` : text);
}

async function getExportRows(storeId, dateFrom, dateTo) {
  const from = normalizeDateBoundary(dateFrom, false);
  const to = normalizeDateBoundary(dateTo, true);
  if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return [];
  }

  const orders = await db('orders')
    .where({ store_id: storeId })
    .whereBetween('create_time', [from, to])
    .orderBy('create_time', 'desc');

  if (orders.length === 0) return [];

  const orderIds = orders.map((order) => order.id);
  const allItems = await db('order_items')
    .whereIn('order_id', orderIds)
    .orderBy('id', 'asc');
  const itemsByOrderId = new Map();
  for (const item of allItems) {
    if (!itemsByOrderId.has(item.order_id)) {
      itemsByOrderId.set(item.order_id, []);
    }
    itemsByOrderId.get(item.order_id).push(item);
  }

  const rows = [];

  for (const order of orders) {
    const items = itemsByOrderId.get(order.id) || [];

    const orderItems = items.length > 0
      ? items
      : [{ item_name: '', sku: '', quantity: '', unit_price: '', subtotal: '' }];

    for (const item of orderItems) {
      rows.push({
        order_id: order.order_id || '',
        order_sn: order.order_sn || '',
        income_invoice_id: order.income_invoice_id || '',
        buyer_name: order.buyer_name || '',
        order_status: order.order_status || '',
        create_time: order.create_time ? new Date(order.create_time).toISOString().slice(0, 19).replace('T', ' ') : '',
        payment_method: order.payment_method || '',
        item_name: item.item_name || '',
        sku: item.sku || '',
        quantity: item.quantity || '',
        unit_price: item.unit_price || '',
        subtotal: item.subtotal || '',
        total_quantity: order.total_quantity || '',
        order_total: order.order_total || '',
        admin_fee: order.admin_fee || '',
        service_fee: order.service_fee || '',
        transaction_fee: order.transaction_fee || '',
        shipping_fee: order.shipping_fee || '',
        shipping_fee_rebate: order.shipping_fee_rebate || '',
        buyer_shipping_fee: order.buyer_shipping_fee || '',
        shopee_shipping_rebate: order.shopee_shipping_rebate || '',
        voucher_from_shopee: order.voucher_from_shopee || '',
        voucher_from_seller: order.voucher_from_seller || '',
        coins: order.coins || '',
        order_income: order.order_income || '',
        net_income: order.net_income || '',
      });
    }
  }

  return rows;
}

async function generateCSV(storeId, dateFrom, dateTo) {
  const rows = await getExportRows(storeId, dateFrom, dateTo);
  const lines = [CSV_HEADERS.join(',')];

  for (const row of rows) {
    const values = [
      row.order_id, row.order_sn, row.income_invoice_id, row.buyer_name,
      row.order_status, row.create_time, row.payment_method,
      row.item_name, row.sku, row.quantity, row.unit_price, row.subtotal,
      row.total_quantity, row.order_total, row.admin_fee, row.service_fee,
      row.transaction_fee, row.shipping_fee, row.shipping_fee_rebate,
      row.buyer_shipping_fee, row.shopee_shipping_rebate, row.voucher_from_shopee,
      row.voucher_from_seller, row.coins, row.order_income, row.net_income,
    ].map(escCsv);
    lines.push(values.join(','));
  }

  return '\uFEFF' + lines.join('\n');
}

async function generateExcelXml(storeId, dateFrom, dateTo) {
  const rows = await getExportRows(storeId, dateFrom, dateTo);

  const colors = ['#FFFFFF', '#F2F2F2'];
  let lastOrderSn = '';
  let colorIdx = 0;

  let rowsXml = '';

  // Header row
  rowsXml += '<Row ss:StyleID="header">';
  for (const h of CSV_HEADERS) {
    rowsXml += `<Cell><Data ss:Type="String">${escXml(h)}</Data></Cell>`;
  }
  rowsXml += '</Row>\n';

  for (const row of rows) {
    if (row.order_sn && row.order_sn !== lastOrderSn) {
      colorIdx = 1 - colorIdx;
      lastOrderSn = row.order_sn;
    }
    const style = colorIdx === 0 ? 'groupA' : 'groupB';

    const vals = [
      row.order_id, row.order_sn, row.income_invoice_id, row.buyer_name,
      row.order_status, row.create_time, row.payment_method,
      row.item_name, row.sku, row.quantity, row.unit_price, row.subtotal,
      row.total_quantity, row.order_total, row.admin_fee, row.service_fee,
      row.transaction_fee, row.shipping_fee, row.shipping_fee_rebate,
      row.buyer_shipping_fee, row.shopee_shipping_rebate, row.voucher_from_shopee,
      row.voucher_from_seller, row.coins, row.order_income, row.net_income,
    ];

    rowsXml += `<Row ss:StyleID="${style}">`;
    for (const v of vals) {
      const isNum = v !== '' && !isNaN(v);
      const type = isNum ? 'Number' : 'String';
      rowsXml += `<Cell><Data ss:Type="${type}">${escXml(v)}</Data></Cell>`;
    }
    rowsXml += '</Row>\n';
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default"><Font ss:Size="11"/></Style>
    <Style ss:ID="header">
      <Font ss:Bold="1" ss:Size="11"/>
      <Interior ss:Color="#EE4D2D" ss:Pattern="Solid"/>
      <Font ss:Color="#FFFFFF" ss:Bold="1"/>
    </Style>
    <Style ss:ID="groupA">
      <Interior ss:Color="${colors[0]}" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="groupB">
      <Interior ss:Color="${colors[1]}" ss:Pattern="Solid"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="Orders">
    <Table>
${rowsXml}
    </Table>
  </Worksheet>
</Workbook>`;
}

module.exports = { generateCSV, generateExcelXml };
