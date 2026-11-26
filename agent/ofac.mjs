// A second sanctions opinion, straight from the source: the US Treasury's OFAC SDN list.
// Why: in our probes (26 Nov) the Telegraph sanctions miner cleared "PAO Sovcomflot", a listed
// Russian shipping company, and matched "Garantex" to a different company ("GARANT-SV").
// The list also names ~1,570 sanctioned ships, 840 with an MMSI, so the ship is screened too.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FILES = { sdn: "https://www.treasury.gov/ofac/downloads/sdn.csv", alt: "https://www.treasury.gov/ofac/downloads/alt.csv" };
const DAY = 24 * 3600e3;
const DIR = process.env.OFAC_DIR || path.join(process.env.NORTHSTAR_KEYS || path.join(os.homedir(), ".northstar"), "ofac");

// Legal forms and filler words: "PAO Sovcomflot" and "JOINT STOCK COMPANY SOVCOMFLOT" are the same company.
const FILLER = new Set(("PAO OAO ZAO AO PJSC OJSC CJSC JSC NAO JOINT STOCK COMPANY CO CORP CORPORATION INC INCORPORATED LTD LIMITED LLC LLP " +
  "OOO TOO PLC GMBH AG SA SAS SARL SPA SRL BV NV OU AB AS OY PTE PVT PRIVATE PUBLIC LIABILITY THE OF AND HOLDING HOLDINGS GROUP").split(" "));
export function normalize(name) {
  return String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).filter((t) => t && !FILLER.has(t)).join(" ");
}

// Minimal CSV reader for OFAC's files (quoted fields, commas inside quotes, "-0-" for empty).
export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1) rows.push(row); row = []; }
    else f += c;
  }
  if (f || row.length) { row.push(f); if (row.length > 1) rows.push(row); }
  return rows.map((r) => r.map((v) => (v.trim() === "-0-" ? "" : v.trim())));
}

export function buildIndex(sdnText, altText, listDate = null) {
  const byName = new Map(), byMmsi = new Map(), entries = new Map();
  const add = (key, e) => { if (!key) return; if (!byName.has(key)) byName.set(key, []); byName.get(key).push(e); };
  for (const [uid, name, type, program, , , , , , , , remarks = ""] of parseCsv(sdnText)) {
    const e = { uid, name, type: type || "entity", program: program.replace(/[\[\]]/g, "").replace(/\s+/g, " ") };
    entries.set(uid, e); add(normalize(name), e);
    for (const m of remarks.matchAll(/MMSI\s+(\d{9})/g)) byMmsi.set(m[1], e);
  }
  for (const [uid, , , alias] of parseCsv(altText || "")) { const e = entries.get(uid); if (e) add(normalize(alias), { ...e, alias }); }
  return { byName, byMmsi, size: entries.size, listDate };
}

// A company or person: exact match after removing legal forms. Names of 1 short token are too
// loose to trust ("ALFA"), so they are reported as a possible match, not a hit.
export function screenName(index, name) {
  const key = normalize(name);
  const hits = [...new Map((index.byName.get(key) || []).filter((e) => e.type !== "vessel").map((e) => [e.uid, e])).values()];
  const strong = key.replace(/\s/g, "").length >= 5;
  return { source: "OFAC SDN (US Treasury)", listDate: index.listDate, query: name, matched: hits.length > 0 && strong, possible: hits.length > 0 && !strong,
    matches: hits.map((e) => ({ uid: e.uid, name: e.name, alias: e.alias, program: e.program })) };
}

export function screenVessel(index, mmsi) {
  const e = mmsi ? index.byMmsi.get(String(mmsi)) : null;
  return { source: "OFAC SDN (US Treasury)", listDate: index.listDate, mmsi: mmsi ? String(mmsi) : null, matched: !!e, match: e ? { uid: e.uid, name: e.name, program: e.program } : null };
}

let cached = null;
// Downloads the list once a day; keeps the last good copy if the download fails.
export async function loadOfac({ fetchImpl = fetch } = {}) {
  if (cached && Date.now() - cached.loadedAt < DAY) return cached.index;
  fs.mkdirSync(DIR, { recursive: true });
  const file = (k) => path.join(DIR, `${k}.csv`);
  const stale = (k) => !fs.existsSync(file(k)) || Date.now() - fs.statSync(file(k)).mtimeMs > DAY;
  for (const [k, url] of Object.entries(FILES)) {
    if (!stale(k)) continue;
    try { const r = await fetchImpl(url); if (r.ok) { const t = await r.text(); if (t.length > 100000 || k === "alt") fs.writeFileSync(file(k), t); } } catch {}
  }
  if (!fs.existsSync(file("sdn"))) return null;
  const listDate = fs.statSync(file("sdn")).mtime.toISOString().slice(0, 10);
  const index = buildIndex(fs.readFileSync(file("sdn"), "utf8"), fs.existsSync(file("alt")) ? fs.readFileSync(file("alt"), "utf8") : "", listDate);
  cached = { index, loadedAt: Date.now() };
  return index;
}
