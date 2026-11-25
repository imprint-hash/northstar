// Northstar page: reads /api/state, draws the deal list, the bill of lading, the checks and the map.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (s, n = 4) => (s ? `${s.slice(0, n)}…${s.slice(-n)}` : "");
const usd = (n) => `${Number(n || 0).toLocaleString("en-US")} USDC`;
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const tx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const LABEL = { SOURCES_CONFLICT: "Sources disagree: holding", FUNDED: "Funded", SUPPLIER_BLOCKED: "Supplier blocked", AT_SEA: "At sea", ARRIVING: "Arriving", IN_PORT_CONFIRMING: "In port · confirming", STALE_FIX: "Waiting for fresh fix",
  DARK: "Ship went dark", NOT_SEEN: "Not heard yet", NO_ANSWER: "Retrying", UNKNOWN_PORT: "Unknown port", ARRIVED: "Paid on arrival", REFUNDED: "Refunded" };
function pillFor(d) {
  if (d.status === "released") return `<span class="pill paid">Paid</span>`;
  if (d.status === "refunded") return `<span class="pill back">Refunded</span>`;
  if (d.state === "SUPPLIER_BLOCKED" || d.state === "DARK") return `<span class="pill block">${esc(LABEL[d.state])}</span>`;
  return `<span class="pill hold">Holding</span>`;
}
function stage(d) {
  if (d.status === "released") return 5;
  const s = d.state;
  if (s === "IN_PORT_CONFIRMING" || s === "STALE_FIX") return 4;
  if (["AT_SEA", "ARRIVING", "NOT_SEEN", "DARK", "NO_ANSWER"].includes(s)) return 3;
  if (d.supplierCheck?.verdict?.ok) return 3;
  return 2;
}
const lastRound = (d) => [...(d.rounds || [])].reverse().find((r) => r.vessel?.ok && r.vessel.result?.latitude != null);

let state = { deals: [] }, selected = null, map;

function renderList() {
  const el = $("#deals");
  if (!state.deals.length) { el.innerHTML = `<p class="empty">No deals yet. Open a live demo deal above: Northstar picks a real ship that is about to reach a port.</p>`; return; }
  el.innerHTML = state.deals.map((d) => {
    const r = lastRound(d); const dist = r?.verdict?.distanceKm;
    const total = d.origin?.distanceKm || dist || 1;
    const pct = d.status === "released" ? 100 : Math.max(4, Math.min(96, 100 - ((dist ?? total) / total) * 100));
    return `<button class="deal ${d.id === selected ? "active" : ""}" data-id="${esc(d.id)}">
      <div class="row1"><span class="vessel">${esc(d.vessel)}</span>${pillFor(d)}</div>
      <div class="route"><span>AT SEA</span><span class="track"><b style="left:calc(${pct}% - 5px)"></b></span><span>${esc(d.portInfo?.code || d.port)}</span></div>
      <div class="row3"><span>${esc(d.supplier)}</span><span>${usd(d.amount)}</span></div>
    </button>`;
  }).join("");
  el.querySelectorAll(".deal").forEach((b) => b.addEventListener("click", () => { selected = b.dataset.id; lastFit = null; if (shipMk) { shipMk.remove(); shipEl = null; shipMk = null; } render(); }));
}

