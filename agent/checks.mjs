// One round of checks for a deal, every one bought from Telegraph's miners.
import { ask, QUAY } from "./telegraph.mjs";

// Miners that gave correct answers in our probes (21 Nov): pinned first, routed ask as fallback.
const REGISTRY_MINER = "20260828";  // PREFLIGHT: real registry ids (Tesco 00445790, Flutterwave Inc 6031713)
const SANCTIONS_MINER = "302";      // ChainSight: matched Garantex, cleared a non-sanctioned name
async function pinnedOrRouted(intent, params, miner) {
  const r = await ask(intent, params, { miner });
  return r.ok ? r : ask(intent, params);
}
import { judgeSupplier, judgeVoyage, judgeCorroboration } from "./verify.mjs";

export async function checkSupplier(deal) {
  const [registry, sanctions] = await Promise.all([
    pinnedOrRouted("CORPORATE_REGISTRY_LOOKUP_GENERAL", { company: deal.supplier, jurisdiction: deal.supplierCountry }, REGISTRY_MINER),
    pinnedOrRouted("SANCTIONS_SCREENING_MATCH_GENERAL", { name: deal.supplier }, SANCTIONS_MINER),
  ]);
  return { at: new Date().toISOString(), kind: "supplier", registry, sanctions, verdict: judgeSupplier(registry, sanctions) };
}

export async function checkVoyage(deal, history = []) {
  // Ask by MMSI when known: ship names are not unique (two ships called ELISE were 780 km apart).
  const vessel = await ask("VESSEL_TELEMETRY_VERIFY_GENERAL", { vessel: deal.mmsi ? String(deal.mmsi) : deal.vessel }, { miner: QUAY });
  const port = await ask("LIVE_PORT_CONGESTION_GENERAL", { port: deal.port }, { miner: QUAY });
  let verdict = judgeVoyage(deal, vessel, port, history);
  let second = null, corroboration = null;
  // Only when money is about to move (or the ship is confirming in port): buy a second opinion.
  if (verdict.action === "RELEASE" || verdict.code === "IN_PORT_CONFIRMING") {
    second = await ask("VESSEL_TELEMETRY_VERIFY_GENERAL", { vessel: deal.mmsi ? String(deal.mmsi) : deal.vessel });
    if (second.minerId === QUAY || /quay/i.test(second.miner || "")) second = { ...second, ok: false, error: "routed back to Quay" };
    corroboration = judgeCorroboration(vessel, second);
    if (corroboration.status === "CONFLICT") verdict = { ...verdict, action: "HOLD", code: "SOURCES_CONFLICT", text: corroboration.text };
    else verdict = { ...verdict, text: `${verdict.text} ${corroboration.text}` };
  }
  return { at: new Date().toISOString(), kind: "voyage", vessel, port, second, corroboration, verdict };
}
