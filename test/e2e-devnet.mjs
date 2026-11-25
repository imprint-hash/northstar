// Live devnet test of the escrow program: release, refund after deadline, and two refusals.
import crypto from "node:crypto";
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn, keypair, openDeal, recordCheck, release, refund, readDeal } from "../agent/chain.mjs";
const cfg = JSON.parse(fs.readFileSync("data/chain.json", "utf8"));
const buyer = keypair("buyer"), seller = keypair("seller"), verifier = keypair("verifier"), stranger = keypair("deployer");
const bal = async (owner) => { try { return Number((await getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(cfg.mint), owner))).amount) / 1e6; } catch { return 0; } };
const out = {};
const base = Date.now();
// 1. open + check + release
const a = await openDeal({ buyer, seller: seller.publicKey, verifier: verifier.publicKey, mint: cfg.mint, dealId: base, amount: 120e6, vessel: "HULDA MAERSK", port: "London Gateway", deadline: Math.floor(Date.now() / 1000) + 3 * 86400 });
out.open = a.url; const A = { address: a.deal, mint: cfg.mint, seller: seller.publicKey.toBase58(), buyer: buyer.publicKey.toBase58() };
out.check = (await recordCheck(A, 4, crypto.randomBytes(32))).url;
// a stranger tries to release: must fail
const saved = keypair; try { await release({ ...A }, crypto.randomBytes(32), stranger); out.strangerRelease = "UNEXPECTEDLY SUCCEEDED"; } catch (e) { out.strangerRelease = "refused"; }
const sellerBefore = await bal(seller.publicKey);
out.release = (await release(A, crypto.createHash("sha256").update("demo-evidence").digest())).url;
out.sellerGot = (await bal(seller.publicKey)) - sellerBefore;
out.dealA = await readDeal(a.deal);
// 2. deadline refund
const b = await openDeal({ buyer, seller: seller.publicKey, verifier: verifier.publicKey, mint: cfg.mint, dealId: base + 1, amount: 50e6, vessel: "TEST", port: "Rotterdam", deadline: Math.floor(Date.now() / 1000) + 25 });
const B = { address: b.deal, mint: cfg.mint, seller: seller.publicKey.toBase58(), buyer: buyer.publicKey.toBase58() };
try { await refund(B, buyer); out.earlyRefund = "UNEXPECTEDLY SUCCEEDED"; } catch { out.earlyRefund = "refused (before deadline)"; }
await new Promise((r) => setTimeout(r, 35000));
try { await release(B, crypto.randomBytes(32)); out.lateRelease = "UNEXPECTEDLY SUCCEEDED"; } catch { out.lateRelease = "refused (after deadline)"; }
const buyerBefore = await bal(buyer.publicKey);
out.refund = (await refund(B, stranger)).url; // anyone may trigger it; money only goes to the buyer
out.buyerGotBack = (await bal(buyer.publicKey)) - buyerBefore;
out.dealB = (await readDeal(b.deal)).status;
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync("docs/e2e-devnet.json", JSON.stringify(out, null, 1));
