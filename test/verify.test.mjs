import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeVoyage, judgeSupplier, findPort } from "../agent/verify.mjs";

const deal = { vessel: "TEST SHIP", port: "London Gateway" };
const gw = findPort("London Gateway");
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const fix = (lat, lon, kn, ageMin) => ({ ok: true, result: { latitude: lat, longitude: lon, speed_knots: kn, observed_at: ago(ageMin) } });

test("ship far away holds AT_SEA", () => assert.equal(judgeVoyage(deal, fix(40, -30, 15, 5)).code, "AT_SEA"));
test("ship in port but moving holds ARRIVING", () => assert.equal(judgeVoyage(deal, fix(gw.lat, gw.lon, 6, 5)).code, "ARRIVING"));
test("first stopped fix in port waits for confirmation", () => assert.equal(judgeVoyage(deal, fix(gw.lat, gw.lon, 0, 5)).action, "HOLD"));
test("two stopped fixes 30+ min apart release", () => {
  const history = [{ at: ago(40), vessel: fix(gw.lat, gw.lon, 0.2, 42) }];
  // current fix heard 3 min ago, earlier one 42 min ago: 39 min apart
  const v = judgeVoyage(deal, fix(gw.lat, gw.lon, 0, 3), null, history);
  assert.equal(v.action, "RELEASE"); assert.equal(v.code, "ARRIVED");
});
test("an earlier fix only 10 min ago is not enough", () => {
  const history = [{ at: ago(10), vessel: fix(gw.lat, gw.lon, 0, 12) }];
  assert.equal(judgeVoyage(deal, fix(gw.lat, gw.lon, 0, 3), null, history).action, "HOLD");
});
test("old fix in port never releases", () => assert.equal(judgeVoyage(deal, fix(gw.lat, gw.lon, 0, 90), null, [{ at: ago(120), vessel: fix(gw.lat, gw.lon, 0, 120) }]).code, "STALE_FIX"));
test("ship silent for over 6 h holds DARK", () => assert.equal(judgeVoyage(deal, fix(40, -30, 10, 400)).code, "DARK"));
test("no answer holds", () => assert.equal(judgeVoyage(deal, { ok: false }).code, "NO_ANSWER"));
test("unheard ship holds NOT_SEEN", () => assert.equal(judgeVoyage(deal, { ok: true, result: { latitude: null } }).code, "NOT_SEEN"));
test("unknown port holds", () => assert.equal(judgeVoyage({ vessel: "X", port: "Atlantis" }, fix(0, 0, 0, 1)).code, "UNKNOWN_PORT"));

test("sanctions match blocks the deal", () => {
  const v = judgeSupplier({ ok: true, result: { legal_name: "X LTD", registration_id: "1", active: true } }, { ok: true, result: { matched: true, matches: ["X LTD"] } });
  assert.equal(v.ok, false); assert.equal(v.flags[0].code, "SANCTIONS_MATCH");
});
test("inactive company blocks the deal", () => assert.equal(judgeSupplier({ ok: true, result: { legal_name: "X", registration_id: "1", active: false } }, { ok: true, result: { matched: false } }).ok, false));
test("registered, active, not sanctioned passes", () => {
  const v = judgeSupplier({ ok: true, result: { legal_name: "TESCO PLC", registration_id: "00445790", active: true } }, { ok: true, result: { matched: false } });
  assert.equal(v.ok, true); assert.equal(v.sanctionsClear, true); assert.equal(v.flags.length, 0);
});
test("a check that did not answer warns but does not block", () => assert.equal(judgeSupplier({ ok: false }, { ok: false }).ok, true));

test("a ship moored at Hamburg's city docks counts as in port (berth zone)", () => {
  const d = { vessel: "X", port: "Hamburg" };
  const v = judgeVoyage(d, fix(53.54, 9.97, 0, 3));
  assert.equal(v.code, "IN_PORT_CONFIRMING");
});

import { judgeCorroboration } from "../agent/verify.mjs";
test("second source within 5 km agrees", () => assert.equal(judgeCorroboration(fix(51.9, 4.0, 0, 2), { ok: true, miner: "B", result: { latitude: 51.91, longitude: 4.0, observed_at: ago(3) } }).status, "AGREE"));
test("second source 40 km away conflicts", () => assert.equal(judgeCorroboration(fix(51.9, 4.0, 0, 2), { ok: true, miner: "B", result: { latitude: 52.26, longitude: 4.0, observed_at: ago(3) } }).status, "CONFLICT"));
test("second source with nulls is unavailable, not blocking", () => assert.equal(judgeCorroboration(fix(51.9, 4.0, 0, 2), { ok: true, result: { latitude: null } }).status, "UNAVAILABLE"));
test("second source with swapped lat/lon (lat > 90) is ignored", () => assert.equal(judgeCorroboration(fix(63.5, 20.4, 0, 2), { ok: true, result: { latitude: 120.4, longitude: 63.5 } }).status, "UNAVAILABLE"));

test("the same AIS report seen on two rounds does not release (found live: MONTEVERDI, 25 Nov)", () => {
  const sameObs = ago(33);
  const one = { ok: true, result: { latitude: gw.lat, longitude: gw.lon, speed_knots: 0, observed_at: sameObs } };
  const v = judgeVoyage(deal, one, null, [{ at: ago(32), vessel: one }]);
  assert.equal(v.action, "HOLD");
});
