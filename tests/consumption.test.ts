import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setClockForTests } from "../src/utils/clock.js";
import { consume, predefinedPlanId, setup, startServer, type Api } from "./helpers.js";

let api: Api;
let close: () => Promise<void>;
before(async () => ({ api, close } = await startServer()));
after(() => close());

describe("applying account and user plans together (examples from the brief)", () => {
  // account: 10,000/month, 100 per request. user: 1,000/month, 20 per request
  test("25 units: rejected by the USER per-request limit; nothing consumed", async () => {
    const { key } = await setup(api, { monthly: 10_000, perRequest: 100 }, { u: { monthly: 1_000, perRequest: 20 } });
    const res = await consume(api, key, "u", 25);
    assert.equal(res.status, 429);
    assert.equal(res.body.accepted, false);
    assert.deepEqual([res.body.rejection.level, res.body.rejection.rule], ["user", "max_per_request"]);
    assert.equal(res.body.user.used_units, 0);
    assert.equal(res.body.account.used_units, 0);
  });

  test("10 units: accepted, counted for the user AND the shared account", async () => {
    const { key } = await setup(api, { monthly: 10_000, perRequest: 100 }, { u: { monthly: 1_000, perRequest: 20 } });
    const res = await consume(api, key, "u", 10);
    assert.equal(res.status, 201);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.user.used_units, 10);
    assert.equal(res.body.user.remaining_units, 990);
    assert.equal(res.body.account.used_units, 10);
    assert.equal(res.body.account.remaining_units, 9_990);
  });

  test("account has 5 units left: 10-unit request rejected by the ACCOUNT even though the user has plenty", async () => {
    const { key } = await setup(api, { monthly: 15, perRequest: 100 }, { u: { monthly: 1_000, perRequest: 20 } });
    assert.equal((await consume(api, key, "u", 10)).status, 201);
    const res = await consume(api, key, "u", 10);
    assert.equal(res.status, 429);
    assert.deepEqual([res.body.rejection.level, res.body.rejection.rule], ["account", "monthly_limit"]);
    assert.equal(res.body.account.remaining_units, 5);
    assert.equal(res.body.user.used_units, 10, "a rejection consumes nothing");
  });

  test("the account total is the sum of its users; a bigger user plan does not grow the account allowance", async () => {
    const { key } = await setup(api, { monthly: 30, perRequest: 30 }, { a: { monthly: 1_000, perRequest: 30 }, b: { monthly: 1_000, perRequest: 30 } });
    await consume(api, key, "a", 20);
    await consume(api, key, "b", 10);
    const refused = await consume(api, key, "a", 1);
    assert.equal(refused.body.rejection.level, "account");
    const summary = (await api("GET", "/api/usage/summary", key)).body.account;
    assert.equal(summary.used_units, 30);
    assert.equal(summary.remaining_units, 0);
  });

  test("exactly reaching the monthly allowance is accepted", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, { u: { monthly: 20, perRequest: 10 } });
    assert.equal((await consume(api, key, "u", 10)).status, 201);
    assert.equal((await consume(api, key, "u", 10)).status, 201);
    assert.equal((await consume(api, key, "u", 1)).status, 429);
  });
});

describe("safe retries (idempotency)", () => {
  test("repeating a request_id returns the same decision and counts once", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 50 }, { u: { monthly: 100, perRequest: 10 } });
    const first = await consume(api, key, "u", 5, "retry-1");
    const again = await consume(api, key, "u", 5, "retry-1");
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.accepted, true);
    assert.equal(again.body.user.used_units, 5);
  });

  test("a rejection is also replayed, and is stored in history once", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 50 }, { u: { monthly: 100, perRequest: 10 } });
    const first = await consume(api, key, "u", 20, "rej-1");
    const again = await consume(api, key, "u", 20, "rej-1");
    assert.equal(first.status, 429);
    assert.equal(again.status, 429);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.rejection, first.body.rejection);
    assert.equal((await api("GET", "/api/usage/history", key)).body.total, 1);
  });

  test("the same request_id with a different amount or user is a 409 conflict", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 50 }, { u: { monthly: 100, perRequest: 10 }, v: { monthly: 100, perRequest: 10 } });
    await consume(api, key, "u", 5, "conflict-1");
    assert.equal((await consume(api, key, "u", 6, "conflict-1")).status, 409);
    assert.equal((await consume(api, key, "v", 5, "conflict-1")).status, 409);
    assert.equal((await api("GET", "/api/usage/users/u/summary", key)).body.used_units, 5);
  });

  test("40 concurrent copies of the same request count exactly once", async () => {
    const { key } = await setup(api, { monthly: 1_000, perRequest: 50 }, { u: { monthly: 1_000, perRequest: 50 } });
    const results = await Promise.all(Array.from({ length: 40 }, () => consume(api, key, "u", 5, "same-everywhere")));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 200 && r.body.replayed).length, 39);
    assert.equal((await api("GET", "/api/usage/users/u/summary", key)).body.used_units, 5);
    assert.equal((await api("GET", "/api/usage/summary", key)).body.account.used_units, 5);
  });
});