// Economic value: how soon after the ship stopped in port the supplier was paid.
function paidAfter(d) {
  const firstInPort = (d.rounds || []).find((r) => ["IN_PORT_CONFIRMING", "ARRIVED"].includes(r.verdict?.code));
  if (d.status === "released" && firstInPort) { const m = Math.max(1, Math.round((Date.parse(d.releasedAt) - Date.parse(firstInPort.at)) / 60000)); return `${m} min after the ship stopped in port (open-account terms usually pay 30–60 days later)`; }
  if (d.status === "refunded") return "not paid: no verified arrival";
  return firstInPort ? "ship is in port; paying after a second fix" : "on arrival, minutes after docking (not 30–60 days later)";
}
function renderDetail(d) {
  if (!d) { $("#steps").innerHTML = ""; $("#bl").innerHTML = `<p class="muted">Select a deal.</p>`; $("#timeline").innerHTML = ""; return; }
  const st = stage(d); const blocked = d.state === "SUPPLIER_BLOCKED";
  const names = ["Funded", "Supplier", "At sea", "In port", "Paid"];
  $("#steps").innerHTML = names.map((n, i) => {
    const k = i + 1; const cls = k === 5 && st === 5 ? "paid" : k === 2 && blocked ? "bad" : k < st ? "done" : k === st ? "now" : "";
    return `<div class="step ${cls}"><b>${k}</b>${n}</div>`;
  }).join("");
  const sc = d.supplierCheck?.verdict; const co = sc?.company;
  const r = lastRound(d);
  $("#bl").innerHTML = `
    <div class="bl-top">
      <div><div class="bl-id">DEAL ${esc(d.id)} · <a href="${esc(d.dealUrl)}" target="_blank" rel="noopener">${esc(short(d.address))}</a></div><p class="bl-title">${esc(d.commodity || "Shipment")}</p></div>
      <div class="amount"><b>${usd(d.amount)}</b><span>${d.status === "released" ? "paid to supplier" : d.status === "refunded" ? "returned to buyer" : "locked in escrow"}</span></div>
    </div>
    <div class="legs">
      <div class="leg"><div><div class="dot"></div><div class="bar"></div></div><div><small>Vessel</small><span>${esc(d.vessel)}</span>${r ? ` <span class="muted mono">· ${esc(r.verdict?.distanceKm)} km to release zone · ${esc(r.vessel.result.speed_knots)} kn</span>` : ""}</div></div>
      <div class="leg"><div><div class="dot" style="border-color:var(--paid)"></div></div><div><small>Port of discharge</small><span>${esc(d.portInfo?.name || d.port)} <span class="muted mono">${esc(d.portInfo?.code || "")}</span></span></div></div>
    </div>
    <div class="fields">
      <div><small>Supplier</small><span>${esc(co?.legalName || d.supplier)}</span></div>
      <div><small>Registry</small><span>${co ? `${esc(co.registrationId)} · ${esc(co.jurisdiction)} · ${co.active ? "active" : "inactive"}` : sc ? "no record returned" : "checking…"}</span></div>
      <div><small>Sanctions</small><span>${sc ? (sc.flags.some((f) => f.code === "SANCTIONS_MATCH") ? "MATCH: blocked" : sc.sanctionsClear ? "clear" : "no clear answer") : "checking…"}</span></div>
      <div><small>Deadline (refund after)</small><span>${new Date(d.deadline).toUTCString().slice(5, 22)} UTC</span></div>
      <div><small>Status</small><span>${esc(LABEL[d.state] || d.state)}</span></div>
      <div><small>Buyer protected</small><span>${d.status === "released" ? `${usd(d.amount)} released only after arrival was verified` : d.status === "refunded" ? `${usd(d.amount)} returned: the ship never arrived` : `${usd(d.amount)} cannot move until the ship is verified in port`}</span></div>
      <div><small>Supplier paid</small><span>${paidAfter(d)}</span></div>
      <div><small>Opened</small><span>${d.openTx ? `<a href="${esc(d.openTx.url)}" target="_blank" rel="noopener">${ago(d.createdAt)} ↗</a>` : ago(d.createdAt)}</span></div>
    </div>
    ${d.status === "released" ? `<div class="stamp">PAID ON ARRIVAL</div>` : ""}`;

  const events = [];
  events.push({ cls: "ok", at: d.createdAt, text: `Buyer locked ${usd(d.amount)} for <b>${esc(d.vessel)}</b> → ${esc(d.portInfo?.name || d.port)}.`, meta: d.openTx ? [`<a href="${esc(d.openTx.url)}" target="_blank" rel="noopener">Solana tx ↗</a>`] : [] });
  if (d.supplierCheck) {
    const v = d.supplierCheck.verdict;
    const m = [d.supplierCheck.registry, d.supplierCheck.sanctions].filter(Boolean).map((a) => `${esc(a.miner || "miner")}${a.receipt ? ` · receipt ${esc(short(a.receipt, 6))}` : ""}`);
    events.push({ cls: v.ok ? "ok" : "bad", at: d.supplierCheck.at, text: v.ok ? `Supplier checked: <b>${esc(v.company?.legalName || d.supplier)}</b>${v.company ? ` (${esc(v.company.registrationId)})` : ""} ${v.sanctionsClear ? "is not on sanctions lists." : ""}${v.flags.length ? ` ${v.flags.map((f) => esc(f.text)).join(" ")}` : ""}` : `Supplier blocked: ${v.flags.filter((f) => f.level === "block").map((f) => esc(f.text)).join(" ")} The money stays locked and goes back to the buyer at the deadline.`, meta: m });
  }
  for (const r of d.rounds || []) {
    const v = r.verdict || {};
    const meta = [];
    if (r.vessel) meta.push(`Quay${r.vessel.via === "anjoman" ? " via Anjoman" : ""}${r.vessel.receipt ? ` · receipt ${esc(short(r.vessel.receipt, 6))}` : ""}${r.vessel.ms ? ` · ${(r.vessel.ms / 1000).toFixed(1)} s` : ""}`);
    if (r.corroboration) meta.push(`2nd source: ${esc(r.corroboration.status.toLowerCase())}`);
    if (r.port?.ok) meta.push(`port: ${esc(r.port.result.vessels_waiting)} waiting, ${esc(r.port.result.congestion_level)}`);
    if (r.tx?.url) meta.push(`<a href="${esc(r.tx.url)}" target="_blank" rel="noopener">${v.action === "RELEASE" ? "release" : "on-chain record"} ↗</a>`);
    events.push({ cls: v.action === "RELEASE" ? "paid" : v.code === "DARK" ? "bad" : "", at: r.at, text: esc(v.text || v.code), meta });
  }
  if (d.refundTx?.signature) events.push({ cls: "ok", at: d.events?.at(-1)?.at || d.deadline, text: "Deadline passed without arrival: the buyer was refunded.", meta: [`<a href="${tx(d.refundTx.signature)}" target="_blank" rel="noopener">refund ↗</a>`] });
  $("#timeline").innerHTML = events.reverse().map((e) => `<li class="ev ${e.cls}"><span class="bullet"></span><div><p>${e.text}</p><div class="meta"><span>${ago(e.at)}</span>${e.meta.map((m) => `<span>${m}</span>`).join("")}</div></div></li>`).join("");
}

