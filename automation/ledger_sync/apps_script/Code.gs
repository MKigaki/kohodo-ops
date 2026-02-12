/**
 * Shopify -> 04_FG_Ledger synchronizer
 *
 * Required Script Properties:
 * - SHOPIFY_STORE_DOMAIN (e.g. your-store.myshopify.com)
 * - SHOPIFY_ADMIN_TOKEN (Admin API access token)
 *
 * Optional Script Properties:
 * - APPLY=true|false (default: false)
 * - MODE=incremental|backfill (default: incremental)
 * - START_AT=ISO8601
 * - END_AT=ISO8601
 * - LAST_SYNC_AT=ISO8601 (used by incremental)
 */

const LEDGER_SHEET = '04_FG_Ledger';
const STAGING_SHEET = 'staging_04_FG_Ledger';
const LEDGER_HEADERS = [
  'event_id',
  'event_time',
  'source',
  'event_type',
  'sku',
  'qty',
  'from_location',
  'to_location',
  'ref_id',
  'note',
];

/**
 * Main entrypoint. Default mode is dry-run and incremental.
 */
function runLedgerSync() {
  const scriptProps = PropertiesService.getScriptProperties();

  const config = {
    storeDomain: mustGetProp_(scriptProps, 'SHOPIFY_STORE_DOMAIN'),
    adminToken: mustGetProp_(scriptProps, 'SHOPIFY_ADMIN_TOKEN'),
    apply: (scriptProps.getProperty('APPLY') || 'false').toLowerCase() === 'true',
    mode: (scriptProps.getProperty('MODE') || 'incremental').toLowerCase(),
    startAt: scriptProps.getProperty('START_AT') || null,
    endAt: scriptProps.getProperty('END_AT') || null,
    lastSyncAt: scriptProps.getProperty('LAST_SYNC_AT') || null,
  };

  if (!['incremental', 'backfill'].includes(config.mode)) {
    throw new Error('MODE must be incremental or backfill');
  }

  const window = resolveSyncWindow_(config);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ledgerSheet = ensureSheetWithHeaders_(ss, LEDGER_SHEET, LEDGER_HEADERS);
  const stagingSheet = ensureSheetWithHeaders_(ss, STAGING_SHEET, LEDGER_HEADERS);

  const existingEventIds = loadExistingEventIds_(ledgerSheet);
  const { ordersCount, rows } = collectShopifyRows_(config, window.startAt, window.endAt, existingEventIds);

  const targetSheet = config.apply ? ledgerSheet : stagingSheet;
  appendRows_(targetSheet, rows);

  scriptProps.setProperty('LAST_SYNC_AT', new Date().toISOString());

  Logger.log(
    JSON.stringify(
      {
        mode: config.mode,
        apply: config.apply,
        targetSheet: targetSheet.getName(),
        ordersFetched: ordersCount,
        rowsAppended: rows.length,
        window,
      },
      null,
      2,
    ),
  );
}

/**
 * Convenience wrapper for forced apply.
 */
function runLedgerSyncApply() {
  PropertiesService.getScriptProperties().setProperty('APPLY', 'true');
  runLedgerSync();
}

/**
 * Convenience wrapper for forced dry-run.
 */
function runLedgerSyncDryRun() {
  PropertiesService.getScriptProperties().setProperty('APPLY', 'false');
  runLedgerSync();
}

function resolveSyncWindow_(config) {
  const nowIso = new Date().toISOString();

  if (config.mode === 'backfill') {
    if (!config.startAt || !config.endAt) {
      throw new Error('backfill mode requires START_AT and END_AT in Script Properties');
    }

    return {
      startAt: toIso_(config.startAt),
      endAt: toIso_(config.endAt),
      type: 'backfill',
    };
  }

  // incremental
  return {
    startAt: config.lastSyncAt ? toIso_(config.lastSyncAt) : '1970-01-01T00:00:00.000Z',
    endAt: nowIso,
    type: 'incremental',
  };
}

