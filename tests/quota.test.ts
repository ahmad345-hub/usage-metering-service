import assert from "node:assert/strict";
import test from "node:test";
import { checkQuota, remainingUnits } from "../src/services/quotaService.js";

const account = { monthlyLimit: 10_000, maxPerRequest: 100, usedUnits: 0 };
const user = { monthlyLimit: 1_000, maxPerRequest: 20, usedUnits: 0 };
const run = (a = {}, u = {}, requestedUnits = 10) =>
  checkQuota({ account: { ...account, ...a }, user: { ...user, ...u }, requestedUnits });

test("accepts when both plans allow the request", () => {
  assert.deepEqual(run(), { allowed: true, rejectionLevel: null, rejectionRule: null });
});

test("brief example: 25 units is rejected by the user's per-request limit", () => {
  assert.deepEqual(run({}, {}, 25), { allowed: false, rejectionLevel: "user", rejectionRule: "max_per_request" });
});

test("brief example: 10 units with 5 account units left is rejected by the account", () => {
  assert.deepEqual(run({ usedUnits: 9_995 }), { allowed: false, rejectionLevel: "account", rejectionRule: "monthly_limit" });
});

test("rejects account per-request limit", () => {
  assert.deepEqual(run({ maxPerRequest: 5 }), { allowed: false, rejectionLevel: "account", rejectionRule: "max_per_request" });
});

test("rejects user monthly allowance", () => {
  assert.deepEqual(run({}, { usedUnits: 995 }), { allowed: false, rejectionLevel: "user", rejectionRule: "monthly_limit" });
});

test("accepts exactly up to the monthly allowance", () => {
  assert.equal(run({}, { usedUnits: 990 }).allowed, true);
  assert.equal(run({ usedUnits: 9_990 }).allowed, true);
});

test("limit lowered below usage: rejects and remaining is zero, never negative", () => {
  assert.equal(run({}, { monthlyLimit: 10, usedUnits: 40 }).allowed, false);
  assert.equal(remainingUnits(10, 40), 0);
  assert.equal(remainingUnits(100, 40), 60);
});
