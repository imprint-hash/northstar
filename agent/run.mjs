// The Northstar agent: one pass over every open deal. Run it every few minutes (pm2 / cron).
// Supplier checks once at the start; ship checks every round; each round's outcome goes on-chain:
// record_check while holding (a public trail), release when the ship has docked.
import crypto from "node:crypto";
import { load, save } from "./store.mjs";
import { checkSupplier, checkVoyage } from "./checks.mjs";
import * as chain from "./chain.mjs";

const CODES = { AT_SEA: 2, ARRIVING: 3, IN_PORT_CONFIRMING: 4, STALE_FIX: 5, DARK: 6, NOT_SEEN: 7, NO_ANSWER: 8, UNKNOWN_PORT: 9, SUPPLIER_BLOCKED: 10, ARRIVED: 1 };
const evidenceHash = (round) => crypto.createHash("sha256").update(JSON.stringify([round.vessel?.receipt, round.port?.receipt, round.vessel?.result, round.verdict?.code])).digest();

export async function tick(log = console.log) {
  const db = load();
  for (const deal of db.deals.filter((d) => d.status === "open")) {
    deal.rounds ||= [];
    // Past the deadline and never released: the buyer's money goes back (anyone may trigger this).
    if (Date.parse(deal.deadline) <= Date.now()) {
      const tx = await chain.refund(deal, chain.keypair("verifier")).catch((e) => ({ error: e.message }));
      if (!tx.error) { deal.status = "refunded"; deal.state = "REFUNDED"; deal.refundTx = tx; }
      deal.events = [...(deal.events || []), { at: new Date().toISOString(), kind: "refund", tx }];
      log(`[${deal.id}] deadline passed: refund ${tx.error ? "failed: " + tx.error : tx.signature}`);
      save(db); continue;
    }
    if (!deal.supplierCheck) {
      deal.supplierCheck = await checkSupplier(deal);
      log(`[${deal.id}] supplier: ${deal.supplierCheck.verdict.ok ? "ok" : "BLOCKED"} ${deal.supplierCheck.verdict.flags.map((f) => f.code).join(",")}`);
      if (!deal.supplierCheck.verdict.ok) {
        deal.state = "SUPPLIER_BLOCKED";
        const tx = await chain.recordCheck(deal, CODES.SUPPLIER_BLOCKED, crypto.createHash("sha256").update(JSON.stringify(deal.supplierCheck.verdict)).digest()).catch((e) => ({ error: e.message }));
        deal.events = [...(deal.events || []), { at: new Date().toISOString(), kind: "blocked", tx }];
        save(db); continue;
      }
      save(db);
    }
    if (deal.state === "SUPPLIER_BLOCKED") continue;
    const history = deal.rounds.filter((r) => r.vessel?.ok);
    const round = await checkVoyage(deal, history);
    const v = round.verdict;
    const ev = evidenceHash(round);
    round.evidence = ev.toString("hex");
    log(`[${deal.id}] ${v.action} ${v.code}: ${v.text}`);
    if (v.action === "RELEASE") {
      const tx = await chain.release(deal, ev).catch((e) => ({ error: e.message }));
      round.tx = tx;
      if (!tx.error) { deal.status = "released"; deal.releasedAt = round.at; deal.releaseTx = tx.signature; }
    } else if (v.code !== deal.state) { // only write to chain when the situation changes
      round.tx = await chain.recordCheck(deal, CODES[v.code] || 0, ev).catch((e) => ({ error: e.message }));
    }
    deal.state = deal.status === "released" ? "ARRIVED" : v.code;
    deal.rounds.push(round);
    save(db);
  }
  return db;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await tick();
