#!/usr/bin/env python3
"""Validate the minimal review workflow structure."""
from pathlib import Path
import sys

required = ["findings", "tests"]
text = Path(sys.argv[1]).read_text(encoding="utf-8") if len(sys.argv) > 1 else ""
missing = [item for item in required if item not in text.lower()]
if missing:
    raise SystemExit("missing review sections: " + ", ".join(missing))
print("review checklist: valid")
