/**
 * Square POS -> 04_FG_Ledger 同期
 *
 * Script Properties:
 * - SQUARE_ACCESS_TOKEN: Square personal access token
 * - SQUARE_LOCATION_ID: Square location ID
 * - APPLY: "true" の場合のみ本番 04_FG_Ledger に反映
 * - SQUARE_LAST_SYNC_AT: 増分同期の開始カーソル（ISO8601）
 * - INVENTORY_SPREADSHEET_ID: 対象スプレッドシートID（未指定時は active）
 */

var SQUARE_API_BASE_URL_ = 'https://connect.squareup.com/v2';
var SQUARE_EVENT_SOURCE_ = 'square';
var SQUARE_STAGING_SHEET_NAME_ = 'staging_04_FG_Ledger';
var SQUARE_LEDGER_SHEET_NAME_ = '04_FG_Ledger';
var SQUARE_SKU_MASTER_FILE_NAME_ = 'configs/sku_master.csv';

/**
 * 手動バックフィル用エントリポイント
 * @param {string} startAt ISO8601
 * @param {string=} endAt ISO8601
 */
function backfillSquareSalesToLedger(startAt, endAt) {
  return syncSquareSalesToLedger({
    startAt: startAt,
    endAt: endAt,
    apply: true,
    isBackfill: true,
  });
}

/**
 * Square売上を staging_04_FG_Ledger へ常時書き出し、APPLY=true のときのみ 04_FG_Ledger へ追記する。
 * @param {{startAt?: string, endAt?: string, apply?: boolean, isBackfill?: boolean}=} options
 */
function syncSquareSalesToLedger(options) {
  options = options || {};

  var props = PropertiesService.getScriptProperties();
  var accessToken = props.getProperty('SQUARE_ACCESS_TOKEN');
  var locationId = props.getProperty('SQUARE_LOCATION_ID');
  if (!accessToken || !locationId) {
    throw new Error('Missing Script Properties: SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID');
  }

  var apply = typeof options.apply === 'boolean'
    ? options.apply
    : String(props.getProperty('APPLY') || '').toLowerCase() === 'true';

  var nowIso = new Date().toISOString();
  var incrementalStart = props.getProperty('SQUARE_LAST_SYNC_AT');
  var defaultStart = incrementalStart || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  var startAt = options.startAt || defaultStart;
  var endAt = options.endAt || nowIso;

  var sheet = getInventorySpreadsheet_();
  var stagingSheet = getOrCreateSheet_(sheet, SQUARE_STAGING_SHEET_NAME_);
  var ledgerSheet = getOrCreateSheet_(sheet, SQUARE_LEDGER_SHEET_NAME_);

  var header = [
    'event_id',
    'event_type',
    'event_at',
    'sku',
    'qty',
    'from_location',
    'to_location',
    'ref_id',
    'source',
    'created_at',
  ];
  ensureHeader_(stagingSheet, header);
  ensureHeader_(ledgerSheet, header);

  var skuMap = loadSquareVariationIdToSkuMap_();
  var existingEventIds = readEventIds_(ledgerSheet);

  var lineItems = fetchSquareOrderLineItems_(accessToken, locationId, startAt, endAt);
  var rows = [];

  for (var i = 0; i < lineItems.length; i++) {
    var item = lineItems[i];
    if (!item.itemVariationId || !skuMap[item.itemVariationId]) {
      continue;
    }

    var qty = -Math.abs(Number(item.quantity || 0));
    if (!qty) {
      continue;
    }

    var eventId = [
      SQUARE_EVENT_SOURCE_,
      item.orderId,
      item.lineItemUid,
      'sale',
      item.createdAt,
    ].join(':');

    if (existingEventIds[eventId]) {
      continue;
    }

    rows.push([
      eventId,
      'sale',
      item.createdAt,
      skuMap[item.itemVariationId],
      qty,
      'square_store',
      'customer',
      item.orderId || item.paymentId || '',
      SQUARE_EVENT_SOURCE_,
      nowIso,
    ]);

    existingEventIds[eventId] = true;
  }

  if (rows.length > 0) {
    appendRows_(stagingSheet, rows);
    if (apply) {
      appendRows_(ledgerSheet, rows);
    }
  }

  props.setProperty('SQUARE_LAST_SYNC_AT', endAt);

  return {
    startAt: startAt,
    endAt: endAt,
    fetchedLineItems: lineItems.length,
    writtenRows: rows.length,
    apply: apply,
  };
}

