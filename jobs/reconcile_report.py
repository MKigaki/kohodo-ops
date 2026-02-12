from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Dict, Tuple

COMPARE_PAIRS = [("shopify", "stockcrew"), ("square", "shopify"), ("amazon", "shopify")]
METRICS = ["on_hand", "available", "committed", "in_transit"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create reconciliation report by source pairs")
    parser.add_argument("--date", default=str(date.today()), help="snapshot date (YYYY-MM-DD)")
    return parser.parse_args()


def to_float(v: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def main() -> None:
    args = parse_args()
    input_path = Path("data/normalized") / f"snapshot_{args.date}.csv"
    if not input_path.exists():
        raise FileNotFoundError(f"normalized snapshot not found: {input_path}")

    table: Dict[Tuple[str, str, str], Dict[str, float]] = defaultdict(dict)

    with input_path.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = (row["source"], row["sku"], row["location"])
            table[key] = {metric: to_float(row.get(metric, "0")) for metric in METRICS}

    rows = []
    for left, right in COMPARE_PAIRS:
        keys = {(sku, location) for src, sku, location in table.keys() if src in {left, right}}
        for sku, location in sorted(keys):
            left_vals = table.get((left, sku, location), {m: 0.0 for m in METRICS})
            right_vals = table.get((right, sku, location), {m: 0.0 for m in METRICS})
            for metric in METRICS:
                lv = left_vals.get(metric, 0.0)
                rv = right_vals.get(metric, 0.0)
                rows.append(
                    {
                        "as_of": args.date,
                        "comparison": f"{left}_vs_{right}",
                        "sku": sku,
                        "location": location,
                        "metric": metric,
                        "left_source": left,
                        "right_source": right,
                        "left_value": lv,
                        "right_value": rv,
                        "diff": lv - rv,
                    }
                )

    output_dir = Path("data/exports")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"reconcile_{args.date}.csv"

    fieldnames = [
        "as_of",
        "comparison",
        "sku",
        "location",
        "metric",
        "left_source",
        "right_source",
        "left_value",
        "right_value",
        "diff",
    ]

    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"[reconcile] wrote {output_path} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
