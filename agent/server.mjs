// Northstar server: serves the web page, a read-only API of deals, and "open a live demo deal",
// and runs the agent loop every few minutes. Binds to 127.0.0.1 (Caddy terminates HTTPS in front).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { load, save } from "./store.mjs";
import { tick } from "./run.mjs";
import { keypair, openDeal, readDeal, explorer } from "./chain.mjs";
import { findPort } from "./verify.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WEB = path.join(ROOT, "web");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "data/chain.json"), "utf8"));
const PORT = Number(process.env.PORT || 8090);
const QUAY_LOCAL = process.env.QUAY_LOCAL || "http://127.0.0.1:8080";
const TICK_MIN = Number(process.env.TICK_MINUTES || 15);
const MAX_OPEN = Number(process.env.MAX_OPEN_DEALS || 4);
const DEMO_GAP_MIN = Number(process.env.DEMO_GAP_MINUTES || 10);
const SUPPLIERS = JSON.parse(fs.readFileSync(path.join(ROOT, "agent/suppliers.json"), "utf8"));
const DEMO_PORTS = ["Los Angeles", "Rotterdam", "Antwerp", "Singapore", "Hamburg", "Felixstowe", "Busan", "Algeciras"];
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", json: "application/json", png: "image/png", webp: "image/webp", ico: "image/x-icon" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": type === "application/json" ? "no-store" : "public, max-age=300" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// What the page needs: no keys, no raw Telegraph payment headers.
function publicDeal(d) {
  return { id: d.id, address: d.address, status: d.status, state: d.state, vessel: d.vessel, mmsi: d.mmsi || null, port: d.port, supplier: d.supplier, supplierCountry: d.supplierCountry,
    commodity: d.commodity, amount: d.amount, createdAt: d.createdAt, deadline: d.deadline, openTx: d.openTx, explorer: explorer(""), dealUrl: `https://explorer.solana.com/address/${d.address}?cluster=devnet`, releaseTx: d.releaseTx, releasedAt: d.releasedAt,
    origin: d.origin, demo: !!d.demo, portInfo: (({ code, names, lat, lon, radiusKm, zones }) => ({ code, name: names[0], lat, lon, radiusKm, zones }))(findPort(d.port) || { names: [d.port] }), refundTx: d.refundTx, events: d.events,
    supplierCheck: d.supplierCheck && { at: d.supplierCheck.at, verdict: d.supplierCheck.verdict,
      registry: pick(d.supplierCheck.registry), sanctions: pick(d.supplierCheck.sanctions) },
    rounds: (d.rounds || []).map((r) => ({ at: r.at, verdict: r.verdict, evidence: r.evidence, tx: r.tx?.signature ? { signature: r.tx.signature, url: explorer(r.tx.signature) } : r.tx?.error ? { error: r.tx.error } : null,
      vessel: pick(r.vessel), port: pick(r.port), second: pick(r.second), corroboration: r.corroboration || null })) };
}
const pick = (a) => a && { ok: a.ok, via: a.via || "x402", miner: a.miner, minerId: a.minerId, result: a.result, receipt: a.receipt, epoch: a.epoch, priceUsdc: a.priceUsdc, ms: a.ms, error: a.error };

async function quayJson(p) { const r = await fetch(QUAY_LOCAL + p, { signal: AbortSignal.timeout(10000) }); return r.json(); }

async function openDemo(body) {
  const db = load();
  const open = db.deals.filter((d) => d.status === "open");
  if (open.length >= MAX_OPEN) return [429, { error: `${open.length} deals are already open. Watch one settle, or try again later.` }];
  const last = Math.max(0, ...db.deals.filter((d) => d.demo).map((d) => Date.parse(d.createdAt)));
  if (Date.now() - last < DEMO_GAP_MIN * 60000) return [429, { error: `A demo deal opened ${Math.round((Date.now() - last) / 60000)} min ago. One every ${DEMO_GAP_MIN} min keeps the test wallet alive.` }];
  const ports = body.port ? [body.port] : [...DEMO_PORTS].sort(() => Math.random() - 0.5);
  let pick = null;
  for (const port of ports) {
    const a = await quayJson(`/approaching?port=${encodeURIComponent(port)}&limit=5`).catch(() => null);
    const s = a?.inbound?.find((x) => x.hours_to_port_area <= 3 && !open.some((d) => d.vessel === x.name));
    if (s) { pick = { port: a.port, ship: s }; break; }
  }
  if (!pick) return [503, { error: "No cargo ship is inbound to a covered port right now. Try again in a few minutes." }];
  const sup = SUPPLIERS[Math.floor(Math.random() * SUPPLIERS.length)];
  const amount = sup.amount;
  const dealId = Date.now();
  const deadline = Math.floor(Date.now() / 1000) + 2 * 86400;
  const r = await openDeal({ buyer: keypair("buyer"), seller: CFG.seller, verifier: CFG.verifier, mint: CFG.mint, dealId, amount: amount * 1e6, vessel: pick.ship.name, port: pick.port, deadline });
  const deal = { id: String(dealId), address: r.deal, mint: CFG.mint, buyer: CFG.buyer, seller: CFG.seller, status: "open", state: "FUNDED", vessel: pick.ship.name, mmsi: pick.ship.mmsi,
    port: pick.port, supplier: sup.name, supplierCountry: sup.country, commodity: sup.commodity, amount, createdAt: new Date().toISOString(), deadline: new Date(deadline * 1000).toISOString(),
    openTx: { signature: r.signature, url: r.url }, origin: { distanceKm: pick.ship.distance_km, hoursToPort: pick.ship.hours_to_port_area, destinationReported: pick.ship.destination }, demo: true, rounds: [] };
  db.deals.unshift(deal); save(db);
  setTimeout(() => runTick(), 2000); // first checks right away
  return [200, publicDeal(deal)];
}

let ticking = false;
async function runTick() {
  if (ticking) return; ticking = true;
  try { await tick((l) => console.log(new Date().toISOString(), l)); } catch (e) { console.error("tick failed", e.message); } finally { ticking = false; }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/state") {
      const db = load();
      return send(res, 200, { chain: { ...CFG, cluster: "devnet" }, tickMinutes: TICK_MIN, deals: db.deals.slice(0, 30).map(publicDeal) });
    }
    if (u.pathname === "/api/chain-deal") return send(res, 200, await readDeal(u.searchParams.get("address")));
    if (u.pathname === "/api/demo" && req.method === "POST") {
      let raw = ""; for await (const c of req) { raw += c; if (raw.length > 2000) break; }
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
      const [c, b] = await openDemo(body); return send(res, c, b);
    }
    let f = path.normalize(path.join(WEB, u.pathname === "/" ? "index.html" : u.pathname));
    if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, { error: "not found" });
    return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f).slice(1)] || "application/octet-stream");
  } catch (e) { return send(res, 500, { error: e.message }); }
}).listen(PORT, "127.0.0.1", () => console.log(`northstar on 127.0.0.1:${PORT}, agent every ${TICK_MIN} min`));

setInterval(runTick, TICK_MIN * 60000);
setTimeout(runTick, 5000);
