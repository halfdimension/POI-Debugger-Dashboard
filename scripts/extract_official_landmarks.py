#!/usr/bin/env python3
"""Extract official navigation-landmark nodes from an OSM PBF into debugger CSV."""

from __future__ import annotations

import argparse
import csv
import math
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


CSV_FIELDS = (
    "new_node_id",
    "mappls_poi_id",
    "name",
    "landmark_type",
    "priority",
    "visible",
    "lat",
    "lon",
    "osm_source_type",
    "osm_source_id",
    "osm_amenity",
    "osm_tourism",
    "osm_shop",
    "osm_historic",
    "osm_leisure",
    "osm_railway",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Extract nodes tagged navigation_landmark=yes using the normalized "
            "CSV schema consumed by the POI debugger. Requires osmium-tool."
        )
    )
    parser.add_argument("input_pbf", type=Path)
    parser.add_argument("output_csv", type=Path)
    return parser.parse_args()


def valid_coordinate(lat_text: str, lon_text: str) -> bool:
    try:
        lat = float(lat_text)
        lon = float(lon_text)
    except (TypeError, ValueError):
        return False
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def main() -> int:
    args = parse_args()
    input_pbf = args.input_pbf.expanduser().resolve()
    output_csv = args.output_csv.expanduser().resolve()
    if not input_pbf.is_file():
        print(f"error: input PBF does not exist: {input_pbf}", file=sys.stderr)
        return 2

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    counters: Counter[str] = Counter()
    poi_ids: Counter[str] = Counter()
    node_ids: Counter[str] = Counter()

    command = [
        "osmium",
        "tags-filter",
        str(input_pbf),
        "n/navigation_landmark=yes",
        "-f",
        "osm",
    ]

    temporary_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=output_csv.parent,
            prefix=f".{output_csv.name}.",
            suffix=".tmp",
            delete=False,
        ) as output_handle, tempfile.TemporaryFile(mode="w+b") as error_handle:
            temporary_name = output_handle.name
            writer = csv.DictWriter(output_handle, fieldnames=CSV_FIELDS, lineterminator="\n")
            writer.writeheader()

            try:
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=error_handle)
            except FileNotFoundError:
                print("error: osmium-tool is required but 'osmium' was not found", file=sys.stderr)
                return 2

            assert process.stdout is not None
            try:
                for _, element in ET.iterparse(process.stdout, events=("end",)):
                    if element.tag != "node":
                        continue

                    tags = {
                        child.attrib.get("k", ""): child.attrib.get("v", "")
                        for child in element
                        if child.tag == "tag"
                    }
                    if tags.get("navigation_landmark") != "yes":
                        element.clear()
                        continue

                    counters["total_source_landmark_nodes"] += 1
                    node_id = element.attrib.get("id", "").strip()
                    poi_id = tags.get("poi_id", "").strip()
                    lat = element.attrib.get("lat", "").strip()
                    lon = element.attrib.get("lon", "").strip()
                    if node_id:
                        node_ids[node_id] += 1
                    else:
                        counters["missing_node_ids"] += 1
                    if poi_id:
                        poi_ids[poi_id] += 1
                    else:
                        counters["missing_poi_ids"] += 1

                    if not valid_coordinate(lat, lon):
                        counters["bad_or_missing_coordinates"] += 1
                        element.clear()
                        continue

                    name = tags.get("name", "")
                    landmark_type = tags.get("landmark_type", "")
                    if not name.strip():
                        counters["missing_names"] += 1
                    if not landmark_type.strip():
                        counters["missing_landmark_types"] += 1

                    writer.writerow(
                        {
                            "new_node_id": node_id,
                            "mappls_poi_id": poi_id,
                            "name": name,
                            "landmark_type": landmark_type,
                            "priority": tags.get("landmark_priority", ""),
                            "visible": tags.get("landmark_visible", ""),
                            "lat": lat,
                            "lon": lon,
                            "osm_source_type": "node",
                            "osm_source_id": node_id,
                            "osm_amenity": "",
                            "osm_tourism": "",
                            "osm_shop": "",
                            "osm_historic": "",
                            "osm_leisure": "",
                            "osm_railway": "",
                        }
                    )
                    counters["valid_pois"] += 1
                    element.clear()
            except ET.ParseError as exc:
                process.kill()
                process.wait()
                print(f"error: osmium produced invalid OSM XML: {exc}", file=sys.stderr)
                return 2

            return_code = process.wait()
            if return_code:
                error_handle.seek(0)
                detail = error_handle.read().decode("utf-8", errors="replace").strip()
                print(f"error: osmium exited with status {return_code}: {detail}", file=sys.stderr)
                return 2

        os.replace(temporary_name, output_csv)
        output_csv.chmod(0o644)
        temporary_name = ""
    finally:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)

    duplicate_poi_ids = sum(count - 1 for count in poi_ids.values() if count > 1)
    duplicate_node_ids = sum(count - 1 for count in node_ids.values() if count > 1)
    print(f"input_pbf: {input_pbf}")
    print(f"output_csv: {output_csv}")
    print(f"total_source_landmark_nodes: {counters['total_source_landmark_nodes']}")
    print(f"valid_pois: {counters['valid_pois']}")
    print(f"bad_or_missing_coordinates: {counters['bad_or_missing_coordinates']}")
    print(f"duplicate_poi_ids: {duplicate_poi_ids}")
    print(f"duplicate_node_ids: {duplicate_node_ids}")
    print(f"missing_poi_ids: {counters['missing_poi_ids']}")
    print(f"missing_node_ids: {counters['missing_node_ids']}")
    print(f"missing_names: {counters['missing_names']}")
    print(f"missing_landmark_types: {counters['missing_landmark_types']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
