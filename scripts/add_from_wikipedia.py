\
#!/usr/bin/env python3

"""
Add a POI stub to data/ww1-belgium.yaml from a Wikipedia URL.

Why: you said you want to extend the catalogue "by means of a Wikipedia page".

What it does (best-effort):
- MediaWiki API: gets title + short extract
- Tries to get coordinates (lat/lon) if present
- Tries to get Wikidata ID

Then it writes a new POI into the YAML under `pois`.

Limitations:
- Wikipedia pages vary a lot. Some don't have coordinates.
- "Official website" isn't reliably extractable without deeper parsing; keep it manual for now.
"""

import argparse
import re
from urllib.parse import urlparse, unquote

import requests
import yaml


WIKI_API = "https://en.wikipedia.org/w/api.php"


def wikipedia_title_from_url(url: str) -> str:
    p = urlparse(url)
    if "wikipedia.org" not in p.netloc:
        raise ValueError("URL does not look like a Wikipedia URL.")
    # /wiki/Title
    m = re.search(r"/wiki/([^?#]+)", p.path)
    if not m:
        raise ValueError("Could not extract /wiki/<title> from URL.")
    return unquote(m.group(1)).replace("_", " ")


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[’'`]", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "poi"


def mw_query(params: dict) -> dict:
    r = requests.get(WIKI_API, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_wikipedia_extract_and_props(title: str) -> dict:
    # Extract (summary) + pageprops (wikibase_item) + coordinates
    data = mw_query(
        {
            "action": "query",
            "format": "json",
            "formatversion": 2,
            "prop": "extracts|pageprops|coordinates",
            "exintro": 1,
            "explaintext": 1,
            "exsentences": 2,
            "titles": title,
            "redirects": 1,
            "ppprop": "wikibase_item",
            "colimit": 1,
        }
    )
    pages = data.get("query", {}).get("pages", [])
    if not pages or "missing" in pages[0]:
        raise ValueError(f"Wikipedia page not found for title: {title}")
    page = pages[0]

    extract = page.get("extract", "").strip()
    wikidata = page.get("pageprops", {}).get("wikibase_item")

    lat = lon = None
    coords = page.get("coordinates") or []
    if coords:
        lat = coords[0].get("lat")
        lon = coords[0].get("lon")

    return {"title": page.get("title", title), "extract": extract, "wikidata": wikidata, "lat": lat, "lon": lon}


def load_yaml(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def save_yaml(path: str, obj: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(obj, f, sort_keys=False, allow_unicode=True, width=100)


def region_exists(doc: dict, region_id: str) -> bool:
    return any(r.get("id") == region_id for r in doc.get("regions", []))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yaml", required=True, help="Path to data/ww1-belgium.yaml")
    ap.add_argument("--region", required=True, help="Region id (e.g. westhoek-ypres-salient)")
    ap.add_argument("--type", required=True, help="POI type (museum|memorial|cemetery|trench|fort|...)")
    ap.add_argument("--wikipedia", required=True, help="Wikipedia URL")
    ap.add_argument("--province", default="", help="Province (optional; helps search)")
    ap.add_argument("--locality", default="", help="City/village (optional; helps search)")
    args = ap.parse_args()

    doc = load_yaml(args.yaml)
    if not region_exists(doc, args.region):
        raise SystemExit(f"Region id not found in YAML: {args.region}")

    title = wikipedia_title_from_url(args.wikipedia)
    info = fetch_wikipedia_extract_and_props(title)

    poi_id = slugify(info["title"])

    # Avoid collisions
    existing_ids = {p.get("id") for p in doc.get("pois", [])}
    base_id = poi_id
    i = 2
    while poi_id in existing_ids:
        poi_id = f"{base_id}-{i}"
        i += 1

    poi = {
        "id": poi_id,
        "name": info["title"],
        "type": args.type,
        "region_id": args.region,
        "location": {
            "locality": args.locality or "",
            "province": args.province or "",
            "country": "Belgium",
        },
        "why_visit": info["extract"] or "TODO: add why this is worth visiting.",
        "themes": [],
        "related": {"battles": [], "years": []},
        "practical": {"typical_visit_time": "", "indoor_outdoor": "", "notes": ""},
        "links": {
            "official": "",
            "wikipedia": args.wikipedia,
            "wikidata": info["wikidata"] or "",
            "maps_query": f"{info['title']} Belgium",
        },
    }

    if info["lat"] is not None and info["lon"] is not None:
        poi["location"]["coordinates"] = {"lat": float(info["lat"]), "lon": float(info["lon"])}

    doc.setdefault("pois", []).append(poi)
    save_yaml(args.yaml, doc)

    print(f"Added POI: {poi_id}  ({info['title']})")
    print("Now edit the YAML to refine: locality/province, themes, visit time, official link, etc.")


if __name__ == "__main__":
    main()
