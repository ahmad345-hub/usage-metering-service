// Load test for POST /api/usage. Each scenario ends with a CORRECTNESS CHECK against the service's own
// totals, so a fast-but-wrong result fails the run.
//
//   npm run perf                                  (service on http://localhost:3000)
//   BASE_URL=http://api:3000 DURATION=10 CONNECTIONS=50 node perf/loadtest.mjs
import autocannon from "autocannon";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);

async function api(method, path, key, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** Account on custom plans with the given limits and `userCount` users sharing one user plan. */
async function createAccount(label, { accountMonthly, userMonthly, userCount }) {
  const plans = await api("GET", "/api/plans?type=account");
  const acct = await api("POST", "/api/accounts", null, { name: `${label}-${randomUUID().slice(0, 8)}`, plan_id: plans[0].id });
  const key = acct.api_key;
  const ap = await api("POST", "/api/plans", key, { name: "load-account", plan_type: "account", monthly_limit: accountMonthly, max_per_request: 10 });
  await api("PUT", "/api/accounts/me/plan", key, { plan_id: ap.id });
  const up = await api("POST", "/api/plans", key, { name: "load-user", plan_type: "user", monthly_limit: userMonthly, max_per_request: 10 });
  const users = Array.from({ length: userCount }, (_, i) => `user-${i}`);
  for (let i = 0; i < users.length; i += 20) {
    await Promise.all(users.slice(i, i + 20).map((u) => api("POST", "/api/users", key, { external_id: u, plan_id: up.id })));
  }
  return { key, users };
}

async function readTotals({ key }) {
  const account = (await api("GET", "/api/usage/summary", key)).account;
  let userSum = 0;
  for (let page = 1; ; page++) {
    const { users } = await api("GET", `/api/usage/users?limit=100&page=${page}`, key);
    userSum += users.reduce((s, u) => s + u.used_units, 0);
    if (users.length < 100) break;
  }
  const history = await api("GET", "/api/usage/history?accepted=true&limit=1", key);
  return { accountUsed: account.used_units, userSum, decisions: history.total };
}

/**
 * autocannon stops measuring at the deadline but the service still finishes requests that were in
 * flight, so wait until the totals stop moving, then read them. `decisions` is the number of accepted
 * requests recorded in the service's own request history (units are always 1 here).
 */
async function totals(acct) {
  let last = await readTotals(acct);
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const now = await readTotals(acct);
    if (now.accountUsed === last.accountUsed && now.decisions === last.decisions) return now;
    last = now;
  }
}

/** Server-side numbers must agree with each other exactly and with the client's count within the in-flight window. */
const agree = (t, clientAccepted) =>
  t.accountUsed === t.userSum && t.accountUsed === t.decisions &&
  t.decisions >= clientAccepted && t.decisions <= clientAccepted + CONNECTIONS;

function drive(accounts, requestIdFor) {
  let n = 0;
  return autocannon({
    url: BASE, connections: CONNECTIONS, duration: DURATION,
    requests: [{
      method: "POST", path: "/api/usage",
      setupRequest: (req) => {
        const i = n++;
        const acct = accounts[i % accounts.length];
        req.headers = { "content-type": "application/json", "x-api-key": acct.key };
        req.body = JSON.stringify({ external_id: acct.users[i % acct.users.length], request_id: requestIdFor(i), units: 1 });
        return req;
      },
    }],
  });
}

const rows = [];
let failed = false;
let served = 0; // requests served in scenario 1; sizes the limit/ids of scenarios 3 and 4 so they always exceed them
function report(name, result, verdict) {
  const s = result.statusCodeStats;
  const accepted = s["201"]?.count ?? 0, rejected = s["429"]?.count ?? 0, replayed = s["200"]?.count ?? 0;
  const bad = result.non2xx - rejected;
  const row = {
    scenario: name, rps: Math.round(result.requests.average), p50: result.latency.p50, p99: result.latency.p99,
    max: result.latency.max, accepted, rejected, replayed, errors: result.errors + result.timeouts + bad, verdict,
  };
  rows.push(row);
  if (verdict !== "OK" || row.errors > 0) failed = true;
  console.log(`\n== ${name} ==`);
  console.table([row]);
}

