"""Optional reproducible benchmark; run explicitly because it creates 700k rows."""

from __future__ import annotations

import argparse
import csv
import json
import tempfile
import time
import tracemalloc
from pathlib import Path

from backend.app.poi_search import PoiSearchIndex


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=700_000)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "generated.csv"
        with source.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(("new_node_id", "mappls_poi_id", "name", "landmark_type", "priority", "visible", "lat", "lon", "osm_source_id"))
            for number in range(args.rows):
                writer.writerow((f"node-{number}", f"poi-{number}", f"Generated school {number}", "school" if number % 2 else "fuel", number % 101, "yes", 8 + (number % 2800) / 100, 68 + (number % 2900) / 100, f"osm-{number}"))

        index = PoiSearchIndex({"benchmark": {"poi_csv_path": str(source)}}, root / "index")
        tracemalloc.start()
        started = time.perf_counter()
        first = index.search("benchmark", q="school 699999", limit=100)
        build_seconds = time.perf_counter() - started
        _, peak = tracemalloc.get_traced_memory()
        measurements: dict[str, object] = {
            "rows": args.rows,
            "index_and_first_query_seconds": build_seconds,
            "python_peak_bytes": peak,
            "index_bytes": sum(path.stat().st_size for path in (root / "index").iterdir()),
            "first_response_bytes": len(json.dumps(first).encode("utf-8")),
        }
        for name, kwargs in (
            ("text_query", {"q": "school 699999"}),
            ("bbox_query", {"bbox": (76.9, 27.9, 77.3, 28.3)}),
            ("pagination_query", {"q": "generated school", "limit": 100}),
        ):
            started = time.perf_counter()
            result = index.search("benchmark", **kwargs)
            measurements[f"{name}_seconds"] = time.perf_counter() - started
            measurements[f"{name}_returned"] = result["returned"]
            measurements[f"{name}_response_bytes"] = len(json.dumps(result).encode("utf-8"))
        print(json.dumps(measurements, indent=2))


if __name__ == "__main__":
    main()
