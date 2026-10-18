// Everything the example application knows about the metering service lives here. It only uses the
// public HTTP API and an account API key. It has no knowledge of plan limits, so changing a plan
// changes what users can do without touching this code.
import { randomUUID } from "node:crypto";

export const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:3000";

export const session = { apiKey: null, accountName: null };

export class ServiceUnreachable extends Error {}

export async function call(method, path, body, apiKey = session.apiKey) {
  let res;
  try {
    res = await fetch(SERVICE_URL + path, {
      method,
      headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ServiceUnreachable("Cannot reach the metering service. Retry.");
  }
  return { status: res.status, data: await res.json() };
}

export async function waitForService(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await fetch(SERVICE_URL + "/health")).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new ServiceUnreachable(`Metering service not reachable at ${SERVICE_URL}`);
}

/**
 * Creates a fresh demo company with:
 *  - a small CUSTOM account plan (60 units/month, 30 per request) so the shared limit is easy to reach
 *  - alice on the predefined Basic plan   (180/month, 12 per request)
 *  - bob   on the predefined Premium plan (1800/month, 85 per request)
 */
export async function resetDemo() {
  const plans = (await call("GET", "/api/plans", undefined, null)).data;
  const byName = (n) => plans.find((p) => p.name === n);

  const created = await call("POST", "/api/accounts", { name: `Docs Inc ${randomUUID().slice(0, 4)}`, plan_id: byName("Starter").id }, null);
  session.apiKey = created.data.api_key;
  session.accountName = created.data.name;

  const demoPlan = await call("POST", "/api/plans", { name: "Demo Account Plan", plan_type: "account", monthly_limit: 60, max_per_request: 30 });
  await call("PUT", "/api/accounts/me/plan", { plan_id: demoPlan.data.id });
  await call("POST", "/api/users", { external_id: "alice", plan_id: byName("Basic").id });
  await call("POST", "/api/users", { external_id: "bob", plan_id: byName("Premium").id });
  return { demoPlanId: demoPlan.data.id };
}

export async function ensureSession() {
  if (!session.apiKey) await resetDemo();
}

/** The "business action" is simulated. The metering service decides whether it may run. */
export async function processDocument(externalId, units) {
  const { status, data } = await call("POST", "/api/usage", { external_id: externalId, request_id: randomUUID(), units });
  return { http: status, ...data };
}

export async function snapshot() {
  await ensureSession();
  const [account, summary, users, history, accountPlans, userPlans, custom] = await Promise.all([
    call("GET", "/api/accounts/me"),
    call("GET", "/api/usage/summary"),
    call("GET", "/api/usage/users"),
    call("GET", "/api/usage/history?limit=12"),
    call("GET", "/api/plans?type=account", undefined, null),
    call("GET", "/api/plans?type=user", undefined, null),
    call("GET", "/api/plans/custom"),
  ]);
  const customOf = (type) => custom.data.filter((p) => p.type === type);
  return {
    accountName: session.accountName,
    account: { ...account.data, usage: summary.data.account },
    users: users.data.users,
    history: history.data.requests,
    history_total: history.data.total,
    plans: {
      account: [...customOf("account"), ...accountPlans.data],
      user: [...customOf("user"), ...userPlans.data],
      all: [...custom.data, ...accountPlans.data, ...userPlans.data],
    },
  };
}
