
import { Router } from "express";
import pool from "../config/database.js";
import { generateApiKey, hashApiKey } from "../utils/apiKey.js";

const router = Router();

router.post("/", async (req, res) => {
  const { name, plan_id } = req.body ?? {};

  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    !Number.isSafeInteger(plan_id) ||
    plan_id <= 0
  ) {
    return res.status(400).json({
      message: "Valid name and plan_id are required"
    });
  }

  try {
    const planResult = await pool.query(
      `SELECT id FROM plans
       WHERE id = $1
       AND plan_type = 'account'
       AND account_id IS NULL`,
      [plan_id]
    );

    if (planResult.rows.length === 0) {
      return res.status(400).json({
        message: "Invalid account plan"
      });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const result = await pool.query(
      `INSERT INTO accounts (name, plan_id, api_key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, plan_id, created_at`,
      [name.trim(), plan_id, apiKeyHash]
    );

    return res.status(201).json({
      ...result.rows[0],
      api_key: apiKey
    });
  } catch (error) {
    console.error("Failed to create account:", error);

    return res.status(500).json({
      message: "Failed to create account"
    });
  }
});

export default router;
