# WWI Belgium Tripkit (data-first)

This repo is a **data-first, GitHub-friendly** catalogue of **World War I points of interest in Belgium**.
It’s meant to be:
- **Simple** (one main YAML file)
- **Searchable** (easy to grep / filter / load in scripts)
- **Extensible** (add POIs quickly—ideally starting from a Wikipedia URL)

> Note: “all WWI sites” is effectively unbounded (thousands of cemeteries, memorials, small markers).
> This repo starts with **high-value / visitor-relevant** sites and provides a workflow to keep expanding.

## File structure

- `data/ww1-belgium.yaml` — regions + POIs
- `scripts/add_from_wikipedia.py` — add a stub POI from a Wikipedia URL (and enrich it a bit)
- `scripts/validate.py` — basic schema checks

## Data model (quick)

Each POI has:
- `region_id` (links to a region)
- `type` (museum / memorial / cemetery / trench / fort / …)
- `why_visit` (1–2 lines)
- `themes` (tags for filtering)
- `links` (official, wikipedia, wikidata, …)

## Quick start

### 1) Validate the YAML
```bash
python -m pip install pyyaml jsonschema
python scripts/validate.py data/ww1-belgium.yaml
```

### 2) Add a POI from Wikipedia
Example:
```bash
python -m pip install pyyaml requests
python scripts/add_from_wikipedia.py \
  --yaml data/ww1-belgium.yaml \
  --region westhoek-ypres-salient \
  --type museum \
  --wikipedia "https://en.wikipedia.org/wiki/Essex_Farm_Cemetery"
```

The script will:
- fetch the title + short extract via the MediaWiki API
- try to pull coordinates and Wikidata ID
- insert a new POI stub you can then refine (why_visit, themes, visit time, official site, etc.)

## Contributing

PRs welcome:
- add new POIs
- improve `why_visit` summaries
- add coordinates / Wikidata IDs
- add better region groupings

## License
Suggested:
- Code: **MIT**
- Data: **CC BY 4.0**

(You can of course choose one license for everything if you prefer.)

## GitHub Pages (optioneel: browsebare webgids)

Deze repo bevat een **statische webpagina** (geen build tools nodig) onder `docs/`:
- `docs/index.html`
- `docs/app.js`
- `docs/styles.css`
- `docs/data/ww1-belgium.yaml`

### Pages aanzetten
1. GitHub → **Settings** → **Pages**
2. **Build and deployment** → *Deploy from a branch*
3. Branch: **main**
4. Folder: **/docs**
5. Save

Na publicatie vind je de gids op je GitHub Pages URL.

### Data bewerken via browser
Iedereen met write-access kan direct in GitHub de YAML aanpassen via:
`docs/data/ww1-belgium.yaml` (of via de “Bewerk data op GitHub” link bovenaan de pagina).

Voor bijdragers zonder write-access: laat ze een PR openen.

## Enrich coordinates (lat/lon)

Voor routeplanning zijn coördinaten handig. Draai lokaal:

```bash
python -m pip install -r requirements.txt
python scripts/enrich_coords.py --yaml data/ww1-belgium.yaml
python scripts/enrich_coords.py --yaml docs/data/ww1-belgium.yaml
```

Of gebruik GitHub Actions:
**Actions → Enrich POI coordinates → Run workflow** (of wacht op de wekelijkse run).
