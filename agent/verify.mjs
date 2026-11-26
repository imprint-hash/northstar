// Northstar's judgement. Pure functions: given what Telegraph's miners said, decide what to do
// with the buyer's money. Three outcomes: RELEASE (the ship is at the destination port),
// HOLD (not yet, or something is wrong), and the buyer's own REFUND after the deadline.
import { createRequire } from "node:module";
const PORTS = createRequire(import.meta.url)("./ports.cjs");

// Quay's zones are drawn around anchorages (where ships queue). Where the berths sit far from
// them (river ports), Northstar adds berth zones so a ship moored at the docks also counts as arrived.
const BERTHS = {
  DEHAM: [{ name: "Hamburg docks", lat: 53.53, lon: 9.93, radiusKm: 14 }],
  CNSHA: [{ name: "Waigaoqiao", lat: 31.36, lon: 121.6, radiusKm: 15 }],
  USHOU: [{ name: "Port of Houston terminals", lat: 29.72, lon: -95.15, radiusKm: 20 }],
};
export function findPort(q) {
  const s = String(q || "").trim().toUpperCase();
  const p = PORTS.find((x) => x.code === s || x.names.some((n) => n.toUpperCase() === s));
  if (!p) return null;
  return { ...p, zones: [{ name: `${p.names[0]} anchorage`, lat: p.lat, lon: p.lon, radiusKm: p.radiusKm }, ...(BERTHS[p.code] || [])] };
}
// Distance from a point to the nearest release zone (0 = inside one).
export function zoneDistance(port, lat, lon) {
  let best = { inside: false, km: Infinity, zone: null };
  for (const z of port.zones) {
    const d = km(lat, lon, z.lat, z.lon);
    const out = Math.max(0, d - z.radiusKm);
    if (out < best.km || (out === 0 && !best.inside)) best = { inside: d <= z.radiusKm, km: out, centreKm: d, zone: z.name };
  }
  return best;
}

