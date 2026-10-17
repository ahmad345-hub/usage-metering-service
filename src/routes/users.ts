import { Router } from "express";
import { pool } from "../config/database.js";
import { withAccountLock } from "../db/tx.js";
import { accountOf, authenticateApiKey } from "../middleware/auth.js";
import { findAssignablePlan, planColumns, planFromRow, type Queryable } from "../services/planService.js";
import { ApiError, isUniqueViolation } from "../utils/errors.js";
import { bodyOf, pagination, planIdOf, requireString } from "../utils/validation.js";

const router = Router();
router.use(authenticateApiKey);

const toView = (r: Record<string, any>) => ({
  id: r.id,
  external_id: r.external_id,
  created_at: r.created_at,
  plan: planFromRow(r, "plan"),
});

async function findUser(db: Queryable, accountId: number, externalId: string) {
  const { rows } = await db.query(
    `SELECT u.id, u.external_id, u.created_at, ${planColumns("p", "plan")}
     FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountId, externalId],
  );
  if (rows.length === 0) throw new ApiError(404, "user_not_found", "User not found in this account");
  return toView(rows[0]);
}

router.post("/", async (req, res) => {
  const accountId = accountOf(res).id;
  const body = bodyOf(req);
  const externalId = requireString(body.external_id, "external_id");
  const planId = planIdOf(body.plan_id);

  if (!(await findAssignablePlan(pool, accountId, planId, "user"))) {
    throw new ApiError(400, "invalid_plan", "plan_id must be a predefined user plan or one of your own user plans");
  }
  try {
    await pool.query(`INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3)`, [accountId, externalId, planId]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "user_exists", "A user with this external_id already exists");
    throw error;
  }
  res.status(201).json(await findUser(pool, accountId, externalId));
});

router.get("/", async (req, res) => {
  const accountId = accountOf(res).id;
  const { page, limit, offset } = pagination(req.query);
  const [list, total] = await Promise.all([
    pool.query(
      `SELECT u.id, u.external_id, u.created_at, ${planColumns("p", "plan")}
       FROM users u JOIN plans p ON p.id = u.plan_id WHERE u.account_id = $1 ORDER BY u.id LIMIT $2 OFFSET $3`,
      [accountId, limit, offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM users WHERE account_id = $1`, [accountId]),
  ]);
  res.json({ page, limit, total: total.rows[0].total, users: list.rows.map(toView) });
});

router.get("/:externalId", async (req, res) => {
  res.json(await findUser(pool, accountOf(res).id, requireString(req.params.externalId, "externalId")));
});

// Switch a user's plan. Units already consumed this month are kept (usage is not tied to the plan).
router.patch("/:externalId", async (req, res) => {
  const accountId = accountOf(res).id;
  const externalId = requireString(req.params.externalId, "externalId");
  const planId = planIdOf(bodyOf(req).plan_id);

  const view = await withAccountLock(accountId, async (db) => {
    await findUser(db, accountId, externalId);
    if (!(await findAssignablePlan(db, accountId, planId, "user"))) {
      throw new ApiError(400, "invalid_plan", "plan_id must be a predefined user plan or one of your own user plans");
    }
    await db.query(`UPDATE users SET plan_id = $3 WHERE account_id = $1 AND external_id = $2`, [accountId, externalId, planId]);
    return findUser(db, accountId, externalId);
  });
  res.json(view);
});

export default router;