function nearestZone(d, s) {
  const zs = d.portInfo.zones || [{ lat: d.portInfo.lat, lon: d.portInfo.lon }];
  const dd = (z) => (z.lat - s[0]) ** 2 + ((z.lon - s[1]) * Math.cos(s[0] * Math.PI / 180)) ** 2;
  const z = zs.reduce((a, b) => (dd(b) < dd(a) ? b : a)); return [z.lat, z.lon];
}
const circle = (lat, lon, km, n = 72) => { const pts = []; for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([lon + (km / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.sin(a), lat + (km / 110.57) * Math.cos(a)]); } return pts; };
// Dead reckoning: from the last AIS fix, sail on at the reported speed and course (capped at 15 min).
function estimate(fix) {
  const v = fix.result; const sp = v.speed_knots || 0, cog = v.course_deg;
  const mins = Math.min(15, Math.max(0, (Date.now() - Date.parse(v.observed_at)) / 60000));
  if (sp < 0.5 || cog == null) return { lat: v.latitude, lon: v.longitude, moved: 0 };
  const km = sp * 1.852 * (mins / 60), a = cog * Math.PI / 180;
  return { lat: v.latitude + (km / 110.57) * Math.cos(a), lon: v.longitude + (km / (111.32 * Math.cos(v.latitude * Math.PI / 180))) * Math.sin(a), moved: km };
}
const SHIP_SVG = `<svg class="hull" viewBox="0 0 34 34"><path d="M17 3 C20 7 21 11 21 15 L21 28 Q17 31 13 28 L13 15 C13 11 14 7 17 3 Z" fill="#EAF7FF" stroke="#0B2236" stroke-width="1"/><rect x="14.6" y="12" width="4.8" height="3" rx=".6" fill="#3DDC97"/><rect x="14.6" y="16.5" width="4.8" height="3" rx=".6" fill="#F2B84B"/><rect x="14.6" y="21" width="4.8" height="3" rx=".6" fill="#7FD4F5"/><rect x="15" y="25" width="4" height="2.2" rx=".5" fill="#0B2236"/></svg>`;
let shipEl, shipMk, mapReady = false, current = null, lastFit = null;

