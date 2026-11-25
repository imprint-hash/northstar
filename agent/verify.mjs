// Northstar's judgement. Pure functions: given what Telegraph's miners said, decide what to do
// with the buyer's money. Three outcomes: RELEASE (the ship is at the destination port),
// HOLD (not yet, or something is wrong), and the buyer's own REFUND after the deadline.
import { createRequire } from "node:module";
const PORTS = createRequire(import.meta.url)("./ports.cjs");

export function findPort(q) {
  const s = String(q || "").trim().toUpperCase();
  return PORTS.find((p) => p.code === s || p.names.some((n) => n.toUpperCase() === s)) || null;
}

export function km(a, b, c, d) {
  const p = Math.PI / 180, x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

// Supplier checks at the start of a deal (company registry + sanctions screening).
// A missing answer is a warning; only a positive finding (not registered, inactive, sanctioned) blocks.
export function judgeSupplier(registry, sanctions) {
  const flags = [];
  const reg = registry?.result || {};
  if (!registry?.ok) flags.push({ level: "warn", code: "REGISTRY_UNAVAILABLE", text: "The company registry check did not answer." });
  else if (!reg.registration_id) flags.push({ level: "warn", code: "REGISTRY_NO_RECORD", text: `No registry record returned for ${reg.legal_name || "the supplier"}.` });
  else if (reg.active === false) flags.push({ level: "block", code: "COMPANY_INACTIVE", text: `${reg.legal_name} (${reg.registration_id}) is not active in the registry.` });
  const san = sanctions?.result || {};
  if (!sanctions?.ok || san.matched == null) flags.push({ level: "warn", code: "SANCTIONS_UNAVAILABLE", text: "Sanctions screening gave no clear answer." });
  else if (san.matched === true) flags.push({ level: "block", code: "SANCTIONS_MATCH", text: `Sanctions match: ${(san.matches || []).join(", ") || san.name}.` });
  const found = registry?.ok && reg.registration_id ? { legalName: reg.legal_name, registrationId: reg.registration_id, jurisdiction: reg.jurisdiction, active: reg.active, incorporated: reg.incorporated } : null;
  return { ok: !flags.some((f) => f.level === "block"), company: found, sanctionsClear: san.matched === false, flags };
}

const STOPPED_KN = 1, FRESH_MIN = 60, CONFIRM_MIN = 30, DARK_MIN = 360;

// Where is the ship relative to the deal's port, from one Quay answer (via Telegraph).
export function position(deal, vessel) {
  const dest = findPort(deal.port);
  const v = vessel?.result;
  if (!dest || !vessel?.ok || v?.latitude == null) return null;
  const ageMin = (Date.now() - Date.parse(v.observed_at)) / 60000;
  const d = km(v.latitude, v.longitude, dest.lat, dest.lon);
  return { dest, distanceKm: Math.round(d * 10) / 10, ageMinutes: Math.round(ageMin), speed: v.speed_knots, observedAt: v.observed_at,
    inPort: d <= dest.radiusKm, stopped: v.speed_knots != null && v.speed_knots < STOPPED_KN };
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
  if (!p.inPort) return { ...base, action: "HOLD", code: "AT_SEA", text: `${name} is ${p.distanceKm} km from ${dest.names[0]}, ${p.speed ?? "?"} kn.${portNote}` };
  if (!p.stopped) return { ...base, action: "HOLD", code: "ARRIVING", text: `${name} is inside ${dest.names[0]} and still moving (${p.speed} kn).${portNote}` };
  if (p.ageMinutes > FRESH_MIN) return { ...base, action: "HOLD", code: "STALE_FIX", text: `${name} was stopped at ${dest.names[0]}, but that fix is ${p.ageMinutes} min old. Waiting for a fresh one.` };
  const earlier = history.map((h) => ({ at: Date.parse(h.at), p: position(deal, h.vessel) }))
    .find((h) => h.p && h.p.inPort && h.p.stopped && h.p.ageMinutes <= FRESH_MIN + (Date.now() - h.at) / 60000 && Date.now() - h.at >= CONFIRM_MIN * 60000);
  if (!earlier) return { ...base, action: "HOLD", code: "IN_PORT_CONFIRMING", text: `${name} is stopped inside ${dest.names[0]} (${p.distanceKm} km from the port centre). Confirming with a second fix in ${CONFIRM_MIN} min before paying.${portNote}` };
  return { ...base, action: "RELEASE", code: "ARRIVED", text: `${name} has been stopped inside ${dest.names[0]} for at least ${Math.round((Date.now() - earlier.at) / 60000)} min (${p.distanceKm} km from the port centre, fix ${p.ageMinutes} min old). Paying the supplier.` };
}
