/* Data-driven site for GitHub Pages
 * - Loads docs/data/ww1-belgium.yaml
 * - Groups POIs by region
 * - Filters: search, region, type, theme, photos-only
 * - Fetches Wikipedia thumbnails + short summary (best-effort)
 * - Lets users star "favorites" (stored in localStorage)
 * - Builds a simple weekend plan + a Google Maps directions link from favorites
 */

const DATA_URL = "./data/ww1-belgium.yaml";

const els = {
  statusText: document.getElementById("statusText"),
  regionsContainer: document.getElementById("regionsContainer"),
  search: document.getElementById("search"),
  region: document.getElementById("region"),
  type: document.getElementById("type"),
  theme: document.getElementById("theme"),
  photosOnly: document.getElementById("photosOnly"),
  editDataLink: document.getElementById("editDataLink"),
  viewRepoLink: document.getElementById("viewRepoLink"),
};

function setStatus(msg){ els.statusText.textContent = msg; }

function normalize(str){
  return (str || "").toString().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function uniq(arr){
  return Array.from(new Set(arr.filter(Boolean)));
}

function escapeHtml(s){
  return (s || "").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function wikiTitleFromUrl(url){
  try{
    const u = new URL(url);
    const m = u.pathname.match(/\/wiki\/([^?#]+)/);
    if(!m) return null;
    return decodeURIComponent(m[1]).replace(/_/g, " ");
  }catch(e){
    return null;
  }
}

function wikiLangFromUrl(url){
  try{
    const u = new URL(url);
    // en.wikipedia.org / nl.wikipedia.org etc
    return (u.host.split(".")[0] || "en").toLowerCase();
  }catch(e){
    return "en";
  }
}

function mediaWikiApi(lang){
  return `https://${lang}.wikipedia.org/w/api.php`;
}

async function fetchJson(url){
  const res = await fetch(url, { headers: { "accept": "application/json" }});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function mwQuery(lang, params){
  const u = new URL(mediaWikiApi(lang));
  u.searchParams.set("origin", "*"); // CORS
  for(const [k,v] of Object.entries(params)){
    u.searchParams.set(k, String(v));
  }
  return fetchJson(u.toString());
}

/** MediaWiki pageimages + extract + wikidata id (pageprops wikibase_item) */
async function fetchMwSummary(lang, title){
  // Use MW API because it's more likely to return a thumbnail than REST summary for some pages.
  const data = await mwQuery(lang, {
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "pageimages|extracts|pageprops",
    pithumbsize: "700",
    pilicense: "any",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    redirects: "1",
    titles: title,
    ppprop: "wikibase_item",
  });

  const pages = data?.query?.pages || [];
  const page = pages[0];
  if(!page || page.missing) return null;

  return {
    title: page.title || title,
    extract: (page.extract || "").trim(),
    thumbnail: page.thumbnail?.source || null,
    pageUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent((page.title || title).replace(/ /g, "_"))}`,
    wikidata: page.pageprops?.wikibase_item || null,
    lang,
  };
}

/** Fetch Wikidata entity to get sitelinks + image (P18) */
async function fetchWikidataEntity(qid){
  if(!qid) return null;
  const u = new URL("https://www.wikidata.org/w/api.php");
  u.searchParams.set("origin", "*");
  u.searchParams.set("action", "wbgetentities");
  u.searchParams.set("format", "json");
  u.searchParams.set("props", "sitelinks|claims");
  u.searchParams.set("ids", qid);
  const data = await fetchJson(u.toString());
  return data?.entities?.[qid] || null;
}

function commonsFilePathUrl(filename, width=900){
  // Special:FilePath returns an image URL (may redirect) and supports ?width=
  // Filename must be without "File:" prefix, spaces allowed but encode it.
  const clean = filename.replace(/^File:/i, "");
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(clean)}?width=${width}`;
}

function poiSearchHaystack(poi, regionById){
  const r = regionById.get(poi.region_id);
  return normalize([
    poi.name,
    poi.type,
    poi.location?.locality,
    poi.location?.province,
    r?.name,
    r?.description,
    (poi.themes || []).join(" "),
    (poi.related?.battles || []).join(" "),
    poi.why_visit,
  ].filter(Boolean).join(" | "));
}

function groupByRegion(pois){
  const map = new Map();
  for(const p of pois){
    const arr = map.get(p.region_id) || [];
    arr.push(p);
    map.set(p.region_id, arr);
  }
  return map;
}

function badge(text){
  const span = document.createElement("span");
  span.className = "badge";
  span.textContent = text;
  return span;
}

/* -------- Favorites -------- */
const FAV_KEY = "ww1_poi_favorites_v1";
function loadFavs(){
  try{ return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); }
  catch{ return new Set(); }
}
function saveFavs(favs){
  localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(favs)));
}
let favs = loadFavs();

/* -------- Route planning -------- */
function haversineKm(a, b){
  if(!a || !b) return Infinity;
  const R = 6371;
  const toRad = (x)=> x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}

function nearestNeighborOrder(points){
  // points: [{id, coord:{lat,lon}, ...}]
  const remaining = points.slice();
  const ordered = [];
  if(remaining.length === 0) return ordered;
  // start with first (user selection order)
  ordered.push(remaining.shift());
  while(remaining.length){
    const last = ordered[ordered.length-1];
    let bestIdx = 0;
    let bestD = Infinity;
    for(let i=0;i<remaining.length;i++){
      const d = haversineKm(last.coord, remaining[i].coord);
      if(d < bestD){
        bestD = d; bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx,1)[0]);
  }
  return ordered;
}

function googleMapsDirectionsLink(coords){
  // Up to 10-ish waypoints; Google limits vary. We'll keep it modest.
  // Use api=1 with destination and waypoints.
  // Start = first, Destination = last, Waypoints = middle.
  if(coords.length < 2) return null;
  const fmt = (c)=> `${c.lat},${c.lon}`;
  const origin = fmt(coords[0]);
  const destination = fmt(coords[coords.length-1]);
  const waypoints = coords.slice(1,-1).map(fmt).join("|");
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", origin);
  u.searchParams.set("destination", destination);
  if(waypoints) u.searchParams.set("waypoints", waypoints);
  u.searchParams.set("travelmode", "driving");
  return u.toString();
}

function ensurePlannerPanel(){
  let panel = document.getElementById("plannerPanel");
  if(panel) return panel;

  panel = document.createElement("section");
  panel.id = "plannerPanel";
  panel.className = "status";
  panel.style.marginTop = "10px";

  panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <div>
        <div style="font-size:13px; color: var(--muted); margin-bottom:6px;">
          ⭐ Favorieten & weekendroute
        </div>
        <div class="small" id="plannerMeta">Selecteer locaties met de ster. Daarna kun je een compacte weekendroute laten voorstellen.</div>
      </div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btnPlan" class="btn">Maak weekendplan</button>
        <button id="btnClearFavs" class="btn btn-ghost">Wis favorieten</button>
      </div>
    </div>
    <div id="plannerOutput" style="margin-top:12px;"></div>
  `;

  // Minimal button styles (avoid extra file)
  const style = document.createElement("style");
  style.textContent = `
    .btn{
      background: rgba(122,162,255,.14);
      border: 1px solid rgba(122,162,255,.25);
      color: var(--text);
      padding: 9px 12px;
      border-radius: 12px;
      cursor:pointer;
      font-size: 12px;
    }
    .btn:hover{ border-color: rgba(122,162,255,.45); }
    .btn-ghost{
      background: rgba(255,255,255,.03);
      border-color: rgba(255,255,255,.10);
      color: var(--muted);
    }
    .favrow{ display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .plan{ border-top: 1px solid rgba(255,255,255,.08); padding-top: 10px; margin-top: 10px; }
    .plan h3{ margin: 0 0 6px; font-size: 13px; }
    .plan ul{ margin: 6px 0 0 18px; padding:0; }
    .plan li{ margin: 4px 0; }
    .pill{
      display:inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(155,255,199,.10);
      border: 1px solid rgba(155,255,199,.18);
      color: rgba(232,232,234,.95);
      font-size: 11px;
      margin-left: 8px;
    }
    .linkbtn{
      display:inline-block;
      margin-top: 8px;
      text-decoration:none;
      font-size:12px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.10);
      color: var(--text);
    }
    .linkbtn:hover{ border-color: rgba(122,162,255,.35); }
  `;
  document.head.appendChild(style);

  const main = document.querySelector("main.container");
  // insert after first status block (after the existing status section)
  const status = document.querySelector("section.status");
  status.insertAdjacentElement("afterend", panel);

  return panel;
}

/* -------- Photo + summary enrichment -------- */
const wikiCache = new Map(); // key: wikipediaUrl -> result
async function getBestWikipediaInfo(poi){
  const wikipediaUrl = poi.links?.wikipedia;
  if(!wikipediaUrl) return null;
  if(wikiCache.has(wikipediaUrl)) return wikiCache.get(wikipediaUrl);

  const title = wikiTitleFromUrl(wikipediaUrl);
  if(!title) return null;

  const lang = wikiLangFromUrl(wikipediaUrl);
  let info = await fetchMwSummary(lang, title);

  // If still no thumb: try other language via Wikidata sitelink, and/or Wikidata P18 image.
  let best = info;

  // prefer thumbnail if present
  const hasThumb = (x)=> !!(x && x.thumbnail);

  // Determine Wikidata QID (YAML or from MW)
  const qid = (poi.links?.wikidata) || (info?.wikidata) || null;

  // Try other language sitelink if no thumb
  if(!hasThumb(best) && qid){
    const ent = await fetchWikidataEntity(qid);
    const sitelinks = ent?.sitelinks || {};
    const otherLang = (lang === "nl") ? "en" : "nl";
    const key = otherLang + "wiki";
    const other = sitelinks[key];
    if(other?.title){
      const otherInfo = await fetchMwSummary(otherLang, other.title);
      if(hasThumb(otherInfo)) best = otherInfo;
    }

    // If still no thumb: try image (P18) from Wikidata
    if(!hasThumb(best)){
      const p18 = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if(p18){
        best = best || { title, extract: "", pageUrl: wikipediaUrl, wikidata: qid, lang };
        best.thumbnail = commonsFilePathUrl(p18, 900);
      }
    }

    // Prefer extract if missing
    if(best && (!best.extract || best.extract.length < 10)){
      const ex = ent?.descriptions?.[lang]?.value || ent?.descriptions?.en?.value || "";
      if(ex) best.extract = ex;
    }
  }

  // If MW query failed, try REST summary quickly as last resort
  if(!best){
    try{
      const host = new URL(wikipediaUrl).host;
      const apiBase = `https://${host}/api/rest_v1/page/summary/`;
      const endpoint = apiBase + encodeURIComponent(title);
      const j = await fetchJson(endpoint);
      best = {
        title: j.title || title,
        extract: j.extract || "",
        thumbnail: j.thumbnail?.source || null,
        pageUrl: j.content_urls?.desktop?.page || wikipediaUrl,
        wikidata: j.wikibase_item || qid || null,
        lang,
      };
    }catch{}
  }

  wikiCache.set(wikipediaUrl, best);
  return best;
}

/* -------- Rendering -------- */
function createStarButton(poiId){
  const btn = document.createElement("button");
  btn.className = "starbtn";
  btn.type = "button";
  btn.title = "Markeer als favoriet";
  btn.innerHTML = favs.has(poiId) ? "★" : "☆";
  btn.setAttribute("aria-label", "Favoriet");
  btn.addEventListener("click", (ev)=>{
    ev.preventDefault();
    ev.stopPropagation();
    if(favs.has(poiId)) favs.delete(poiId);
    else favs.add(poiId);
    saveFavs(favs);
    btn.innerHTML = favs.has(poiId) ? "★" : "☆";
    // refresh planner panel meta/output if it exists
    updatePlannerUI();
  });
  return btn;
}

function injectStarStylesOnce(){
  if(document.getElementById("starStyles")) return;
  const s = document.createElement("style");
  s.id = "starStyles";
  s.textContent = `
    .starbtn{
      position:absolute;
      top: 10px;
      right: 10px;
      width: 34px;
      height: 34px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(11,12,16,.55);
      color: rgba(232,232,234,.95);
      font-size: 18px;
      cursor:pointer;
      display:flex;
      align-items:center;
      justify-content:center;
      backdrop-filter: blur(6px);
    }
    .starbtn:hover{ border-color: rgba(155,255,199,.35); }
  `;
  document.head.appendChild(s);
}

function createCard(poi, regionById){
  const a = document.createElement("a");
  a.className = "card";
  a.href = poi.links?.wikipedia || "#";
  a.target = "_blank";
  a.rel = "noopener";

  // Star
  a.appendChild(createStarButton(poi.id));

  // Thumbnail
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const noimg = document.createElement("div");
  noimg.className = "noimg";
  noimg.textContent = "Foto laden…";
  thumb.appendChild(noimg);

  // Header row
  const row = document.createElement("div");
  row.className = "row";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = poi.name;

  const badges = document.createElement("div");
  badges.className = "badges";
  badges.appendChild(badge(poi.type));
  const locality = poi.location?.locality;
  if(locality) badges.appendChild(badge(locality));

  row.appendChild(title);
  row.appendChild(badges);

  const meta = document.createElement("div");
  meta.className = "meta";
  const prov = poi.location?.province ? `, ${poi.location.province}` : "";
  meta.textContent = `${poi.location?.locality || "—"}${prov}`;

  const summary = document.createElement("div");
  summary.className = "summary";
  summary.textContent = poi.why_visit || "";

  a.appendChild(thumb);
  a.appendChild(row);
  a.appendChild(meta);
  a.appendChild(summary);

  // Enrich from Wikipedia/Wikidata
  getBestWikipediaInfo(poi).then((info)=>{
    if(!info){
      noimg.textContent = "Geen foto beschikbaar";
      a.dataset.hasPhoto = "0";
      return;
    }
    if(info.pageUrl) a.href = info.pageUrl;

    if(info.thumbnail){
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = poi.name;
      img.src = info.thumbnail;
      thumb.innerHTML = "";
      thumb.appendChild(img);
      a.dataset.hasPhoto = "1";
    }else{
      noimg.textContent = "Geen foto beschikbaar";
      a.dataset.hasPhoto = "0";
    }

    // If YAML why_visit is short/empty, use extract
    if((poi.why_visit || "").length < 40 && info.extract){
      summary.textContent = info.extract;
    }
  });

  return a;
}

function getRepoInfo(){
  // Best-effort: infer owner/repo from GitHub Pages URL:
  // https://<owner>.github.io/<repo>/...
  const host = window.location.host;
  const path = window.location.pathname.split("/").filter(Boolean);
  const m = host.match(/^(.+)\.github\.io$/);
  if(!m) return null;
  const owner = m[1];
  const repo = path[0] || ""; // for project pages
  return { owner, repo };
}

function wireGitHubLinks(){
  const info = getRepoInfo();
  if(!info || !info.repo){
    els.editDataLink.href = "#";
    els.viewRepoLink.href = "#";
    els.editDataLink.textContent = "Bewerk data (repo-URL onbekend)";
    els.viewRepoLink.textContent = "Bekijk repo";
    return;
  }
  const { owner, repo } = info;
  const repoUrl = `https://github.com/${owner}/${repo}`;
  els.viewRepoLink.href = repoUrl;
  els.editDataLink.href = `${repoUrl}/edit/main/docs/data/ww1-belgium.yaml`;
}

/* Planner UI needs access to doc in memory */
let __DOC = null;

function coordsFromPoi(poi){
  const c = poi.location?.coordinates;
  if(c && typeof c.lat === "number" && typeof c.lon === "number") return {lat:c.lat, lon:c.lon};
  return null;
}

function updatePlannerUI(){
  if(!__DOC) return;
  const panel = ensurePlannerPanel();
  const meta = panel.querySelector("#plannerMeta");
  const out = panel.querySelector("#plannerOutput");

  const favList = (__DOC.pois || []).filter(p => favs.has(p.id));
  meta.textContent = favList.length
    ? `${favList.length} favoriet(en) geselecteerd.`
    : "Selecteer locaties met de ster. Daarna kun je een compacte weekendroute laten voorstellen.";

  // If no output exists yet, keep empty
  if(!out.dataset.hasPlan){
    out.innerHTML = favList.length ? renderFavListOnly(favList) : "";
  }
}

function renderFavListOnly(favList){
  const items = favList
    .map(p => `<li>${escapeHtml(p.name)} <span class="pill">${escapeHtml(p.region_id)}</span></li>`)
    .join("");
  return `
    <div class="small">Favorieten:</div>
    <ul>${items || ""}</ul>
  `;
}

function buildWeekendPlan(doc){
  const favList = (doc.pois || []).filter(p => favs.has(p.id));
  if(favList.length < 2){
    return { html: `<div class="small">Selecteer minstens 2 favorieten om een route te maken.</div>` };
  }

  // Only use POIs with coords for routing
  const withCoords = favList
    .map(p => ({ poi: p, coord: coordsFromPoi(p) }))
    .filter(x => x.coord);

  if(withCoords.length < 2){
    return { html: `<div class="small">Ik heb coördinaten nodig om een route te berekenen. Voeg in YAML bij je favorieten <code>location.coordinates</code> toe (lat/lon), of voeg favorieten toe die al coördinaten hebben.</div>` };
  }

  // Order by nearest-neighbor (start = first favorite with coords in favList order)
  const startId = withCoords[0].poi.id;
  const ordered = nearestNeighborOrder(withCoords.map(x=>({ id:x.poi.id, coord:x.coord, poi:x.poi })));

  // Split: Fri (1), Sat (up to 5), Sun (rest)
  const fri = ordered.slice(0, 1);
  const sat = ordered.slice(1, Math.min(6, ordered.length));
  const sun = ordered.slice(Math.min(6, ordered.length));

  const section = (label, arr) => `
    <div class="plan">
      <h3>${label} <span class="pill">${arr.length} stop(s)</span></h3>
      <ul>
        ${arr.map(x => `<li>${escapeHtml(x.poi.name)} <span class="pill">${escapeHtml(x.poi.location?.locality || "")}</span></li>`).join("")}
      </ul>
    </div>
  `;

  // Google Maps link for whole route (limit waypoints)
  const coords = ordered.slice(0, 10).map(x=>x.coord); // keep within typical waypoint limits
  const maps = googleMapsDirectionsLink(coords);

  const html = `
    <div class="small">
      Suggestie is gebaseerd op een simpele “dichtstbijzijnde volgende stop” aanpak (compact rijden, geen openingstijden).
      Tip: zet je vrijdagstop in de buurt van je overnachtingsplek en houd zondag lichter.
    </div>
    ${section("Vrijdag (aankomst)", fri)}
    ${section("Zaterdag (hoofddag)", sat)}
    ${section("Zondag (terugreis)", sun)}
    ${maps ? `<a class="linkbtn" href="${maps}" target="_blank" rel="noopener">Open route in Google Maps</a>` : ""}
    <div class="small" style="margin-top:8px;">
      Let op: Google Maps krijgt max ~10 punten mee in één link; bij meer favorieten pak je best per dag een aparte route.
    </div>
  `;

  return { html };
}

function buildSelect(selectEl, values, placeholder){
  // preserve first option
  const first = selectEl.querySelector("option");
  selectEl.innerHTML = "";
  if(first){
    selectEl.appendChild(first);
    first.textContent = placeholder;
    first.value = "";
  }else{
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    selectEl.appendChild(opt);
  }
  for(const v of values){
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  }
}

function render(doc, state){
  const regions = doc.regions || [];
  const pois = doc.pois || [];
  const regionById = new Map(regions.map(r => [r.id, r]));
  const grouped = groupByRegion(pois);

  // Apply filters
  const q = normalize(state.search || "");
  const regionFilter = state.region || "";
  const typeFilter = state.type || "";
  const themeFilter = state.theme || "";
  const photosOnly = !!state.photosOnly;

  let filteredPois = pois.filter(p => {
    if(regionFilter && p.region_id !== regionFilter) return false;
    if(typeFilter && (p.type || "") !== typeFilter) return false;
    if(themeFilter && !(p.themes || []).includes(themeFilter)) return false;
    if(q){
      const hay = poiSearchHaystack(p, regionById);
      if(!hay.includes(q)) return false;
    }
    return true;
  });

  // Render region sections
  els.regionsContainer.innerHTML = "";

  let shownRegions = 0;
  let shownCards = 0;

  for(const r of regions){
    const arr = (grouped.get(r.id) || []).filter(p => filteredPois.includes(p));
    if(arr.length === 0) continue;

    shownRegions++;

    // sort by type then name for stability
    arr.sort((a,b)=> (a.type||"").localeCompare(b.type||"") || (a.name||"").localeCompare(b.name||""));

    const section = document.createElement("section");
    section.className = "region";

    const header = document.createElement("div");
    header.className = "region-header";

    const left = document.createElement("div");
    const h = document.createElement("div");
    h.className = "region-title";
    h.textContent = r.name;

    const d = document.createElement("div");
    d.className = "region-desc";
    d.textContent = r.description || "";

    left.appendChild(h);
    left.appendChild(d);

    const right = document.createElement("div");
    right.className = "region-meta";
    const base = (r.base_towns || []).join(" · ");
    right.innerHTML = `${arr.length} locaties<br><span class="small">${escapeHtml(base)}</span>`;

    header.appendChild(left);
    header.appendChild(right);

    const grid = document.createElement("div");
    grid.className = "grid";

    for(const p of arr){
      const card = createCard(p, regionById);
      grid.appendChild(card);
      shownCards++;
    }

    section.appendChild(header);
    section.appendChild(grid);
    els.regionsContainer.appendChild(section);
  }

  setStatus(`Toont ${shownCards} locaties in ${shownRegions} regio’s.`);

  // Photos-only filter needs to wait for async thumbnails.
  if(photosOnly){
    setTimeout(()=>{
      const cards = Array.from(document.querySelectorAll(".card"));
      let visible = 0;
      for(const c of cards){
        const has = c.dataset.hasPhoto;
        if(has === "0") c.classList.add("hidden");
        else { c.classList.remove("hidden"); visible++; }
      }
      setStatus(`Toont ${visible} locaties (foto-filter). Thumbnails laden nog…`);
      setTimeout(()=>{
        const cards2 = Array.from(document.querySelectorAll(".card"));
        let visible2 = 0;
        for(const c of cards2){
          if(c.dataset.hasPhoto === "0") c.classList.add("hidden");
          else { c.classList.remove("hidden"); visible2++; }
        }
        setStatus(`Toont ${visible2} locaties met foto.`);
      }, 1500);
    }, 350);
  }else{
    Array.from(document.querySelectorAll(".card.hidden")).forEach(el=>el.classList.remove("hidden"));
  }

  updatePlannerUI();
}

async function fetchYaml(){
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if(!res.ok) throw new Error(`Cannot fetch YAML (${res.status})`);
  const text = await res.text();
  return jsyaml.load(text);
}

async function main(){
  wireGitHubLinks();
  injectStarStylesOnce();
  ensurePlannerPanel();
  setStatus("Laden van data…");

  let doc;
  try{
    doc = await fetchYaml();
    __DOC = doc;
  }catch(e){
    console.error(e);
    setStatus("Kon data niet laden. Controleer of docs/data/ww1-belgium.yaml bestaat en GitHub Pages correct staat.");
    return;
  }

  // Populate selects
  const regions = doc.regions || [];
  const pois = doc.pois || [];

  buildSelect(els.region, regions.map(r=>({id:r.id, name:r.name})).map(o=>o.id), "Alle regio’s");
  // show region names in dropdown
  for(const opt of Array.from(els.region.options)){
    const r = regions.find(x=>x.id===opt.value);
    if(r) opt.textContent = r.name;
  }

  buildSelect(els.type, uniq(pois.map(p=>p.type)).sort(), "Alle types");
  buildSelect(els.theme, uniq(pois.flatMap(p=>p.themes || [])).sort(), "Alle thema’s");

  const state = { search:"", region:"", type:"", theme:"", photosOnly:false };

  function rerender(){ render(doc, state); }

  // Wire controls
  els.search.addEventListener("input", (e)=>{ state.search = e.target.value; rerender(); });
  els.region.addEventListener("change", (e)=>{ state.region = e.target.value; rerender(); });
  els.type.addEventListener("change", (e)=>{ state.type = e.target.value; rerender(); });
  els.theme.addEventListener("change", (e)=>{ state.theme = e.target.value; rerender(); });
  els.photosOnly.addEventListener("change", (e)=>{ state.photosOnly = e.target.checked; rerender(); });

  // Planner buttons
  const panel = document.getElementById("plannerPanel");
  panel.querySelector("#btnClearFavs").addEventListener("click", ()=>{
    favs = new Set();
    saveFavs(favs);
    // update all stars
    document.querySelectorAll(".starbtn").forEach(b=> b.innerHTML = "☆");
    updatePlannerUI();
  });

  panel.querySelector("#btnPlan").addEventListener("click", ()=>{
    const out = panel.querySelector("#plannerOutput");
    const plan = buildWeekendPlan(doc);
    out.innerHTML = plan.html;
    out.dataset.hasPlan = "1";
  });

  rerender();
}

main();
