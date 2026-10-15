
import { test } from "node:test";
import assert from "node:assert/strict";

test("GET /health returns database connection status", async () => {
  const response = await fetch("http://localhost:3000/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    database: "connected",
  });
});