export function km(a, b, c, d) {
  const p = Math.PI / 180, x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

// Supplier checks at the start of a deal (company registry + sanctions screening).
// A missing answer is a warning; only a positive finding (not registered, inactive, sanctioned) blocks.
export function judgeSupplier(registry, sanctions, ofac = null, ofacVessel = null) {
  const flags = [];
  const reg = registry?.result || {};
  if (!registry?.ok) flags.push({ level: "warn", code: "REGISTRY_UNAVAILABLE", text: "The company registry check did not answer." });
  else if (!reg.registration_id) flags.push({ level: "warn", code: "REGISTRY_NO_RECORD", text: `No registry record returned for ${reg.legal_name || "the supplier"}.` });
  else if (reg.active === false) flags.push({ level: "block", code: "COMPANY_INACTIVE", text: `${reg.legal_name} (${reg.registration_id}) is not active in the registry.` });
  const san = sanctions?.result || {};
  if (!sanctions?.ok || san.matched == null) flags.push({ level: "warn", code: "SANCTIONS_UNAVAILABLE", text: "Sanctions screening gave no clear answer." });
  else if (san.matched === true) flags.push({ level: "block", code: "SANCTIONS_MATCH", text: `Sanctions match: ${(san.matches || []).join(", ") || san.name}.` });
  // Official OFAC SDN list as a second opinion: a listed name blocks even if the miner cleared it.
  const listed = (ofac?.matches || []).map((m) => m.name);
  if (ofac?.matched) flags.push({ level: "block", code: "OFAC_SDN_MATCH", text: `On the US Treasury OFAC SDN list: ${listed.join(", ")} (${ofac.matches[0].program}).` });
  else if (ofac?.possible) flags.push({ level: "warn", code: "OFAC_POSSIBLE", text: `Short name resembles an OFAC SDN entry (${listed.join(", ")}); review by hand.` });
  if (ofac?.matched && sanctions?.ok && san.matched === false) flags.push({ level: "warn", code: "SANCTIONS_SOURCES_DISAGREE", text: "The Telegraph sanctions miner cleared this name, but the official OFAC list has it." });
  if (ofacVessel?.matched) flags.push({ level: "block", code: "VESSEL_SANCTIONED", text: `The ship (MMSI ${ofacVessel.mmsi}) is on the OFAC SDN list as ${ofacVessel.match.name} (${ofacVessel.match.program}).` });
  const found = registry?.ok && reg.registration_id ? { legalName: reg.legal_name, registrationId: reg.registration_id, jurisdiction: reg.jurisdiction, active: reg.active, incorporated: reg.incorporated } : null;
  return { ok: !flags.some((f) => f.level === "block"), company: found, sanctionsClear: san.matched === false && !ofac?.matched && !ofacVessel?.matched, ofacChecked: !!ofac, flags };
}

const STOPPED_KN = 1, FRESH_MIN = 60, CONFIRM_MIN = 30, DARK_MIN = 360;

// Where is the ship relative to the deal's port, from one Quay answer (via Telegraph).
export function position(deal, vessel) {
  const dest = findPort(deal.port);
  const v = vessel?.result;
  if (!dest || !vessel?.ok || v?.latitude == null) return null;
  const ageMin = (Date.now() - Date.parse(v.observed_at)) / 60000;
  const z = zoneDistance(dest, v.latitude, v.longitude);
  return { dest, distanceKm: Math.round(z.km * 10) / 10, zone: z.zone, ageMinutes: Math.round(ageMin), speed: v.speed_knots, observedAt: v.observed_at,
    inPort: z.inside, stopped: v.speed_knots != null && v.speed_knots < STOPPED_KN };
}

// One check of the ship against the deal. RELEASE needs two fresh fixes, at least 30 minutes apart,
// both showing the ship stopped inside the destination port area. Everything else holds the money.
export function judgeVoyage(deal, vessel, port, history = []) {
  const dest = findPort(deal.port);
  if (!dest) return { action: "HOLD", code: "UNKNOWN_PORT", text: `${deal.port} is not one of the ports Northstar can verify.` };
  if (!vessel?.ok) return { action: "HOLD", code: "NO_ANSWER", text: "Quay did not answer this round; checking again next round." };
  const p = position(deal, vessel);
  if (!p) return { action: "HOLD", code: "NOT_SEEN", text: `No AIS position heard for ${deal.vessel}. Holding until it is heard.` };
  const base = { distanceKm: p.distanceKm, ageMinutes: p.ageMinutes, speed: p.speed, observedAt: p.observedAt };
  const name = deal.vessel;
  if (p.ageMinutes > DARK_MIN) return { ...base, action: "HOLD", code: "DARK", text: `${name} has not been heard for ${Math.round(p.ageMinutes / 60)} h. Holding: a ship that goes dark is a risk signal.` };
  const c = port?.ok ? port.result : null;
  const portNote = c ? ` ${c.vessels_waiting} ships waiting at ${dest.names[0]}, congestion ${c.congestion_level}.` : "";
  if (!p.inPort) return { ...base, action: "HOLD", code: "AT_SEA", text: `${name} is ${p.distanceKm} km from the ${dest.names[0]} release zone, ${p.speed ?? "?"} kn.${portNote}` };
  if (!p.stopped) return { ...base, action: "HOLD", code: "ARRIVING", text: `${name} is inside ${dest.names[0]} and still moving (${p.speed} kn).${portNote}` };
  if (p.ageMinutes > FRESH_MIN) return { ...base, action: "HOLD", code: "STALE_FIX", text: `${name} was stopped at ${dest.names[0]}, but that fix is ${p.ageMinutes} min old. Waiting for a fresh one.` };
  // The earlier fix must be a different AIS report, heard at least 30 min before the current one
  // (not the same report seen again on a later round: a ship that stops transmitting proves nothing).
  const nowObs = Date.parse(p.observedAt);
  const earlier = history.map((h) => ({ at: Date.parse(h.at), p: position(deal, h.vessel) }))
    .find((h) => h.p && h.p.inPort && h.p.stopped && nowObs - Date.parse(h.p.observedAt) >= CONFIRM_MIN * 60000);
  if (!earlier) return { ...base, action: "HOLD", code: "IN_PORT_CONFIRMING", text: `${name} is stopped inside ${p.zone}. Confirming with a second fix in ${CONFIRM_MIN} min before paying.${portNote}` };
  return { ...base, action: "RELEASE", code: "ARRIVED", text: `${name} has been stopped inside ${p.zone} on two AIS reports ${Math.round((nowObs - Date.parse(earlier.p.observedAt)) / 60000)} min apart (latest ${p.ageMinutes} min old). Paying the supplier.` };
}

// Second opinion before paying: another Telegraph miner's fix for the same ship. Most vessel miners
// only cover some waters, so "no answer" is noted, not blocking. A fresh fix that disagrees with
// Quay by more than 5 km blocks the release until the sources agree.
export function judgeCorroboration(primary, second) {
  const a = primary?.result, b = second?.result;
  if (!second?.ok || b?.latitude == null || b?.longitude == null) return { status: "UNAVAILABLE", text: "No second vessel source covers this ship right now; relying on Quay alone." };
  const lat = Math.abs(b.latitude) <= 90 ? b.latitude : null;
  if (lat == null) return { status: "UNAVAILABLE", text: `${second.miner || "Second source"} returned an impossible position; ignored.` };
  const d = km(a.latitude, a.longitude, b.latitude, b.longitude);
  const gapMin = b.observed_at ? Math.abs(Date.parse(a.observed_at) - Date.parse(b.observed_at)) / 60000 : null;
  const allowed = 5 + (gapMin != null ? ((a.speed_knots || 0) * 1.852 * gapMin) / 60 : 0);
  if (d <= allowed) return { status: "AGREE", km: Math.round(d * 100) / 100, text: `${second.miner || "A second source"} agrees: ${Math.round(d * 100) / 100} km apart.` };
  return { status: "CONFLICT", km: Math.round(d * 10) / 10, text: `${second.miner || "A second source"} puts the ship ${Math.round(d * 10) / 10} km from Quay's fix. Holding until the sources agree.` };
}
