import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../config/database.js";

const SCHEMA_LOCK_KEY = 7001;

/** Applies db/init.sql (idempotent). A session lock makes concurrent starters (replicas, tests) safe. */
export async function migrate(): Promise<void> {
  const sql = readFileSync(path.resolve(__dirname, "../../db/init.sql"), "utf8");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
