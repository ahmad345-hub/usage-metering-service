// Same-shape benchmark that only uses endpoints present in every version of the service (used for
// the before/after comparison in perf/RESULTS.md):  BASE_URL=... node perf/compare.mjs
import autocannon from "autocannon";
import { randomUUID } from "node:crypto";
const BASE = process.env.BASE_URL, DURATION = Number(process.env.DURATION ?? 10), CONN = Number(process.env.CONNECTIONS ?? 50);
const j = async (m, p, k, b) => (await fetch(BASE + p, { method: m, headers: { "content-type": "application/json", ...(k ? { "x-api-key": k } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();
const plans = await j("GET", "/api/plans");
const pro = plans.find((p) => p.name === "Pro"), premium = plans.find((p) => p.name === "Premium");
const acct = await j("POST", "/api/accounts", null, { name: "cmp-" + randomUUID().slice(0, 6), plan_id: pro.id });
const users = Array.from({ length: 50 }, (_, i) => `u${i}`);
await Promise.all(users.map((u) => j("POST", "/api/users", acct.api_key, { external_id: u, plan_id: premium.id })));
let n = 0;
const r = await autocannon({ url: BASE, connections: CONN, duration: DURATION, requests: [{ method: "POST", path: "/api/usage",
  setupRequest: (req) => { req.headers = { "content-type": "application/json", "x-api-key": acct.api_key };
    req.body = JSON.stringify({ external_id: users[n++ % 50], request_id: randomUUID(), units: 1 }); return req; } }] });
console.log(JSON.stringify({ rps: Math.round(r.requests.average), p50: r.latency.p50, p99: r.latency.p99, "201": r.statusCodeStats["201"]?.count ?? 0, "429": r.statusCodeStats["429"]?.count ?? 0, errors: r.errors + r.timeouts }));
