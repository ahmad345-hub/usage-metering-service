import type { NextFunction, Request, Response } from "express";
import { pool } from "../config/database.js";
import { hashApiKey } from "../utils/apiKey.js";
import { ApiError } from "../utils/errors.js";

export interface AuthedAccount { id: number; name: string }

// Keys cannot be revoked or rotated in this version, so a positive lookup never goes stale and can
// be cached in memory. It removes one database round trip from every request.
const cache = new Map<string, AuthedAccount>();
const CACHE_MAX = 10_000;

export const accountOf = (res: Response) => res.locals.account as AuthedAccount;

export async function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.header("x-api-key");
  if (!apiKey) throw new ApiError(401, "missing_api_key", "Missing x-api-key header");

  const hash = hashApiKey(apiKey);
  let account = cache.get(hash);
  if (!account) {
    const { rows } = await pool.query("SELECT id, name FROM accounts WHERE api_key_hash = $1", [hash]);
    if (rows.length === 0) throw new ApiError(401, "invalid_api_key", "Invalid API key");
    account = { id: rows[0].id, name: rows[0].name };
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(hash, account);
  }
  res.locals.account = account;
  next();
}
