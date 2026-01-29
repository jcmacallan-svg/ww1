#!/usr/bin/env python3
"""
Merge a POI snippet into an existing Tripkit dataset YAML (Berlin).

- Adds new POIs if missing (by id)
- Updates existing POIs by deep-merging fields
- Forces Klunkerkranich to be type=food and include themes food/cocktails/vibe
- Writes back to both data/ and docs/data copies if provided
"""
from __future__ import annotations
import argparse, copy, sys
from pathlib import Path
import yaml

def deep_merge(dst, src):
    for k, v in (src or {}).items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst

def load_yaml(p: Path):
    return yaml.safe_load(p.read_text(encoding="utf-8"))

def dump_yaml(obj, p: Path):
    p.write_text(yaml.safe_dump(obj, sort_keys=False, allow_unicode=True), encoding="utf-8")

def ensure_list(doc, key):
    if key not in doc or doc[key] is None:
        doc[key] = []
    if not isinstance(doc[key], list):
        raise SystemExit(f"{key} must be a list in {doc}")
    return doc[key]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="Path to berlin-trip.yaml (e.g., data/berlin-trip.yaml)")
    ap.add_argument("--snippet", required=True, help="Path to snippet yaml (e.g., data/berlin-food-bars-snippet.yaml)")
    args = ap.parse_args()

    target = Path(args.target)
    snippet = Path(args.snippet)
    if not target.exists():
        raise SystemExit(f"Target not found: {target}")
    if not snippet.exists():
        raise SystemExit(f"Snippet not found: {snippet}")

    doc = load_yaml(target)
    sn = load_yaml(snippet)
    new_pois = sn.get("pois", [])
    if not isinstance(new_pois, list):
        raise SystemExit("Snippet must contain pois: [ ... ]")

    pois = ensure_list(doc, "pois")
    by_id = {p.get("id"): p for p in pois if isinstance(p, dict) and p.get("id")}

    added = 0
    updated = 0

    for p in new_pois:
        pid = p.get("id")
        if not pid:
            continue
        if pid in by_id:
            deep_merge(by_id[pid], p)
            updated += 1
        else:
            pois.append(copy.deepcopy(p))
            by_id[pid] = pois[-1]
            added += 1

    # enforce Klunkerkranich normalization if present
    kid = "klunkerkranich"
    if kid in by_id:
        kp = by_id[kid]
        kp["type"] = "food"
        kp.setdefault("themes", [])
        if isinstance(kp["themes"], list):
            for t in ["food", "cocktails", "vibe", "nightlife"]:
                if t not in kp["themes"]:
                    kp["themes"].append(t)

    dump_yaml(doc, target)
    print(f"OK: {target} (added {added}, updated {updated})")

if __name__ == "__main__":
    main()
