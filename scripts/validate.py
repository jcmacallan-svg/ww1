\
#!/usr/bin/env python3

"""
Very small validator for data/ww1-belgium.yaml.

Checks:
- required top-level keys exist
- region ids are unique
- poi ids are unique
- each poi.region_id exists
"""

import sys
import yaml


REQUIRED_TOP = ["version", "country", "topic", "regions", "pois"]


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main(path: str) -> None:
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    for k in REQUIRED_TOP:
        if k not in doc:
            die(f"Missing top-level key: {k}")

    regions = doc.get("regions", [])
    pois = doc.get("pois", [])

    region_ids = [r.get("id") for r in regions]
    if None in region_ids or "" in region_ids:
        die("One or more regions missing id.")
    if len(set(region_ids)) != len(region_ids):
        die("Duplicate region id found.")

    poi_ids = [p.get("id") for p in pois]
    if None in poi_ids or "" in poi_ids:
        die("One or more POIs missing id.")
    if len(set(poi_ids)) != len(poi_ids):
        die("Duplicate POI id found.")

    region_set = set(region_ids)
    for p in pois:
        rid = p.get("region_id")
        if rid not in region_set:
            die(f"POI {p.get('id')} refers to unknown region_id: {rid}")

    print("OK: basic validation passed.")
    print(f"Regions: {len(regions)} | POIs: {len(pois)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        die("Usage: python scripts/validate.py data/ww1-belgium.yaml")
    main(sys.argv[1])
