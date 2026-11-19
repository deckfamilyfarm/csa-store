import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PDFDocument, PageSizes, PrintScaling, StandardFonts, rgb } from 'pdf-lib';
import { getPool } from '../db.js';
import { cancelledValue, remainingQuantity } from '../lib/storefrontCancellations.js';
import { parse, recordId } from '../lib/storefrontCore.js';
import { stripeOrderMode } from '../lib/storefrontStripe.js';

// Avery 5164 / 8164 coordinates match the poultry dashboard, in PDF points.
const columns = 2;
const rowsPerSheet = 3;
const labelWidth = 4 * 72;
const labelHeight = 240;
const leftMargin = 0.15625 * 72;
const topMargin = 0.5 * 72;
const columnGap = 0.1875 * 72;
const ink = rgb(0.07, 0.11, 0.14);

const markets = [
  { name: 'PSU', matches: /\b(?:psu|portland state)\b/i, hex: '#9CCB77' },
  { name: 'Hollywood', matches: /\bhollywood\b/i, hex: '#F8DE60' },
  { name: 'LCFM', matches: /\b(?:lcfm|lane county)\b/i, hex: '#91C8F0' },
  { name: 'Farm Pickup', matches: /^(?:deck family )?farm(?: pick[ -]?up)?$/i, hex: '#FADADD' },
];

const collator = new Intl.Collator('en-US', { sensitivity: 'base', numeric: true });

async function readOrders(pool, saleId) {
  const [rows] = await pool.execute(`SELECT o.id, o.number, o.status, o.total_cents, o.refunded_cents, o.refund_status,
    o.stripe_mode, o.stripe_session_id, o.pickup_json,
    JSON_UNQUOTE(JSON_EXTRACT(o.customer_json, '$.name')) AS customer_name,
    JSON_UNQUOTE(JSON_EXTRACT(o.customer_json, '$.phone')) AS customer_phone,
    i.option_id, i.label, i.quantity, i.cancelled_quantity, i.price_cents, i.turkey_type, i.size_label
    FROM storefront_orders o LEFT JOIN storefront_order_items i ON i.order_id = o.id
    WHERE o.sale_id = ? AND o.paid_ms IS NOT NULL
    ORDER BY o.created_ms, o.id, i.option_id`, [saleId]);
  const orders = new Map();
  for (const { option_id, label, quantity, cancelled_quantity, price_cents, turkey_type, size_label, ...row } of rows) {
    if (!orders.has(row.id)) orders.set(row.id, { ...row, items: [] });
    if (option_id != null) orders.get(row.id).items.push({ label, quantity, cancelled_quantity, price_cents, turkey_type, size_label });
  }
  return [...orders.values()];
}

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

function formatPhone(phone) {
  // Preserve international numbers and extensions as entered.
  if (!/^\+?[\d ().-]+$/.test(phone)) return phone;
  const digits = phone.replace(/\D/g, '');
  const domestic = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (domestic.length !== 10 || (phone.startsWith('+') && digits.length !== 11)) return phone;
  return `(${domestic.slice(0, 3)}) ${domestic.slice(3, 6)}-${domestic.slice(6)}`;
}

function marketForPickup(pickup) {
  for (const title of [pickup?.name, pickup?.groupName]) {
    const matches = markets.filter(market => market.matches.test(clean(title)));
    if (matches.length === 1) return matches[0];
  }
}

function turkeyDetails(item) {
  const label = clean(item.label);
  const type = clean(item.turkey_type) || label;
  const breed = /\bheritage\b/i.test(type) ? 'Heritage Black'
    : /\bwhite\b/i.test(type) ? 'Broad Breasted White' : '';
  const sizeName = label.match(/\b(?:extra[ -]large|small|medium|large)\b/i)?.[0];
  const size = [sizeName, clean(item.size_label)].filter(Boolean).join('  ·  ');
  return { breed, size };
}

