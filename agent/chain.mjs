// Solana side of Northstar: talks to the escrow program on devnet with plain web3.js
// (Anchor instruction layout: 8-byte sha256("global:<name>") discriminator + Borsh args).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey(process.env.NORTHSTAR_PROGRAM || "AQUt6WJcig7EFaq5rJsCYZze2onSRmFitte8yzdnsKgc");
const KEYDIR = process.env.NORTHSTAR_KEYS || path.join(os.homedir(), ".northstar");
export const conn = new Connection(RPC, "confirmed");
export const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function keypair(name) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYDIR, `${name}.json`), "utf8"))));
}

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const str = (s) => { const v = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(v.length); return Buffer.concat([l, v]); };
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

export function dealPda(buyer, dealId) {
  return PublicKey.findProgramAddressSync([Buffer.from("deal"), new PublicKey(buyer).toBuffer(), u64(dealId)], PROGRAM_ID)[0];
}
export const vaultPda = (deal) => PublicKey.findProgramAddressSync([Buffer.from("vault"), new PublicKey(deal).toBuffer()], PROGRAM_ID)[0];

async function send(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  const signature = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  return { signature, url: explorer(signature) };
}

// Buyer locks `amount` (base units) for the voyage. Returns the deal address and the tx.
export async function openDeal({ buyer, seller, verifier, mint, dealId, amount, vessel, port, deadline }) {
  const deal = dealPda(buyer.publicKey, dealId);
  const vault = vaultPda(deal);
  const buyerToken = getAssociatedTokenAddressSync(new PublicKey(mint), buyer.publicKey);
  const data = Buffer.concat([disc("open_deal"), u64(dealId), u64(amount), str(vessel), str(port), i64(deadline)]);
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    meta(buyer.publicKey, true, true), meta(new PublicKey(seller), false, false), meta(new PublicKey(verifier), false, false),
    meta(new PublicKey(mint), false, false), meta(deal, false, true), meta(vault, false, true), meta(buyerToken, false, true),
    meta(TOKEN_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false)] });
  return { deal: deal.toBase58(), vault: vault.toBase58(), ...(await send([ix], [buyer])) };
}

export async function recordCheck(d, code, evidence) {
  const verifier = keypair("verifier");
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc("record_check"), Buffer.from([code]), Buffer.from(evidence)]),
    keys: [meta(verifier.publicKey, true, false), meta(new PublicKey(d.address), false, true)] });
  return send([ix], [verifier]);
}

export async function release(d, evidence, signer = null) {
  const verifier = signer || keypair("verifier");
  const sellerToken = await getOrCreateAssociatedTokenAccount(conn, verifier, new PublicKey(d.mint), new PublicKey(d.seller));
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc("release"), Buffer.from(evidence)]), keys: [
    meta(verifier.publicKey, true, false), meta(new PublicKey(d.address), false, true), meta(vaultPda(d.address), false, true),
    meta(sellerToken.address, false, true), meta(TOKEN_PROGRAM_ID, false, false)] });
  return send([ix], [verifier]);
}

export async function refund(d, caller) {
  const buyerToken = getAssociatedTokenAddressSync(new PublicKey(d.mint), new PublicKey(d.buyer));
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, data: disc("refund"), keys: [
    meta(caller.publicKey, true, false), meta(new PublicKey(d.address), false, true), meta(vaultPda(d.address), false, true),
    meta(buyerToken, false, true), meta(TOKEN_PROGRAM_ID, false, false)] });
  return send([ix], [caller]);
}

// Read a deal account straight from the chain (what the web page shows as the source of truth).
export async function readDeal(address) {
  const info = await conn.getAccountInfo(new PublicKey(address));
  if (!info) return null;
  const b = info.data; let o = 8;
  const pk = () => { const p = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return p; };
  const rU64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
  const rI64 = () => { const v = b.readBigInt64LE(o); o += 8; return v; };
  const rStr = () => { const l = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + l).toString("utf8"); o += l; return s; };
  const buyer = pk(), seller = pk(), verifier = pk(), mint = pk();
  const dealId = rU64(), amount = rU64(), deadline = rI64(), vessel = rStr(), port = rStr();
  const status = ["open", "released", "refunded"][b[o++]];
  const checks = b.readUInt32LE(o); o += 4; const lastCode = b[o++];
  const evidence = b.subarray(o, o + 32).toString("hex");
  return { address, buyer, seller, verifier, mint, dealId: Number(dealId), amount: Number(amount), deadline: Number(deadline), vessel, port, status, checks, lastCode, evidence };
}