function initMap() {
  map = new maplibregl.Map({ container: "map", attributionControl: { compact: true }, center: [5, 40], zoom: 2.2, pitch: 55, bearing: -15, maxPitch: 75,
    style: { version: 8,
      sources: {
        sat: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 17, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
        dem: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, encoding: "terrarium", maxzoom: 12, attribution: "Terrain: Mapzen / AWS Open Data" } },
      layers: [{ id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.25, "raster-brightness-max": 0.85, "raster-contrast": 0.1 } }],
      sky: { "sky-color": "#06121F", "horizon-color": "#163a5c", "fog-color": "#0A1B2D", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.4 } } });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.on("load", () => {
    map.setTerrain({ source: "dem", exaggeration: 1.4 });
    map.addSource("zones", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "zone-fill", type: "fill", source: "zones", paint: { "fill-color": "#3DDC97", "fill-opacity": 0.1 } });
    map.addLayer({ id: "zone-line", type: "line", source: "zones", paint: { "line-color": "#3DDC97", "line-width": 1.6, "line-dasharray": [2, 2] } });
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#7FD4F5", "line-width": 2, "line-dasharray": [1, 2.5], "line-opacity": 0.9 } });
    map.addSource("trail", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "trail", type: "circle", source: "trail", paint: { "circle-radius": 3, "circle-color": "#7FD4F5", "circle-opacity": 0.55, "circle-stroke-width": 1, "circle-stroke-color": "#06121F" } });
    mapReady = true; if (current) renderMap(current, true);
  });
  // move the ship a little every second (dead reckoning between fixes)
  setInterval(() => { if (current) placeShip(current, false); }, 1000);
}

function placeShip(d, fit) {
  const r = lastRound(d); if (!r || !mapReady) return;
  const e = estimate(r.vessel);
  if (!shipEl) { shipEl = document.createElement("div"); shipEl.className = "ship"; shipEl.innerHTML = `<span class="ping"></span><span class="wake"></span>${SHIP_SVG}`; shipMk = new maplibregl.Marker({ element: shipEl, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([e.lon, e.lat]).addTo(map); }
  shipMk.setLngLat([e.lon, e.lat]).setRotation(r.vessel.result.course_deg || 0);
  shipEl.querySelector(".wake").style.opacity = (r.vessel.result.speed_knots || 0) > 0.5 ? 1 : 0;
  const z = nearestZone(d, [e.lat, e.lon]);
  map.getSource("route")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: [[e.lon, e.lat], [z[1], z[0]]] } });
  $("#mapNote").textContent = e.moved > 0.05 ? `Ship position estimated from its last AIS fix (${ago(r.vessel.result.observed_at)}) at ${r.vessel.result.speed_knots} kn, course ${Math.round(r.vessel.result.course_deg)}°.` : `Last AIS fix ${ago(r.vessel.result.observed_at)}.`;
  if (fit) {
    const b = new maplibregl.LngLatBounds([e.lon, e.lat], [e.lon, e.lat]); b.extend([z[1], z[0]]);
    map.fitBounds(b, { padding: { top: 90, bottom: 140, left: 60, right: 60 }, maxZoom: 11.5, pitch: 58, bearing: (r.vessel.result.course_deg || 0) - 20, duration: 2400 });
  }
}

