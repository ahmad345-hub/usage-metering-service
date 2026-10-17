import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { consume, predefinedPlanId, setup, startServer, uniq, type Api } from "./helpers.js";

let api: Api;
let close: () => Promise<void>;
let base: string;
before(async () => ({ api, close, base } = await startServer()));
after(() => close());

describe("API key validation", () => {
  test("rejects a missing key on every protected route", async () => {
    for (const [method, path] of [
      ["GET", "/api/accounts/me"], ["GET", "/api/users"], ["POST", "/api/users"], ["GET", "/api/plans/custom"],
      ["POST", "/api/plans"], ["POST", "/api/usage"], ["GET", "/api/usage/summary"], ["GET", "/api/usage/history"],
    ]) {
      const res = await api(method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.code, "missing_api_key");
    }
  });

  test("rejects an invalid key", async () => {
    const res = await api("GET", "/api/usage/summary", "qk_not_a_real_key");
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "invalid_api_key");
  });

  test("account creation returns the key once and it works afterwards", async () => {
    const res = await api("POST", "/api/accounts", null, { name: uniq("a"), plan_id: await predefinedPlanId(api, "Pro") });
    assert.equal(res.status, 201);
    assert.match(res.body.api_key, /^qk_[0-9a-f]{64}$/);
    assert.equal(res.body.plan.name, "Pro");
    const me = await api("GET", "/api/accounts/me", res.body.api_key);
    assert.equal(me.status, 200);
    assert.equal(me.body.api_key, undefined, "the key must not be returned again");
  });
});

describe("predefined plans", () => {
  test("Starter, Pro, Basic and Premium exist and are read-only", async () => {
    const plans = (await api("GET", "/api/plans")).body;
    assert.deepEqual(plans.map((p: any) => p.name).sort(), ["Basic", "Premium", "Pro", "Starter"]);
    assert.ok(plans.every((p: any) => p.predefined));
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, {});
    const res = await api("PATCH", `/api/plans/${plans[0].id}`, key, { monthly_limit: 1 });
    assert.equal(res.status, 404);
  });

  test("a new account can only start on a predefined account plan", async () => {
    const res = await api("POST", "/api/accounts", null, { name: "x", plan_id: await predefinedPlanId(api, "Basic") });
    assert.equal(res.status, 400);
  });
});

describe("custom plans and assignment", () => {
  test("create, view, update; several users share a plan but keep separate usage", async () => {
    const { key, userPlanIds } = await setup(api, { monthly: 1000, perRequest: 100 }, { a: { monthly: 50, perRequest: 10 } });
    const shared = userPlanIds.a;
    await api("POST", "/api/users", key, { external_id: "b", plan_id: shared });
    await consume(api, key, "a", 10);
    const b = await api("GET", "/api/usage/users/b/summary", key);
    assert.equal(b.body.used_units, 0);
    assert.equal(b.body.plan.id, shared);

    const patched = await api("PATCH", `/api/plans/${shared}`, key, { monthly_limit: 60 });
    assert.equal(patched.status, 200);
    assert.equal((await api("GET", `/api/plans/${shared}`, key)).body.monthly_limit, 60);
    assert.ok((await api("GET", "/api/plans/custom", key)).body.some((p: any) => p.id === shared));
  });

  test("duplicate plan name and bad numbers are rejected with 4xx", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, {});
    const body = { name: "dup", plan_type: "user", monthly_limit: 10, max_per_request: 1 };
    assert.equal((await api("POST", "/api/plans", key, body)).status, 201);
    assert.equal((await api("POST", "/api/plans", key, body)).status, 409);
    assert.equal((await api("POST", "/api/plans", key, { ...body, name: "n", monthly_limit: -1 })).status, 400);
    assert.equal((await api("POST", "/api/plans", key, { ...body, name: "n", max_per_request: 0 })).status, 400);
    assert.equal((await api("POST", "/api/plans", key, { ...body, name: "n", plan_type: "other" })).status, 400);
  });

  test("assign plans to users and to the account; type is enforced", async () => {
    const { key, accountPlanId, userPlanIds } = await setup(api, { monthly: 100, perRequest: 10 }, { u: { monthly: 10, perRequest: 5 } });
    const premium = await predefinedPlanId(api, "Premium");
    const patched = await api("PATCH", "/api/users/u", key, { plan_id: premium });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.plan.name, "Premium");
    assert.equal((await api("PATCH", "/api/users/u", key, { plan_id: accountPlanId })).status, 400, "account plan on a user");
    assert.equal((await api("PUT", "/api/accounts/me/plan", key, { plan_id: userPlanIds.u })).status, 400, "user plan on the account");
    assert.equal((await api("PATCH", "/api/users/ghost", key, { plan_id: premium })).status, 404);
    const pro = await predefinedPlanId(api, "Pro");
    assert.equal((await api("PUT", "/api/accounts/me/plan", key, { plan_id: pro })).body.plan.name, "Pro");
  });

  test("users: list, get, duplicates", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, { u1: { monthly: 10, perRequest: 5 }, u2: { monthly: 10, perRequest: 5 } });
    const list = await api("GET", "/api/users?limit=1", key);
    assert.equal(list.body.total, 2);
    assert.equal(list.body.users.length, 1);
    assert.equal((await api("GET", "/api/users/u2", key)).status, 200);
    const dup = await api("POST", "/api/users", key, { external_id: "u1", plan_id: await predefinedPlanId(api, "Basic") });
    assert.equal(dup.status, 409);
  });
});

