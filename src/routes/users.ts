
import { Router } from "express";
import pool from "../config/database.js";
import { authenticateApiKey } from "../middleware/auth.js";

const router = Router();

router.post("/", authenticateApiKey, async (req, res) => {
  const { external_id, plan_id } = req.body ?? {};
  const account_id = res.locals.account.id;

  if (
    typeof external_id !== "string" ||
    external_id.trim() === "" ||
    !Number.isSafeInteger(plan_id) ||
    plan_id <= 0
  ) {
    return res.status(400).json({
      message: "Valid external_id and plan_id are required"
    });
  }

  try {
    const accountResult = await pool.query(
      "SELECT id FROM accounts WHERE id = $1",
      [account_id]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({
        message: "Account not found"
      });
    }

    const planResult = await pool.query(
      `SELECT id FROM plans
       WHERE id = $1
       AND plan_type = 'user'
       AND (account_id IS NULL OR account_id = $2)`,
      [plan_id, account_id]
    );

    if (planResult.rows.length === 0) {
      return res.status(400).json({
        message: "Invalid user plan"
      });
    }

    const result = await pool.query(
      `INSERT INTO users (account_id, external_id, plan_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, external_id) DO NOTHING
       RETURNING id, account_id, external_id, plan_id, created_at`,
      [account_id, external_id.trim(), plan_id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        message: "User already exists in this account"
      });
    }

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Failed to create user:", error);

    return res.status(500).json({
      message: "Failed to create user"
    });
  }
});

export default router;