function buildLabels(orders) {
  const labels = [];
  const issues = [];
  for (const order of orders) {
    const mode = stripeOrderMode(order);
    if (mode === 'test' || (order.status === 'refunded' && order.refunded_cents === order.total_cents)) continue;
    if (mode !== 'live' || !['paid', 'collected'].includes(order.status) ||
      ![null, '', 'partial', 'succeeded'].includes(order.refund_status) || order.refunded_cents !== cancelledValue(order) ||
      order.items.reduce((total, item) => total + remainingQuantity(item) * item.price_cents, 0) !== order.total_cents - order.refunded_cents) {
      issues.push(`${order.number} needs payment or refund review`);
      continue;
    }
    const market = marketForPickup(parse(order.pickup_json));
    const name = clean(order.customer_name);
    const phone = clean(order.customer_phone);
    if (!market || !name || phone.replace(/\D/g, '').length < 7) {
      issues.push(`${order.number} needs a recognized market, name, and phone number`);
      continue;
    }
    for (const item of order.items) {
      const quantity = remainingQuantity(item);
      if (quantity === 0) continue;
      const { breed, size } = turkeyDetails(item);
      if (quantity < 0 || !breed || !size) {
        issues.push(`${order.number} needs a valid turkey variant, size, and quantity`);
        continue;
      }
      for (let copy = 0; copy < quantity; copy++) {
        labels.push({ market, name, phone: formatPhone(phone), breed, size, order: order.number });
      }
    }
  }
  if (issues.length) throw new Error(issues.join('\n'));
  return labels.sort((a, b) => markets.indexOf(a.market) - markets.indexOf(b.market) || collator.compare(a.name, b.name));
}

function color(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return rgb((value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function drawText(page, text, x, y, maxWidth, maxSize, font) {
  const size = Math.min(maxSize, maxWidth / font.widthOfTextAtSize(text, 1));
  page.drawText(text, { x, y, size, font, color: ink });
}

function drawLabel(page, label, slot, regular, bold) {
  const x = leftMargin + (slot % columns) * (labelWidth + columnGap);
  const top = page.getHeight() - topMargin - Math.floor(slot / columns) * labelHeight;
  const textX = x + 22;
  const textWidth = labelWidth - 44;

  page.drawRectangle({ x: x + 11, y: top - 51, width: labelWidth - 22, height: 35, color: color(label.market.hex) });
  drawText(page, label.market.name, textX, top - 40, textWidth, 19, bold);
  drawText(page, label.name, textX, top - 95, textWidth, 25, bold);
  drawText(page, label.phone, textX, top - 124, textWidth, 17, regular);
  drawText(page, label.breed, textX, top - 173, textWidth, 22, bold);
  drawText(page, label.size, textX, top - 200, textWidth, 17, regular);
}

async function renderPdf(labels) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Turkey Pickup Labels');
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const labelsPerSheet = columns * rowsPerSheet;
  for (let start = 0; start < labels.length; start += labelsPerSheet) {
    const page = pdf.addPage(PageSizes.Letter);
    labels.slice(start, start + labelsPerSheet).forEach((label, slot) => {
      try {
        drawLabel(page, label, slot, regular, bold);
      } catch (error) {
        throw new Error(`${label.order} contains text that the label font could not display.`, { cause: error });
      }
    });
  }
  return pdf.save();
}

async function main() {
  const { values } = parseArgs({
    options: { 'sale-id': { type: 'string', default: '1' }, output: { type: 'string' }, help: { type: 'boolean' } },
  });
  const usage = 'node --env-file=.env apps/api/scripts/printTurkeyLabels.js --output /private/tmp/turkey-labels.pdf [--sale-id 1]';
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.output) throw new Error(`Specify a PDF output path.\n${usage}`);
  const saleId = recordId(values['sale-id'], 'Sale ID');
  const pool = getPool();
  try {
    const labels = buildLabels(await readOrders(pool, saleId));
    if (!labels.length) throw new Error(`No live, paid turkeys to print for sale ${saleId}.`);
    await writeFile(values.output, await renderPdf(labels), { flag: 'wx', mode: 0o600 });
    console.log(`${labels.length} labels on ${Math.ceil(labels.length / (columns * rowsPerSheet))} sheets`);
    for (const market of markets) console.log(`${market.name} — ${labels.filter(label => label.market === market).length}`);
    console.log(values.output);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
