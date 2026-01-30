#!/usr/bin/env python3
"""Enrich POIs in a TripKit YAML file with practical.visit_duration_min/max.

Heuristics are intentionally simple (type + themes). This keeps your YAML usable
for scheduling without needing a separate database.

Usage:
  python scripts/enrich_durations.py --yaml data/berlin-trip.yaml
"""

import argparse
import re
from pathlib import Path

import yaml


THEME_TO_BUCKET = {
    # history / war context
    "ww1": "history-war",
    "ww2": "history-war",
    "cold-war": "history-war",
    "invasion-1914": "history-war",
    "fortress-warfare": "history-war",
    "trench-warfare": "history-war",
    "logistics": "history-war",
    "civilian-history": "history-war",

    # remembrance
    "remembrance": "remembrance",

    # culture
    "museum": "culture-art",
    "art": "culture-art",
    "modern-art": "culture-art",
    "architecture": "culture-art",
    "street-art": "culture-art",

    # outdoors
    "outdoors": "outdoors-walks",
    "naval-coastal": "outdoors-walks",
    "air-war": "outdoors-walks",

    # food / nightlife
    "food": "food-nightlife",
    "nightlife": "food-nightlife",
    "vibe": "food-nightlife",
    "cocktails": "food-nightlife",
}

TYPE_DEFAULTS = {
    "hotel": (0, 0),
    "food": (45, 105),
    "nightlife": (60, 150),
    "bar": (60, 150),
    "cafe": (45, 120),
    "restaurant": (60, 150),

    "memorial": (25, 60),
    "monument": (20, 45),
    "cemetery": (25, 60),

    "park": (45, 120),
    "site": (30, 90),
    "district": (45, 120),
    "landmark": (30, 90),
    "viewpoint": (30, 90),
    "town": (45, 120),
    "battlefield": (45, 120),
    "trench": (45, 120),

    "museum": (75, 180),
    "visitor-centre": (60, 150),
    "fort": (75, 180),
    "palace": (75, 180),
}


def parse_minutes_from_string(s: str):
    """Parse strings like '60–120 min', '45-90 min', '90 min', 'Half day'."""
    if not s:
        return None
    t = s.strip().lower()
    if t in {"—", "-", "n/a"}:
        return None
    if "half day" in t:
        return (180, 300)
    if "multi-day" in t:
        return (300, 420)

    nums = [int(x) for x in re.findall(r"\d+", t)]
    if len(nums) == 1:
        n = max(5, nums[0])
        return (n, n)
    if len(nums) >= 2:
        a, b = sorted(nums[:2])
        a = max(5, a)
        b = max(a, b)
        return (a, b)
    return None


def buckets_for(poi: dict):
    themes = [str(x).lower() for x in (poi.get("themes") or [])]
    b = set()
    typ = str(poi.get("type") or "").lower()

    if typ in {"food", "nightlife", "bar", "cafe", "restaurant"}:
        b.add("food-nightlife")
    if typ == "museum":
        b.add("culture-art")
    if typ in {"memorial", "cemetery", "monument"}:
        b.add("remembrance")
    if typ in {"park", "trench", "battlefield"}:
        b.add("outdoors-walks")

    for t in themes:
        if t in THEME_TO_BUCKET:
            b.add(THEME_TO_BUCKET[t])
        if any(k in t for k in ["ww1", "ww2", "cold", "battle", "front", "trench", "fortress", "invasion"]):
            b.add("history-war")
        if "remembr" in t:
            b.add("remembrance")
        if any(k in t for k in ["museum", "art", "architect", "gallery"]):
            b.add("culture-art")
        if any(k in t for k in ["park", "outdoor", "walk", "hike", "trail", "landscape"]):
            b.add("outdoors-walks")
        if any(k in t for k in ["food", "bar", "club", "cocktail", "night", "vibe", "restaurant"]):
            b.add("food-nightlife")

    if not b:
        b.add("history-war")
    return b


def default_duration(poi: dict):
    typ = str(poi.get("type") or "").lower()
    if typ in TYPE_DEFAULTS:
        return TYPE_DEFAULTS[typ]

    b = buckets_for(poi)
    if "food-nightlife" in b:
        return (60, 150)
    if "culture-art" in b:
        return (75, 180)
    if "outdoors-walks" in b:
        return (45, 120)
    if "remembrance" in b:
        return (25, 60)
    return (45, 120)


def enrich_file(path: Path) -> bool:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    changed = False

    for poi in data.get("pois", []) or []:
        practical = poi.setdefault("practical", {}) or {}
        if practical.get("visit_duration_min") is not None and practical.get("visit_duration_max") is not None:
            continue

        parsed = parse_minutes_from_string(str(practical.get("typical_visit_time") or ""))
        if parsed:
            mn, mx = parsed
        else:
            mn, mx = default_duration(poi)

        if mn == 0 and mx == 0:
            continue

        practical["visit_duration_min"] = int(mn)
        practical["visit_duration_max"] = int(mx)
        changed = True

    if changed:
        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yaml", required=True, help="Path to a TripKit YAML file")
    args = ap.parse_args()

    p = Path(args.yaml)
    if not p.exists():
        raise SystemExit(f"YAML not found: {p}")

    changed = enrich_file(p)
    print("UPDATED" if changed else "NO-CHANGES", p)


if __name__ == "__main__":
    main()
