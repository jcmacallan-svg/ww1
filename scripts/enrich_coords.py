#!/usr/bin/env python3
"""
Enrich POIs in YAML with coordinates (lat/lon) using Wikipedia / MediaWiki API.

Why:
- The web UI can suggest compact routes only when POIs have coordinates.
- You asked to have coordinates for *all* POIs.

What it does:
- For each POI with links.wikipedia, fetch:
  - canonical title (redirects handled)
  - coordinates (if present)
  - Wikidata QID (pageprops.wikibase_item) (optional)
- Writes back into YAML:
  - location.coordinates: {lat: <float>, lon: <float>}
  - links.wikidata: Q...
- Leaves existing coordinates untouched unless --overwrite is passed.

Usage:
  python -m pip install -r requirements.txt
  python scripts/enrich_coords.py --yaml data/ww1-belgium.yaml
  python scripts/enrich_coords.py --yaml docs/data/ww1-belgium.yaml

Optional:
  --overwrite   overwrite existing coordinates
"""

import argparse
import re
from urllib.parse import urlparse, unquote

import requests
import yaml

USER_AGENT = "ww1-tripkit/0.1 (coordinate enrichment)"
TIMEOUT = 30


def wiki_title_from_url(url: str) -> tuple[str, str]:
    """Return (lang, title) from a Wikipedia URL."""
    u = urlparse(url)
    host = (u.netloc or "").lower()
    lang = host.split(".")[0] if "wikipedia.org" in host else "en"
    m = re.search(r"/wiki/([^?#]+)", u.path)
    if not m:
        raise ValueError("Could not parse /wiki/<title> from wikipedia URL")
    title = unquote(m.group(1)).replace("_", " ")
    return lang, title


def mw_api(lang: str) -> str:
    return f"https://{lang}.wikipedia.org/w/api.php"


def mw_query(lang: str, params: dict) -> dict:
    params = dict(params)
    params["action"] = "query"
    params["format"] = "json"
    params["formatversion"] = 2
    params["origin"] = "*"
    r = requests.get(mw_api(lang), params=params, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def fetch_coords_and_qid(lang: str, title: str) -> dict | None:
    data = mw_query(
        lang,
        {
            "prop": "coordinates|pageprops",
            "redirects": 1,
            "titles": title,
            "colimit": 1,
            "ppprop": "wikibase_item",
        },
    )
    pages = data.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None

    page = pages[0]
    coords = page.get("coordinates") or []
    lat = lon = None
    if coords:
        lat = coords[0].get("lat")
        lon = coords[0].get("lon")

    qid = (page.get("pageprops") or {}).get("wikibase_item")

    return {"title": page.get("title") or title, "lat": lat, "lon": lon, "qid": qid}


def load_yaml(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def save_yaml(path: str, obj: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(obj, f, sort_keys=False, allow_unicode=True, width=110)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yaml", required=True, help="Path to YAML file (e.g. data/ww1-belgium.yaml)")
    ap.add_argument("--overwrite", action="store_true", help="Overwrite existing coordinates if present.")
    args = ap.parse_args()

    doc = load_yaml(args.yaml)
    pois = doc.get("pois", [])
    updated = 0
    no_coords = 0
    no_page = 0

    for p in pois:
        wiki = ((p.get("links") or {}).get("wikipedia") or "").strip()
        if not wiki:
            continue

        loc = p.setdefault("location", {})
        if not args.overwrite and isinstance(loc.get("coordinates"), dict):
            continue

        try:
            lang, title = wiki_title_from_url(wiki)
        except Exception:
            no_page += 1
            continue

        try:
            info = fetch_coords_and_qid(lang, title)
        except Exception:
            info = None

        if not info:
            no_page += 1
            continue

        if info["lat"] is None or info["lon"] is None:
            no_coords += 1
        else:
            loc["coordinates"] = {"lat": float(info["lat"]), "lon": float(info["lon"])}
            updated += 1

        links = p.setdefault("links", {})
        if info.get("qid") and not links.get("wikidata"):
            links["wikidata"] = info["qid"]

    save_yaml(args.yaml, doc)
    print(f"Done. Updated coords: {updated}. Pages missing: {no_page}. No coords on page: {no_coords}.")


if __name__ == "__main__":
    main()
