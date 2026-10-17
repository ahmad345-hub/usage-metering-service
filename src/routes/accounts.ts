import { Router } from "express";
import { pool } from "../config/database.js";
import { withAccountLock } from "../db/tx.js";
import { accountOf, authenticateApiKey } from "../middleware/auth.js";
import { findAssignablePlan, planColumns, planFromRow, type Queryable } from "../services/planService.js";
import { generateApiKey, hashApiKey } from "../utils/apiKey.js";
import { ApiError } from "../utils/errors.js";
import { bodyOf, planIdOf, requireString } from "../utils/validation.js";

const router = Router();

async function accountView(db: Queryable, accountId: number) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.created_at, ${planColumns("p", "plan")}
     FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1`,
    [accountId],
  );
  const r = rows[0];
  return { id: r.id, name: r.name, created_at: r.created_at, plan: planFromRow(r, "plan") };
}

// Open by design: this is how an application obtains its API key (see README, assumptions).
router.post("/", async (req, res) => {
  const body = bodyOf(req);
  const name = requireString(body.name, "name", 255);
  const planId = planIdOf(body.plan_id);

  const apiKey = generateApiKey();
  const accountId = await createAccount(name, planId, apiKey);
  res.status(201).json({ ...(await accountView(pool, accountId)), api_key: apiKey });
});

async function createAccount(name: string, planId: number, apiKey: string): Promise<number> {
  // A brand-new account owns no custom plans, so only a predefined account plan can be chosen.
  const { rows: plans } = await pool.query(`SELECT 1 FROM plans WHERE id = $1 AND plan_type = 'account' AND account_id IS NULL`, [planId]);
  if (plans.length === 0) throw new ApiError(400, "invalid_plan", "plan_id must be a predefined account plan (see GET /api/plans?type=account)");
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, api_key_hash, plan_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, hashApiKey(apiKey), planId],
  );
  return rows[0].id;
}

router.use(authenticateApiKey);

router.get("/me", async (_req, res) => {
  res.json(await accountView(pool, accountOf(res).id));
});

// Assign a predefined account plan or one of the account's own custom account plans.
// Existing usage is kept; the new plan simply applies to the next request.
router.put("/me/plan", async (req, res) => {
  const accountId = accountOf(res).id;
  const planId = planIdOf(bodyOf(req).plan_id);
  const view = await withAccountLock(accountId, async (db) => {
    if (!(await findAssignablePlan(db, accountId, planId, "account"))) {
      throw new ApiError(400, "invalid_plan", "plan_id must be a predefined account plan or one of your own account plans");
    }
    await db.query("UPDATE accounts SET plan_id = $2 WHERE id = $1", [accountId, planId]);
    return accountView(db, accountId);
  });
  res.json(view);
});

export default router;