describe("account isolation", () => {
  test("an account cannot see, use or change another account's data", async () => {
    const A = await setup(api, { monthly: 100, perRequest: 10 }, { shared: { monthly: 50, perRequest: 10 }, onlyA: { monthly: 50, perRequest: 10 } });
    const B = await setup(api, { monthly: 100, perRequest: 10 }, { shared: { monthly: 50, perRequest: 10 } });

    // A's user is invisible to B
    assert.equal((await consume(api, B.key, "onlyA", 1)).status, 404);
    assert.equal((await api("GET", "/api/users/onlyA", B.key)).status, 404);
    assert.equal((await api("GET", "/api/usage/users/onlyA/summary", B.key)).status, 404);
    assert.equal((await api("PATCH", "/api/users/onlyA", B.key, { plan_id: B.userPlanIds.shared })).status, 404);

    // A's custom plans are invisible/immutable/unassignable for B
    assert.equal((await api("GET", `/api/plans/${A.userPlanIds.onlyA}`, B.key)).status, 404);
    assert.equal((await api("PATCH", `/api/plans/${A.userPlanIds.onlyA}`, B.key, { monthly_limit: 1 })).status, 404);
    assert.equal((await api("PATCH", "/api/users/shared", B.key, { plan_id: A.userPlanIds.onlyA })).status, 400);
    assert.equal((await api("PUT", "/api/accounts/me/plan", B.key, { plan_id: A.accountPlanId })).status, 400);
    assert.equal((await api("POST", "/api/users", B.key, { external_id: "z", plan_id: A.userPlanIds.onlyA })).status, 400);
    assert.deepEqual((await api("GET", "/api/plans/custom", B.key)).body.map((p: any) => p.id).sort(),
      [B.accountPlanId, B.userPlanIds.shared].sort());

    // Same external_id and same request_id in two accounts are fully independent
    assert.equal((await consume(api, A.key, "shared", 7, "same-id")).status, 201);
    const b = await consume(api, B.key, "shared", 3, "same-id");
    assert.equal(b.status, 201);
    assert.equal(b.body.replayed, false);
    assert.equal(b.body.user.used_units, 3);
    assert.equal(b.body.account.used_units, 3);

    // History and summaries only contain the caller's own data
    const histB = (await api("GET", "/api/usage/history", B.key)).body;
    assert.equal(histB.total, 1);
    assert.equal(histB.requests[0].units, 3);
    assert.equal((await api("GET", "/api/usage/summary", A.key)).body.account.used_units, 7);
    assert.equal((await api("GET", "/api/usage/users", B.key)).body.total, 1);
  });
});

describe("validation and errors", () => {
  test("consume validates its input", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, { u: { monthly: 10, perRequest: 5 } });
    const post = (b: unknown) => api("POST", "/api/usage", key, b);
    for (const units of [0, -1, 1.5, "5", null, 2 ** 40]) {
      assert.equal((await post({ external_id: "u", request_id: "r", units })).status, 400, `units=${String(units)}`);
    }
    assert.equal((await post({ external_id: "u", units: 1 })).status, 400);
    assert.equal((await post({ request_id: "r", units: 1 })).status, 400);
    assert.equal((await post({ external_id: "u".repeat(101), request_id: "r", units: 1 })).status, 400);
    assert.equal((await post({ external_id: "ghost", request_id: "r", units: 1 })).status, 404);
  });

  test("errors are JSON: malformed body, bad query, unknown route, long external_id", async () => {
    const { key } = await setup(api, { monthly: 100, perRequest: 10 }, {});
    const malformed = await fetch(`${base}/api/usage`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "invalid_json");
    assert.equal((await api("GET", "/api/usage/summary?month=2026-13", key)).status, 400);
    assert.equal((await api("GET", "/api/usage/history?limit=1000", key)).status, 400);
    assert.equal((await api("GET", "/api/nope")).status, 404);
    const long = await api("POST", "/api/users", key, { external_id: "x".repeat(300), plan_id: await predefinedPlanId(api, "Basic") });
    assert.equal(long.status, 400);
  });

  test("health reports the database", async () => {
    assert.deepEqual((await api("GET", "/health")).body, { status: "ok", database: "connected" });
  });
});