// 1. Worst case: one account (all requests share one lock), 50 users, nothing ever rejected.
{
  const acct = await createAccount("one-account", { accountMonthly: 1e12, userMonthly: 1e12, userCount: 50 });
  const r = await drive([acct], () => randomUUID());
  const t = await totals(acct);
  const accepted = r.statusCodeStats["201"]?.count ?? 0;
  served = accepted;
  report("1. one account, 50 users, all accepted", r, agree(t, accepted) ? "OK" : `MISMATCH client=${accepted} account=${t.accountUsed} users=${t.userSum} recorded=${t.decisions}`);
}

// 2. Typical SaaS shape: many accounts in parallel. Different accounts never block each other.
{
  const accounts = await Promise.all(Array.from({ length: 20 }, (_, i) => createAccount(`multi-${i}`, { accountMonthly: 1e12, userMonthly: 1e12, userCount: 10 })));
  const r = await drive(accounts, () => randomUUID());
  const all = await Promise.all(accounts.map(totals));
  const accepted = r.statusCodeStats["201"]?.count ?? 0;
  const consistent = all.every((t) => t.accountUsed === t.userSum && t.accountUsed === t.decisions);
  const sum = all.reduce((s, t) => s + t.decisions, 0);
  report("2. 20 accounts x 10 users, all accepted", r, consistent && sum >= accepted && sum <= accepted + CONNECTIONS ? "OK" : `MISMATCH client=${accepted} recorded=${sum}`);
}

// 3. Contention at the limit: the allowance is ~40% of what the machine serves in one run, so far more
//    requests arrive than may pass. Exactly LIMIT of them must be accepted, never LIMIT+1.
{
  const LIMIT = Number(process.env.LIMIT ?? Math.max(50, Math.floor(served * 0.4)));
  const acct = await createAccount("tight", { accountMonthly: LIMIT, userMonthly: 1e12, userCount: 100 });
  const r = await drive([acct], () => randomUUID());
  const t = await totals(acct);
  const accepted = r.statusCodeStats["201"]?.count ?? 0;
  const total = (r.statusCodeStats["201"]?.count ?? 0) + (r.statusCodeStats["429"]?.count ?? 0);
  const verdict = t.accountUsed !== LIMIT || t.userSum !== LIMIT || t.decisions !== LIMIT
    ? `MISMATCH account=${t.accountUsed} users=${t.userSum} recorded=${t.decisions} (expected exactly ${LIMIT})`
    : total <= LIMIT ? `INCONCLUSIVE: limit never exceeded, raise DURATION` : "OK";
  report(`3. account limit ${LIMIT}, requests >> limit`, r, verdict);
}

// 4. Retry storm: a fixed set of request ids, each sent many times concurrently. Each must count exactly once.
{
  const IDS = Math.max(20, Math.min(500, Math.floor(served * 0.25)));
  const acct = await createAccount("retries", { accountMonthly: 1e12, userMonthly: 1e12, userCount: 20 });
  // external_id is derived from the request id, so a retry always carries the same user and amount.
  let n = 0;
  const r = await autocannon({
    url: BASE, connections: CONNECTIONS, duration: DURATION,
    requests: [{
      method: "POST", path: "/api/usage",
      setupRequest: (req) => {
        const id = n++ % IDS;
        req.headers = { "content-type": "application/json", "x-api-key": acct.key };
        req.body = JSON.stringify({ external_id: acct.users[id % acct.users.length], request_id: `retry-${id}`, units: 1 });
        return req;
      },
    }],
  });
  const t = await totals(acct);
  report(`4. retry storm, ${IDS} unique request ids`, r, t.accountUsed === IDS && t.userSum === IDS && t.decisions === IDS ? "OK" : `MISMATCH account=${t.accountUsed} users=${t.userSum} recorded=${t.decisions} (expected ${IDS})`);
}

const md = [
  `Load test against ${BASE} - ${CONNECTIONS} connections, ${DURATION}s per scenario, ${new Date().toISOString()}`,
  "",
  "| Scenario | req/s | p50 ms | p99 ms | max ms | 201 | 429 | 200 (replay) | errors | correctness |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.scenario} | ${r.rps} | ${r.p50} | ${r.p99} | ${r.max} | ${r.accepted} | ${r.rejected} | ${r.replayed} | ${r.errors} | ${r.verdict} |`),
].join("\n");
writeFileSync(new URL("./last-run.md", import.meta.url), md + "\n");
console.log("\n" + md);
process.exit(failed ? 1 : 0);
