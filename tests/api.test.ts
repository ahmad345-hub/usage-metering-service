import { test } from "node:test";
import assert from "node:assert/strict";

const baseUrl = "http://localhost:3000";

test("GET /health returns database connection status", async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    database: "connected",
  });
});

test("GET /api/usage/summary rejects a missing API key", async () => {
  const response = await fetch(`${baseUrl}/api/usage/summary`);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    message: "API key is required",
  });
});

test("GET /api/usage/summary rejects an invalid API key", async () => {
  const response = await fetch(`${baseUrl}/api/usage/summary`, {
    headers: {
      "x-api-key": "invalid-test-api-key",
    },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    message: "Invalid API key",
  });
});