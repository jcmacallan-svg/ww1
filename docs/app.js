/* Data-driven site for GitHub Pages
 * - Loads docs/data/ww1-belgium.yaml
 * - Groups POIs by region
 * - Filters: search, region, type, theme, photos-only
 * - Fetches Wikipedia thumbnails + short summary on demand (best-effort)
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

async function fetchYaml(){
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if(!res.ok) throw new Error(`Cannot fetch YAML (${res.status})`);
  const text = await res.text();
  return jsyaml.load(text);
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

const wikiCache = new Map(); // wikipediaUrl -> { thumbnail, extract }
async function fetchWikiSummary(wikipediaUrl){
  if(!wikipediaUrl) return null;
  if(wikiCache.has(wikipediaUrl)) return wikiCache.get(wikipediaUrl);

  const title = wikiTitleFromUrl(wikipediaUrl);
  if(!title) return null;

  // Prefer matching language of the URL host (en.wikipedia.org / nl.wikipedia.org)
  const host = new URL(wikipediaUrl).host;
  const apiBase = `https://${host}/api/rest_v1/page/summary/`;
  const endpoint = apiBase + encodeURIComponent(title);

  try{
    const res = await fetch(endpoint, { headers: { "accept": "application/json" }});
    if(!res.ok) throw new Error(`wiki ${res.status}`);
    const j = await res.json();
    const out = {
      title: j.title || title,
      extract: j.extract || "",
      thumbnail: j.thumbnail?.source || null,
      page: j.content_urls?.desktop?.page || wikipediaUrl,
    };
    wikiCache.set(wikipediaUrl, out);
    return out;
  }catch(e){
    // fail quietly
    return null;
  }
}

function createCard(poi, regionById){
  const a = document.createElement("a");
  a.className = "card";
  a.href = poi.links?.wikipedia || "#";
  a.target = "_blank";
  a.rel = "noopener";

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

  // Enrich from Wikipedia (thumbnail + extract)
  const wikiUrl = poi.links?.wikipedia;
  if(wikiUrl){
    fetchWikiSummary(wikiUrl).then((info)=>{
      if(!info) {
        noimg.textContent = "Geen foto beschikbaar";
        return;
      }
      // Update link in case of redirect/canonical
      if(info.page) a.href = info.page;

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

      // Prefer Wikipedia extract if YAML why_visit is short/empty
      if((poi.why_visit || "").length < 40 && info.extract){
        summary.textContent = info.extract;
      }
    });
  }else{
    noimg.textContent = "Geen Wikipedia-link";
    a.dataset.hasPhoto = "0";
  }

  return a;
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

  // Render region sections, but only those with POIs after filter
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
  // We'll do a lightweight pass shortly after render.
  if(photosOnly){
    setTimeout(()=>{
      const cards = Array.from(document.querySelectorAll(".card"));
      let visible = 0;
      for(const c of cards){
        const has = c.dataset.hasPhoto;
        if(has === "0"){
          c.classList.add("hidden");
        }else{
          // if still unknown (not set yet), keep for now
          c.classList.remove("hidden");
          visible++;
        }
      }
      setStatus(`Toont (foto-filter) ~${visible} locaties. Sommige thumbnails laden nog…`);
      // second pass a bit later for late loads
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
    // ensure nothing hidden
    Array.from(document.querySelectorAll(".card.hidden")).forEach(el=>el.classList.remove("hidden"));
  }
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
    els.editDataLink.textContent = "Bewerk data (zet repo-URL in app.js)";
    els.viewRepoLink.textContent = "Bekijk repo";
    return;
  }
  const { owner, repo } = info;
  const repoUrl = `https://github.com/${owner}/${repo}`;
  els.viewRepoLink.href = repoUrl;
  els.editDataLink.href = `${repoUrl}/edit/main/docs/data/ww1-belgium.yaml`;
}

async function main(){
  wireGitHubLinks();
  setStatus("Laden van data…");

  let doc;
  try{
    doc = await fetchYaml();
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

  function rerender(){
    render(doc, state);
  }

  // Wire controls
  els.search.addEventListener("input", (e)=>{ state.search = e.target.value; rerender(); });
  els.region.addEventListener("change", (e)=>{ state.region = e.target.value; rerender(); });
  els.type.addEventListener("change", (e)=>{ state.type = e.target.value; rerender(); });
  els.theme.addEventListener("change", (e)=>{ state.theme = e.target.value; rerender(); });
  els.photosOnly.addEventListener("change", (e)=>{ state.photosOnly = e.target.checked; rerender(); });

  rerender();
}

main();
