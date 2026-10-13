
import { Router } from "express";
import { authenticateApiKey } from "../middleware/auth.js";
import pool from "../config/database.js";

const router = Router();

// Record usage and enforce quotas
router.post("/", authenticateApiKey, async (req, res) => {
  const { external_id, request_id, units } = req.body ?? {};
  const accountId = res.locals.account.id;

  if (
    typeof external_id !== "string" ||
    external_id.trim() === "" ||
    typeof request_id !== "string" ||
    request_id.trim() === "" ||
    request_id.trim().length > 100 ||
    !Number.isSafeInteger(units) ||
    units <= 0 ||
    units > 2147483647
  ) {
    return res.status(400).json({
      message: "Valid external_id, request_id and units are required"
    });
  }

  const client = await pool.connect().catch((error) => {
    console.error("Database connection failed:", error);
    return null;
  });

  if (!client) {
    return res.status(503).json({
      message: "Database unavailable"
    });
  }

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [accountId]
    );

    const existingRequest = await client.query(
      `SELECT
         r.id,
         r.user_id,
         u.external_id,
         r.units,
         r.accepted,
         r.rejection_level,
         r.rejection_rule
       FROM usage_requests r
       JOIN users u ON r.user_id = u.id
       WHERE r.account_id = $1
         AND r.request_id = $2`,
      [accountId, request_id.trim()]
    );

    if (existingRequest.rows.length > 0) {
      const previous = existingRequest.rows[0];

      await client.query("ROLLBACK");

      if (
        previous.external_id !== external_id.trim() ||
        previous.units !== units
      ) {
        return res.status(409).json({
          message: "Request ID already used with different data",
          request_id: request_id.trim()
        });
      }

      return res.status(previous.accepted ? 200 : 429).json({
        message: previous.accepted
          ? "Usage already recorded"
          : "Request was previously rejected",
        request_id: request_id.trim(),
        accepted: previous.accepted,
        requested_units: previous.units,
        rejection_level: previous.rejection_level,
        rejection_rule: previous.rejection_rule,
        replayed: true
      });
    }

    const userResult = await client.query(
      `SELECT
         u.id,
         u.external_id,
         p.name AS plan_name,
         p.monthly_limit,
         p.max_per_request
       FROM users u
       JOIN plans p ON u.plan_id = p.id
       WHERE u.account_id = $1
         AND u.external_id = $2`,
      [accountId, external_id.trim()]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "User not found"
      });
    }

    const accountResult = await client.query(
      `SELECT
         a.id,
         a.name,
         p.name AS plan_name,
         p.monthly_limit,
         p.max_per_request
       FROM accounts a
       JOIN plans p ON a.plan_id = p.id
       WHERE a.id = $1`,
      [accountId]
    );

    if (accountResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Account not found"
      });
    }

    const accountPlan = accountResult.rows[0];
    const userPlan = userResult.rows[0];

    const usageResult = await client.query(
      `SELECT
         COALESCE(
           (SELECT used_units
            FROM usage_records
            WHERE account_id = $1
              AND user_id IS NULL
              AND month = DATE_TRUNC('month', NOW())::date),
           0
         ) AS account_used,
         COALESCE(
           (SELECT used_units
            FROM usage_records
            WHERE account_id = $1
              AND user_id = $2
              AND month = DATE_TRUNC('month', NOW())::date),
           0
         ) AS user_used`,
      [accountId, userPlan.id]
    );

    const accountUsed = BigInt(usageResult.rows[0].account_used);
    const userUsed = BigInt(usageResult.rows[0].user_used);
    const requestedUnits = BigInt(units);

    let rejectionLevel: "account" | "user" | null = null;
    let rejectionRule: "monthly_limit" | "max_per_request" | null = null;

    if (units > accountPlan.max_per_request) {
      rejectionLevel = "account";
      rejectionRule = "max_per_request";
    } else if (units > userPlan.max_per_request) {
      rejectionLevel = "user";
      rejectionRule = "max_per_request";
    } else if (
      accountUsed + requestedUnits > BigInt(accountPlan.monthly_limit)
    ) {
      rejectionLevel = "account";
      rejectionRule = "monthly_limit";
    } else if (
      userUsed + requestedUnits > BigInt(userPlan.monthly_limit)
    ) {
      rejectionLevel = "user";
      rejectionRule = "monthly_limit";
    }

    if (rejectionLevel && rejectionRule) {
      await client.query(
        `INSERT INTO usage_requests
           (account_id, user_id, request_id, units,
            accepted, rejection_level, rejection_rule)
         VALUES ($1, $2, $3, $4, FALSE, $5, $6)`,
        [
          accountId,
          userPlan.id,
          request_id.trim(),
          units,
          rejectionLevel,
          rejectionRule
        ]
      );

      await client.query("COMMIT");

      return res.status(429).json({
        message: "Quota exceeded",
        level: rejectionLevel,
        rule: rejectionRule,
        requested_units: units
      });
    }

    await client.query(
      `INSERT INTO usage_records
         (account_id, user_id, month, used_units)
       VALUES ($1, NULL, DATE_TRUNC('month', NOW())::date, $2)
       ON CONFLICT (account_id, month)
       WHERE user_id IS NULL
       DO UPDATE SET
         used_units = usage_records.used_units + EXCLUDED.used_units`,
      [accountId, units]
    );

    await client.query(
      `INSERT INTO usage_records
         (account_id, user_id, month, used_units)
       VALUES ($1, $2, DATE_TRUNC('month', NOW())::date, $3)
       ON CONFLICT (user_id, month)
       WHERE user_id IS NOT NULL
       DO UPDATE SET
         used_units = usage_records.used_units + EXCLUDED.used_units`,
      [accountId, userPlan.id, units]
    );

    await client.query(
      `INSERT INTO usage_requests
         (account_id, user_id, request_id, units, accepted)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [accountId, userPlan.id, request_id.trim(), units]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Usage recorded successfully",
      request_id: request_id.trim(),
      accepted: true,
      requested_units: units,
      account_used: (accountUsed + requestedUnits).toString(),
      user_used: (userUsed + requestedUnits).toString()
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback failed:", rollbackError);
    }

    console.error("Failed to record usage:", error);

    return res.status(500).json({
      message: "Failed to record usage"
    });
  } finally {
    client.release();
  }
});

// Get paginated usage history
router.get("/history", authenticateApiKey, async (req, res) => {
  const accountId = res.locals.account.id;

  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger((page - 1) * limit)
  ) {
    return res.status(400).json({
      message: "Page must be positive and limit must be between 1 and 100"
    });
  }

  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total
       FROM usage_requests
       WHERE account_id = $1`,
      [accountId]
    );

    const total = Number(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    const result = await pool.query(
      `SELECT
         r.id,
         r.request_id,
         u.external_id,
         r.units,
         r.accepted,
         r.rejection_level,
         r.rejection_rule,
         r.created_at
       FROM usage_requests r
       JOIN users u ON r.user_id = u.id
       WHERE r.account_id = $1
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );

    return res.json({
      account_id: accountId,
      page,
      limit,
      total,
      total_pages: totalPages,
      count: result.rows.length,
      requests: result.rows
    });
  } catch (error) {
    console.error("Failed to load usage history:", error);

    return res.status(500).json({
      message: "Failed to load usage history"
    });
  }
});

export default router;
