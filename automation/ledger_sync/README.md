# ledger_sync (Shopify -> 04_FG_Ledger)

`automation/ledger_sync` は、Shopifyの注文イベントを Google Sheets の `04_FG_Ledger` に追記するための Apps Script 実装です。

初期版は Shopify のみ対応し、次を取り込みます。

- `order_created`
- `order_cancelled`
- `refund`

## 1. 事前準備

1. Google Spreadsheet を開く
2. Extensions > Apps Script を開く
3. `automation/ledger_sync/apps_script/Code.gs` の内容を貼り付けて保存
4. Script Properties を設定する

### Script Properties

必須:

- `SHOPIFY_STORE_DOMAIN` (例: `your-store.myshopify.com`)
- `SHOPIFY_ADMIN_TOKEN`

任意:

- `APPLY` (`true` / `false`) ※デフォルト dry-run のため `false` 推奨
- `MODE` (`incremental` / `backfill`) ※デフォルト `incremental`
- `START_AT` (`backfill` 時に必須)
- `END_AT` (`backfill` 時に必須)
- `LAST_SYNC_AT` (`incremental` の開始点)

## 2. シート構成

スクリプト実行時に次のシートを自動作成（存在しない場合）します。

- `04_FG_Ledger`（本番）
- `staging_04_FG_Ledger`（dry-run 出力先）

ヘッダは固定で次の順です。

`event_id, event_time, source, event_type, sku, qty, from_location, to_location, ref_id, note`

## 3. 実行方法

### dry-run（デフォルト）

- `APPLY=false` の状態で `runLedgerSync` を実行
- 追記候補は `staging_04_FG_Ledger` にのみ出力

### 本番追記（APPLY）

- `APPLY=true` に設定
- `runLedgerSync` を実行
- `04_FG_Ledger` にのみ追記（更新・削除はしない）

## 4. backfill / incremental

### incremental

- `MODE=incremental`
- `LAST_SYNC_AT` 以降〜現在までを取得
- 実行後に `LAST_SYNC_AT` を現在時刻へ更新

### backfill

- `MODE=backfill`
- `START_AT`, `END_AT` を ISO8601 で指定して実行

## 5. 重複防止

`event_id` は次の形式で生成されます。

`shopify:{order_id}:{line_item_id}:{event_type}:{processed_at}`

同一 `event_id` が `04_FG_Ledger` に存在する場合は追加しません。

## 6. トリガー設定

Apps Script の Triggers から `runLedgerSync` の時間主導トリガーを設定可能です。

推奨:

- 開始時は 1時間ごと
- 安定後は運用方針に合わせて短縮

## 7. 権限

初回実行時に以下権限の許可が必要です。

- Google Sheets への読み書き
- 外部通信（Shopify Admin API への `UrlFetchApp`）

## 8. 注意事項

- dry-run で差分確認後に APPLY 実行する運用を推奨
- APIトークンや実データはリポジトリにコミットしない
- 03a_Form_RM / StockCrew / Square / Amazon の連携は将来追加
