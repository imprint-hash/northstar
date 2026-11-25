<p align="center"><img src="web/logo.svg" width="96" alt="Northstar"></p>

# Northstar

**Pay your supplier when the ship docks.**

An importer paying an overseas supplier has two bad options today: pay up front and trust, or pay a bank for a letter of credit and wait 30–60 days of paperwork. Northstar is the third option. The buyer's USDC sits in a **Solana escrow** tied to one ship, one port and a deadline. Northstar checks the supplier, then watches the real ship from live AIS radio through **Telegraph**. The money moves to the supplier only when the vessel is verified stopped in the destination port, and goes back to the buyer if it never arrives.

- **Live:** https://northstar.16-192-237-212.sslip.io (press *Open a live demo deal*: it picks a real cargo ship about to reach a port)
- **Escrow program (Solana devnet):** [`AQUt6WJcig7EFaq5rJsCYZze2onSRmFitte8yzdnsKgc`](https://explorer.solana.com/address/AQUt6WJcig7EFaq5rJsCYZze2onSRmFitte8yzdnsKgc?cluster=devnet)
- **Ship intelligence:** [Quay](https://github.com/imprint-hash/quay), our Telegraph miner (rank 1 on `LIVE_PORT_CONGESTION`)
- **Telegraph Season II:** Mission 08 Commodities, route 2 (cargo and counterparty provenance, settled). Apps & Agents track.

## How a deal runs

1. **Lock.** The buyer opens a deal: USDC moves into a program-owned vault. The program can do exactly two things with it: pay the seller fixed at opening (only on the verifier's signature, only before the deadline) or refund the buyer (anyone can trigger it, only after the deadline). Northstar cannot send it anywhere else.
2. **Check the supplier.** Paid Telegraph asks: `CORPORATE_REGISTRY_LOOKUP_GENERAL` (registry id, active?) and `SANCTIONS_SCREENING_MATCH_GENERAL`. A sanctions match or an inactive company blocks the deal; the money stays locked and goes home at the deadline.
3. **Watch the ship.** Every 10 minutes: `VESSEL_TELEMETRY_VERIFY_GENERAL` (pinned to Quay, asked by MMSI) and `LIVE_PORT_CONGESTION_GENERAL`. Each change of situation is written on-chain (`record_check`) with a hash of the Telegraph receipts.
4. **Settle.** Release needs **two fresh AIS fixes at least 30 minutes apart, both showing the ship stopped inside the port's release zone**, and a second vessel source that does not disagree. Then the verifier signs `release` with the evidence hash. Otherwise: hold, and say why.

| Situation | Decision |
|---|---|
| Ship far away / still moving in port | `HOLD` (`AT_SEA`, `ARRIVING`) |
| First stopped fix in port | `HOLD` (`IN_PORT_CONFIRMING`) until a second fix 30+ min later |
| Fix older than 60 min | `HOLD` (`STALE_FIX`) |
| Not heard for 6 h | `HOLD` (`DARK`): a ship that goes dark is a risk signal |
| Second source puts the ship 5+ km away | `HOLD` (`SOURCES_CONFLICT`) |
| Supplier sanctioned / inactive | blocked; refund at the deadline |
| Two stopped fixes in port, sources agree | `RELEASE` → supplier paid |

## Problems met on real ships, and the fix

- **Two ships called ELISE, 780 km apart.** Asking by name returned the wrong one. Deals now store the MMSI and ask by it.
- **Hamburg's docks are 100 km up the Elbe** from the anchorage Quay counts congestion in. Ports now have berth zones (Hamburg, Shanghai Waigaoqiao, Houston) as well as anchorage zones.
- **Telegraph trims answers to the intent's schema** (no `nav_status`), so "moored" can't be read; arrival is "stopped inside the zone on two fixes 30+ minutes apart" instead.

## Proof

- [`docs/e2e-devnet.json`](docs/e2e-devnet.json), live on devnet: open → record check → **a stranger's release refused** → verifier release (seller +120) · **refund before the deadline refused** → **release after the deadline refused** → refund (buyer +50).
- `npm test`: 19 decision tests (arrival rule, stale fixes, dark ships, unknown ports, sanctions, second-source agreement and conflict, swapped coordinates).
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
