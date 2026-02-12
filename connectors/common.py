from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict


def load_mock_or_empty(source: str, env_key: str, as_of: str, default_mock_file: str = "") -> Dict[str, Any]:
    mock_file = os.getenv(env_key, "").strip() or default_mock_file
    if mock_file:
        path = Path(mock_file)
        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            data.setdefault("source", source)
            data.setdefault("as_of", as_of)
            return data

    return {
        "source": source,
        "as_of": as_of,
        "inventory": [],
        "orders": [],
        "allocations": [],
        "meta": {"mode": "empty-fallback"},
    }
