import type { PoolClient } from "pg";
import { pool } from "../config/database.js";

const ACCOUNT_LOCK_NAMESPACE = 1001;

/**
 * Runs `fn` in a transaction holding a per-account advisory lock.
 *
 * Every operation that can change what a request is allowed to do for an account (consuming units,
 * changing a plan, assigning a plan) takes this lock. That serialises decisions per account, so
 * usage totals can never be over-committed and a plan change is ordered strictly before or after
 * any concurrent consume. Different accounts never block each other.
 */
export async function withAccountLock<T>(accountId: number, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [ACCOUNT_LOCK_NAMESPACE, accountId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