function collectShopifyRows_(config, startAtIso, endAtIso, existingEventIds) {
  const orders = fetchOrdersByUpdatedAt_(config.storeDomain, config.adminToken, startAtIso, endAtIso);
  const rows = [];
  const seenEventIds = new Set();

  orders.forEach((order) => {
    // order_created (sales => negative qty)
    if (isInWindow_(order.processed_at, startAtIso, endAtIso)) {
      (order.line_items || []).forEach((lineItem) => {
        const eventId = buildEventId_(order.id, lineItem.id, 'order_created', order.processed_at);
        if (shouldSkipEvent_(eventId, existingEventIds, seenEventIds)) return;

        rows.push(
          buildLedgerRow_({
            eventId,
            eventTime: order.processed_at,
            eventType: 'order_created',
            sku: lineItem.sku,
            qty: -Math.abs(Number(lineItem.quantity || 0)),
            refId: String(order.id),
            note: `shopify order ${order.name || order.id}`,
          }),
        );
        seenEventIds.add(eventId);
      });
    }

    // order_cancelled (cancel => positive qty)
    if (isInWindow_(order.cancelled_at, startAtIso, endAtIso)) {
      (order.line_items || []).forEach((lineItem) => {
        const eventId = buildEventId_(order.id, lineItem.id, 'order_cancelled', order.cancelled_at);
        if (shouldSkipEvent_(eventId, existingEventIds, seenEventIds)) return;

        rows.push(
          buildLedgerRow_({
            eventId,
            eventTime: order.cancelled_at,
            eventType: 'order_cancelled',
            sku: lineItem.sku,
            qty: Math.abs(Number(lineItem.quantity || 0)),
            refId: String(order.id),
            note: `shopify cancellation ${order.name || order.id}`,
          }),
        );
        seenEventIds.add(eventId);
      });
    }

    // refund (refund => positive qty)
    (order.refunds || []).forEach((refund) => {
      if (!isInWindow_(refund.created_at, startAtIso, endAtIso)) return;

      (refund.refund_line_items || []).forEach((refundLine) => {
        const lineItemId = refundLine.line_item_id;
        const eventId = buildEventId_(order.id, lineItemId, 'refund', refund.created_at);
        if (shouldSkipEvent_(eventId, existingEventIds, seenEventIds)) return;

        const sku = lookupSkuFromOrderLine_(order.line_items || [], lineItemId);

        rows.push(
          buildLedgerRow_({
            eventId,
            eventTime: refund.created_at,
            eventType: 'refund',
            sku,
            qty: Math.abs(Number(refundLine.quantity || 0)),
            refId: String(order.id),
            note: `shopify refund ${refund.id || ''}`.trim(),
          }),
        );
        seenEventIds.add(eventId);
      });
    });
  });

  return { ordersCount: orders.length, rows };
}

function buildLedgerRow_({ eventId, eventTime, eventType, sku, qty, refId, note }) {
  return [
    eventId,
    toIso_(eventTime),
    'shopify',
    eventType,
    sku || '',
    Number(qty || 0),
    '',
    'stockcrew_warehouse',
    refId,
    note || '',
  ];
}

function buildEventId_(orderId, lineItemId, eventType, processedAt) {
  return `shopify:${orderId}:${lineItemId}:${eventType}:${toIso_(processedAt)}`;
}

function shouldSkipEvent_(eventId, existingEventIds, seenEventIds) {
  return !eventId || existingEventIds.has(eventId) || seenEventIds.has(eventId);
}

function fetchOrdersByUpdatedAt_(storeDomain, adminToken, startAtIso, endAtIso) {
  const baseUrl = `https://${storeDomain}/admin/api/2024-07/orders.json`;
  const fields = [
    'id',
    'name',
    'processed_at',
    'updated_at',
    'cancelled_at',
    'line_items',
    'refunds',
  ].join(',');

  let url = `${baseUrl}?status=any&limit=250&order=updated_at+asc&updated_at_min=${encodeURIComponent(
    startAtIso,
  )}&updated_at_max=${encodeURIComponent(endAtIso)}&fields=${encodeURIComponent(fields)}`;

  const allOrders = [];
  while (url) {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json',
      },
    });

    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error(`Shopify API error ${code}: ${response.getContentText()}`);
    }

    const payload = JSON.parse(response.getContentText());
    const orders = payload.orders || [];
    allOrders.push.apply(allOrders, orders);

    const linkHeader = response.getHeaders()['Link'] || response.getHeaders()['link'];
    url = extractNextPageUrl_(linkHeader);
  }

  return allOrders;
}

function extractNextPageUrl_(linkHeader) {
  if (!linkHeader) return null;

  const links = String(linkHeader).split(',').map((part) => part.trim());
  for (let i = 0; i < links.length; i += 1) {
    const part = links[i];
    if (part.indexOf('rel="next"') === -1) continue;

    const match = part.match(/<([^>]+)>/);
    if (match && match[1]) return match[1];
  }

  return null;
}

function loadExistingEventIds_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const range = sheet.getRange(2, 1, lastRow - 1, 1);
  const values = range.getValues();
  const ids = new Set();

  values.forEach((row) => {
    const eventId = row[0];
    if (eventId) ids.add(String(eventId));
  });

  return ids;
}

function ensureSheetWithHeaders_(spreadsheet, sheetName, headers) {
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);

  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeader = headers.some((h, idx) => existing[idx] !== h);

  if (needsHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, LEDGER_HEADERS.length).setValues(rows);
}

function lookupSkuFromOrderLine_(lineItems, lineItemId) {
  const match = lineItems.find((li) => String(li.id) === String(lineItemId));
  return match ? match.sku || '' : '';
}

function mustGetProp_(props, key) {
  const value = props.getProperty(key);
  if (!value) throw new Error(`Missing Script Property: ${key}`);
  return value;
}

function toIso_(value) {
  if (!value) return '';
  return new Date(value).toISOString();
}

function isInWindow_(value, startAtIso, endAtIso) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return t >= new Date(startAtIso).getTime() && t <= new Date(endAtIso).getTime();
}
