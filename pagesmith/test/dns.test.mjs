import { test } from "node:test";
import assert from "node:assert/strict";

import { isApex, requiredRecords, APEX_A } from "../lib/dns.js";

test("apex domains are told apart from subdomains", () => {
  assert.equal(isApex("dutdutrecords.com"), true);
  assert.equal(isApex("www.dutdutrecords.com"), false);
});

test("an apex domain needs the four GitHub A records", () => {
  const records = requiredRecords("dutdutrecords.com", "handelmusic-cpu");
  const a = records.filter((r) => r.type === "A").map((r) => r.value);
  assert.deepEqual(a, APEX_A);
  assert.ok(records.every((r) => r.type !== "A" || r.name === "@"));
  const www = records.find((r) => r.name === "www");
  assert.equal(www.value, "handelmusic-cpu.github.io");
  assert.equal(www.optional, true);
});

test("a subdomain needs one CNAME and nothing else", () => {
  const records = requiredRecords("shop.dutdutrecords.com", "handelmusic-cpu");
  assert.deepEqual(records, [
    { type: "CNAME", name: "shop", value: "handelmusic-cpu.github.io" },
  ]);
});
