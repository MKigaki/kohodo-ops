from __future__ import annotations

import argparse
import csv
import json
from datetime import date
from pathlib import Path
from typing import Any, Dict, List

COMMON_COLUMNS = ["sku", "location", "on_hand", "available", "committed", "in_transit", "source", "as_of"]
SOURCES = ["google_sheets", "shopify", "square", "amazon", "stockcrew"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize raw snapshots into common format")
    parser.add_argument("--date", default=str(date.today()), help="snapshot date (YYYY-MM-DD)")
    return parser.parse_args()


def to_float(v: Any) -> float:
    try:
        if v is None or v == "":
            return 0.0
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def normalize_inventory_rows(source: str, as_of: str, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result = []
    for r in rows:
        result.append(
            {
                "sku": str(r.get("sku", "")).strip(),
                "location": str(r.get("location", "")).strip(),
                "on_hand": to_float(r.get("on_hand")),
                "available": to_float(r.get("available")),
                "committed": to_float(r.get("committed")),
                "in_transit": to_float(r.get("in_transit")),
                "source": source,
                "as_of": as_of,
            }
        )
    return result


def main() -> None:
    args = parse_args()
    normalized_rows: List[Dict[str, Any]] = []

    for source in SOURCES:
        raw_path = Path("data/raw") / source / f"{args.date}.json"
        if not raw_path.exists():
            print(f"[normalize] skip missing {raw_path}")
            continue

        with raw_path.open("r", encoding="utf-8") as f:
            payload = json.load(f)

        as_of = str(payload.get("as_of", args.date))
        inventory = payload.get("inventory", [])
        normalized_rows.extend(normalize_inventory_rows(source, as_of, inventory))

    output_dir = Path("data/normalized")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"snapshot_{args.date}.csv"

    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COMMON_COLUMNS)
        writer.writeheader()
        writer.writerows(normalized_rows)

    print(f"[normalize] wrote {output_path} ({len(normalized_rows)} rows)")


if __name__ == "__main__":
    main()
