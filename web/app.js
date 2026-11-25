// Northstar page: reads /api/state, draws the deal list, the bill of lading, the checks and the map.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (s, n = 4) => (s ? `${s.slice(0, n)}…${s.slice(-n)}` : "");
const usd = (n) => `${Number(n || 0).toLocaleString("en-US")} USDC`;
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const tx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const LABEL = { FUNDED: "Funded", SUPPLIER_BLOCKED: "Supplier blocked", AT_SEA: "At sea", ARRIVING: "Arriving", IN_PORT_CONFIRMING: "In port · confirming", STALE_FIX: "Waiting for fresh fix",
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

let state = { deals: [] }, selected = null, map, shipMarker, portCircle, routeLine;

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
  el.querySelectorAll(".deal").forEach((b) => b.addEventListener("click", () => { selected = b.dataset.id; render(); }));
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
      <div class="leg"><div><div class="dot"></div><div class="bar"></div></div><div><small>Vessel</small><span>${esc(d.vessel)}</span>${r ? ` <span class="muted mono">· ${esc(r.verdict?.distanceKm)} km from port · ${esc(r.vessel.result.speed_knots)} kn</span>` : ""}</div></div>
      <div class="leg"><div><div class="dot" style="border-color:var(--paid)"></div></div><div><small>Port of discharge</small><span>${esc(d.portInfo?.name || d.port)} <span class="muted mono">${esc(d.portInfo?.code || "")}</span></span></div></div>
    </div>
    <div class="fields">
      <div><small>Supplier</small><span>${esc(co?.legalName || d.supplier)}</span></div>
      <div><small>Registry</small><span>${co ? `${esc(co.registrationId)} · ${esc(co.jurisdiction)} · ${co.active ? "active" : "inactive"}` : sc ? "no record returned" : "checking…"}</span></div>
      <div><small>Sanctions</small><span>${sc ? (sc.flags.some((f) => f.code === "SANCTIONS_MATCH") ? "MATCH: blocked" : sc.sanctionsClear ? "clear" : "no clear answer") : "checking…"}</span></div>
      <div><small>Deadline (refund after)</small><span>${new Date(d.deadline).toUTCString().slice(5, 22)} UTC</span></div>
      <div><small>Status</small><span>${esc(LABEL[d.state] || d.state)}</span></div>
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
    if (r.vessel) meta.push(`Quay${r.vessel.receipt ? ` · receipt ${esc(short(r.vessel.receipt, 6))}` : ""}${r.vessel.ms ? ` · ${(r.vessel.ms / 1000).toFixed(1)} s` : ""}`);
    if (r.port?.ok) meta.push(`port: ${esc(r.port.result.vessels_waiting)} waiting, ${esc(r.port.result.congestion_level)}`);
    if (r.tx?.url) meta.push(`<a href="${esc(r.tx.url)}" target="_blank" rel="noopener">${v.action === "RELEASE" ? "release" : "on-chain record"} ↗</a>`);
    events.push({ cls: v.action === "RELEASE" ? "paid" : v.code === "DARK" ? "bad" : "", at: r.at, text: esc(v.text || v.code), meta });
  }
  if (d.refundTx?.signature) events.push({ cls: "ok", at: d.events?.at(-1)?.at || d.deadline, text: "Deadline passed without arrival: the buyer was refunded.", meta: [`<a href="${tx(d.refundTx.signature)}" target="_blank" rel="noopener">refund ↗</a>`] });
  $("#timeline").innerHTML = events.reverse().map((e) => `<li class="ev ${e.cls}"><span class="bullet"></span><div><p>${e.text}</p><div class="meta"><span>${ago(e.at)}</span>${e.meta.map((m) => `<span>${m}</span>`).join("")}</div></div></li>`).join("");
}

function renderMap(d) {
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([30, 0], 2);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 17, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }).addTo(map);
  }
  [shipMarker, portCircle, routeLine].forEach((l) => l && map.removeLayer(l));
  const card = $("#mapCard");
  if (!d || !d.portInfo?.lat) { card.innerHTML = ""; return; }
  const p = [d.portInfo.lat, d.portInfo.lon];
  portCircle = L.circle(p, { radius: d.portInfo.radiusKm * 1000, color: "#3DDC97", weight: 1.5, fillOpacity: 0.08, dashArray: "4 6" }).addTo(map).bindTooltip(`${d.portInfo.name}: release zone`);
  const r = lastRound(d);
  if (r) {
    const s = [r.vessel.result.latitude, r.vessel.result.longitude];
    shipMarker = L.marker(s, { icon: L.divIcon({ className: "", html: `<div class="ship-ico"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map).bindTooltip(`${d.vessel} · ${r.vessel.result.speed_knots} kn`);
    routeLine = L.polyline([s, p], { color: "#7FD4F5", weight: 2, dashArray: "6 8" }).addTo(map);
    map.fitBounds(L.latLngBounds([s, p]).pad(0.6), { maxZoom: 10 });
  } else map.setView(p, 9);
  const v = r?.verdict;
  card.innerHTML = `<div><small>Distance to port</small><b>${v?.distanceKm ?? "–"} km</b></div><div><small>Speed</small><b>${r ? r.vessel.result.speed_knots + " kn" : "–"}</b></div>
    <div><small>Last AIS fix</small><b>${r ? ago(r.vessel.result.observed_at) : "–"}</b></div><div><small>Escrow</small><b style="color:${d.status === "released" ? "var(--paid)" : "var(--hold)"}">${d.status === "released" ? "Paid" : d.status === "refunded" ? "Refunded" : "Holding"}</b></div>`;
}

function render() {
  if (!selected && state.deals.length) selected = state.deals[0].id;
  renderList();
  const d = state.deals.find((x) => x.id === selected);
  renderDetail(d); renderMap(d);
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
