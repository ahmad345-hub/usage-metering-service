import { Router } from "express";
import { pool } from "../config/database.js";
import { withAccountLock } from "../db/tx.js";
import { accountOf, authenticateApiKey } from "../middleware/auth.js";
import { planFromPlanRow } from "../services/planService.js";
import { ApiError, isUniqueViolation } from "../utils/errors.js";
import { MAX_MONTHLY_LIMIT, MAX_UNITS, bodyOf, requireInt, requireString } from "../utils/validation.js";

const router = Router();

// Predefined plans are public and read-only: they are needed before an account exists.
router.get("/", async (req, res) => {
  const type = req.query.type;
  if (type !== undefined && type !== "account" && type !== "user") {
    throw new ApiError(400, "validation_error", "type must be account or user");
  }
  const { rows } = await pool.query(
    `SELECT * FROM plans WHERE account_id IS NULL AND ($1::text IS NULL OR plan_type = $1) ORDER BY id`,
    [type ?? null],
  );
  res.json(rows.map(planFromPlanRow));
});

router.use(authenticateApiKey);

router.get("/custom", async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM plans WHERE account_id = $1 ORDER BY id`, [accountOf(res).id]);
  res.json(rows.map(planFromPlanRow));
});

const parsePathId = (value: string) => {
  const id = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id > MAX_UNITS) throw new ApiError(404, "plan_not_found", "Plan not found");
  return id;
};

// A predefined plan or one of the caller's own. Other accounts' plans look like they do not exist.
router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`, [
    parsePathId(req.params.id),
    accountOf(res).id,
  ]);
  if (rows.length === 0) throw new ApiError(404, "plan_not_found", "Plan not found");
  res.json(planFromPlanRow(rows[0]));
});

router.post("/", async (req, res) => {
  const body = bodyOf(req);
  const name = requireString(body.name, "name");
  const type = body.plan_type;
  if (type !== "account" && type !== "user") throw new ApiError(400, "validation_error", "plan_type must be account or user");
  const monthlyLimit = requireInt(body.monthly_limit, "monthly_limit", 0, MAX_MONTHLY_LIMIT);
  const maxPerRequest = requireInt(body.max_per_request, "max_per_request", 1, MAX_UNITS);

  try {
    const { rows } = await pool.query(
      `INSERT INTO plans (account_id, name, plan_type, monthly_limit, max_per_request) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [accountOf(res).id, name, type, monthlyLimit, maxPerRequest],
    );
    res.status(201).json(planFromPlanRow(rows[0]));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "plan_name_conflict", "You already have a plan of this type with that name");
    throw error;
  }
});

// Takes effect for the next consume request of every account/user using the plan (no redeploy, no cache).
router.patch("/:id", async (req, res) => {
  const accountId = accountOf(res).id;
  const planId = parsePathId(req.params.id);
  const body = bodyOf(req);
  const name = body.name === undefined ? null : requireString(body.name, "name");
  const monthlyLimit = body.monthly_limit === undefined ? null : requireInt(body.monthly_limit, "monthly_limit", 0, MAX_MONTHLY_LIMIT);
  const maxPerRequest = body.max_per_request === undefined ? null : requireInt(body.max_per_request, "max_per_request", 1, MAX_UNITS);
  if (name === null && monthlyLimit === null && maxPerRequest === null) {
    throw new ApiError(400, "validation_error", "Provide at least one of name, monthly_limit, max_per_request");
  }

  try {
    // The account lock orders this update before or after any concurrent consume request.
    const plan = await withAccountLock(accountId, async (db) => {
      const { rows } = await db.query(
        `UPDATE plans SET name = COALESCE($3, name), monthly_limit = COALESCE($4, monthly_limit),
                max_per_request = COALESCE($5, max_per_request), updated_at = NOW()
         WHERE id = $1 AND account_id = $2 RETURNING *`,
        [planId, accountId, name, monthlyLimit, maxPerRequest],
      );
      return rows[0];
    });
    if (!plan) throw new ApiError(404, "plan_not_found", "Custom plan not found (predefined plans are read-only)");
    res.json(planFromPlanRow(plan));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "plan_name_conflict", "You already have a plan of this type with that name");
    throw error;
  }
});

export default router;
