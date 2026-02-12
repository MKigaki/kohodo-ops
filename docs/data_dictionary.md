# 共通フォーマット（`data/normalized/snapshot_<date>.csv`）

| column | type | description |
|---|---|---|
| `sku` | string | 商品SKU |
| `location` | string | 在庫ロケーション（倉庫/店舗） |
| `on_hand` | number | 物理在庫数 |
| `available` | number | 引当可能在庫 |
| `committed` | number | 受注や予約などで確保済み数量 |
| `in_transit` | number | 移動中・入荷予定数量 |
| `source` | string | 取得元システム（`google_sheets`, `shopify`, `square`, `amazon`, `stockcrew`） |
| `as_of` | string (`YYYY-MM-DD`) | スナップショット基準日 |
