import dotenv from "dotenv";
import { Pool, types } from "pg";

dotenv.config({ quiet: true });

// BIGINT (OID 20) is returned as a string by default. Limits are capped at 1e12 and usage can never
// exceed a limit by more than one request, so values always fit in a JS safe integer.
types.setTypeParser(20, (value) => Number(value));

export const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "quota_user",
  password: process.env.DB_PASSWORD ?? "quota_password",
  database: process.env.DB_NAME ?? "quota_service",
  max: Number(process.env.DB_POOL_MAX ?? 20),
});
