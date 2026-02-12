/**
 * 04_FG_Ledger sync job
 *
 * Required Script Properties:
 * - SHOPIFY_SHOP
 * - SHOPIFY_ACCESS_TOKEN
 * Optional Script Properties:
 * - APPLY=true to append to 04_FG_Ledger
 */

function sync04FGLedgerFromShopify() {
  const config = getConfig_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stagingSheet = getOrCreateSheet_(ss, 'staging_04_FG_Ledger');
  const ledgerSheet = getOrCreateSheet_(ss, '04_FG_Ledger');

  const existingEventIds = collectExistingEventIds_([stagingSheet, ledgerSheet]);

  const orders = fetchShopifyOrders_(config);
  const candidateEvents = buildLedgerEvents_(orders);

  const newEvents = candidateEvents.filter(function(event) {
    return !existingEventIds[event.event_id];
  });

  writeStagingEvents_(stagingSheet, newEvents);

  if (config.apply) {
    appendLedgerEvents_(ledgerSheet, newEvents);
  }

  Logger.log(
    '04_FG_Ledger sync done. orders=%s candidates=%s new=%s apply=%s',
    orders.length,
    candidateEvents.length,
    newEvents.length,
    config.apply
  );
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    shop: props.getProperty('SHOPIFY_SHOP'),
    token: props.getProperty('SHOPIFY_ACCESS_TOKEN'),
    apiVersion: props.getProperty('SHOPIFY_API_VERSION') || '2024-10',
    apply: String(props.getProperty('APPLY')).toLowerCase() === 'true'
  };
}

function fetchShopifyOrders_(config) {
  if (!config.shop || !config.token) {
    throw new Error('Missing Script Properties: SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN');
  }

  const params = {
    status: 'any',
    limit: 250,
    fields: [
      'id',
      'created_at',
      'cancelled_at',
      'line_items',
      'fulfillments'
    ].join(',')
  };

  const query = Object.keys(params)
    .map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    })
    .join('&');

  const url =
    'https://' +
    config.shop +
    '/admin/api/' +
    config.apiVersion +
    '/orders.json?' +
    query;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'X-Shopify-Access-Token': config.token
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() >= 300) {
    throw new Error('Shopify API error: ' + response.getContentText());
  }

  const body = JSON.parse(response.getContentText());
  return body.orders || [];
}

function buildLedgerEvents_(orders) {
  const events = [];

  orders.forEach(function(order) {
    buildCommitEvents_(order).forEach(function(event) {
      events.push(event);
    });
    buildShipmentEvents_(order).forEach(function(event) {
      events.push(event);
    });
  });

  return events;
}

function buildCommitEvents_(order) {
  const createdAt = order.created_at || new Date().toISOString();
  return (order.line_items || []).map(function(item) {
    const quantity = Number(item.quantity || 0);
    return {
      event_id: [
        'shopify',
        order.id,
        item.id,
        'commit',
        createdAt
      ].join(':'),
      event_type: 'commit',
      source_system: 'shopify',
      source_entity: 'order',
      source_id: String(order.id),
      source_line_id: String(item.id),
      sku: item.sku || '',
      qty: quantity,
      event_at: createdAt,
      ref_id: 'order:' + order.id,
      from_location: 'stockcrew_warehouse',
      to_location: 'committed',
      note: 'order_created as commit'
    };
  });
}

function buildShipmentEvents_(order) {
  const events = [];
  const fulfillments = order.fulfillments || [];

  fulfillments.forEach(function(fulfillment) {
    const processedAt =
      fulfillment.processed_at ||
      fulfillment.created_at ||
      new Date().toISOString();

    (fulfillment.line_items || []).forEach(function(item) {
      const qty = Number(item.quantity || 0);
      if (!qty) {
        return;
      }

      const trackingCompany = fulfillment.tracking_company || '';
      const trackingNumber =
        (fulfillment.tracking_numbers && fulfillment.tracking_numbers[0]) ||
        fulfillment.tracking_number ||
        '';
      const refIdParts = ['fulfillment:' + fulfillment.id];
      if (trackingCompany) {
        refIdParts.push('company:' + trackingCompany);
      }
      if (trackingNumber) {
        refIdParts.push('tracking:' + trackingNumber);
      }

      events.push({
        event_id: [
          'shopify',
          fulfillment.id,
          item.id,
          'shipment',
          processedAt
        ].join(':'),
        event_type: 'shipment',
        source_system: 'shopify',
        source_entity: 'fulfillment',
        source_id: String(fulfillment.id),
        source_line_id: String(item.id),
        sku: item.sku || '',
        qty: -Math.abs(qty),
        event_at: processedAt,
        ref_id: refIdParts.join('|'),
        from_location: 'stockcrew_warehouse',
        to_location: 'customer',
        note: 'shipment from Shopify fulfillment'
      });
    });
  });

  return events;
}

function collectExistingEventIds_(sheets) {
  const ids = {};
  sheets.forEach(function(sheet) {
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return;
    }

    const header = values[0];
    const eventIdIndex = header.indexOf('event_id');
    if (eventIdIndex < 0) {
      return;
    }

    for (let i = 1; i < values.length; i++) {
      const eventId = values[i][eventIdIndex];
      if (eventId) {
        ids[String(eventId)] = true;
      }
    }
  });

  return ids;
}

function writeStagingEvents_(sheet, events) {
  const header = ledgerHeader_();
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);

  if (!events.length) {
    return;
  }

  const rows = events.map(function(event) {
    const staged = Object.assign({}, event, {
      note: '[追加予定] ' + (event.note || '')
    });
    return eventToRow_(staged);
  });
  sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
}

function appendLedgerEvents_(sheet, events) {
  if (!events.length) {
    return;
  }

  ensureHeader_(sheet);
  const rows = events.map(eventToRow_);
  const startRow = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(startRow, 1, rows.length, ledgerHeader_().length).setValues(rows);
}

function ensureHeader_(sheet) {
  const header = ledgerHeader_();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    return;
  }

  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  if (current.join('|') !== header.join('|')) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ledgerHeader_() {
  return [
    'event_id',
    'event_type',
    'source_system',
    'source_entity',
    'source_id',
    'source_line_id',
    'sku',
    'qty',
    'event_at',
    'ref_id',
    'from_location',
    'to_location',
    'note'
  ];
}

function eventToRow_(event) {
  return ledgerHeader_().map(function(key) {
    return event[key] || '';
  });
}
