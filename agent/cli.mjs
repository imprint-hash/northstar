// Run one round of checks for a deal described on the command line (no chain needed).
// node agent/cli.mjs '{"supplier":"Tesco PLC","supplierCountry":"GB","vessel":"HULDA MAERSK","port":"London Gateway"}'
import { checkSupplier, checkVoyage } from "./checks.mjs";
const deal = JSON.parse(process.argv[2]);
const s = await checkSupplier(deal);
const v = await checkVoyage(deal);
const brief = (x) => ({ ok: x.ok, miner: x.miner, ms: x.ms, receipt: x.receipt, result: x.result, error: x.error });
console.log(JSON.stringify({ supplier: { registry: brief(s.registry), sanctions: brief(s.sanctions), verdict: s.verdict }, voyage: { vessel: brief(v.vessel), port: brief(v.port), verdict: v.verdict } }, null, 1));
