import { Router } from "express";
import { pool } from "../config/database.js";
import { accountOf, authenticateApiKey } from "../middleware/auth.js";
import { planColumns, planFromRow } from "../services/planService.js";
import { remainingUnits } from "../services/quotaService.js";
import { consumeUnits } from "../services/usageService.js";
import { monthKey, now } from "../utils/clock.js";
import { ApiError } from "../utils/errors.js";
import {
  MAX_UNITS, bodyOf, optionalBoolean, optionalMonth, optionalString, pagination, requireInt, requireString,
} from "../utils/validation.js";

const router = Router();
router.use(authenticateApiKey);

router.post("/", async (req, res) => {
  const body = bodyOf(req);
  const externalId = requireString(body.external_id, "external_id");
  const requestId = requireString(body.request_id, "request_id");
  const units = requireInt(body.units, "units", 1, MAX_UNITS);
  const { status, body: result } = await consumeUnits(accountOf(res).id, externalId, requestId, units);
  res.status(status).json(result);
});

/**
 * remaining_units is only reported for the current UTC month. For other months the account/user may
 * have been on different plans, and the current limits would give a misleading number, so it is null.
 */
const usageView = (month: string, plan: ReturnType<typeof planFromRow>, used: number) => ({
  plan,
  used_units: used,
  remaining_units: month === monthKey(now()) ? remainingUnits(plan.monthly_limit, used) : null,
});

const monthOrCurrent = (value: unknown) => optionalMonth(value) ?? monthKey(now());

router.get("/summary", async (req, res) => {
  const month = monthOrCurrent(req.query.month);
  const { rows } = await pool.query(
    `SELECT ${planColumns("p", "plan")}, COALESCE(ar.used_units, 0) AS used
     FROM accounts a JOIN plans p ON p.id = a.plan_id
     LEFT JOIN usage_records ar ON ar.account_id = a.id AND ar.user_id IS NULL AND ar.month = $2::date
     WHERE a.id = $1`,
    [accountOf(res).id, `${month}-01`],
  );
  res.json({ month, account: usageView(month, planFromRow(rows[0], "plan"), rows[0].used) });
});

// Usage of every user of the account (paginated).
router.get("/users", async (req, res) => {
  const accountId = accountOf(res).id;
  const month = monthOrCurrent(req.query.month);
  const { page, limit, offset } = pagination(req.query);
  const [list, total] = await Promise.all([
    pool.query(
      `SELECT u.external_id, ${planColumns("p", "plan")}, COALESCE(ur.used_units, 0) AS used
       FROM users u JOIN plans p ON p.id = u.plan_id
       LEFT JOIN usage_records ur ON ur.user_id = u.id AND ur.month = $2::date
       WHERE u.account_id = $1 ORDER BY u.id LIMIT $3 OFFSET $4`,
      [accountId, `${month}-01`, limit, offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM users WHERE account_id = $1`, [accountId]),
  ]);
  res.json({
    month, page, limit, total: total.rows[0].total,
    users: list.rows.map((r) => ({ external_id: r.external_id, ...usageView(month, planFromRow(r, "plan"), r.used) })),
  });
});

router.get("/users/:externalId/summary", async (req, res) => {
  const month = monthOrCurrent(req.query.month);
  const externalId = requireString(req.params.externalId, "externalId");
  const { rows } = await pool.query(
    `SELECT ${planColumns("p", "plan")}, COALESCE(ur.used_units, 0) AS used
     FROM users u JOIN plans p ON p.id = u.plan_id
     LEFT JOIN usage_records ur ON ur.user_id = u.id AND ur.month = $3::date
     WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountOf(res).id, externalId, `${month}-01`],
  );
  if (rows.length === 0) throw new ApiError(404, "user_not_found", "User not found in this account");
  res.json({ month, external_id: externalId, ...usageView(month, planFromRow(rows[0], "plan"), rows[0].used) });
});

// Months in which the account consumed anything, newest first.
router.get("/months", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT to_char(month, 'YYYY-MM') AS month, used_units FROM usage_records
     WHERE account_id = $1 AND user_id IS NULL ORDER BY month DESC`,
    [accountOf(res).id],
  );
  res.json(rows);
});

// Request outcomes (accepted and rejected), newest first. Filters: month, external_id, accepted.
router.get("/history", async (req, res) => {
  const accountId = accountOf(res).id;
  const month = optionalMonth(req.query.month);
  const externalId = optionalString(req.query.external_id, "external_id");
  const accepted = optionalBoolean(req.query.accepted, "accepted");
  const { page, limit, offset } = pagination(req.query);

  const where = `r.account_id = $1
    AND ($2::text IS NULL OR u.external_id = $2)
    AND ($3::boolean IS NULL OR r.accepted = $3)
    AND ($4::date IS NULL OR (r.created_at >= ($4::date AT TIME ZONE 'UTC') AND r.created_at < ((($4::date + INTERVAL '1 month')::date) AT TIME ZONE 'UTC')))`;
  const params = [accountId, externalId, accepted, month ? `${month}-01` : null];

  const [list, total] = await Promise.all([
    pool.query(
      `SELECT r.request_id, u.external_id, r.units, r.accepted, r.rejection_level, r.rejection_rule, r.created_at
       FROM usage_requests r JOIN users u ON u.id = r.user_id
       WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $5 OFFSET $6`,
      [...params, limit, offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM usage_requests r JOIN users u ON u.id = r.user_id WHERE ${where}`, params),
  ]);
  res.json({
    page, limit, total: total.rows[0].total,
    requests: list.rows.map((r) => ({
      request_id: r.request_id,
      external_id: r.external_id,
      units: r.units,
      accepted: r.accepted,
      rejection: r.accepted ? null : { level: r.rejection_level, rule: r.rejection_rule },
      created_at: r.created_at,
    })),
  });
});

export default router;
