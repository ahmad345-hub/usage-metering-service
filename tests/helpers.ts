import { once } from "node:events";
import { pool } from "../src/config/database.js";
import { app } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";

export type Api = (method: string, path: string, key?: string | null, body?: unknown) => Promise<{ status: number; body: any }>;

/** Starts the real Express app on a random port (needs only PostgreSQL, not a running service). */
export async function startServer() {
  await migrate();
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const api: Api = async (method, path, key, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };
  return { api, close, base };
}

export const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function predefinedPlanId(api: Api, name: string): Promise<number> {
  const plans = (await api("GET", "/api/plans")).body as Array<{ id: number; name: string }>;
  return plans.find((p) => p.name === name)!.id;
}

export interface Limits { monthly: number; perRequest: number }

/**
 * Creates an account whose account plan and user plans have exactly the given limits,
 * so each test controls the numbers it asserts on.
 */
export async function setup(api: Api, accountLimits: Limits, users: Record<string, Limits>) {
  const created = await api("POST", "/api/accounts", null, { name: uniq("acct"), plan_id: await predefinedPlanId(api, "Starter") });
  const key: string = created.body.api_key;

  const accountPlan = await api("POST", "/api/plans", key, {
    name: "acct-plan", plan_type: "account", monthly_limit: accountLimits.monthly, max_per_request: accountLimits.perRequest,
  });
  await api("PUT", "/api/accounts/me/plan", key, { plan_id: accountPlan.body.id });

  const userPlanIds: Record<string, number> = {};
  for (const [externalId, limits] of Object.entries(users)) {
    const plan = await api("POST", "/api/plans", key, {
      name: `plan-${externalId}`, plan_type: "user", monthly_limit: limits.monthly, max_per_request: limits.perRequest,
    });
    userPlanIds[externalId] = plan.body.id;
    await api("POST", "/api/users", key, { external_id: externalId, plan_id: plan.body.id });
  }
  return { key, accountPlanId: accountPlan.body.id as number, userPlanIds, accountId: created.body.id as number };
}

let counter = 0;
export const consume = (api: Api, key: string, externalId: string, units: number, requestId = `req-${Date.now()}-${counter++}`) =>
  api("POST", "/api/usage", key, { external_id: externalId, request_id: requestId, units });
