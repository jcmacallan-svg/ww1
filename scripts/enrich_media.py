#!/usr/bin/env python3
"""
enrich_media.py
---------------
Enrich POIs in a Tripkit YAML with a usable image thumbnail URL (Wikimedia/Wikipedia).

Writes (best-effort):
  poi.media.image.thumb       Thumbnail URL (Wikimedia Special:FilePath?width=...)
  poi.media.image.page        Source page (Commons file page or Wikipedia page)
  poi.media.image.license     License short name (if available)
  poi.media.image.license_url License URL (if available)
  poi.media.image.credit      Credit/artist/user (if available)
  poi.media.image.source      "wikimedia"

Strategy:
  1) If links.wikidata exists: use Wikidata claim P18 (image filename) -> Commons thumbnail
  2) Else if links.wikipedia exists: query Wikipedia to get a thumbnail + (optionally) wikibase_item (QID)
  3) If we discover a QID from (2), try P18 again to prefer Commons images.

Notes:
  - For restaurants/bars without Wikipedia/Wikidata, this script will not add images (placeholder will be shown in the UI).
"""

from __future__ import annotations

import argparse
import re
import sys
from typing import Any, Dict, Optional, Tuple

import requests
import yaml

UA = "tripkit-enrich-media/1.0 (GitHub Actions; contact via repo)"

def load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}

