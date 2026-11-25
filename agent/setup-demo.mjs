// One-time devnet setup: a test-USDC mint (6 decimals, clearly a devnet test token), SOL for the
// verifier and buyer, and test USDC in the buyer's wallet. Writes data/chain.json.
import fs from "node:fs";
import path from "node:path";
import { LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { conn, keypair, PROGRAM_ID } from "./chain.mjs";

const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../data/chain.json");
const cfg = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
const deployer = keypair("deployer"), verifier = keypair("verifier"), buyer = keypair("buyer"), seller = keypair("seller");
for (const [k, amt] of [[verifier, 0.3], [buyer, 0.3]]) {
  if ((await conn.getBalance(k.publicKey)) < 0.1 * LAMPORTS_PER_SOL)
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k.publicKey, lamports: amt * LAMPORTS_PER_SOL })), [deployer]);
}
if (!cfg.mint) cfg.mint = (await createMint(conn, deployer, deployer.publicKey, null, 6)).toBase58();
const ata = await getOrCreateAssociatedTokenAccount(conn, deployer, new (await import("@solana/web3.js")).PublicKey(cfg.mint), buyer.publicKey);
if (Number(ata.amount) < 1000e6) await mintTo(conn, deployer, new (await import("@solana/web3.js")).PublicKey(cfg.mint), ata.address, deployer, 25000e6);
Object.assign(cfg, { program: PROGRAM_ID.toBase58(), verifier: verifier.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), seller: seller.publicKey.toBase58(), token: "test USDC (devnet, 6 decimals, minted by Northstar for the demo)" });
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(cfg, null, 1));
console.log(cfg);
