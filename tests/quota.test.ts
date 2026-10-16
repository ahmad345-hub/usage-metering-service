
import test from "node:test";
import assert from "node:assert/strict";
import { checkQuota } from "../src/services/quotaService.js";

test("Accept usage when both quotas allow it", () => {
  const result = checkQuota({
    account: {
      monthlyLimit: 2400n,
      maxPerRequest: 35,
      usedUnits: 100n
    },
    user: {
      monthlyLimit: 180n,
      maxPerRequest: 12,
      usedUnits: 20n
    },
    requestedUnits: 10
  });

  assert.deepEqual(result, {
    allowed: true,
    rejectionLevel: null,
    rejectionRule: null
  });
});



test("Reject usage when user request limit is exceeded", () => {
  const result = checkQuota({
    account: {
      monthlyLimit: 2400n,
      maxPerRequest: 35,
      usedUnits: 100n
    },
    user: {
      monthlyLimit: 180n,
      maxPerRequest: 12,
      usedUnits: 20n
    },
    requestedUnits: 20
  });

  assert.deepEqual(result, {
    allowed: false,
    rejectionLevel: "user",
    rejectionRule: "max_per_request"
  });
});




test("Reject usage when user monthly quota is exceeded", () => {
  const result = checkQuota({
    account: {
      monthlyLimit: 2400n,
      maxPerRequest: 35,
      usedUnits: 100n
    },
    user: {
      monthlyLimit: 180n,
      maxPerRequest: 12,
      usedUnits: 175n
    },
    requestedUnits: 10
  });

  assert.deepEqual(result, {
    allowed: false,
    rejectionLevel: "user",
    rejectionRule: "monthly_limit"
  });
});




test("Reject usage when account monthly quota is exceeded", () => {
  const result = checkQuota({
    account: {
      monthlyLimit: 2400n,
      maxPerRequest: 35,
      usedUnits: 2395n
    },
    user: {
      monthlyLimit: 180n,
      maxPerRequest: 12,
      usedUnits: 20n
    },
    requestedUnits: 10
  });

  assert.deepEqual(result, {
    allowed: false,
    rejectionLevel: "account",
    rejectionRule: "monthly_limit"
  });
});




test("Reject usage when account request limit is exceeded", () => {
  const result = checkQuota({
    account: {
      monthlyLimit: 2400n,
      maxPerRequest: 35,
      usedUnits: 100n
    },
    user: {
      monthlyLimit: 950n,
      maxPerRequest: 45,
      usedUnits: 30n
    },
    requestedUnits: 40
  });

  assert.deepEqual(result, {
    allowed: false,
    rejectionLevel: "account",
    rejectionRule: "max_per_request"
  });
});



test("Accept usage when user reaches monthly quota exactly", () => {
  const result = checkQuota({
    account: {
      monthlyLimit: 2400n,
      maxPerRequest: 35,
      usedUnits: 100n
    },
    user: {
      monthlyLimit: 500n,
      maxPerRequest: 25,
      usedUnits: 490n
    },
    requestedUnits: 10
  });

  assert.deepEqual(result, {
    allowed: true,
    rejectionLevel: null,
    rejectionRule: null
  });
});