describe("competing requests", () => {
  test("200 concurrent requests for one user never exceed the user allowance", async () => {
    const { key } = await setup(api, { monthly: 10_000, perRequest: 10 }, { u: { monthly: 50, perRequest: 10 } });
    const results = await Promise.all(Array.from({ length: 200 }, () => consume(api, key, "u", 1)));
    assert.equal(results.filter((r) => r.status === 201).length, 50);
    assert.equal(results.filter((r) => r.status === 429).length, 150);
    assert.equal((await api("GET", "/api/usage/users/u/summary", key)).body.used_units, 50);
    assert.equal((await api("GET", "/api/usage/summary", key)).body.account.used_units, 50);
  });

  test("300 concurrent requests across 10 users never exceed the shared account allowance", async () => {
    const users = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`u${i}`, { monthly: 1_000, perRequest: 10 }]));
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, users);
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => consume(api, key, `u${i % 10}`, 1)));
    assert.equal(results.filter((r) => r.status === 201).length, 100);
    assert.ok(results.filter((r) => r.status === 429).every((r) => r.body.rejection.level === "account"));
    const perUser = (await api("GET", "/api/usage/users?limit=100", key)).body.users;
    assert.equal(perUser.reduce((sum: number, u: any) => sum + u.used_units, 0), 100, "user totals add up to the account total");
    assert.equal((await api("GET", "/api/usage/summary", key)).body.account.used_units, 100);
  });

  test("a plan change racing with consumption never loses or double counts units", async () => {
    const { key, userPlanIds } = await setup(api, { monthly: 10_000, perRequest: 10 }, { u: { monthly: 100, perRequest: 10 } });
    const jobs: Array<Promise<any>> = Array.from({ length: 100 }, () => consume(api, key, "u", 1));
    jobs.splice(50, 0, api("PATCH", `/api/plans/${userPlanIds.u}`, key, { monthly_limit: 20 }));
    const results = (await Promise.all(jobs)).filter((r) => r.body.request_id);
    const accepted = results.filter((r) => r.status === 201).length;
    const used = (await api("GET", "/api/usage/users/u/summary", key)).body.used_units;
    assert.equal(used, accepted);
    assert.ok(accepted >= 20 && accepted <= 100);
  });
});

