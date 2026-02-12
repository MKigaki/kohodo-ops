# 04_FG_Ledger schema

## Event semantics

- `event_type=commit`
  - Shopify order created events are recorded as **committed inventory (引当)**.
  - This represents reservation only and **does not decrease physical stock**.
- `event_type=shipment`
  - Shopify fulfillment events are recorded as shipment.
  - Shipment is the source of truth for stock-out and `qty` must be negative.
  - Even if cancellation/refund exists, if shipment event exists, ledger keeps shipment as stock decrement event.

## Shipment event_id rule

To avoid duplicates for partial / split shipment at line-item level:

`event_id = "shopify:" + fulfillment_id + ":" + line_item_id + ":shipment:" + processed_at`

## Location defaults

- `from_location = stockcrew_warehouse`
- `to_location = customer`

## Staging / Apply flow

- New candidate events are written to `staging_04_FG_Ledger` as 「追加予定」.
- Only when script property `APPLY=true`, records are appended to `04_FG_Ledger`.
