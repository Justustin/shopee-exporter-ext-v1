const db = require('../db');

const EXPORT_COLUMNS = [
  { header: 'Order ID', key: 'order_id', type: 'string' },
  { header: 'Order SN', key: 'order_sn', type: 'string' },
  { header: 'Income Invoice ID', key: 'income_invoice_id', type: 'string' },
  { header: 'Buyer Name', key: 'buyer_name', type: 'string' },
  { header: 'Order Status', key: 'order_status', type: 'string' },
  { header: 'Created', key: 'create_time', type: 'string' },
  { header: 'Payment Method', key: 'payment_method', type: 'string' },
  { header: 'Product Name', key: 'item_name', type: 'string' },
  { header: 'SKU/Variant', key: 'sku', type: 'string' },
  { header: 'Quantity', key: 'quantity', type: 'number' },
  { header: 'Unit Price', key: 'unit_price', type: 'number' },
  { header: 'Product Subtotal', key: 'subtotal', type: 'number' },
  { header: 'Total Quantity', key: 'total_quantity', type: 'number' },
  { header: 'Order Total (Rp)', key: 'order_total', type: 'number' },
  { header: 'Admin Fee (Rp)', key: 'admin_fee', type: 'number' },
  { header: 'Service Fee (Rp)', key: 'service_fee', type: 'number' },
  { header: 'Transaction Fee (Rp)', key: 'transaction_fee', type: 'number' },
  { header: 'Shipping Fee (Rp)', key: 'shipping_fee', type: 'number' },
  { header: 'Shipping Fee Rebate (Rp)', key: 'shipping_fee_rebate', type: 'number' },
  { header: 'Buyer Shipping Fee (Rp)', key: 'buyer_shipping_fee', type: 'number' },
  { header: 'Shopee Shipping Rebate (Rp)', key: 'shopee_shipping_rebate', type: 'number' },
  { header: 'Voucher Shopee (Rp)', key: 'voucher_from_shopee', type: 'number' },
  { header: 'Voucher Seller (Rp)', key: 'voucher_from_seller', type: 'number' },
  { header: 'Coins (Rp)', key: 'coins', type: 'number' },
  { header: 'Order Income (Rp)', key: 'order_income', type: 'number' },
  { header: 'Net Income (Rp)', key: 'net_income', type: 'number' },
];

const CSV_HEADERS = EXPORT_COLUMNS.map((column) => column.header);

function protectSpreadsheetText(value) {
  const text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) {
    return `'${text}`;
  }
  if (/^\d{15,}$/.test(text.trim())) {
    return `'${text}`;
  }
  return text;
}

function escCsv(val, options = {}) {
  const s = options.text ? protectSpreadsheetText(val) : String(val ?? '');
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
    const values = EXPORT_COLUMNS.map((column) => escCsv(row[column.key], { text: column.type !== 'number' }));
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

    rowsXml += `<Row ss:StyleID="${style}">`;
    for (const column of EXPORT_COLUMNS) {
      const value = row[column.key];
      const isNumber = column.type === 'number' && value !== '' && value !== null && value !== undefined && !isNaN(value);
      const type = isNumber ? 'Number' : 'String';
      const cellValue = isNumber ? value : String(value ?? '');
      rowsXml += `<Cell><Data ss:Type="${type}">${escXml(cellValue)}</Data></Cell>`;
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