def save_yaml(path: str, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(
            data,
            f,
            sort_keys=False,
            allow_unicode=True,
            width=110,
            default_flow_style=False,
        )

def wikipedia_lang_and_title(url: str) -> Optional[Tuple[str, str]]:
    if not url:
        return None
    m = re.match(r"^https?://([a-z\-]+)\.wikipedia\.org/wiki/(.+)$", url)
    if not m:
        return None
    lang = m.group(1)
    title = m.group(2).split("#")[0].replace("_", " ")
    return lang, title

def wikipedia_pageinfo(lang: str, title: str) -> Dict[str, Any]:
    u = f"https://{lang}.wikipedia.org/w/api.php"
    params = {
        "origin": "*",
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "prop": "pageimages|pageprops",
        "pithumbsize": "900",
        "pilicense": "any",
        "redirects": "1",
        "titles": title,
        "ppprop": "wikibase_item",
    }
    r = requests.get(u, params=params, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    pages = (((r.json() or {}).get("query") or {}).get("pages")) or []
    if not pages or pages[0].get("missing"):
        return {}
    page = pages[0]
    return {
        "thumbnail": (page.get("thumbnail") or {}).get("source"),
        "qid": (page.get("pageprops") or {}).get("wikibase_item"),
        "page_url": f"https://{lang}.wikipedia.org/wiki/{(page.get('title') or title).replace(' ', '_')}",
    }

def wikidata_entity(qid: str) -> Optional[Dict[str, Any]]:
    u = "https://www.wikidata.org/w/api.php"
    params = {
        "origin": "*",
        "action": "wbgetentities",
        "format": "json",
        "props": "claims|sitelinks",
        "ids": qid,
    }
    r = requests.get(u, params=params, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    return (r.json() or {}).get("entities", {}).get(qid)

def wikidata_p18_filename(ent: Dict[str, Any]) -> Optional[str]:
    try:
        claims = ent.get("claims") or {}
        p18 = claims.get("P18") or []
        if not p18:
            return None
        mainsnak = (p18[0].get("mainsnak") or {})
        datavalue = (mainsnak.get("datavalue") or {})
        value = datavalue.get("value")
        if isinstance(value, str) and value.strip():
            return value.strip()
    except Exception:
        return None
    return None

def commons_thumb_url(filename: str, width: int) -> str:
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{filename.replace(' ', '_')}?width={width}"

def commons_page_url(filename: str) -> str:
    return f"https://commons.wikimedia.org/wiki/File:{filename.replace(' ', '_')}"

def commons_imageinfo(filename: str) -> Dict[str, Optional[str]]:
    u = "https://commons.wikimedia.org/w/api.php"
    params = {
        "origin": "*",
        "action": "query",
        "format": "json",
        "prop": "imageinfo",
        "titles": f"File:{filename}",
        "iiprop": "extmetadata|user|url",
    }
    r = requests.get(u, params=params, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    data = r.json() or {}
    pages = (((data.get("query") or {}).get("pages")) or {})
    for _, page in pages.items():
        ii = page.get("imageinfo") or []
        if not ii:
            continue
        ext = ii[0].get("extmetadata") or {}

        def _v(k: str) -> Optional[str]:
            val = (ext.get(k) or {}).get("value")
            if isinstance(val, str):
                val = re.sub(r"<[^>]+>", "", val).strip()
                return val or None
            return None

        return {
            "license": _v("LicenseShortName") or _v("License"),
            "license_url": _v("LicenseUrl"),
            "credit": _v("Credit") or _v("Artist") or ii[0].get("user"),
        }
    return {}

def set_media(poi: Dict[str, Any], thumb: str, page: str, meta: Dict[str, Optional[str]]) -> bool:
    media = poi.get("media") or {}
    img = media.get("image") or {}
    changed = False

    if img.get("thumb") != thumb:
        img["thumb"] = thumb
        changed = True
    if page and img.get("page") != page:
        img["page"] = page
        changed = True

    if meta.get("license") and img.get("license") != meta.get("license"):
        img["license"] = meta.get("license")
        changed = True
    if meta.get("license_url") and img.get("license_url") != meta.get("license_url"):
        img["license_url"] = meta.get("license_url")
        changed = True
    if meta.get("credit") and img.get("credit") != meta.get("credit"):
        img["credit"] = meta.get("credit")
        changed = True

    if img.get("source") != "wikimedia":
        img["source"] = "wikimedia"
        changed = True

    media["image"] = img
    poi["media"] = media
    return changed

def enrich_poi(poi: Dict[str, Any], width: int, overwrite: bool) -> bool:
    existing = ((poi.get("media") or {}).get("image") or {}).get("thumb")
    if existing and not overwrite:
        return False

    links = poi.get("links") or {}
    qid = links.get("wikidata")
    wiki = links.get("wikipedia")

    # Try Wikipedia first to discover QID (and sometimes thumbnail).
    wiki_thumb = None
    wiki_qid = None
    wiki_page = None
    if wiki:
        lt = wikipedia_lang_and_title(wiki)
        if lt:
            lang, title = lt
            info = wikipedia_pageinfo(lang, title)
            wiki_thumb = info.get("thumbnail")
            wiki_qid = info.get("qid")
            wiki_page = info.get("page_url") or wiki

    # Prefer Wikidata P18 if we have QID
    best_qid = qid or wiki_qid
    if best_qid:
        ent = wikidata_entity(best_qid)
        if ent:
            p18 = wikidata_p18_filename(ent)
            if p18:
                thumb = commons_thumb_url(p18, width)
                page = commons_page_url(p18)
                meta = commons_imageinfo(p18)
                return set_media(poi, thumb, page, meta)

    # Fall back to Wikipedia-provided thumbnail
    if wiki_thumb:
        return set_media(poi, wiki_thumb, wiki_page or wiki, {})

    return False

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yaml", dest="yamls", action="append", required=True, help="YAML file to enrich (repeatable).")
    ap.add_argument("--width", type=int, default=900)
    ap.add_argument("--overwrite", action="store_true", help="Overwrite existing poi.media.image.thumb")
    args = ap.parse_args()

    any_changed = False
    for path in args.yamls:
        data = load_yaml(path)
        pois = data.get("pois") or []
        changed = 0
        for poi in pois:
            try:
                if enrich_poi(poi, width=args.width, overwrite=args.overwrite):
                    changed += 1
            except requests.RequestException as e:
                print(f"[warn] {path}: {poi.get('id')} request failed: {e}", file=sys.stderr)
            except Exception as e:
                print(f"[warn] {path}: {poi.get('id')} failed: {e}", file=sys.stderr)
        if changed:
            save_yaml(path, data)
            any_changed = True
        print(f"{path}: +{changed} images")
    return 0 if any_changed or True else 0

if __name__ == "__main__":
    raise SystemExit(main())