/**
 * Square + Shopify 同期を行い、最後に 05_FG_Inventory_Snapshot を更新する。
 *
 * 既存の sync04FGLedgerFromShopifyAndRefreshInventory() はそのまま活かし、
 * ここでは Square 同期を前後に実行して取りこぼしを最小化する。
 */
function syncAllAndRefreshInventory() {
  var props = PropertiesService.getScriptProperties();
  var apply = String(props.getProperty('APPLY') || '').toLowerCase() === 'true';

  syncSquareSalesToLedger({ apply: apply });

  if (typeof sync04FGLedgerFromShopifyAndRefreshInventory === 'function') {
    sync04FGLedgerFromShopifyAndRefreshInventory();
  }

  syncSquareSalesToLedger({ apply: apply });

  if (typeof refreshInventorySnapshot === 'function') {
    refreshInventorySnapshot();
  }
}

function fetchSquareOrderLineItems_(accessToken, locationId, startAt, endAt) {
  var endpoint = SQUARE_API_BASE_URL_ + '/orders/search';
  var headers = {
    Authorization: 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Square-Version': '2024-08-21',
  };

  var cursor;
  var result = [];

  do {
    var body = {
      location_ids: [locationId],
      query: {
        filter: {
          date_time_filter: {
            created_at: {
              start_at: startAt,
              end_at: endAt,
            },
          },
          state_filter: {
            states: ['COMPLETED'],
          },
        },
        sort: {
          sort_field: 'CREATED_AT',
          sort_order: 'ASC',
        },
      },
      limit: 100,
    };

    if (cursor) {
      body.cursor = cursor;
    }

    var response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      headers: headers,
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    var status = response.getResponseCode();
    var text = response.getContentText();

    if (status >= 300) {
      throw new Error('Square Orders API error (' + status + '): ' + text);
    }

    var json = JSON.parse(text || '{}');
    var orders = json.orders || [];

    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      var lineItems = order.line_items || [];
      for (var j = 0; j < lineItems.length; j++) {
        var li = lineItems[j];
        result.push({
          orderId: order.id || '',
          paymentId: (order.tenders && order.tenders[0] && order.tenders[0].id) || '',
          lineItemUid: li.uid || String(j),
          itemVariationId: li.catalog_object_id || '',
          quantity: li.quantity || '0',
          createdAt: order.created_at || '',
        });
      }
    }

    cursor = json.cursor;
  } while (cursor);

  return result;
}

function loadSquareVariationIdToSkuMap_() {
  var csv = readSkuMasterCsv_();
  var rows = Utilities.parseCsv(csv);
  if (!rows.length) {
    throw new Error('configs/sku_master.csv is empty');
  }

  var header = rows[0];
  var variationIdx = header.indexOf('square_item_variation_id');
  var skuIdx = header.indexOf('kohodo_sku');
  if (variationIdx < 0 || skuIdx < 0) {
    throw new Error('configs/sku_master.csv must include columns: square_item_variation_id, kohodo_sku');
  }

  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var variationId = (r[variationIdx] || '').trim();
    var sku = (r[skuIdx] || '').trim();
    if (variationId && sku) {
      map[variationId] = sku;
    }
  }

  return map;
}

function readSkuMasterCsv_() {
  var props = PropertiesService.getScriptProperties();
  var inlineCsv = props.getProperty('SKU_MASTER_CSV');
  if (inlineCsv) {
    return inlineCsv;
  }

  var files = DriveApp.getFilesByName(SQUARE_SKU_MASTER_FILE_NAME_);
  if (!files.hasNext()) {
    throw new Error('Cannot find ' + SQUARE_SKU_MASTER_FILE_NAME_ + ' in Drive and SKU_MASTER_CSV property is empty');
  }

  return files.next().getBlob().getDataAsString('UTF-8');
}

function getInventorySpreadsheet_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('INVENTORY_SPREADSHEET_ID');
  return spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  return sheet || spreadsheet.insertSheet(name);
}

function ensureHeader_(sheet, header) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    return;
  }

  var current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  var matches = true;
  for (var i = 0; i < header.length; i++) {
    if (String(current[i] || '') !== header[i]) {
      matches = false;
      break;
    }
  }

  if (!matches) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function readEventIds_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return {};
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var map = {};
  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][0] || '').trim();
    if (id) {
      map[id] = true;
    }
  }

  return map;
}

function appendRows_(sheet, rows) {
  if (!rows || !rows.length) {
    return;
  }

  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}