function renderMap(d, force) {
  current = d;
  const card = $("#mapCard");
  if (!d) { card.innerHTML = ""; return; }
  const r = lastRound(d); const v = r?.verdict;
  card.innerHTML = `<div class="vname"><b>${esc(d.vessel)}</b><span>${d.mmsi ? "MMSI " + esc(d.mmsi) + " · " : ""}to ${esc(d.portInfo?.name || d.port)}</span></div>
    <div><small>To release zone</small><b>${v?.distanceKm ?? "–"} km</b></div><div><small>Speed</small><b>${r ? r.vessel.result.speed_knots + " kn" : "–"}</b></div>
    <div><small>Last AIS fix</small><b>${r ? ago(r.vessel.result.observed_at) : "–"}</b></div><div><small>Escrow</small><b style="color:${d.status === "released" ? "var(--paid)" : d.status === "refunded" ? "var(--muted)" : "var(--hold)"}">${d.status === "released" ? "Paid" : d.status === "refunded" ? "Refunded" : "Holding"}</b></div>`;
  if (!map) initMap();
  if (!mapReady || !d.portInfo?.lat) return;
  const zones = d.portInfo.zones || [{ lat: d.portInfo.lat, lon: d.portInfo.lon, radiusKm: d.portInfo.radiusKm }];
  map.getSource("zones").setData({ type: "FeatureCollection", features: zones.map((z) => ({ type: "Feature", properties: { name: z.name }, geometry: { type: "Polygon", coordinates: [circle(z.lat, z.lon, z.radiusKm)] } })) });
  // earlier fixes of this ship (skip any far from the latest one: before the MMSI fix, a same-named ship was asked once)
  const near = (x) => !r || Math.abs(x.vessel.result.latitude - r.vessel.result.latitude) + Math.abs(x.vessel.result.longitude - r.vessel.result.longitude) < 3;
  const trail = (d.rounds || []).filter((x) => x.vessel?.ok && x.vessel.result?.latitude != null && near(x)).map((x) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x.vessel.result.longitude, x.vessel.result.latitude] } }));
  map.getSource("trail").setData({ type: "FeatureCollection", features: trail });
  const key = d.id + ":" + (d.rounds || []).length;
  if (!r) { if (force || lastFit !== key) map.flyTo({ center: [d.portInfo.lon, d.portInfo.lat], zoom: 9, pitch: 58, duration: 2000 }); lastFit = key; if (shipMk) { shipMk.remove(); shipEl = null; shipMk = null; } return; }
  placeShip(d, force || lastFit !== key); lastFit = key;
}

function render() {
  if (!selected && state.deals.length) selected = state.deals[0].id;
  renderList();
  const d = state.deals.find((x) => x.id === selected);
  renderDetail(d); renderMap(d, false);
  const paid = state.deals.filter((x) => x.status === "released").length;
  const held = state.deals.filter((x) => x.status === "open").reduce((a, x) => a + x.amount, 0);
  const checks = state.deals.reduce((a, x) => a + (x.rounds || []).length * 2 + (x.supplierCheck ? 2 : 0), 0);
  $("#stPaid").textContent = paid; $("#stHeld").textContent = usd(held); $("#stChecks").textContent = checks;
  $("#tick").textContent = `agent every ${state.tickMinutes || 15} min`;
  if (state.chain?.program) { const a = $("#progLink"); a.textContent = state.chain.program; a.href = `https://explorer.solana.com/address/${state.chain.program}?cluster=devnet`; }
}

async function load() {
  try { const r = await fetch("api/state", { cache: "no-store" }); state = await r.json(); render(); }
  catch { $("#deals").innerHTML = `<p class="empty">Could not reach the Northstar agent. Retrying…</p>`; }
}

$("#demoBtn").addEventListener("click", async () => {
  const b = $("#demoBtn"), n = $("#demoNote");
  b.disabled = true; n.textContent = "Finding a real ship about to reach a port, then locking test USDC on Solana…";
  try {
    const r = await fetch("api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    if (!r.ok) n.textContent = j.error || "Could not open a demo deal.";
    else { n.innerHTML = `Opened: ${esc(j.vessel)} → ${esc(j.port)}, ${usd(j.amount)} locked. Supplier and ship checks start now.`; selected = j.id; await load(); location.hash = "app"; }
  } catch { n.textContent = "Could not reach the agent."; }
  b.disabled = false;
});

load(); setInterval(load, 20000);
