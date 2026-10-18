// Example application: a small "document processing" web app that calls the metering service.
// The browser never sees the account API key: it talks to this server, which calls the service.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  SERVICE_URL, ServiceUnreachable, call, ensureSession, processDocument, resetDemo, session, snapshot, waitForService,
} from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const page = readFileSync(new URL("./public/index.html", import.meta.url));

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => {
  let s = "";
  req.on("data", (c) => (s += c));
  req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
});

const routes = {
  "GET /": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page); },
  "GET /api/state": async (_req, res) => json(res, 200, await snapshot()),
  "POST /api/process": async (req, res) => {
    const b = await readBody(req);
    await ensureSession();
    json(res, 200, await processDocument(String(b.external_id ?? ""), b.units));
  },
  "POST /api/user-plan": async (req, res) => {
    const b = await readBody(req);
    json(res, 200, await call("PATCH", `/api/users/${encodeURIComponent(String(b.external_id))}`, { plan_id: Number(b.plan_id) }));
  },
  "POST /api/account-plan": async (req, res) => {
    const b = await readBody(req);
    json(res, 200, await call("PUT", "/api/accounts/me/plan", { plan_id: Number(b.plan_id) }));
  },
  "POST /api/edit-plan": async (req, res) => {
    const { id, ...fields } = await readBody(req);
    json(res, 200, await call("PATCH", `/api/plans/${Number(id)}`, fields));
  },
  "POST /api/reset": async (_req, res) => { await resetDemo(); json(res, 200, { ok: true }); },
};

createServer(async (req, res) => {
  const handler = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  if (!handler) return json(res, 404, { message: "Not found" });
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof ServiceUnreachable) return json(res, 502, { message: error.message });
    console.error(error);
    json(res, 500, { message: "Unexpected error in the example client" });
  }
}).listen(PORT, async () => {
  console.log(`Example client on http://localhost:${PORT}, metering service at ${SERVICE_URL}`);
  try {
    await waitForService();
    await resetDemo();
    console.log(`Demo account "${session.accountName}" ready (alice = Basic, bob = Premium).`);
  } catch (error) {
    console.error(String(error.message ?? error));
  }
});
