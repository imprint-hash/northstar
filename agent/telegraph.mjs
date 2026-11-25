// Telegraph client: every check Northstar makes is a paid machine-to-machine purchase on the
// Telegraph network (x402 "escrow" scheme: sign the payment template, resend with X-PAYMENT).
// Each answer comes back with Telegraph's receipt hash, which Northstar writes on-chain as evidence.
import { execFile } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";

const NODE = process.env.TELEGRAPH_NODE || "https://devnode.telegraphprotocol.com/engine/v1/ask";
const MAX_PRICE_USDC = Number(process.env.TELEGRAPH_MAX_PRICE || 0.05);
export const QUAY = "8818818";

let acct;
export function account() {
  if (!acct) acct = privateKeyToAccount((process.env.TELEGRAPH_KEY || fs.readFileSync(process.env.TELEGRAPH_KEY_FILE, "utf8")).trim());
  return acct;
}

function post(url, body, headers = {}) {
  const args = ["-s", "-m", "150", "-i", "-X", "POST", "-H", "Content-Type: application/json"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", body, url);
  return new Promise((resolve) => {
    const go = (n) => execFile("curl", args, { maxBuffer: 2e7 }, (e, out) => {
      if (e || !out) return n > 0 ? setTimeout(() => go(n - 1), 3000) : resolve({ status: -1, headers: {}, body: String(e?.message || "no answer") });
      const parts = out.split(/\r?\n\r?\n/); let i = 0;
      while (/^HTTP\/[\d.]+ 100/.test(parts[i] || "")) i++;
      const [statusLine, ...hl] = parts[i].split(/\r?\n/); const h = {};
      for (const l of hl) { const k = l.indexOf(":"); if (k > 0) h[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); }
      resolve({ status: Number(statusLine.split(" ")[1]), headers: h, body: parts.slice(i + 1).join("\n\n") });
    });
    go(1);
  });
}

// With an Anjoman API key, Northstar buys through its Anjoman account (Telegraph backend, Bearer key,
// paid from the account's escrow), so its purchases are credited to a registered app.
const ANJOMAN = process.env.ANJOMAN_BACKEND || "https://backend.telegraphprotocol.com";
let anjomanKey;
function anjomanKeyOrNull() {
  if (anjomanKey !== undefined) return anjomanKey;
  try { anjomanKey = (process.env.ANJOMAN_API_KEY || (process.env.ANJOMAN_KEY_FILE ? fs.readFileSync(process.env.ANJOMAN_KEY_FILE, "utf8") : "")).trim() || null; } catch { anjomanKey = null; }
  return anjomanKey;
}
async function askAnjoman(intent, params, miner) {
  const t0 = Date.now();
  const r = await post(miner ? `${ANJOMAN}/engine/ask/${miner}` : `${ANJOMAN}/engine/ask`, JSON.stringify({ intent, params }), { Authorization: `Bearer ${anjomanKeyOrNull()}` });
  let j = null; try { j = JSON.parse(r.body); } catch {}
  // Anjoman wraps the node's answer: { result: { miner_name, result: {...intent fields}, cost_usd, signal_hash }, receipt: {...} }
  const env = j?.result && typeof j.result === "object" && "result" in j.result ? j.result : j;
  const ok = r.status >= 200 && r.status < 300 && env && env.result != null;
  const rc = typeof j?.receipt === "object" ? j.receipt : null;
  return { ok, status: r.status, via: "anjoman", intent, params, result: env?.result ?? null, miner: env?.miner_name || null, minerId: env?.miner_id ?? miner, signalHash: env?.signal_hash || null,
    receipt: rc?.receipt_hash || null, epoch: rc?.epoch_id ?? null, payer: rc?.payer || null, priceUsdc: Number(env?.cost_usd ?? (rc ? Number(rc.amount_uusdc) / 1e6 : 0)),
    ms: Date.now() - t0, error: ok ? null : (j?.message || j?.error || r.body.slice(0, 200)) };
}

// Ask Telegraph (optionally pinned to one miner). Returns { ok, result, miner, receipt, epoch, priceUsdc, ms }.
// Through Anjoman when a key is configured; otherwise straight to the node with x402 escrow signing.
export async function ask(intent, params, { miner = null } = {}) {
  if (anjomanKeyOrNull()) {
    const a = await askAnjoman(intent, params, miner);
    if (a.ok || !/balance|unauthor|401|403/i.test(String(a.error) + a.status)) return a;
  }
  const url = miner ? `${NODE}/${miner}` : NODE;
  const body = JSON.stringify({ intent, params });
  const t0 = Date.now();
  let r = await post(url, body);
  let price = 0;
  if (r.status === 402) {
    const j = JSON.parse(r.body);
    const esc = (j.accepts || []).find((a) => a.scheme === "escrow");
    const amount = esc?.extra?.message?.match(/Amount:\s*(\d+)/)?.[1];
    if (!amount) return { ok: false, error: "no escrow payment offered", ms: Date.now() - t0 };
    price = Number(amount) / 1e6;
    if (price > MAX_PRICE_USDC) return { ok: false, error: `price ${price} USDC over cap`, ms: Date.now() - t0 };
    const a = account(); const now = Math.floor(Date.now() / 1000);
    const auth = { from: a.address.toLowerCase(), to: esc.payTo, value: amount, validAfter: String(now - 5), validBefore: String(now + 100), nonce: crypto.randomUUID() };
    const msg = esc.extra.message.replace("{from}", auth.from).replace("{nonce}", auth.nonce).replace("{validAfter}", auth.validAfter).replace("{validBefore}", auth.validBefore);
    const signature = await a.signMessage({ message: msg });
    const pay = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "escrow", network: esc.network, payload: { signature, authorization: auth } })).toString("base64");
    r = await post(url, body, { "X-PAYMENT": pay });
  }
  let j = null; try { j = JSON.parse(r.body); } catch {}
  let receipt = null, epoch = null;
  try { const pr = JSON.parse(Buffer.from(r.headers["x-payment-response"] || "", "base64").toString()); receipt = pr.receipt_hash || null; epoch = pr.epoch_id ?? null; } catch {}
  const ok = r.status === 200 && j && j.result != null;
  return { ok, status: r.status, intent, params, result: j?.result ?? null, miner: j?.miner_name || j?.miner || null, minerId: j?.miner_id ?? miner, signalHash: j?.signal_hash || null,
    receipt, epoch, priceUsdc: price, ms: Date.now() - t0, error: ok ? null : (j?.error || j?.message || r.body.slice(0, 200)) };
}
