
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

test("API integration: usage, idempotency, and account isolation", async (t) => {
  const suffix = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  // Find a default account plan.
  const plansResponse = await fetch(`${baseUrl}/api/plans`);

  assert.equal(plansResponse.status, 200);

  const plans = (await plansResponse.json()) as Array<{
    id: number;
    plan_type: string;
  }>;

  const defaultPlan = plans.find(
    (plan) => plan.plan_type === "account",
  );

  assert.ok(defaultPlan, "A default account plan should exist");

  // Create an account and retrieve its API key.
  async function createAccount(name: string) {
    const response = await fetch(`${baseUrl}/api/accounts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        plan_id: defaultPlan!.id,
      }),
    });

    assert.equal(response.status, 201);

    const account = (await response.json()) as {
      id: number;
      api_key: string;
    };

    assert.ok(account.id);
    assert.ok(account.api_key);

    return account;
  }

  const accountA = await createAccount(`Test Account A ${suffix}`);
  const accountB = await createAccount(`Test Account B ${suffix}`);

  const headersA = {
    "content-type": "application/json",
    "x-api-key": accountA.api_key,
  };

  const headersB = {
    "content-type": "application/json",
    "x-api-key": accountB.api_key,
  };

  // Create a custom user plan for account A.
  const planResponse = await fetch(`${baseUrl}/api/plans`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      name: `Test User Plan ${suffix}`,
      plan_type: "user",
      monthly_limit: 500,
      max_per_request: 25,
    }),
  });

  assert.equal(planResponse.status, 201);

  const customPlan = (await planResponse.json()) as {
    id: number;
  };

  assert.ok(customPlan.id);

  // Create a user belonging to account A.
  const userExternalId = `test-user-${suffix}`;

  const userResponse = await fetch(`${baseUrl}/api/users`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      external_id: userExternalId,
      plan_id: customPlan.id,
    }),
  });

  assert.equal(userResponse.status, 201);

  // Test successful usage recording.
  await t.test("accepts valid usage", async () => {
    const response = await fetch(`${baseUrl}/api/usage`, {
      method: "POST",
      headers: headersA,
      body: JSON.stringify({
        external_id: userExternalId,
        request_id: `usage-${suffix}`,
        units: 10,
      }),
    });

    assert.equal(response.status, 201);

    const result = (await response.json()) as {
      message: string;
      accepted: boolean;
      requested_units: number;
    };

    assert.equal(result.message, "Usage recorded successfully");
    assert.equal(result.accepted, true);
    assert.equal(result.requested_units, 10);
  });

  // Test idempotency: repeating a request must not count its units twice.
  await t.test("does not count a repeated request twice", async () => {
    const requestBody = {
      external_id: userExternalId,
      request_id: `idempotency-${suffix}`,
      units: 1,
    };

    const firstResponse = await fetch(`${baseUrl}/api/usage`, {
      method: "POST",
      headers: headersA,
      body: JSON.stringify(requestBody),
    });

    assert.equal(firstResponse.status, 201);

    const firstResult = (await firstResponse.json()) as {
      accepted: boolean;
    };

    assert.equal(firstResult.accepted, true);

    const secondResponse = await fetch(`${baseUrl}/api/usage`, {
      method: "POST",
      headers: headersA,
      body: JSON.stringify(requestBody),
    });

    const secondResult = (await secondResponse.json()) as {
      message: string;
      accepted: boolean;
      replayed: boolean;
    };

    assert.equal(secondResult.message, "Usage already recorded");
    assert.equal(secondResult.accepted, true);
    assert.equal(secondResult.replayed, true);

    // The first usage request added 10 units, and this request added 1.
    // Replaying it must not increase the total again.
    const summaryResponse = await fetch(
      `${baseUrl}/api/usage/users/${encodeURIComponent(
        userExternalId,
      )}/summary`,
      {
        headers: headersA,
      },
    );

    assert.equal(summaryResponse.status, 200);

    const summary = (await summaryResponse.json()) as {
      used_units: string | number;
    };

    assert.equal(Number(summary.used_units), 11);
  });

  // Account B must not be able to access account A's user.
  await t.test("does not expose a user's usage to another account", async () => {
    const response = await fetch(`${baseUrl}/api/usage`, {
      method: "POST",
      headers: headersB,
      body: JSON.stringify({
        external_id: userExternalId,
        request_id: `cross-account-${suffix}`,
        units: 1,
      }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      message: "User not found",
    });
  });

  // Account B must not be able to update account A's custom plan.
  await t.test("does not allow another account to update a custom plan", async () => {
    const response = await fetch(
      `${baseUrl}/api/plans/${customPlan.id}`,
      {
        method: "PATCH",
        headers: headersB,
        body: JSON.stringify({
          name: `Unauthorized Change ${suffix}`,
        }),
      },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      message: "Custom plan not found",
    });
  });

  // Default plans must not be editable through the custom-plan endpoint.
  await t.test("does not allow updating a default plan", async () => {
    const response = await fetch(
      `${baseUrl}/api/plans/${defaultPlan!.id}`,
      {
        method: "PATCH",
        headers: headersA,
        body: JSON.stringify({
          name: `Unauthorized Default Plan Change ${suffix}`,
        }),
      },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      message: "Custom plan not found",
    });
  });
});
