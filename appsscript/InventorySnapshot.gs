/**
 * Inventory snapshot builder for 04_FG_Ledger.
 *
 * Creates/updates:
 * - 05_FG_Inventory_Snapshot
 * - 05_FG_Inventory_Summary
 * - 05_FG_Exceptions
 *
 * Mapping data is synchronized from Google Drive CSV files when available:
 * - sku_master.csv -> 00_Config_SKU_Master
 * - location_map.csv -> 00_Config_Location_Map
 */
const FG_CONFIG = {
  ledgerSheet: '04_FG_Ledger',
  snapshotSheet: '05_FG_Inventory_Snapshot',
  summarySheet: '05_FG_Inventory_Summary',
  exceptionsSheet: '05_FG_Exceptions',
  skuMasterSheet: '00_Config_SKU_Master',
  locationMapSheet: '00_Config_Location_Map',
  defaultCommitLocation: 'stockcrew_warehouse',
  abnormalQtyThreshold: 1000000,
};

/**
 * Run this after sync04FGLedgerFromShopify().
 * This keeps staging/apply behavior intact while always refreshing snapshot views.
 */
function refreshInventorySnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const configSyncWarnings = syncConfigCsvToSheets_(ss);
  const skuMap = buildSkuMap_(ss);
  const locationMap = buildLocationMap_(ss);

  const ledgerSheet = ss.getSheetByName(FG_CONFIG.ledgerSheet);
  if (!ledgerSheet) {
    throw new Error(`Sheet not found: ${FG_CONFIG.ledgerSheet}`);
  }

  const values = ledgerSheet.getDataRange().getValues();
  if (values.length < 2) {
    writeSnapshot_(ss, []);
    writeSummary_(ss, []);
    writeExceptions_(ss, configSyncWarnings);
    return;
  }

  const headers = normalizeHeaders_(values[0]);
  const rows = values.slice(1);

  const inventoryBySkuLocation = new Map();
  const exceptions = [...configSyncWarnings];

  rows.forEach((row, idx) => {
    const rowNo = idx + 2;
    const eventType = String(readByAlias_(row, headers, ['event_type', 'type', 'event']) || '').toLowerCase().trim();
    if (!eventType) {
      return;
    }

    const rawSku = String(readByAlias_(row, headers, ['sku', 'item_sku', 'variant_sku']) || '').trim();
    const rawFromLocation = String(
      readByAlias_(row, headers, ['from_location', 'location', 'warehouse', 'source_location']) || ''
    ).trim();
    const rawQty = Number(readByAlias_(row, headers, ['qty', 'quantity', 'delta']) || 0);

    const mappedSku = mapSku_(rawSku, skuMap);
    const mappedFromLocation = mapLocation_(rawFromLocation, locationMap);
    const commitLocation = mapLocation_(FG_CONFIG.defaultCommitLocation, locationMap) || FG_CONFIG.defaultCommitLocation;

    if (!mappedSku) {
      exceptions.push(makeException_('UNMAPPED_SKU', rowNo, rawSku, rawFromLocation, eventType, 'SKU not found in mapping'));
      return;
    }

    if (Math.abs(rawQty) > FG_CONFIG.abnormalQtyThreshold) {
      exceptions.push(
        makeException_('ABNORMAL_QTY', rowNo, mappedSku, mappedFromLocation, eventType, `qty=${rawQty} exceeds threshold`)
      );
    }

    if (eventType === 'shipment') {
      const location = mappedFromLocation || commitLocation;
      if (!mappedFromLocation) {
        exceptions.push(
          makeException_('UNMAPPED_LOCATION', rowNo, mappedSku, rawFromLocation, eventType, 'Using default location for shipment')
        );
      }
      const delta = rawQty > 0 ? -rawQty : rawQty;
      applyInventoryDelta_(inventoryBySkuLocation, mappedSku, location, { onHand: delta, committed: 0 });
      return;
    }

    if (eventType === 'commit') {
      applyInventoryDelta_(inventoryBySkuLocation, mappedSku, commitLocation, { onHand: 0, committed: Math.abs(rawQty) });
      return;
    }

    if (eventType === 'cancel' || eventType === 'refund') {
      applyInventoryDelta_(inventoryBySkuLocation, mappedSku, commitLocation, { onHand: 0, committed: -Math.abs(rawQty) });
      return;
    }

    // Optional support for adjustment-like events.
    if (eventType === 'adjustment' || eventType === 'inventory_adjustment') {
      const location = mappedFromLocation || commitLocation;
      applyInventoryDelta_(inventoryBySkuLocation, mappedSku, location, { onHand: rawQty, committed: 0 });
    }
  });

  const snapshotRows = [...inventoryBySkuLocation.values()]
    .map((row) => {
      const available = row.on_hand - row.committed;
      if (row.on_hand < 0) {
        exceptions.push(
          makeException_('NEGATIVE_ON_HAND', '', row.sku, row.location, 'derived', `on_hand=${row.on_hand}`)
        );
      }
      if (available < 0) {
        exceptions.push(
          makeException_('NEGATIVE_AVAILABLE', '', row.sku, row.location, 'derived', `available=${available}`)
        );
      }
      return [row.sku, row.location, row.on_hand, row.committed, available];
    })
    .sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`));

  writeSnapshot_(ss, snapshotRows);
  writeSummary_(ss, snapshotRows);
  writeExceptions_(ss, exceptions);
}

/**
 * Wrapper helper if you want one-click execution.
 * Existing staging/apply behavior remains in sync04FGLedgerFromShopify().
 */
function sync04FGLedgerFromShopifyAndRefreshInventory() {
  if (typeof sync04FGLedgerFromShopify !== 'function') {
    throw new Error('sync04FGLedgerFromShopify() is not defined in this project.');
  }
  sync04FGLedgerFromShopify();
  refreshInventorySnapshot();
}

function syncConfigCsvToSheets_(ss) {
  const warnings = [];
  const syncTargets = [
    { fileName: 'sku_master.csv', sheetName: FG_CONFIG.skuMasterSheet },
    { fileName: 'location_map.csv', sheetName: FG_CONFIG.locationMapSheet },
  ];

  syncTargets.forEach((target) => {
    const file = findDriveFileByName_(target.fileName);
    if (!file) {
      warnings.push(makeException_('CONFIG_SYNC_WARNING', '', '', '', 'config', `${target.fileName} not found on Drive`));
      return;
    }

    const csvValues = Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8'));
    if (!csvValues.length) {
      warnings.push(makeException_('CONFIG_SYNC_WARNING', '', '', '', 'config', `${target.fileName} is empty`));
      return;
    }

    const sheet = getOrCreateSheet_(ss, target.sheetName);
    sheet.clearContents();
    sheet.getRange(1, 1, csvValues.length, csvValues[0].length).setValues(csvValues);
  });

  return warnings;
}

function findDriveFileByName_(fileName) {
  const files = DriveApp.getFilesByName(fileName);
  if (!files.hasNext()) {
    return null;
  }
  return files.next();
}

function buildSkuMap_(ss) {
  const sheet = ss.getSheetByName(FG_CONFIG.skuMasterSheet);
  if (!sheet) return new Map();

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return new Map();

  const headers = normalizeHeaders_(values[0]);
  const map = new Map();
  values.slice(1).forEach((row) => {
    const from = String(readByAlias_(row, headers, ['source_sku', 'sku', 'raw_sku']) || '').trim();
    const to = String(readByAlias_(row, headers, ['mapped_sku', 'normalized_sku', 'canonical_sku', 'sku']) || '').trim();
    if (from && to) {
      map.set(from, to);
    }
  });
  return map;
}

function buildLocationMap_(ss) {
  const sheet = ss.getSheetByName(FG_CONFIG.locationMapSheet);
  if (!sheet) return new Map();

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return new Map();

  const headers = normalizeHeaders_(values[0]);
  const map = new Map();
  values.slice(1).forEach((row) => {
    const from = String(readByAlias_(row, headers, ['source_location', 'location', 'raw_location']) || '').trim();
    const to = String(
      readByAlias_(row, headers, ['mapped_location', 'normalized_location', 'canonical_location', 'location']) || ''
    ).trim();
    if (from && to) {
      map.set(from, to);
    }
  });
  return map;
}

function mapSku_(rawSku, skuMap) {
  if (!rawSku) return '';
  return skuMap.get(rawSku) || rawSku;
}

function mapLocation_(rawLocation, locationMap) {
  if (!rawLocation) return '';
  return locationMap.get(rawLocation) || rawLocation;
}

function applyInventoryDelta_(inventoryBySkuLocation, sku, location, delta) {
  const key = `${sku}__${location}`;
  const current = inventoryBySkuLocation.get(key) || {
    sku,
    location,
    on_hand: 0,
    committed: 0,
  };

  current.on_hand += Number(delta.onHand || 0);
  current.committed += Number(delta.committed || 0);
  inventoryBySkuLocation.set(key, current);
}

function writeSnapshot_(ss, snapshotRows) {
  const sheet = getOrCreateSheet_(ss, FG_CONFIG.snapshotSheet);
  const header = [['sku', 'location', 'on_hand', 'committed', 'available']];
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header[0].length).setValues(header);

  if (snapshotRows.length) {
    sheet.getRange(2, 1, snapshotRows.length, snapshotRows[0].length).setValues(snapshotRows);
  }
}

function writeSummary_(ss, snapshotRows) {
  const totals = new Map();
  snapshotRows.forEach((row) => {
    const sku = row[0];
    const onHand = Number(row[2]);
    const committed = Number(row[3]);

    const current = totals.get(sku) || { sku, on_hand: 0, committed: 0 };
    current.on_hand += onHand;
    current.committed += committed;
    totals.set(sku, current);
  });

  const output = [...totals.values()]
    .map((v) => [v.sku, v.on_hand, v.committed, v.on_hand - v.committed])
    .sort((a, b) => `${a[0]}`.localeCompare(`${b[0]}`));

  const grand = output.reduce(
    (acc, row) => {
      acc.on_hand += Number(row[1]);
      acc.committed += Number(row[2]);
      return acc;
    },
    { on_hand: 0, committed: 0 }
  );

  const sheet = getOrCreateSheet_(ss, FG_CONFIG.summarySheet);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([['sku', 'on_hand_total', 'committed_total', 'available_total']]);

  if (output.length) {
    sheet.getRange(2, 1, output.length, 4).setValues(output);
  }

  const totalRow = [
    'ALL_SKU_TOTAL',
    grand.on_hand,
    grand.committed,
    grand.on_hand - grand.committed,
  ];
  sheet.getRange(output.length + 2, 1, 1, 4).setValues([totalRow]);
}

function writeExceptions_(ss, exceptions) {
  const sheet = getOrCreateSheet_(ss, FG_CONFIG.exceptionsSheet);
  const header = [['type', 'row_no', 'sku', 'location', 'event_type', 'message', 'created_at']];

  sheet.clearContents();
  sheet.getRange(1, 1, 1, header[0].length).setValues(header);

  if (!exceptions.length) return;
  const now = new Date();
  const rows = exceptions.map((e) => [e.type, e.row_no, e.sku, e.location, e.event_type, e.message, now]);
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function makeException_(type, rowNo, sku, location, eventType, message) {
  return {
    type,
    row_no: rowNo,
    sku,
    location,
    event_type: eventType,
    message,
  };
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function normalizeHeaders_(headerRow) {
  const headers = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (key) headers[key] = i;
  });
  return headers;
}

function readByAlias_(row, headerMap, aliases) {
  for (let i = 0; i < aliases.length; i += 1) {
    const idx = headerMap[aliases[i]];
    if (idx !== undefined) {
      return row[idx];
    }
  }
  return '';
}
