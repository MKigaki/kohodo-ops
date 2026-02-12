from __future__ import annotations

from typing import Any, Dict

from connectors.common import load_mock_or_empty


def fetch_snapshot(as_of: str) -> Dict[str, Any]:
    """Fetch inventory/order/allocation snapshot from Square (read-only)."""
    return load_mock_or_empty("square", "SQUARE_MOCK_FILE", as_of, default_mock_file="data/samples/square_sample.json")
