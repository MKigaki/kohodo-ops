from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

from connectors.amazon_sp_api import fetch_snapshot as fetch_amazon
from connectors.google_sheets import fetch_snapshot as fetch_google_sheets
from connectors.shopify import fetch_snapshot as fetch_shopify
from connectors.square import fetch_snapshot as fetch_square
from connectors.stockcrew import fetch_snapshot as fetch_stockcrew

CONNECTORS = {
    "google_sheets": fetch_google_sheets,
    "shopify": fetch_shopify,
    "square": fetch_square,
    "amazon": fetch_amazon,
    "stockcrew": fetch_stockcrew,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pull snapshots from all sources")
    parser.add_argument("--date", default=str(date.today()), help="snapshot date (YYYY-MM-DD)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    for source, fetcher in CONNECTORS.items():
        payload = fetcher(args.date)
        output_dir = Path("data/raw") / source
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{args.date}.json"
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"[pull] wrote {output_path}")


if __name__ == "__main__":
    main()
