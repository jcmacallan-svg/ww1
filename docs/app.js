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
let __CURRENT_PLAN = null; // last generated plan (for manual editing)
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
  photoCounter: null,
};

// Photo counter (shown next to "Toon alleen POI’s met foto")
let PHOTO_STATS = { total: 0, withPhoto: 0, resolved: 0 };
function resetPhotoStats(){
  PHOTO_STATS = { total: 0, withPhoto: 0, resolved: 0 };
  renderPhotoCounter();
}
function renderPhotoCounter(){
  if(!els.photoCounter) return;
  const t = PHOTO_STATS.total;
  const w = PHOTO_STATS.withPhoto;
  const r = PHOTO_STATS.resolved;
  if(t === 0){
    els.photoCounter.textContent = "";
    return;
  }
  const missing = Math.max(0, t - w);
  const loading = (r < t) ? ` · laden ${r}/${t}` : "";
  els.photoCounter.textContent = `Foto’s ${w}/${t} · ontbreekt ${missing}${loading}`;
}
function ensurePhotoCounterEl(){
  if(els.photoCounter) return;
  const label = els.photosOnly?.closest("label");
  if(!label) return;
  const span = document.createElement("span");
  span.id = "photoCounter";
  span.className = "photoCounter";
  span.textContent = "";
  label.appendChild(span);
  els.photoCounter = span;
}

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

/* ---------------- Planner settings (per dataset) ---------------- */
function planKey(ds){ return `tripkit_plan_${ds}_v1`; }

