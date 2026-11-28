<p align="center"><img src="web/logo.svg" width="96" alt="Northstar"></p>

# Northstar

**Pay your supplier when the ship docks.**

An importer paying an overseas supplier has two bad options today: pay up front and trust, or pay a bank for a letter of credit and wait 30–60 days of paperwork. Northstar is the third option. The buyer's USDC sits in a **Solana escrow** tied to one ship, one port and a deadline. Northstar checks the supplier, then watches the real ship from live AIS radio through **Telegraph**. The money moves to the supplier only when the vessel is verified stopped in the destination port, and goes back to the buyer if it never arrives.

- **Live:** https://northstar.16-192-237-212.sslip.io. Press *Open a live demo deal* (Northstar picks a real cargo ship about to reach a port), or use **Create your own deal**: pick a port Quay can see, choose a cargo ship heading there right now, name your supplier and lock the payment (test USDC on devnet).
- **Escrow program (Solana devnet):** [`AQUt6WJcig7EFaq5rJsCYZze2onSRmFitte8yzdnsKgc`](https://explorer.solana.com/address/AQUt6WJcig7EFaq5rJsCYZze2onSRmFitte8yzdnsKgc?cluster=devnet)
- **Ship intelligence:** [Quay](https://github.com/imprint-hash/quay), our Telegraph miner (rank 1 on `LIVE_PORT_CONGESTION`)
- **Telegraph Season II:** Mission 08 Commodities, route 2 (cargo and counterparty provenance, settled). Apps & Agents track.

## How a deal runs

1. **Lock.** The buyer opens a deal: USDC moves into a program-owned vault. The program can do exactly two things with it: pay the seller fixed at opening (only on the verifier's signature, only before the deadline) or refund the buyer (anyone can trigger it, only after the deadline). Northstar cannot send it anywhere else.
2. **Check the supplier and the ship.** Paid Telegraph asks: `CORPORATE_REGISTRY_LOOKUP_GENERAL` (registry id, active?) and `SANCTIONS_SCREENING_MATCH_GENERAL`, plus a second opinion from the **US Treasury OFAC SDN list itself** (downloaded daily, ~19,600 entries): the supplier by name, and **the ship by MMSI** (838 sanctioned ships carry one). A match on either source, or an inactive company, blocks the deal; the money stays locked and goes home at the deadline.
3. **Watch the ship.** Every 10 minutes: `VESSEL_TELEMETRY_VERIFY_GENERAL` (pinned to Quay, asked by MMSI) and `LIVE_PORT_CONGESTION_GENERAL`. Each change of situation is written on-chain (`record_check`) with a hash of the Telegraph receipts.
4. **Settle.** Release needs **two different AIS reports, heard at least 30 minutes apart, both showing the ship stopped inside the port's release zone**, and a second vessel source that does not disagree. Then the verifier signs `release` with the evidence hash. Otherwise: hold, and say why.

| Situation | Decision |
|---|---|
| Ship far away / still moving in port | `HOLD` (`AT_SEA`, `ARRIVING`) |
| First stopped fix in port | `HOLD` (`IN_PORT_CONFIRMING`) until a second fix 30+ min later |
| Fix older than 60 min | `HOLD` (`STALE_FIX`) |
| Not heard for 6 h | `HOLD` (`DARK`): a ship that goes dark is a risk signal |
| Second source puts the ship 5+ km away | `HOLD` (`SOURCES_CONFLICT`) |
| Supplier sanctioned (miner **or** OFAC list) / inactive | blocked; refund at the deadline |
| Ship itself on the OFAC list (by MMSI) | blocked (`VESSEL_SANCTIONED`) |
| Miner says clear, OFAC lists the name | blocked, and `SANCTIONS_SOURCES_DISAGREE` is shown |
| Two stopped fixes in port, sources agree | `RELEASE` → supplier paid |

## Problems met on real ships, and the fix

- **Two ships called ELISE, 780 km apart.** Asking by name returned the wrong one. Deals now store the MMSI and ask by it.
- **Hamburg's docks are 100 km up the Elbe** from the anchorage Quay counts congestion in. Ports now have berth zones (Hamburg, Shanghai Waigaoqiao, Houston) as well as anchorage zones.
- **The same AIS report counted twice.** The first live payout (MONTEVERDI, Antwerp, 25 Nov) released after the ship had stopped transmitting: one report, seen on two rounds 30 min apart. The ship was stopped in port, but the rule promised two reports; it now compares the reports' own timestamps (regression test added).
- **A sanctions miner cleared a listed company.** Asked about "PAO Sovcomflot" (written word for word as an alias on the OFAC SDN list), the Telegraph sanctions miner answered `matched: false`; it also matched "Garantex" to a different company, "GARANT-SV". Northstar now checks the official OFAC list too and blocks if either source lists the name. Live run: [`docs/sanctions-second-opinion.json`](docs/sanctions-second-opinion.json).
- **Telegraph trims answers to the intent's schema** (no `nav_status`), so "moored" can't be read; arrival is "stopped inside the zone on two fixes 30+ minutes apart" instead.

## Proof

- [`docs/e2e-devnet.json`](docs/e2e-devnet.json), live on devnet: open → record check → **a stranger's release refused** → verifier release (seller +120) · **refund before the deadline refused** → **release after the deadline refused** → refund (buyer +50).
- `npm test`: 28 tests, including 8 on real OFAC rows (Sovcomflot under its PAO alias, Garantex by alias, a sanctioned tanker by MMSI). Decision tests (arrival rule, stale fixes, dark ships, unknown ports, sanctions, second-source agreement and conflict, swapped coordinates).
- Every round on the live site shows the Telegraph receipt for each answer and the Solana transaction for each on-chain record.

## Telegraph purchases

All asks go through an **Anjoman API key** (account escrow) to `backend.telegraphprotocol.com/engine/ask/{miner}`, falling back to the devnode with the x402 escrow scheme. Pinned miners were chosen from probes of the live network: registry → PREFLIGHT (real registry ids), sanctions → ChainSight, vessel and port → Quay. Cost of evidence: about $0.04 per supplier check and $0.02 per 10-minute ship round.

## Run it

```bash
npm install
npm test
# devnet setup (test token, SOL for the demo wallets): keys in ~/.northstar/{deployer,verifier,buyer,seller}.json
node agent/setup-demo.mjs
ANJOMAN_KEY_FILE=~/.northstar/anjoman.key node agent/server.mjs   # web + API + agent loop on 127.0.0.1:8090
```

The program builds in CI (`.github/workflows/build-program.yml`, `cargo-build-sbf`, Anchor 1.2.2) and deploys with `solana program deploy`.

Demo deals use a devnet test token ("test USDC", minted by Northstar) and the demo suppliers are real companies checked live; no real goods or money move. MIT licensed.
