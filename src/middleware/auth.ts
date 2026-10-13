
import type { Request, Response, NextFunction } from "express";
import pool from "../config/database.js";
import { hashApiKey } from "../utils/apiKey.js";

export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.header("x-api-key");

  if (!apiKey) {
    res.status(401).json({
      message: "API key is required"
    });
    return;
  }

  try {
    const apiKeyHash = hashApiKey(apiKey);

    const result = await pool.query(
      "SELECT id, name, plan_id FROM accounts WHERE api_key_hash = $1",
      [apiKeyHash]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        message: "Invalid API key"
      });
      return;
    }

    res.locals.account = result.rows[0];

    next();
  } catch (error) {
    console.error("API key authentication failed:", error);

    res.status(500).json({
      message: "Authentication failed"
    });
  }
}
