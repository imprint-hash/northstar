// OFAC second opinion, tested on real rows from the US Treasury SDN list (fixtures copied 26 Nov 2026).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildIndex, screenName, screenVessel, normalize, parseCsv } from "../agent/ofac.mjs";
import { judgeSupplier } from "../agent/verify.mjs";

const idx = buildIndex(fs.readFileSync(new URL("./fixtures/sdn-sample.csv", import.meta.url), "utf8"), fs.readFileSync(new URL("./fixtures/alt-sample.csv", import.meta.url), "utf8"), "2026-11-26");
const reg = { ok: true, result: { legal_name: "X", registration_id: "1", active: true } };

test("legal forms are ignored: PAO / JSC / Joint Stock Company Sovcomflot are one name", () => {
  assert.equal(normalize("PAO Sovcomflot"), "SOVCOMFLOT");
  assert.equal(normalize("JOINT STOCK COMPANY SOVCOMFLOT"), "SOVCOMFLOT");
});

test("the CSV reader keeps commas inside quotes and blanks -0-", () => {
  assert.deepEqual(parseCsv('1,"A, B",-0- ,"x"\n'), [["1", "A, B", "", "x"]]);
});

test("PAO Sovcomflot is on the list (the Telegraph miner cleared it on 26 Nov)", () => {
  const r = screenName(idx, "PAO Sovcomflot");
  assert.equal(r.matched, true);
  assert.match(r.matches[0].name, /SOVCOMFLOT/);
});

test("Garantex matches Garantex Europe by its listed alias, not a look-alike company", () => {
  const r = screenName(idx, "Garantex");
  assert.equal(r.matched, true);
  assert.equal(r.matches[0].name, "GARANTEX EUROPE OU");
});

test("an unlisted company is clear", () => assert.equal(screenName(idx, "Tesco PLC").matched, false));

test("a sanctioned ship is found by MMSI; another MMSI is clear", () => {
  assert.equal(screenVessel(idx, "572469210").matched, true);
  assert.equal(screenVessel(idx, "367770980").matched, false);
});

test("the miner says clear but OFAC lists the name: blocked, and the disagreement is shown", () => {
  const v = judgeSupplier(reg, { ok: true, result: { matched: false } }, screenName(idx, "PAO Sovcomflot"), screenVessel(idx, "367770980"));
  assert.equal(v.ok, false);
  assert.ok(v.flags.some((f) => f.code === "OFAC_SDN_MATCH"));
  assert.ok(v.flags.some((f) => f.code === "SANCTIONS_SOURCES_DISAGREE"));
  assert.equal(v.sanctionsClear, false);
});

test("a clean supplier on a sanctioned ship is blocked", () => {
  const v = judgeSupplier(reg, { ok: true, result: { matched: false } }, screenName(idx, "Tesco PLC"), screenVessel(idx, "572469210"));
  assert.equal(v.ok, false);
  assert.ok(v.flags.some((f) => f.code === "VESSEL_SANCTIONED"));
});
