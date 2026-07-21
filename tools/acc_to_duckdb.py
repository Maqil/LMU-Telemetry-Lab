#!/usr/bin/env python3
"""
CLI wrapper: convert an ACC MoTeC CSV export into a DuckDB file the
SIM Telemetry Lab backend can read.

The app's Import button does this automatically now (see backend acc_importer);
this CLI is handy for batch conversion.

In MoTeC: File > Export > CSV to produce the input .csv.

Usage:
    python tools/acc_to_duckdb.py INPUT.csv  [OUTPUT.duckdb]

Output defaults to data/<input-stem>.duckdb so it appears in the app's session list.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.services.acc_importer import convert_to_duckdb  # noqa: E402


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    output_dir = None if out else "data"
    result = convert_to_duckdb(src, output_dir=output_dir, output_path=out)
    print(f"Wrote {result}")
    print("Import it in the app just like an LMU .duckdb file.")


if __name__ == "__main__":
    main()
