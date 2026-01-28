/* Tripkit (GitHub Pages)
 * - Data-driven: load YAML dataset
 * - Two datasets via tabs: WW1 + Berlin
 * - Filters: search / region / type / theme / photos-only
 * - Wikipedia/Wikidata enrichment: thumbnail + short extract
 * - Favorites ⭐ stored per-dataset in localStorage
 * - Simple weekend plan + Google Maps directions link from favorites (needs coordinates)
 */

const DATASETS = {
  ww1: { label: "WO1 Tripkit", url: "./data/ww1-belgium.yaml" },
  berlin: { label: "Berlijn Tripkit", url: "./data/berlin-trip.yaml" },
};

let currentDataset = "ww1";
let __DOC = null;
let __STATE = { search:"", region:"", type:"", theme:"", photosOnly:false };

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

function setStatus(msg){ if(els.statusText) els.statusText.textContent = msg; }

function normalize(str){
  return (str || "").toString().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
function uniq(arr){ return Array.from(new Set(arr.filter(Boolean))); }
function escapeHtml(s){
  return (s || "").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ---------------- GitHub links ---------------- */
function getRepoInfo(){
  const host = window.location.host;
  const path = window.location.pathname.split("/").filter(Boolean);
  const m = host.match(/^(.+)\.github\.io$/);
  if(!m) return null;
  const owner = m[1];
  const repo = path[0] || "";
  return { owner, repo };
}
function wireGitHubLinks(){
  const info = getRepoInfo();
  if(!info || !info.repo){
    if(els.editDataLink) els.editDataLink.href = "#";
    if(els.viewRepoLink) els.viewRepoLink.href = "#";
    return;
  }
  const repoUrl = `https://github.com/${info.owner}/${info.repo}`;
  if(els.viewRepoLink) els.viewRepoLink.href = repoUrl;
  // default to WW1 YAML; we’ll update on dataset switch too
  updateEditLink();
}
function updateEditLink(){
  const info = getRepoInfo();
  if(!info || !info.repo || !els.editDataLink) return;
  const repoUrl = `https://github.com/${info.owner}/${info.repo}`;
  const file = (currentDataset === "berlin") ? "docs/data/berlin-trip.yaml" : "docs/data/ww1-belgium.yaml";
  els.editDataLink.href = `${repoUrl}/edit/main/${file}`;
}

/* ---------------- Favorites (per dataset) ---------------- */
function favKey(ds){ return `tripkit_favorites_${ds}_v1`; }
function loadFavs(ds){
  try{ return new Set(JSON.parse(localStorage.getItem(favKey(ds)) || "[]")); }
  catch{ return new Set(); }
}
function saveFavs(ds, favs){
  localStorage.setItem(favKey(ds), JSON.stringify(Array.from(favs)));
}
let favs = loadFavs(currentDataset);

/* ---------------- Wikipedia/Wikidata enrichment ---------------- */
function wikiTitleFromUrl(url){
  try{
    const u = new URL(url);
    const m = u.pathname.match(/\/wiki\/([^?#]+)/);
    if(!m) return null;
    return decodeURIComponent(m[1]).replace(/_/g, " ");
  }catch{ return null; }
}
function wikiLangFromUrl(url){
  try{
    const u = new URL(url);
    return (u.host.split(".")[0] || "en").toLowerCase();
  }catch{ return "en"; }
}
function mediaWikiApi(lang){ return `https://${lang}.wikipedia.org/w/api.php`; }
async function fetchJson(url){
  const res = await fetch(url, { headers: { "accept": "application/json" }});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function mwQuery(lang, params){
  const u = new URL(mediaWikiApi(lang));
  u.searchParams.set("origin", "*");
  for(const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return fetchJson(u.toString());
}
async function fetchMwSummary(lang, title){
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
  const page = (data?.query?.pages || [])[0];
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
  const clean = filename.replace(/^File:/i, "");
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(clean)}?width=${width}`;
}

const wikiCache = new Map();
async function getBestWikipediaInfo(poi){
  const wikipediaUrl = poi.links?.wikipedia;
  if(!wikipediaUrl) return null;
  if(wikiCache.has(wikipediaUrl)) return wikiCache.get(wikipediaUrl);

  const title = wikiTitleFromUrl(wikipediaUrl);
  if(!title) return null;

  const lang = wikiLangFromUrl(wikipediaUrl);
  let best = null;
  try{ best = await fetchMwSummary(lang, title); }catch{}

  const hasThumb = (x)=> !!(x && x.thumbnail);
  const qid = poi.links?.wikidata || best?.wikidata || null;

  if(!hasThumb(best) && qid){
    try{
      const ent = await fetchWikidataEntity(qid);
      const sitelinks = ent?.sitelinks || {};
      const otherLang = (lang === "nl") ? "en" : "nl";
      const other = sitelinks[otherLang + "wiki"];
      if(other?.title){
        const otherInfo = await fetchMwSummary(otherLang, other.title);
        if(hasThumb(otherInfo)) best = otherInfo;
      }
      if(!hasThumb(best)){
        const p18 = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if(p18){
          best = best || { title, extract: "", pageUrl: wikipediaUrl, wikidata: qid, lang };
          best.thumbnail = commonsFilePathUrl(p18, 900);
        }
      }
    }catch{}
  }

  wikiCache.set(wikipediaUrl, best);
  return best;
}

/* ---------------- Routing ---------------- */

function getOriginCoord(doc){
  const c = doc?.settings?.default_origin?.coordinates;
  if(c && typeof c.lat === "number" && typeof c.lon === "number") return {lat:c.lat, lon:c.lon};
  return null;
}

function coordsFromPoi(p){
  const c = p.location?.coordinates;
  if(c && typeof c.lat === "number" && typeof c.lon === "number") return {lat:c.lat, lon:c.lon};
  return null;
}
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
  const remaining = points.slice();
  const ordered = [];
  if(!remaining.length) return ordered;
  ordered.push(remaining.shift());
  while(remaining.length){
    const last = ordered[ordered.length-1];
    let bestIdx = 0, bestD = Infinity;
    for(let i=0;i<remaining.length;i++){
      const d = haversineKm(last.coord, remaining[i].coord);
      if(d < bestD){ bestD = d; bestIdx = i; }
    }
    ordered.push(remaining.splice(bestIdx,1)[0]);
  }
  return ordered;
}
function googleMapsDirectionsLink(coords, originOverride=null){
  if(coords.length < 2) return null;
  const fmt = (c)=> `${c.lat},${c.lon}`;
  const origin = originOverride ? fmt(originOverride) : fmt(coords[0]);
  const destination = fmt(coords[coords.length-1]);
  const waypoints = coords.slice(1,-1).map(fmt).join("|");
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api","1");
  u.searchParams.set("origin", origin);
  u.searchParams.set("destination", destination);
  if(waypoints) u.searchParams.set("waypoints", waypoints);
  u.searchParams.set("travelmode","driving");
  return u.toString();
}

/* ---------------- Planner panel ---------------- */
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
        <div style="font-size:13px; color: var(--muted); margin-bottom:6px;">⭐ Favorieten & weekendroute</div>
        <div class="small" id="plannerMeta">Selecteer locaties met de ster. Daarna kun je een compacte weekendroute laten voorstellen.</div>
      </div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btnPlan" class="btn">Maak weekendplan</button>
        <button id="btnClearFavs" class="btn btn-ghost">Wis favorieten</button>
      </div>
    </div>
    <div id="plannerOutput" style="margin-top:12px;"></div>
  `;
  const style = document.createElement("style");
  style.textContent = `
    .btn{ background: rgba(122,162,255,.14); border:1px solid rgba(122,162,255,.25); color:var(--text);
      padding:9px 12px; border-radius:12px; cursor:pointer; font-size:12px; }
    .btn:hover{ border-color: rgba(122,162,255,.45); }
    .btn-ghost{ background: rgba(255,255,255,.03); border-color: rgba(255,255,255,.10); color:var(--muted); }
    .plan{ border-top:1px solid rgba(255,255,255,.08); padding-top:10px; margin-top:10px; }
    .plan h3{ margin:0 0 6px; font-size:13px; }
    .plan ul{ margin:6px 0 0 18px; padding:0; }
    .plan li{ margin:4px 0; }
    .pill{ display:inline-block; padding:2px 8px; border-radius:999px; background:rgba(155,255,199,.10);
      border:1px solid rgba(155,255,199,.18); color:rgba(232,232,234,.95); font-size:11px; margin-left:8px; }
    .linkbtn{ display:inline-block; margin-top:8px; text-decoration:none; font-size:12px; padding:8px 10px;
      border-radius:12px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.10); color:var(--text); }
    .linkbtn:hover{ border-color: rgba(122,162,255,.35); }
  `;
  document.head.appendChild(style);

  const status = document.querySelector("section.status");
  status?.insertAdjacentElement("afterend", panel);
  return panel;
}
function injectStarStylesOnce(){
  if(document.getElementById("starStyles")) return;
  const s = document.createElement("style");
  s.id = "starStyles";
  s.textContent = `
    .starbtn{
      position:absolute; top:10px; right:10px; width:34px; height:34px;
      border-radius:12px; border:1px solid rgba(255,255,255,.12);
      background: rgba(11,12,16,.55); color: rgba(232,232,234,.95);
      font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center;
      backdrop-filter: blur(6px);
    }
    .starbtn:hover{ border-color: rgba(155,255,199,.35); }
  `;
  document.head.appendChild(s);
}
function updatePlannerUI(){
  const panel = document.getElementById("plannerPanel");
  if(!panel || !__DOC) return;
  const meta = panel.querySelector("#plannerMeta");
  const out = panel.querySelector("#plannerOutput");
  const favList = (__DOC.pois || []).filter(p => favs.has(p.id));
  if(meta){
    meta.textContent = favList.length ? `${favList.length} favoriet(en) geselecteerd.` :
      "Selecteer locaties met de ster. Daarna kun je een compacte weekendroute laten voorstellen.";
  }
  if(out && !out.dataset.hasPlan){
    out.innerHTML = favList.length ? `<div class="small">Favorieten:</div><ul>${favList.map(p=>`<li>${escapeHtml(p.name)} <span class="pill">${escapeHtml(p.region_id)}</span></li>`).join("")}</ul>` : "";
  }
}
function buildWeekendPlan(){
  const favList = (__DOC.pois || []).filter(p => favs.has(p.id));
  if(favList.length < 2){
    return `<div class="small">Selecteer minstens 2 favorieten om een route te maken.</div>`;
  }
  const withCoords = favList.map(p=>({poi:p, coord:coordsFromPoi(p)})).filter(x=>x.coord);
  if(withCoords.length < 2){
    return `<div class="small">Ik heb coördinaten nodig om een route te berekenen. Voeg in YAML bij je favorieten <code>location.coordinates</code> toe (lat/lon), of voeg favorieten toe die al coördinaten hebben.</div>`;
  }
  const origin = getOriginCoord(__DOC);
// Order by nearest-neighbor. If origin is known (e.g. hotel), start from origin for a more realistic route.
let ordered;
if(origin){
  // pick the first stop closest to origin, then do nearest-neighbor among remaining
  const pts = withCoords.map(x=>({ id:x.poi.id, coord:x.coord, poi:x.poi }));
  if(!pts.length){
    return { html: `<div class="small">Geen favorieten met coördinaten gevonden.</div>` };
  }
  // choose start as closest to origin
  let bestIdx = 0, bestD = Infinity;
  for(let i=0;i<pts.length;i++){
    const d = haversineKm(origin, pts[i].coord);
    if(d < bestD){ bestD = d; bestIdx = i; }
  }
  const start = pts.splice(bestIdx,1)[0];
  ordered = [start, ...nearestNeighborOrder(pts)];
}else{
  ordered = nearestNeighborOrder(withCoords.map(x=>({ id:x.poi.id, coord:x.coord, poi:x.poi })));
}
  const fri = ordered.slice(0,1);
  const sat = ordered.slice(1, Math.min(6, ordered.length));
  const sun = ordered.slice(Math.min(6, ordered.length));

  const section = (label, arr) => `
    <div class="plan">
      <h3>${label} <span class="pill">${arr.length} stop(s)</span></h3>
      <ul>${arr.map(x=>`<li>${escapeHtml(x.poi.name)} <span class="pill">${escapeHtml(x.poi.location?.locality || "")}</span></li>`).join("")}</ul>
    </div>
  `;
  const coords = ordered.slice(0,10).map(x=>x.coord);
  const maps = googleMapsDirectionsLink(coords);

  return `
    <div class="small">Suggestie is gebaseerd op een simpele “dichtstbijzijnde volgende stop” aanpak (geen openingstijden).</div>
    ${section("Vrijdag (aankomst)", fri)}
    ${section("Zaterdag (hoofddag)", sat)}
    ${section("Zondag (terugreis)", sun)}
    ${maps ? `<a class="linkbtn" href="${maps}" target="_blank" rel="noopener">Open route in Google Maps</a>` : ""}
  `;
}

/* ---------------- Rendering ---------------- */
function badge(text){
  const span = document.createElement("span");
  span.className = "badge";
  span.textContent = text;
  return span;
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
function createStarButton(poiId){
  const btn = document.createElement("button");
  btn.className = "starbtn";
  btn.type = "button";
  btn.title = "Markeer als favoriet";
  btn.innerHTML = favs.has(poiId) ? "★" : "☆";
  btn.addEventListener("click", (ev)=>{
    ev.preventDefault();
    ev.stopPropagation();
    if(favs.has(poiId)) favs.delete(poiId);
    else favs.add(poiId);
    saveFavs(currentDataset, favs);
    btn.innerHTML = favs.has(poiId) ? "★" : "☆";
    const out = document.querySelector("#plannerOutput");
    if(out){ out.innerHTML = ""; out.dataset.hasPlan = ""; }
    updatePlannerUI();
  });
  return btn;
}
function createCard(poi, regionById){
  const a = document.createElement("a");
  a.className = "card";
  a.href = poi.links?.wikipedia || "#";
  a.target = "_blank";
  a.rel = "noopener";
  a.appendChild(createStarButton(poi.id));

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const noimg = document.createElement("div");
  noimg.className = "noimg";
  noimg.textContent = "Foto laden…";
  thumb.appendChild(noimg);

  const row = document.createElement("div");
  row.className = "row";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = poi.name;
  const badges = document.createElement("div");
  badges.className = "badges";
  badges.appendChild(badge(poi.type));
  if(poi.location?.locality) badges.appendChild(badge(poi.location.locality));
  row.appendChild(title);
  row.appendChild(badges);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${poi.location?.locality || "—"}${poi.location?.province ? ", "+poi.location.province : ""}`;

  const summary = document.createElement("div");
  summary.className = "summary";
  summary.textContent = poi.why_visit || "";

  a.appendChild(thumb);
  a.appendChild(row);
  a.appendChild(meta);
  a.appendChild(summary);

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
    if((poi.why_visit || "").length < 40 && info.extract){
      summary.textContent = info.extract;
    }
  });

  return a;
}

function buildSelect(selectEl, values, placeholder){
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

function render(){
  const doc = __DOC;
  if(!doc) return;

  const regions = doc.regions || [];
  const pois = doc.pois || [];
  const regionById = new Map(regions.map(r => [r.id, r]));
  const grouped = groupByRegion(pois);

  const q = normalize(__STATE.search || "");
  const regionFilter = __STATE.region || "";
  const typeFilter = __STATE.type || "";
  const themeFilter = __STATE.theme || "";
  const photosOnly = !!__STATE.photosOnly;

  const filtered = pois.filter(p=>{
    if(regionFilter && p.region_id !== regionFilter) return false;
    if(typeFilter && (p.type||"") !== typeFilter) return false;
    if(themeFilter && !(p.themes||[]).includes(themeFilter)) return false;
    if(q && !poiSearchHaystack(p, regionById).includes(q)) return false;
    return true;
  });

  els.regionsContainer.innerHTML = "";
  let shownRegions = 0, shownCards = 0;

  for(const r of regions){
    const arr = (grouped.get(r.id) || []).filter(p => filtered.includes(p));
    if(!arr.length) continue;
    shownRegions++;

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
    left.appendChild(h); left.appendChild(d);

    const right = document.createElement("div");
    right.className = "region-meta";
    right.innerHTML = `${arr.length} locaties<br><span class="small">${escapeHtml((r.base_towns||[]).join(" · "))}</span>`;

    header.appendChild(left); header.appendChild(right);

    const grid = document.createElement("div");
    grid.className = "grid";
    for(const p of arr){
      grid.appendChild(createCard(p, regionById));
      shownCards++;
    }

    section.appendChild(header);
    section.appendChild(grid);
    els.regionsContainer.appendChild(section);
  }

  setStatus(`Toont ${shownCards} locaties in ${shownRegions} regio’s.`);

  if(photosOnly){
    setTimeout(()=>{
      const cards = Array.from(document.querySelectorAll(".card"));
      let visible = 0;
      for(const c of cards){
        if(c.dataset.hasPhoto === "0") c.classList.add("hidden");
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

/* ---------------- Data loading ---------------- */
async function fetchYaml(url){
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok) throw new Error(`Cannot fetch YAML (${res.status})`);
  const text = await res.text();
  return jsyaml.load(text);
}

async function loadDataset(ds){
  currentDataset = ds;
  favs = loadFavs(currentDataset);
  updateEditLink();

  // reset UI state
  __STATE = { search:"", region:"", type:"", theme:"", photosOnly:false };
  els.search.value = "";
  els.photosOnly.checked = false;

  setStatus("Laden van data…");
  try{
    __DOC = await fetchYaml(DATASETS[currentDataset].url);
  }catch(e){
    console.error(e);
    setStatus("Kon data niet laden.");
    return;
  }

  // rebuild selects
  const regions = __DOC.regions || [];
  const pois = __DOC.pois || [];

  buildSelect(els.region, regions.map(r=>r.id), "Alle regio’s");
  for(const opt of Array.from(els.region.options)){
    const r = regions.find(x=>x.id===opt.value);
    if(r) opt.textContent = r.name;
  }
  buildSelect(els.type, uniq(pois.map(p=>p.type)).sort(), "Alle types");
  buildSelect(els.theme, uniq(pois.flatMap(p=>p.themes || [])).sort(), "Alle thema’s");
  els.region.value = "";
  els.type.value = "";
  els.theme.value = "";

  // reset planner output
  const out = document.querySelector("#plannerOutput");
  if(out){ out.innerHTML = ""; out.dataset.hasPlan = ""; }

  render();
}

function wireTabs(){
  const tabs = Array.from(document.querySelectorAll("#tabs .tab"));
  if(!tabs.length) return;
  tabs.forEach(t=>{
    t.addEventListener("click", ()=>{
      const ds = t.dataset.dataset;
      if(!ds || ds === currentDataset) return;
      tabs.forEach(x=>x.classList.toggle("active", x.dataset.dataset === ds));
      loadDataset(ds);
    });
  });
}

/* ---------------- Main ---------------- */
async function main(){
  wireGitHubLinks();
  injectStarStylesOnce();
  ensurePlannerPanel();
  wireTabs();

  // controls
  els.search.addEventListener("input", (e)=>{ __STATE.search = e.target.value; render(); });
  els.region.addEventListener("change", (e)=>{ __STATE.region = e.target.value; render(); });
  els.type.addEventListener("change", (e)=>{ __STATE.type = e.target.value; render(); });
  els.theme.addEventListener("change", (e)=>{ __STATE.theme = e.target.value; render(); });
  els.photosOnly.addEventListener("change", (e)=>{ __STATE.photosOnly = e.target.checked; render(); });

  const panel = document.getElementById("plannerPanel");
  panel.querySelector("#btnClearFavs").addEventListener("click", ()=>{
    favs = new Set();
    saveFavs(currentDataset, favs);
    document.querySelectorAll(".starbtn").forEach(b=> b.innerHTML = "☆");
    const out = document.querySelector("#plannerOutput");
    if(out){ out.innerHTML = ""; out.dataset.hasPlan = ""; }
    updatePlannerUI();
  });
  panel.querySelector("#btnPlan").addEventListener("click", ()=>{
    const out = panel.querySelector("#plannerOutput");
    out.innerHTML = buildWeekendPlan();
    out.dataset.hasPlan = "1";
  });

  await loadDataset(currentDataset);
}

main();
