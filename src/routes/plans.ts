
import { Router } from "express";
import pool from "../config/database.js";
import { authenticateApiKey } from "../middleware/auth.js";

const router = Router();

// Get default plans
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, plan_type, monthly_limit, max_per_request
       FROM plans
       WHERE account_id IS NULL
       ORDER BY id`
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Failed to fetch plans:", error);

    return res.status(500).json({
      message: "Failed to fetch plans"
    });
  }
});

// Get custom plans owned by the authenticated account
router.get("/custom", authenticateApiKey, async (req, res) => {
  const accountId = res.locals.account.id;

  try {
    const result = await pool.query(
      `SELECT id, name, plan_type, account_id,
              monthly_limit, max_per_request
       FROM plans
       WHERE account_id = $1
       ORDER BY id`,
      [accountId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Failed to fetch custom plans:", error);

    return res.status(500).json({
      message: "Failed to fetch custom plans"
    });
  }
});


// Update a custom plan owned by the authenticated account
router.patch("/:id", authenticateApiKey, async (req, res) => {
  const accountId = res.locals.account.id;
  const planId = Number(req.params.id);

  if (!Number.isSafeInteger(planId) || planId <= 0) {
    return res.status(400).json({
      message: "Invalid plan ID"
    });
  }

  const { name, monthly_limit, max_per_request } = req.body ?? {};

  const updates: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined) {
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      name.trim().length > 100
    ) {
      return res.status(400).json({
        message: "Invalid plan name"
      });
    }

    values.push(name.trim());
    updates.push(`name = $${values.length}`);
  }

  if (monthly_limit !== undefined) {
    if (
      !Number.isSafeInteger(monthly_limit) ||
      monthly_limit < 0
    ) {
      return res.status(400).json({
        message: "Invalid monthly limit"
      });
    }

    values.push(monthly_limit);
    updates.push(`monthly_limit = $${values.length}`);
  }

  if (max_per_request !== undefined) {
    if (
      !Number.isSafeInteger(max_per_request) ||
      max_per_request <= 0 ||
      max_per_request > 2147483647
    ) {
      return res.status(400).json({
        message: "Invalid maximum per request"
      });
    }

    values.push(max_per_request);
    updates.push(`max_per_request = $${values.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      message: "Provide at least one field to update"
    });
  }

  values.push(planId);
  const planIdPosition = values.length;

  values.push(accountId);
  const accountIdPosition = values.length;

  try {
    const result = await pool.query(
      `UPDATE plans
       SET ${updates.join(", ")}
       WHERE id = $${planIdPosition}
         AND account_id = $${accountIdPosition}
       RETURNING id, name, plan_type, account_id,
                 monthly_limit, max_per_request`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Custom plan not found"
      });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      return res.status(409).json({
        message: "A plan with this name and type already exists"
      });
    }

    console.error("Failed to update custom plan:", error);

    return res.status(500).json({
      message: "Failed to update custom plan"
    });
  }
});

// Create a custom plan for the authenticated account
router.post("/", authenticateApiKey, async (req, res) => {
  const {
    name,
    plan_type,
    monthly_limit,
    max_per_request
  } = req.body ?? {};

  const accountId = res.locals.account.id;

  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.trim().length > 100 ||
    !["account", "user"].includes(plan_type) ||
    !Number.isSafeInteger(monthly_limit) ||
    monthly_limit < 0 ||
    !Number.isSafeInteger(max_per_request) ||
    max_per_request <= 0 ||
    max_per_request > 2147483647
  ) {
    return res.status(400).json({
      message: "Invalid plan details"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO plans
         (name, plan_type, account_id, monthly_limit, max_per_request)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id, name, plan_type, account_id,
                 monthly_limit, max_per_request`,
      [
        name.trim(),
        plan_type,
        accountId,
        monthly_limit,
        max_per_request
      ]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        message:
          "A plan with this name and type already exists for this account"
      });
    }

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Failed to create custom plan:", error);

    return res.status(500).json({
      message: "Failed to create custom plan"
    });
  }
});

export default router;