function mealKey(ds){ return `tripkit_meal_choices_${ds}_v1`; }
function loadMealChoices(ds){
  try{
    const raw = localStorage.getItem(mealKey(ds));
    if(!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  }catch(_){ return {}; }
}
function saveMealChoices(ds, obj){
  try{ localStorage.setItem(mealKey(ds), JSON.stringify(obj || {})); }catch(_){}
}
function setMealChoice(ds, dayIdx, slot, poiId){
  const all = loadMealChoices(ds);
  const key = String(dayIdx);
  all[key] = all[key] || {};
  all[key][slot] = poiId || "";
  saveMealChoices(ds, all);
}
function getMealChoice(ds, dayIdx, slot){
  const all = loadMealChoices(ds);
  return all?.[String(dayIdx)]?.[slot] || "";
}
function defaultPlanSettings(ds){
  if(ds === "berlin"){
    // Example: arrive Fri evening, Sat+Sun full days, depart Mon afternoon
    return {
      days: 4,
      arrival: "evening",
      departure: "afternoon",
      mapProvider: "both",
      // Extra route slots (Berlin): plan food + cocktails per day
      includeLunch: true,
      includeDinner: true,
      includeCocktails: true,
    };
  }
  // WW1 weekend: arrive Fri afternoon, Sat full, depart Sun evening
  return { days: 3, arrival: "afternoon", departure: "evening", mapProvider: "both" };
}
function loadPlanSettings(ds){
  const def = defaultPlanSettings(ds);
  try{
    const raw = JSON.parse(localStorage.getItem(planKey(ds)) || "null");
    if(!raw) return def;
    return { ...def, ...raw };
  }catch{
    return def;
  }
}
function savePlanSettings(ds, settings){
  localStorage.setItem(planKey(ds), JSON.stringify(settings));
}
let __PLAN = loadPlanSettings(currentDataset);

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

function _num(v){
  if(typeof v === "number" && Number.isFinite(v)) return v;
  if(typeof v === "string"){
    const n = parseFloat(v);
    if(Number.isFinite(n)) return n;
  }
  return null;
}

function getOriginCoord(doc){
  const c = doc?.settings?.default_origin?.coordinates;
  const lat = _num(c?.lat);
  const lon = _num(c?.lon);
  if(lat != null && lon != null) return {lat, lon};
  return null;
}

// Per-dataset coordinate overrides (stored client-side; useful when YAML lacks coords)
function coordKey(ds){ return `tripkit_coord_overrides_${ds}_v1`; }
function loadCoordOverrides(ds){
  try{ return JSON.parse(localStorage.getItem(coordKey(ds)) || "{}") || {}; }
  catch{ return {}; }
}
function saveCoordOverrides(ds, obj){
  localStorage.setItem(coordKey(ds), JSON.stringify(obj || {}));
}
let __COORD_OVERRIDES = loadCoordOverrides(currentDataset);

function coordsFromPoi(p){
  // 1) YAML coords
  const c = p.location?.coordinates;
  let lat = _num(c?.lat), lon = _num(c?.lon);
  if(lat != null && lon != null) return {lat, lon};

  // 2) local override
  const o = __COORD_OVERRIDES?.[p.id];
  lat = _num(o?.lat); lon = _num(o?.lon);
  if(lat != null && lon != null) return {lat, lon};

  return null;
}

// 3) Try to get coordinates from Wikidata (P625)
async function fetchWikidataCoord(qid){
  if(!qid) return null;
  try{
    const ent = await fetchWikidataEntity(qid);
    const claim = ent?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    if(claim && typeof claim.latitude !== "undefined" && typeof claim.longitude !== "undefined"){
      const lat = _num(claim.latitude);
      const lon = _num(claim.longitude);
      if(lat != null && lon != null) return {lat, lon, source: "wikidata"};
    }
  }catch{}
  return null;
}

// 4) Fallback: Nominatim geocode using maps_query/name + locality + country.
// Results are cached in localStorage overrides.
async function geocodeNominatim(poi){
  const parts = [];
  if(poi.links?.maps_query) parts.push(poi.links.maps_query);
  else parts.push(poi.name);
  if(poi.location?.locality) parts.push(poi.location.locality);
  if(poi.location?.province) parts.push(poi.location.province);
  if(poi.location?.country) parts.push(poi.location.country);
  const q = parts.filter(Boolean).join(", ");
  try{
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.searchParams.set("format","json");
    u.searchParams.set("limit","1");
    u.searchParams.set("q", q);
    const res = await fetch(u.toString(), { headers: { "accept":"application/json" }, cache: "no-store" });
    if(!res.ok) return null;
    const arr = await res.json();
    const first = Array.isArray(arr) ? arr[0] : null;
    const lat = _num(first?.lat);
    const lon = _num(first?.lon);
    if(lat != null && lon != null) return {lat, lon, source: "nominatim"};
  }catch{}
  return null;
}

async function ensureCoordsForPois(pois){
  const updated = [];
  for(const p of pois){
    if(coordsFromPoi(p)) continue;

    const qid = p.links?.wikidata || null;
    let got = await fetchWikidataCoord(qid);
    if(!got) got = await geocodeNominatim(p);

    if(got){
      __COORD_OVERRIDES[p.id] = { lat: got.lat, lon: got.lon, source: got.source };
      updated.push(p.id);
    }
  }
  if(updated.length){
    saveCoordOverrides(currentDataset, __COORD_OVERRIDES);
  }
  return updated;
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

function appleMapsDirectionsLink(coords, originOverride=null){
  if(coords.length < 2) return null;
  const fmt = (c)=> `${c.lat},${c.lon}`;
  const origin = originOverride ? originOverride : coords[0];
  const stops = coords.slice(1);
  const daddr = stops.map(fmt).join("+to:");
  const u = new URL("https://maps.apple.com/");
  u.searchParams.set("saddr", fmt(origin));
  u.searchParams.set("daddr", daddr);
  u.searchParams.set("dirflg", "d"); // driving
  return u.toString();
}

function parseTypicalVisitMinutes(poi){
  const minV = poi?.practical?.visit_duration_min;
  const maxV = poi?.practical?.visit_duration_max;
  if(Number.isFinite(minV) && Number.isFinite(maxV) && maxV > 0){
    return Math.max(5, Math.round((minV + maxV)/2));
  }

  const s = (poi?.practical?.typical_visit_time || "").toString().trim().toLowerCase();
  if(!s || s === "—" || s === "-") return defaultVisitMinutes(poi);
  if(s.includes("half day")) return 240;
  if(s.includes("multi-day")) return 360;

  const nums = (s.match(/\d+/g) || []).map(n=>parseInt(n,10)).filter(Number.isFinite);
  if(nums.length === 1) return Math.max(5, nums[0]);
  if(nums.length >= 2){
    const a = Math.min(nums[0], nums[1]);
    const b = Math.max(nums[0], nums[1]);
    return Math.max(5, Math.round((a+b)/2));
  }
  return defaultVisitMinutes(poi);
}

function defaultVisitMinutes(poi){
  const t = (poi?.type || "").toLowerCase();
  const buckets = mapToBuckets(poi);
  if(["food","nightlife","bar","cafe","restaurant"].includes(t)) return 75;
  if(["memorial","monument","cemetery"].includes(t)) return 40;
  if(["trench","battlefield","park"].includes(t)) return 70;
  if(["museum","fort","visitor-centre"].includes(t)) return 120;
  if(buckets.includes("eat-night")) return 75;
  if(buckets.includes("culture")) return 120;
  if(buckets.includes("city-outdoors")) return 70;
  if(buckets.includes("history")) return 60;
  return 60;
}

function avgSpeedKmph(doc){
  const s = doc?.settings?.routing?.avg_speed_kmph;
  if(typeof s === "number" && Number.isFinite(s) && s > 5) return s;
  return (currentDataset === "berlin") ? 25 : 60;
}

function formatMinutes(min){
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if(h <= 0) return `${r} min`;
  if(r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

function dayBudgets(days, arrival, departure){
  const arrivalMap = { morning: 360, afternoon: 240, evening: 120 };
  const departMap  = { morning: 180, afternoon: 240, evening: 360 };
  const full = 480;
  const d = Math.max(1, Math.min(10, parseInt(days,10) || 1));
  if(d === 1){
    const a = arrivalMap[arrival] ?? 240;
    const dep = departMap[departure] ?? 240;
    return [Math.min(a + dep, full)];
  }
  const out = new Array(d).fill(full);
  out[0] = arrivalMap[arrival] ?? 240;
  out[d-1] = departMap[departure] ?? 240;
  return out;
}

function buildOptimizedPlan(withCoords, origin, budgets, speed){
  const remaining = withCoords.map(x=>({ poi:x.poi, coord:x.coord }));
  const days = [];
  for(let di=0; di<budgets.length; di++){
    const budget = budgets[di];
    let timeLeft = budget;
    let cur = origin;
    const stops = [];
    let travelKm = 0;
    let visitMin = 0;

    while(remaining.length){
      const ranked = remaining
        .map((x, idx)=>({ idx, x, d: haversineKm(cur, x.coord) }))
        .sort((a,b)=>a.d-b.d);

      let chosen = null;
      for(const cand of ranked){
        const x = cand.x;
        const travelMin = (cand.d / speed) * 60;
        const vMin = parseTypicalVisitMinutes(x.poi);
        const backMin = (haversineKm(x.coord, origin) / speed) * 60;
        const needWithReturn = travelMin + vMin + backMin;
        // small buffer to avoid overfilling
        if(needWithReturn <= timeLeft - 10 || (stops.length === 0 && needWithReturn <= timeLeft + 5)){
          chosen = { ...x, travelMin, vMin, distKm: cand.d, idx: cand.idx };
          break;
        }
      }
      if(!chosen) break;

      stops.push({ poi: chosen.poi, coord: chosen.coord });
      travelKm += chosen.distKm;
      visitMin += chosen.vMin;
      timeLeft -= (chosen.travelMin + chosen.vMin);
      cur = chosen.coord;
      remaining.splice(chosen.idx, 1);
    }

    if(stops.length){
      const backKm = haversineKm(cur, origin);
      travelKm += backKm;
    }

    days.push({ budgetMin: budget, stops, travelKm, visitMin });
  }
  return { days, leftovers: remaining };
}

function routeCoordsForDay(origin, stops){
  const coords = [origin, ...stops.map(s=>s.coord)];
  if(stops.length) coords.push(origin);
  return coords;
}

function isFoodPoi(poi){
  if(!poi) return false;
  const t = (poi.type || "").toLowerCase();
  if(["food","restaurant","cafe","bar","cocktailbar"].includes(t)) return true;
  const themes = (poi.themes || []).map(x=>String(x).toLowerCase());
  return themes.includes("food") || themes.includes("restaurant") || themes.includes("cafe") || themes.includes("bar");
}
function isNightlifePoi(poi){
  if(!poi) return false;
  const t = (poi.type || "").toLowerCase();
  if(["nightlife","bar","cocktailbar","cafe"].includes(t)) return true;
  const themes = (poi.themes || []).map(x=>String(x).toLowerCase());
  return themes.includes("nightlife") || themes.includes("vibe") || themes.includes("bar");
}
function isCocktailPoi(poi){
  if(!poi) return false;
  const t = (poi.type || "").toLowerCase();
  if(t === "cocktailbar") return true;
  const themes = (poi.themes || []).map(x=>String(x).toLowerCase());
  if(themes.includes("cocktails") || themes.includes("cocktail")) return true;
  // heuristic: name contains "cocktail" or it is nightlife+bar-ish
  const nm = (poi.name || "").toLowerCase();
  if(nm.includes("cocktail")) return true;
  if(isNightlifePoi(poi) && (nm.includes("bar") || nm.includes("roof"))) return true;
  return false;
}

function travelKmForStops(origin, stops){
  const coords = routeCoordsForDay(origin, stops);
  let km = 0;
  for(let i=1;i<coords.length;i++) km += haversineKm(coords[i-1], coords[i]);
  return km;
}
function visitMinForStops(stops){
  return (stops || []).reduce((sum, s)=> sum + parseTypicalVisitMinutes(s.poi), 0);
}

function pickNearestUnused(cands, targetCoord, usedIds){
  if(!cands || !cands.length || !targetCoord) return null;
  let best = null;
  for(const x of cands){
    if(!x.coord) continue;
    const used = usedIds && usedIds.has(x.poi.id);
    const d = haversineKm(x.coord, targetCoord);
    if(!best || (used ? 1e9 : d) < (best.used ? 1e9 : best.d) || (!used && !best.used && d < best.d)){
      best = { x, d, used };
    }
  }
  if(best && usedIds) usedIds.add(best.x.poi.id);
  return best ? best.x : null;
}

function insertMealSlotsBerlin(plan, origin, budgets, pools){
  const { lunchPool, dinnerPool, cocktailPool } = pools;
  const ds = currentDataset;

  // Remove any previously inserted meal-slot stops
  (plan.days || []).forEach(d=>{
    d.stops = (d.stops || []).filter(s=>!s.slot);
  });

  const usedIds = new Set();

  const wantMealSlot = (di, slot) => {
    const ps = loadPlanSettings(ds);
    const days = ps.days || (plan.days ? plan.days.length : 0);
    const arrival = ps.arrival || "evening";
    const departure = ps.departure || "afternoon";
    const isFirst = di === 0;
    const isLast = di === days - 1;

    if(slot === "lunch"){
      if(!ps.includeLunch) return false;
      if(isFirst && arrival !== "morning") return false;
      if(isLast && departure === "morning") return false;
      return true;
    }
    if(slot === "dinner"){
      if(!ps.includeDinner) return false;
      if(isLast && departure === "morning") return false;
      return true;
    }
    if(slot === "cocktail"){
      if(!ps.includeCocktails) return false;
      if(isLast && (departure === "morning" || departure === "afternoon")) return false;
      return true;
    }
    return false;
  };

  const pickFromPool = (pool, preferredId, anchorCoord) => {
    if(!pool || !pool.length) return null;

    if(preferredId){
      const found = pool.find(s=>s.poi?.id===preferredId);
      if(found){
        usedIds.add(found.poi.id);
        return found;
      }
    }

    const unused = pool.filter(s=>!usedIds.has(s.poi?.id));
    if(unused.length){
      const picked = pickNearestUnused(unused, anchorCoord, new Set()); // unused already filtered
      if(picked){
        usedIds.add(picked.poi.id);
        return picked;
      }
    }

    // If everything is used, allow reuse but rotate so we don't always pick the same thing
    const picked = pickNearestUnused(pool, anchorCoord, new Set());
    if(picked){
      usedIds.add(picked.poi.id);
      return picked;
    }
    return null;
  };

  for(let di=0; di<plan.days.length; di++){
    const day = plan.days[di];
    const dayStops = day.stops || [];

    // FIX: origin is already {lat,lon}
    const mid = dayStops.length ? dayStops[Math.floor(dayStops.length/2)].coord : origin;
    const end = dayStops.length ? dayStops[dayStops.length-1].coord : origin;

    const lunchPref = getMealChoice(ds, di, "lunch");
    const dinnerPref = getMealChoice(ds, di, "dinner");
    const cocktailPref = getMealChoice(ds, di, "cocktail");

    // Lunch (insert around mid)
    if(wantMealSlot(di, "lunch")){
      const pick = pickFromPool(lunchPool, lunchPref, mid);
      if(pick){
        const stop = { poi: pick.poi, coord: pick.coord, slot: "lunch", manuallyPlaced: !!lunchPref };
        const pos = Math.max(0, Math.floor(dayStops.length/2));
        dayStops.splice(pos, 0, stop);
      }
    }

    // Dinner (towards end)
    if(wantMealSlot(di, "dinner")){
      const pick = pickFromPool(dinnerPool, dinnerPref, end);
      if(pick){
        const stop = { poi: pick.poi, coord: pick.coord, slot: "dinner", manuallyPlaced: !!dinnerPref };
        dayStops.push(stop);
      }
    }

    // Cocktails (end)
    if(wantMealSlot(di, "cocktail")){
      const anchor = dayStops.length ? dayStops[dayStops.length-1].coord : end;
      const pick = pickFromPool(cocktailPool, cocktailPref, anchor);
      if(pick){
        const stop = { poi: pick.poi, coord: pick.coord, slot: "cocktail", manuallyPlaced: !!cocktailPref };
        dayStops.push(stop);
      }
    }

    day.stops = dayStops;
  }

  // FIX: return plan so caller doesn't end up with undefined
  return plan;
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
      <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-top:10px;">
  <div style="display:flex; flex-direction:column; gap:6px;">
    <div class="small" style="color:var(--muted);">Aantal dagen</div>
    <select id="planDays" class="input" style="min-width:120px;">
      <option value="1">1</option><option value="2">2</option><option value="3">3</option>
      <option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:6px;">
    <div class="small" style="color:var(--muted);">Aankomst</div>
    <select id="planArrival" class="input" style="min-width:140px;">
      <option value="morning">Ochtend</option>
      <option value="afternoon">Middag</option>
      <option value="evening">Avond</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:6px;">
    <div class="small" style="color:var(--muted);">Vertrek</div>
    <select id="planDeparture" class="input" style="min-width:140px;">
      <option value="morning">Ochtend</option>
      <option value="afternoon">Middag</option>
      <option value="evening">Avond</option>
    </select>
  </div>
  <div style="display:flex; flex-direction:column; gap:6px;">
    <div class="small" style="color:var(--muted);">Starttijd (volle dagen)</div>
    <input id="planStartTime" class="input" type="time" value="10:00" style="min-width:150px;" />
  </div>
  <div style="display:flex; flex-direction:column; gap:6px;">
    <div class="small" style="color:var(--muted);">Kaart</div>
    <select id="planMapProvider" class="input" style="min-width:150px;">
      <option value="both">Google + Apple</option>
      <option value="google">Alleen Google</option>
      <option value="apple">Alleen Apple</option>
    </select>
  </div>
  <div id="planBerlinExtras" style="display:none; gap:10px; align-items:center; flex-wrap:wrap; padding:6px 10px; border-radius:12px; background: rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08);">
    <label class="small" style="display:flex; align-items:center; gap:8px; color:var(--muted);">
      <input id="planIncludeLunch" type="checkbox" /> Lunch
    </label>
    <label class="small" style="display:flex; align-items:center; gap:8px; color:var(--muted);">
      <input id="planIncludeDinner" type="checkbox" /> Diner
    </label>
    <label class="small" style="display:flex; align-items:center; gap:8px; color:var(--muted);">
      <input id="planIncludeCocktails" type="checkbox" /> Cocktailbar
    </label>
  </div>
  <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-left:auto;">
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
    #plannerPanel select{ color: var(--text); }
    #plannerPanel option{ color:#111; }
    .plan{ border-top:1px solid rgba(255,255,255,.08); padding-top:10px; margin-top:10px; }
    .plan h3{ margin:0 0 6px; font-size:13px; }
    .plan ul{ margin:6px 0 0 18px; padding:0; }
    .plan li{ margin:4px 0; }
    .pill{ display:inline-block; padding:2px 8px; border-radius:999px; background:rgba(155,255,199,.10);
      border:1px solid rgba(155,255,199,.18); color:rgba(232,232,234,.95); font-size:11px; margin-left:8px; }
    .linkbtn{ display:inline-block; margin-top:8px; text-decoration:none; font-size:12px; padding:8px 10px;
      border-radius:12px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.10); color:var(--text); }
    .linkbtn:hover{ border-color: rgba(122,162,255,.35); }

    .plan-tools{ margin-top:8px; }
    .plan-li{ display:flex; gap:10px; align-items:flex-start; justify-content:space-between; padding:10px 0; }
    .plan-li .li-main{ flex: 1 1 auto; min-width: 160px; }
    .plan-li .li-title{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .plan-li .li-tools{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .plan-li .li-tools .time{ width: 120px; }
    .plan-li .li-tools .move{ width: 120px; }
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
async function updatePlannerUI(){
  const panel = document.getElementById("plannerPanel");
  if(!panel || !__DOC) return;
  const meta = panel.querySelector("#plannerMeta");
  const out = panel.querySelector("#plannerOutput");
  const favList = (__DOC.pois || []).filter(p => favs.has(p.id));
  // Vul ontbrekende coördinaten automatisch aan (Wikidata → Nominatim) en cache in je browser.
  await ensureCoordsForPois(favList);
  if(meta){
    meta.textContent = favList.length ? `${favList.length} favoriet(en) geselecteerd.` :
      "Selecteer locaties met de ster. Daarna kun je een compacte weekendroute laten voorstellen.";
  }
  if(out && !out.dataset.hasPlan){
    out.innerHTML = favList.length ? `<div class="small">Favorieten:</div><ul>${favList.map(p=>`<li>${escapeHtml(p.name)} <span class="pill">${escapeHtml(p.region_id)}</span></li>`).join("")}</ul>` : "";
  }
}

function applyPlannerSettingsUI(){
  const panel = document.getElementById("plannerPanel");
  if(!panel) return;
  const daysEl = panel.querySelector("#planDays");
  const arrEl = panel.querySelector("#planArrival");
  const depEl = panel.querySelector("#planDeparture");
  const mapEl = panel.querySelector("#planMapProvider");
  const startEl = panel.querySelector("#planStartTime");
  const extras = panel.querySelector("#planBerlinExtras");
  const lunchEl = panel.querySelector("#planIncludeLunch");
  const dinnerEl = panel.querySelector("#planIncludeDinner");
  const cockEl = panel.querySelector("#planIncludeCocktails");
  if(daysEl) daysEl.value = String(__PLAN.days || 3);
  if(arrEl) arrEl.value = __PLAN.arrival || "afternoon";
  if(depEl) depEl.value = __PLAN.departure || "evening";
  if(mapEl) mapEl.value = __PLAN.mapProvider || "both";
  if(startEl) startEl.value = __PLAN.startTime || "10:00";
  if(extras) extras.style.display = (currentDataset === "berlin") ? "flex" : "none";
  if(lunchEl) lunchEl.checked = !!__PLAN.includeLunch;
  if(dinnerEl) dinnerEl.checked = (__PLAN.includeDinner !== false);
  if(cockEl) cockEl.checked = !!__PLAN.includeCocktails;
}

async function buildWeekendPlan(){
  const favList = (__DOC.pois || []).filter(p => favs.has(p.id));
  const isBerlin = (currentDataset === "berlin");
  // Vul ontbrekende coördinaten automatisch aan (Wikidata → Nominatim) en cache in je browser.
  await ensureCoordsForPois(favList);
  if(favList.length < 2 && !isBerlin){
    return `<div class="small">Selecteer minstens 2 favorieten om een route te maken.</div>`;
  }
  const withCoords = favList.map(p=>({poi:p, coord:coordsFromPoi(p)})).filter(x=>x.coord);
  if(withCoords.length < 1){
    return `<div class="small">Ik heb coördinaten nodig om een route te berekenen. Voeg in YAML bij je favorieten <code>location.coordinates</code> toe (lat/lon), of voeg favorieten toe die al coördinaten hebben.</div>`;
  }

  const origin = getOriginCoord(__DOC) || withCoords[0].coord;
  const speed = avgSpeedKmph(__DOC);
  const budgets = dayBudgets(__PLAN.days, __PLAN.arrival, __PLAN.departure);

  // Optional: for Berlin we can treat food/cocktail favorites as repeating daily slots.
  let mainStops = withCoords;
  const pools = { lunchPool: [], dinnerPool: [], cocktailPool: [] };
  if(isBerlin && (__PLAN.includeLunch || (__PLAN.includeDinner !== false) || __PLAN.includeCocktails)){
    const includeLunch = !!__PLAN.includeLunch;
    const includeDinner = (__PLAN.includeDinner !== false);
    const includeCocktails = !!__PLAN.includeCocktails;

    for(const x of withCoords){
      const p = x.poi;
      if(isFoodPoi(p) && (includeLunch || includeDinner)){
        pools.lunchPool.push(x);
        pools.dinnerPool.push(x);
        continue;
      }
      if(isCocktailPoi(p) && includeCocktails){
        pools.cocktailPool.push(x);
        continue;
      }
      // keep as a regular stop
    }
    // Rebuild mainStops without the pooled items
    mainStops = withCoords.filter(x=>{
      const p = x.poi;
      if(isFoodPoi(p) && (includeLunch || includeDinner)) return false;
      if(isCocktailPoi(p) && includeCocktails) return false;
      return true;
    });
  }

  let plan;
  if(mainStops.length){
    plan = buildOptimizedPlan(mainStops, origin, budgets, speed);
  }else{
    plan = { days: budgets.map(b=>({budgetMin:b, stops: [], travelKm:0, visitMin:0})), leftovers: [] };
  }

  if(isBerlin){
    // FIX: function returns plan now, so this will never become undefined
    plan = insertMealSlotsBerlin(plan, origin, budgets, pools);
  }

  const html = buildWeekendPlanHtml(plan, origin, budgets, withCoords.length, pools);
  __CURRENT_PLAN = {
    plan,
    origin,
    budgets,
    pools,
    totalStops: withCoords.length,
    htmlProvider: () => buildWeekendPlanHtml(plan, origin, budgets, withCoords.length, pools)
  };
  savePlanDraft();
  return html;
}

function buildWeekendPlanHtml(plan, origin, budgets, totalStops, pools){
  const slotLabel = (i)=>{
    const d = budgets.length;
    if(d === 1) return " (dagtrip)";
    if(i === 0){
      const a = { morning:"ochtend", afternoon:"middag", evening:"avond" }[__PLAN.arrival] || "";
      return ` (aankomst: ${a})`;
    }
    if(i === d-1){
      const dep = { morning:"ochtend", afternoon:"middag", evening:"avond" }[__PLAN.departure] || "";
      return ` (vertrek: ${dep})`;
    }
    return " (volledige dag)";
  };

  const provider = __PLAN.mapProvider || "both";
  const mapsButtons = (coords)=>{
    const g = googleMapsDirectionsLink(coords, origin);
    const a = appleMapsDirectionsLink(coords, origin);
    const gBtn = g ? `<a class="linkbtn" href="${g}" target="_blank" rel="noopener">Open in Google Maps</a>` : "";
    const aBtn = a ? `<a class="linkbtn" href="${a}" target="_blank" rel="noopener">Open in Apple Maps</a>` : "";
    if(provider === "google") return `<div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;">${gBtn}</div>`;
    if(provider === "apple") return `<div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;">${aBtn}</div>`;
    return `<div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;">${gBtn}${aBtn}</div>`;
  };

  const ds = currentDataset;
  const ps = loadPlanSettings(ds);

  const wantMealSlot = (di, slot) => {
    const days = ps.days || plan.days.length;
    const arrival = ps.arrival || "evening";
    const departure = ps.departure || "afternoon";
    const isFirst = di === 0;
    const isLast = di === days - 1;

    if(slot === "lunch"){
      if(!ps.includeLunch) return false;
      if(isFirst && arrival !== "morning") return false;
      if(isLast && departure === "morning") return false;
      return true;
    }
    if(slot === "dinner"){
      if(!ps.includeDinner) return false;
      if(isLast && departure === "morning") return false;
      return true;
    }
    if(slot === "cocktail"){
      if(!ps.includeCocktails) return false;
      if(isLast && (departure === "morning" || departure === "afternoon")) return false;
      return true;
    }
    return false;
  };

  const mealSelect = (di, slot, label, pool) => {
    if(!wantMealSlot(di, slot)) return "";
    const chosen = getMealChoice(ds, di, slot);
    const opts = (pool || []).map(s => {
      const id = s.poi?.id || "";
      const nm = s.poi?.name || id;
      return `<option value="${escapeHtml(id)}"${id===chosen ? " selected":""}>${escapeHtml(nm)}</option>`;
    }).join("");
    const disabled = (!pool || !pool.length) ? " disabled" : "";
    return `<label class="small">
        ${label}
        <select class="select" data-action="meal" data-slot="${slot}" data-day="${di}"${disabled}>
          <option value="">(auto)</option>
          ${opts}
        </select>
      </label>`;
  };

  const section = (label, day, di) => {
    const stops = day.stops || [];
    const timeline = computeTimelineForDay(di, stops);
    const coords = routeCoordsForDay(origin, stops);
    return `
        <div class="plan">
          <h3>${label} <span class="pill">${stops.length} stop(s)</span></h3>
          <div class="plan-tools">
            <label class="small" style="color:var(--muted); display:flex; align-items:center; gap:8px;">Start <input class="input time" type="time" data-action="day-start" data-day="${di}" value="${escapeHtml(getDayStart(di))}" /></label>
            ${mealSelect(di,"lunch","Lunch", pools?.lunchPool)}
            ${mealSelect(di,"dinner","Diner", pools?.dinnerPool)}
            ${mealSelect(di,"cocktail","Cocktails", pools?.cocktailPool)}
            <button class="btn btn-ghost" data-action="reopt-day" data-day="${di}">Heroptimaliseer deze dag</button>
          </div>
          <div class="small" style="color:var(--muted);">
            Reis: ~${day.travelKm.toFixed(1)} km • Bezoek: ~${formatMinutes(day.visitMin)} • Budget: ${formatMinutes(day.budgetMin)}
          </div>
          ${stops.length ? `<ul>${stops.map((x, si)=>`
            <li class="plan-li" data-day="${di}" data-poi="${escapeHtml(x.poi.id)}">
              <div class="li-main">
                <div class="li-title"><span class="pill" style="margin-right:8px;">${escapeHtml(hhmmFromMinutes(timeline[si]?.start||0))}–${escapeHtml(hhmmFromMinutes(timeline[si]?.end||0))}</span>${escapeHtml(x.poi.name)} ${x.poi.type ? `<span class="pill">${escapeHtml(x.poi.type)}</span>` : ""} <span class="pill">${escapeHtml(String(timeline[si]?.dur||""))} min</span></div>
                <div class="small" style="color:var(--muted);">${escapeHtml(x.poi.location?.locality || "")}</div>
              </div>
              <div class="li-tools">
                <input class="input time" type="time" data-action="time" data-day="${di}" data-poi="${escapeHtml(x.poi.id)}" value="${escapeHtml(getManualTime(x.poi.id))}" title="Tijd (optioneel)" />
                <select class="input move" data-action="move-day" data-day="${di}" data-poi="${escapeHtml(x.poi.id)}" title="Verplaats naar dag">
                  ${budgets.map((_,dii)=>`<option value="${dii}" ${dii===di?'selected':''}>Dag ${dii+1}</option>`).join("")}
                </select>
                <button class="btn btn-ghost" data-action="up" data-day="${di}" data-poi="${escapeHtml(x.poi.id)}" title="Omhoog">↑</button>
                <button class="btn btn-ghost" data-action="down" data-day="${di}" data-poi="${escapeHtml(x.poi.id)}" title="Omlaag">↓</button>
                <button class="btn btn-ghost" data-action="remove" data-day="${di}" data-poi="${escapeHtml(x.poi.id)}" title="Uit planning halen">✕</button>
              </div>
            </li>`).join("")}</ul>` : `<div class="small">Geen stops gepland (te weinig tijd of alles al ingepland).</div>`}
          ${stops.length ? mapsButtons(coords) : ""}
        </div>
      `;
  };

  const allStops = plan.days.flatMap(d=>d.stops || []);

  // FIX: use the coords actually used by planner (x.coord), not poi.location.coordinates
  const withCoords = allStops.filter(x => Number.isFinite(x?.coord?.lat) && Number.isFinite(x?.coord?.lon));
  const overallCoords = routeCoordsForDay(origin, withCoords);
  const overallMaps = withCoords.length ? mapsButtons(overallCoords) : "";

  const leftoversHtml = plan.leftovers?.length ? `
      <div class="plan">
        <h3>Overige favorieten <span class="pill">${plan.leftovers.length}</span></h3>
        <div class="small">Deze pasten niet in het gekozen aantal dagen/tijden (of zouden de route erg lang maken).</div>
        <ul>${plan.leftovers.map(x=>`<li>${escapeHtml(x.poi.name)} <span class="pill">${escapeHtml(x.poi.location?.locality || "")}</span></li>`).join("")}</ul>
      </div>
    ` : "";

  return `
      <div class="small">Route is geoptimaliseerd (nearest-neighbor) en verdeeld over dagen op basis van jouw tijdblokken. (Geen openingstijden/tickets meegenomen.)</div>

      <div class="plan" style="margin-top:10px;">
        <h3>Handmatig aanpassen</h3>
        <div class="small" style="color:var(--muted);">Verplaats stops tussen dagen, zet een tijd, of heroptimaliseer per dag. Je wijzigingen worden opgeslagen in je browser.</div>
        <div class="row" style="margin-top:8px;">
          <button class="btn" data-action="reopt-all">Heroptimaliseer alles</button>
          <button class="btn btn-ghost" data-action="restore">Herstel laatste handmatige versie</button>
          <button class="btn btn-ghost" data-action="reset">Reset naar automatische planning</button>
        </div>
      </div>

      ${overallMaps ?  `<div class="plan"><h3>Alles in één route <span class="pill">${withCoords.length} stop(s)</span></h3>${overallMaps}</div>` : ""}
      ${plan.days.map((d,i)=>section(`Dag ${i+1}${slotLabel(i)}`, d, i)).join("")}
      ${leftoversHtml}
    `;
}

/* ---------------- Plan editor (manual tweaks) ---------------- */

// FIX: avoid collision with planKey(ds) used for settings
function planDraftKey(){
  const favIds = Array.from(favs).sort().join(",");
  return `tripkit.plan.${currentDataset}.${favIds}.${__PLAN.days}.${__PLAN.arrival}.${__PLAN.departure}.${__PLAN.includeLunch?'L':''}${__PLAN.includeDinner!==false?'D':''}${__PLAN.includeCocktails?'C':''}`;
}
function savePlanDraft(){
  try{
    if(!__CURRENT_PLAN) return;
    localStorage.setItem(planDraftKey(), JSON.stringify({
      v:1, dataset: currentDataset, saved_at: Date.now(),
      plan: __CURRENT_PLAN.plan,
      origin: __CURRENT_PLAN.origin
    }));
  }catch(_){}
}
function loadPlanDraft(){
  try{
    const raw = localStorage.getItem(planDraftKey());
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj || !obj.plan) return null;
    return obj;
  }catch(_){ return null; }
}

function getDayStart(di){
  const t = __CURRENT_PLAN?.plan?.manual?.dayStarts?.[String(di)];
  if(typeof t === "string" && t) return t;
  const d = __PLAN.days || 3;
  const global = (__PLAN.startTime || "10:00");
  if(di === 0){
    const a = __PLAN.arrival || "afternoon";
    return ({ morning: "10:00", afternoon: "15:00", evening: "20:00" })[a] || "15:00";
  }
  if(di === d-1){
    const dep = __PLAN.departure || "evening";
    return ({ morning: "09:00", afternoon: global, evening: global })[dep] || global;
  }
  return global;
}
function setDayStart(di, hhmm){
  if(!__CURRENT_PLAN) return;
  __CURRENT_PLAN.plan.manual = __CURRENT_PLAN.plan.manual || {};
  __CURRENT_PLAN.plan.manual.dayStarts = __CURRENT_PLAN.plan.manual.dayStarts || {};
  __CURRENT_PLAN.plan.manual.dayStarts[String(di)] = hhmm;
  savePlanDraft();
}
function minutesFromHHMM(hhmm){
  const m = /^([0-2]\d):([0-5]\d)$/.exec(hhmm || "");
  if(!m) return null;
  return (parseInt(m[1],10)*60 + parseInt(m[2],10));
}
function hhmmFromMinutes(mins){
  let m = Math.max(0, Math.round(mins));
  const hh = String(Math.floor(m/60)).padStart(2,"0");
  const mm = String(m%60).padStart(2,"0");
  return `${hh}:${mm}`;
}
function computeTimelineForDay(di, stops){
  const manual = (__CURRENT_PLAN?.plan?.manual?.times) || {};
  let cur = minutesFromHHMM(getDayStart(di));
  if(cur == null) cur = 600;
  const bufferMin = 10;
  const out = [];
  for(const x of (stops || [])){
    const pid = x?.poi?.id;
    const dur = parseTypicalVisitMinutes(x?.poi);
    const mHHMM = pid ? manual[pid] : "";
    if(mHHMM){
      const mm = minutesFromHHMM(mHHMM);
      if(mm != null) cur = mm;
    }
    const start = cur;
    const end = cur + dur;
    out.push({ start, end, dur, poiId: pid });
    cur = end + bufferMin;
  }
  return out;
}

function getManualTime(poiId){
  const t = __CURRENT_PLAN?.plan?.manual?.times?.[poiId];
  return (typeof t === "string") ? t : "";
}
function setManualTime(poiId, hhmm){
  __CURRENT_PLAN.plan.manual = __CURRENT_PLAN.plan.manual || {};
  __CURRENT_PLAN.plan.manual.times = __CURRENT_PLAN.plan.manual.times || {};
  if(hhmm) __CURRENT_PLAN.plan.manual.times[poiId] = hhmm;
  else delete __CURRENT_PLAN.plan.manual.times[poiId];
  savePlanDraft();
  renderCurrentPlan();
}
function computeDayStats(day, origin, speed){
  const stops = day.stops || [];
  let km = 0;
  let visit = 0;
  let cur = origin;
  for(const s of stops){
    if(!s?.coord) continue;
    km += haversineKm(cur, s.coord);
    cur = s.coord;
    visit += parseTypicalVisitMinutes(s.poi);
  }
  if(stops.length){
    km += haversineKm(cur, origin);
  }
  day.travelKm = km;
  day.visitMin = visit;
}
function optimizeDayOrder(day, origin){
  const remaining = (day.stops || []).slice();
  const out = [];
  let cur = origin;
  while(remaining.length){
    let bestIdx = 0;
    let bestD = Infinity;
    for(let i=0;i<remaining.length;i++){
      const d = haversineKm(cur, remaining[i].coord);
      if(d < bestD){ bestD = d; bestIdx = i; }
    }
    const picked = remaining.splice(bestIdx,1)[0];
    out.push(picked);
    cur = picked.coord;
  }
  day.stops = out;
}
function renderCurrentPlan(){
  const panel = document.getElementById("plannerPanel");
  const out = panel?.querySelector("#plannerOutput");
  if(!out || !__CURRENT_PLAN) return;
  out.innerHTML = __CURRENT_PLAN.htmlProvider();
  wirePlanEditor(out);
}
function wirePlanEditor(container){
  if(container.dataset.wired === "1") return;
  container.dataset.wired = "1";

  container.addEventListener("click", (e)=>{
    const btn = e.target.closest("button[data-action]");
    if(!btn) return;
    const action = btn.dataset.action;
    const dayIdx = btn.dataset.day ? parseInt(btn.dataset.day,10) : null;
    const poiId = btn.dataset.poi || null;

    if(!__CURRENT_PLAN) return;

    if(action === "restore"){
      const draft = loadPlanDraft();
      if(draft){
        __CURRENT_PLAN.plan = draft.plan;
        __CURRENT_PLAN.origin = draft.origin;
        // recompute stats
        const speed = avgSpeedKmph(__DOC);
        (__CURRENT_PLAN.plan.days||[]).forEach(d=>computeDayStats(d, __CURRENT_PLAN.origin, speed));
        renderCurrentPlan();
      }
      return;
    }

    if(action === "reset"){
      // remove manual draft for this key
      try{ localStorage.removeItem(planDraftKey()); }catch(_){}
      // re-run planning fresh
      const panel = document.getElementById("plannerPanel");
      panel?.querySelector("#btnPlan")?.click();
      return;
    }

    if(action === "reopt-day" && dayIdx!=null){
      const day = __CURRENT_PLAN.plan.days[dayIdx];
      optimizeDayOrder(day, __CURRENT_PLAN.origin);
      computeDayStats(day, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      savePlanDraft();
      renderCurrentPlan();
      return;
    }

    if(action === "reopt-all"){
      (__CURRENT_PLAN.plan.days||[]).forEach(d=>{
        optimizeDayOrder(d, __CURRENT_PLAN.origin);
        computeDayStats(d, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      });
      savePlanDraft();
      renderCurrentPlan();
      return;
    }

    if(!poiId || dayIdx==null) return;
    const days = __CURRENT_PLAN.plan.days || [];
    const day = days[dayIdx];
    const idx = (day.stops||[]).findIndex(s=>s.poi?.id===poiId);
    if(idx<0) return;

    if(action === "up" && idx>0){
      const tmp = day.stops[idx-1]; day.stops[idx-1]=day.stops[idx]; day.stops[idx]=tmp;
      computeDayStats(day, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      savePlanDraft(); renderCurrentPlan(); return;
    }
    if(action === "down" && idx < day.stops.length-1){
      const tmp = day.stops[idx+1]; day.stops[idx+1]=day.stops[idx]; day.stops[idx]=tmp;
      computeDayStats(day, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      savePlanDraft(); renderCurrentPlan(); return;
    }
    if(action === "remove"){
      const removed = day.stops.splice(idx,1)[0];
      __CURRENT_PLAN.plan.leftovers = __CURRENT_PLAN.plan.leftovers || [];
      __CURRENT_PLAN.plan.leftovers.push(removed);
      computeDayStats(day, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      savePlanDraft(); renderCurrentPlan(); return;
    }
  });

  container.addEventListener("change", (e)=>{
    const mealSel = e.target.closest("select[data-action='meal']");
    if(mealSel){
      const di = Number(mealSel.dataset.day);
      const slot = mealSel.dataset.slot || "";
      setMealChoice(currentDataset, di, slot, mealSel.value);

      if(__CURRENT_PLAN?.plan && __CURRENT_PLAN?.pools){
        // Re-apply meal slots without destroying your manual ordering of the other stops
        insertMealSlotsBerlin(__CURRENT_PLAN.plan, __CURRENT_PLAN.origin, __CURRENT_PLAN.budgets, __CURRENT_PLAN.pools);
        // Recompute stats (distance/time)
        for(let i=0;i<__CURRENT_PLAN.plan.days.length;i++){
          computeDayStats(__CURRENT_PLAN.plan.days[i], __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
        }
      }
      renderCurrentPlan();
      return;
    }

    const sel = e.target.closest("select[data-action='move-day']");
    if(sel){
      const poiId = sel.dataset.poi;
      const fromDay = parseInt(sel.dataset.day,10);
      const toDay = parseInt(sel.value,10);
      if(!__CURRENT_PLAN || !poiId || Number.isNaN(fromDay) || Number.isNaN(toDay) || fromDay===toDay) return;
      const days = __CURRENT_PLAN.plan.days || [];
      const src = days[fromDay];
      const dst = days[toDay];
      const idx = (src.stops||[]).findIndex(s=>s.poi?.id===poiId);
      if(idx<0) return;
      const moved = src.stops.splice(idx,1)[0];
      dst.stops = dst.stops || [];
      dst.stops.push(moved);
      computeDayStats(src, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      computeDayStats(dst, __CURRENT_PLAN.origin, avgSpeedKmph(__DOC));
      savePlanDraft(); renderCurrentPlan();
      return;
    }

    const t = e.target.closest("input[data-action='time']");
    const ds = e.target.closest("input[data-action='day-start']");

    if(ds){
      const di = parseInt(ds.dataset.day,10);
      if(!Number.isNaN(di)) setDayStart(di, ds.value);
      renderCurrentPlan();
      return;
    }
    if(t){
      const poiId = t.dataset.poi;
      if(poiId) setManualTime(poiId, t.value);
    }
  });
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
  PHOTO_STATS.total += 1; renderPhotoCounter();
  a.appendChild(createStarButton(poi.id));

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const noimg = document.createElement("div");
  noimg.className = "noimg placeholder";
  noimg.innerHTML = `<div class="phIcon">📷</div><div class="phText">Foto laden…</div>`;
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

  // If YAML already has an image (from enrich_media.py), use it immediately.
  const preThumb = poi.media?.image?.thumb || poi.media?.image?.url || null;
  if(preThumb){
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = poi.name;
    img.src = preThumb;
    thumb.innerHTML = "";
    thumb.appendChild(img);
    a.dataset.hasPhoto = "1";
    PHOTO_STATS.withPhoto += 1;
    PHOTO_STATS.resolved += 1;
    renderPhotoCounter();
  }
  getBestWikipediaInfo(poi).then((info)=>{
    const alreadyHasImg = (thumb.querySelector("img") !== null);

    if(!info){
      const phText = noimg.querySelector(".phText");
      if(phText) phText.textContent = "Geen foto beschikbaar";
      a.dataset.hasPhoto = alreadyHasImg ? "1" : "0";
      if(!alreadyHasImg){
        PHOTO_STATS.resolved += 1;
      }
      renderPhotoCounter();
      return;
    }

    if(info.pageUrl) a.href = info.pageUrl;

    if(!alreadyHasImg && info.thumbnail){
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = poi.name;
      img.src = info.thumbnail;
      thumb.innerHTML = "";
      thumb.appendChild(img);
      a.dataset.hasPhoto = "1";
      PHOTO_STATS.withPhoto += 1;
    }else{
      if(!alreadyHasImg){
        const phText = noimg.querySelector(".phText");
        if(phText) phText.textContent = "Geen foto beschikbaar";
        a.dataset.hasPhoto = "0";
      }
    }

    if((poi.why_visit || "").length < 40 && info.extract){
      summary.textContent = info.extract;
    }

    if(!alreadyHasImg){
      PHOTO_STATS.resolved += 1;
    }
    renderPhotoCounter();
  });

  return a;
}

/** Theme buckets (UI-level categories)
 * We keep detailed tags in YAML, but present 5 consistent categories in the UI.
 */
const THEME_BUCKETS = [
  { id: "eat-night", label: "Eten & Uitgaan" },
  { id: "culture", label: "Musea & Cultuur" },
  { id: "history", label: "Geschiedenis & Herdenking" },
  { id: "city-outdoors", label: "Wijken & Buiten" },
];

function mapToBuckets(poi){
  const buckets = new Set();
  const t = (poi?.type || "").toLowerCase();
  const themes = (poi?.themes || []).map(x=>String(x).toLowerCase());

  const hasAny = (...keys)=> keys.some(k => themes.includes(k));
  const hasLike = (...subs)=> subs.some(s => themes.some(x=>x.includes(s)));

  // --- Type-driven (your current datasets mainly use `type`) ---
  if(["food","restaurant","cafe","cocktailbar","bar","nightlife"].includes(t)) buckets.add("eat-night");
  if(["museum","palace","landmark","viewpoint","viewpoints"].includes(t)) buckets.add("culture");
  if(["memorial","cemetery","monument","trench","battlefield","fort","site"].includes(t)) buckets.add("history");
  if(["district","park","hotel","town","visitor-centre","visitor-center"].includes(t)) buckets.add("city-outdoors");

  // --- Theme-driven (legacy tags) ---
  if(hasLike("food","night","cocktail","bar","cafe","restaurant","vibe") || hasAny("food","nightlife","cocktails","cocktail","vibe")){
    buckets.add("eat-night");
  }
  if(hasAny("museum","art","modern-art","architecture","street-art") || hasLike("museum","art","architect","gallery")){
    buckets.add("culture");
  }
  if(hasLike("ww1","ww2","cold-war","invasion","battle","front","fortress","trench","holocaust","memorial","remembr","cemetery")){
    buckets.add("history");
  }
  if(hasAny("outdoors") || hasLike("outdoor","park","walk","hike","landscape","trail","district","neighborhood")){
    buckets.add("city-outdoors");
  }

  // Fallback
  if(buckets.size === 0){
    if(["district","park","viewpoint","landmark"].includes(t)) buckets.add("city-outdoors");
    else buckets.add("history");
  }
  return Array.from(buckets);
}

function allBucketOptionsForPois(pois){
  const seen = new Set();
  for(const p of pois){
    for(const b of mapToBuckets(p)) seen.add(b);
  }
  return THEME_BUCKETS.filter(t=>seen.has(t.id)).map(t=>({value:t.id, label:t.label}));
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
    if(v && typeof v === "object"){
      opt.value = String(v.value ?? "");
      opt.textContent = String(v.label ?? v.value ?? "");
    }else{
      opt.value = String(v);
      opt.textContent = String(v);
    }
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
    const catFilter = typeFilter || themeFilter;
    if(catFilter && !(mapToBuckets(p) || []).includes(catFilter)) return false;
    if(q && !poiSearchHaystack(p, regionById).includes(q)) return false;
    return true;
  });

  els.regionsContainer.innerHTML = "";
  resetPhotoStats();
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
  __PLAN = loadPlanSettings(currentDataset);
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
  const cats = THEME_BUCKETS.map(b=>({ value: b.id, label: b.label }));
  buildSelect(els.type, cats, "Alle categorieën");
  buildSelect(els.theme, cats, "Alle categorieën");
  els.region.value = "";
  els.type.value = "";
  els.theme.value = "";

  applyPlannerSettingsUI();

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
  ensurePhotoCounterEl();
  wireGitHubLinks();
  injectStarStylesOnce();
  ensurePlannerPanel();
  applyPlannerSettingsUI();
  wireTabs();

  // controls
  els.search.addEventListener("input", (e)=>{ __STATE.search = e.target.value; render(); });
  els.region.addEventListener("change", (e)=>{ __STATE.region = e.target.value; render(); });
  els.type.addEventListener("change", (e)=>{
    __STATE.type = e.target.value;
    __STATE.theme = e.target.value;
    if(els.theme.value !== e.target.value) els.theme.value = e.target.value;
    render();
  });
  els.theme.addEventListener("change", (e)=>{
    __STATE.theme = e.target.value;
    __STATE.type = e.target.value;
    if(els.type.value !== e.target.value) els.type.value = e.target.value;
    render();
  });
  els.photosOnly.addEventListener("change", (e)=>{ __STATE.photosOnly = e.target.checked; render(); });

  const panel = document.getElementById("plannerPanel");

  // planner settings
  const daysSel = panel.querySelector("#planDays");
  const arrSel = panel.querySelector("#planArrival");
  const depSel = panel.querySelector("#planDeparture");
  const mapSel = panel.querySelector("#planMapProvider");
  const startSel = panel.querySelector("#planStartTime");
  const lunchSel = panel.querySelector("#planIncludeLunch");
  const dinnerSel = panel.querySelector("#planIncludeDinner");
  const cockSel = panel.querySelector("#planIncludeCocktails");

  const persistPlan = ()=>{
    __PLAN = {
      ...__PLAN,
      days: parseInt(daysSel?.value || __PLAN.days, 10) || __PLAN.days,
      arrival: arrSel?.value || __PLAN.arrival,
      departure: depSel?.value || __PLAN.departure,
      mapProvider: mapSel?.value || __PLAN.mapProvider,
      startTime: startSel?.value || __PLAN.startTime,
      includeLunch: lunchSel ? !!lunchSel.checked : __PLAN.includeLunch,
      includeDinner: dinnerSel ? !!dinnerSel.checked : (__PLAN.includeDinner !== false),
      includeCocktails: cockSel ? !!cockSel.checked : __PLAN.includeCocktails,
    };
    savePlanSettings(currentDataset, __PLAN);
    const out = panel.querySelector("#plannerOutput");
    if(out){ out.innerHTML = ""; out.dataset.hasPlan = ""; }
    updatePlannerUI();
  };

  daysSel?.addEventListener("change", persistPlan);
  arrSel?.addEventListener("change", persistPlan);
  depSel?.addEventListener("change", persistPlan);
  mapSel?.addEventListener("change", persistPlan);
  startSel?.addEventListener("change", persistPlan);
  lunchSel?.addEventListener("change", persistPlan);
  dinnerSel?.addEventListener("change", persistPlan);
  cockSel?.addEventListener("change", persistPlan);

  panel.querySelector("#btnClearFavs").addEventListener("click", ()=>{
    favs = new Set();
    saveFavs(currentDataset, favs);
    document.querySelectorAll(".starbtn").forEach(b=> b.innerHTML = "☆");
    const out = document.querySelector("#plannerOutput");
    if(out){ out.innerHTML = ""; out.dataset.hasPlan = ""; }
    updatePlannerUI();
  });

  panel.querySelector("#btnPlan").addEventListener("click", async ()=>{
    const out = panel.querySelector("#plannerOutput");
    out.dataset.hasPlan = "1";
    out.innerHTML = `<div class="small">Coördinaten ophalen en route bouwen…</div>`;
    try{
      out.innerHTML = await buildWeekendPlan();
      try{ wirePlanEditor(out); }catch(_){ }
    }catch(e){
      console.error(e);
      out.innerHTML = `<div class="small">Er ging iets mis bij het maken van de route. Probeer opnieuw.</div>`;
    }
  });

  await loadDataset(currentDataset);
}

main();
