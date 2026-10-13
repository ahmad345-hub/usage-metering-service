
import { Router } from "express";
import pool from "../config/database.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, plan_type, monthly_limit, max_per_request FROM plans WHERE account_id IS NULL ORDER BY id"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Failed to fetch plans:", error);

    res.status(500).json({
      message: "Failed to fetch plans"
    });
  }
});

export default router;
