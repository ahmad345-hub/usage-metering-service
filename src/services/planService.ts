import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;
export type PlanType = "account" | "user";

export interface PlanView {
  id: number;
  name: string;
  type: PlanType;
  predefined: boolean;
  monthly_limit: number;
  max_per_request: number;
}

type Row = Record<string, any>;

/** SELECT list that exposes a plan under a column prefix, so one query can load several plans. */
export const planColumns = (alias: string, prefix: string) =>
  `${alias}.id AS ${prefix}_id, ${alias}.name AS ${prefix}_name, ${alias}.plan_type AS ${prefix}_type, ` +
  `${alias}.account_id AS ${prefix}_owner, ${alias}.monthly_limit AS ${prefix}_monthly_limit, ` +
  `${alias}.max_per_request AS ${prefix}_max_per_request`;

export function planFromRow(row: Row, prefix: string): PlanView {
  return {
    id: row[`${prefix}_id`],
    name: row[`${prefix}_name`],
    type: row[`${prefix}_type`],
    predefined: row[`${prefix}_owner`] === null,
    monthly_limit: row[`${prefix}_monthly_limit`],
    max_per_request: row[`${prefix}_max_per_request`],
  };
}

export function planFromPlanRow(row: Row): PlanView {
  return planFromRow(
    { ...row, p_id: row.id, p_name: row.name, p_type: row.plan_type, p_owner: row.account_id,
      p_monthly_limit: row.monthly_limit, p_max_per_request: row.max_per_request },
    "p",
  );
}

/** A plan an account may assign: a predefined plan or one of its own custom plans, of the right type. */
export async function findAssignablePlan(db: Queryable, accountId: number, planId: number, type: PlanType) {
  const { rows } = await db.query(
    `SELECT * FROM plans WHERE id = $1 AND plan_type = $2 AND (account_id IS NULL OR account_id = $3)`,
    [planId, type, accountId],
  );
  return rows[0] as Row | undefined;
}
