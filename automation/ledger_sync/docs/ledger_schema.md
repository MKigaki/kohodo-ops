# 04_FG_Ledger schema and event rules

このドキュメントは `04_FG_Ledger` の固定スキーマと、Shopify 同期時のイベント解釈ルールを定義します。

## Fixed header (required order)

`04_FG_Ledger` は必ず次の順でヘッダを持つこと。

1. `event_id`
2. `event_time`
3. `source`
4. `event_type`
5. `sku`
6. `qty`
7. `from_location`
8. `to_location`
9. `ref_id`
10. `note`

## Source scope (v1)

本実装の対象ソースは `shopify` のみ。

- 03a_Form_RM
- StockCrew
- Square
- Amazon

上記は将来対応（今回のスコープ外）。

## Event types (v1)

`shopify` 連携で取り込むイベントは以下の 3 種のみ。

- `order_created`
- `order_cancelled`
- `refund`

## Quantity sign rule

- 販売/注文 (`order_created`) は **マイナス**
- キャンセル/返金 (`order_cancelled`, `refund`) は **プラス**

## Location rule (v1)

初期実装ではロケーション詳細化前のため、次で固定。

- `to_location = stockcrew_warehouse`
- `from_location` は空欄

## Ref ID rule

- `ref_id` には Shopify の `order_id` を設定する

## De-duplication rule

重複防止キーとして `event_id` を次で構成する。

`shopify:{order_id}:{line_item_id}:{event_type}:{processed_at}`

- `event_id` が既に `04_FG_Ledger` に存在する場合、その行は追加しない
- 同じ処理内で同一 `event_id` が生成された場合も 1 件のみ採用

## Execution modes

- **dry-run (default)**: `staging_04_FG_Ledger` に追記候補を出力するだけ
- **apply mode**: `APPLY=true` のときだけ本番 `04_FG_Ledger` に追記

## Sync windows

- **incremental**: 前回同期時刻以降のみ取得
- **backfill**: 指定日付範囲 (`START_AT` / `END_AT`) を取得

日付は ISO8601 (`YYYY-MM-DDTHH:mm:ssZ`) を推奨。