describe("changing plans", () => {
  test("editing a custom plan applies to the very next request, with no restart", async () => {
    const { key, userPlanIds } = await setup(api, { monthly: 1_000, perRequest: 100 }, { u: { monthly: 100, perRequest: 10 } });
    assert.equal((await consume(api, key, "u", 50)).status, 429);
    await api("PATCH", `/api/plans/${userPlanIds.u}`, key, { max_per_request: 60 });
    assert.equal((await consume(api, key, "u", 50)).status, 201);
  });

  test("switching a user's plan keeps consumed units and gives no fresh allowance", async () => {
    const { key, userPlanIds } = await setup(api, { monthly: 1_000, perRequest: 100 }, { u: { monthly: 50, perRequest: 50 } });
    await consume(api, key, "u", 40);
    const small = await api("POST", "/api/plans", key, { name: "small", plan_type: "user", monthly_limit: 45, max_per_request: 50 });
    await api("PATCH", "/api/users/u", key, { plan_id: small.body.id });
    const summary = (await api("GET", "/api/usage/users/u/summary", key)).body;
    assert.equal(summary.used_units, 40);
    assert.equal(summary.remaining_units, 5);
    assert.equal((await consume(api, key, "u", 6)).status, 429);
    assert.equal((await consume(api, key, "u", 5)).status, 201);
    void userPlanIds;
  });

  test("allowance reduced below usage: zero remaining, rejected until raised again", async () => {
    const { key, userPlanIds } = await setup(api, { monthly: 1_000, perRequest: 100 }, { u: { monthly: 100, perRequest: 50 } });
    await consume(api, key, "u", 40);
    await api("PATCH", `/api/plans/${userPlanIds.u}`, key, { monthly_limit: 10 });
    const summary = (await api("GET", "/api/usage/users/u/summary", key)).body;
    assert.equal(summary.used_units, 40);
    assert.equal(summary.remaining_units, 0);
    assert.deepEqual((await consume(api, key, "u", 1)).body.rejection, { level: "user", rule: "monthly_limit", message: "Rejected by the user's monthly allowance" });
    await api("PATCH", `/api/plans/${userPlanIds.u}`, key, { monthly_limit: 100 });
    assert.equal((await consume(api, key, "u", 1)).status, 201);
  });

  test("the account allowance can be lowered and switched too", async () => {
    const { key, accountPlanId } = await setup(api, { monthly: 100, perRequest: 50 }, { u: { monthly: 100, perRequest: 50 } });
    await consume(api, key, "u", 30);
    await api("PATCH", `/api/plans/${accountPlanId}`, key, { monthly_limit: 20 });
    const rejected = await consume(api, key, "u", 1);
    assert.deepEqual([rejected.body.rejection.level, rejected.body.account.remaining_units], ["account", 0]);
    await api("PUT", "/api/accounts/me/plan", key, { plan_id: await predefinedPlanId(api, "Pro") });
    assert.equal((await consume(api, key, "u", 1)).status, 201);
    assert.equal((await api("GET", "/api/usage/summary", key)).body.account.used_units, 31, "usage kept across the switch");
  });

  test("history keeps old decisions after plan changes", async () => {
    const { key, userPlanIds } = await setup(api, { monthly: 1_000, perRequest: 100 }, { u: { monthly: 100, perRequest: 10 } });
    await consume(api, key, "u", 50, "old-reject");
    await api("PATCH", `/api/plans/${userPlanIds.u}`, key, { max_per_request: 60 });
    await consume(api, key, "u", 50, "new-accept");
    const history = (await api("GET", "/api/usage/history", key)).body;
    assert.deepEqual(history.requests.map((r: any) => [r.request_id, r.accepted]), [["new-accept", true], ["old-reject", false]]);
    assert.equal((await api("GET", "/api/usage/history?accepted=false", key)).body.total, 1);
    assert.equal((await api("GET", "/api/usage/history?external_id=u&limit=1&page=2", key)).body.requests[0].request_id, "old-reject");
  });
});

describe("UTC months", () => {
  test("a new month starts at zero, previous months stay queryable", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 50 }, { u: { monthly: 30, perRequest: 30 } });
    try {
      setClockForTests(() => new Date("2026-09-30T23:59:59Z"));
      assert.equal((await consume(api, key, "u", 30)).status, 201);
      assert.equal((await consume(api, key, "u", 1)).status, 429, "September allowance is used up");

      setClockForTests(() => new Date("2026-10-01T00:00:00Z"));
      const fresh = await consume(api, key, "u", 30);
      assert.equal(fresh.status, 201, "October starts with a fresh allowance");
      assert.equal(fresh.body.month, "2026-10");
      assert.equal(fresh.body.user.used_units, 30);
      assert.equal(fresh.body.account.used_units, 30);

      const september = (await api("GET", "/api/usage/users/u/summary?month=2026-09", key)).body;
      assert.equal(september.used_units, 30);
      assert.equal(september.remaining_units, null, "remaining is only reported for the current month");
      assert.equal((await api("GET", "/api/usage/summary?month=2026-09", key)).body.account.used_units, 30);
      assert.deepEqual((await api("GET", "/api/usage/months", key)).body, [
        { month: "2026-10", used_units: 30 }, { month: "2026-09", used_units: 30 },
      ]);
      const sepHistory = (await api("GET", "/api/usage/history?month=2026-09", key)).body;
      assert.equal(sepHistory.total, 2);
      assert.equal((await api("GET", "/api/usage/history?month=2026-10", key)).body.total, 1);
    } finally {
      setClockForTests(null);
    }
  });
});
