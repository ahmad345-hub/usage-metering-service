import { ApiError } from "../utils/errors.js";
import { monthKey, now } from "../utils/clock.js";
import { withAccountLock } from "../db/tx.js";
import { planColumns, planFromRow, type PlanView } from "./planService.js";
import { checkQuota, remainingUnits, type Level, type Rule } from "./quotaService.js";

export interface ConsumeBody {
  request_id: string;
  accepted: boolean;
  replayed: boolean;
  units: number;
  month: string;
  rejection: null | { level: Level; rule: Rule; message: string };
  user: { external_id: string; plan: PlanView; used_units: number; remaining_units: number };
  account: { plan: PlanView; used_units: number; remaining_units: number };
}

const EXISTING_SQL = `
  SELECT r.units, r.accepted, r.rejection_level, r.rejection_rule, u.external_id
  FROM usage_requests r JOIN users u ON u.id = r.user_id
  WHERE r.account_id = $1 AND r.request_id = $2`;

// Everything a decision needs, in one round trip: both plans and both usage counters for the month.
const STATE_SQL = `
  SELECT u.id AS user_id,
         ${planColumns("up", "user_plan")}, ${planColumns("ap", "account_plan")},
         COALESCE(ur.used_units, 0) AS user_used, COALESCE(ar.used_units, 0) AS account_used
  FROM users u
  JOIN accounts a ON a.id = u.account_id
  JOIN plans up ON up.id = u.plan_id
  JOIN plans ap ON ap.id = a.plan_id
  LEFT JOIN usage_records ur ON ur.user_id = u.id AND ur.month = $3::date
  LEFT JOIN usage_records ar ON ar.account_id = a.id AND ar.user_id IS NULL AND ar.month = $3::date
  WHERE u.account_id = $1 AND u.external_id = $2`;

// Account counter + user counter + request record written in a single statement.
const ACCEPT_SQL = `
  WITH acct AS (
    INSERT INTO usage_records (account_id, user_id, month, used_units) VALUES ($1, NULL, $3::date, $4::bigint)
    ON CONFLICT (account_id, month) WHERE user_id IS NULL
    DO UPDATE SET used_units = usage_records.used_units + EXCLUDED.used_units
    RETURNING 1
  ), usr AS (
    INSERT INTO usage_records (account_id, user_id, month, used_units) VALUES ($1, $2, $3::date, $4::bigint)
    ON CONFLICT (user_id, month) WHERE user_id IS NOT NULL
    DO UPDATE SET used_units = usage_records.used_units + EXCLUDED.used_units
    RETURNING 1
  )
  INSERT INTO usage_requests (account_id, user_id, request_id, units, accepted, created_at)
  VALUES ($1, $2, $5, $4::int, TRUE, $6::timestamptz)`;

const REJECT_SQL = `
  INSERT INTO usage_requests (account_id, user_id, request_id, units, accepted, rejection_level, rejection_rule, created_at)
  VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7::timestamptz)`;

const describe = (level: Level, rule: Rule) =>
  `Rejected by the ${level}'s ${rule === "monthly_limit" ? "monthly allowance" : "per-request limit"}`;

/**
 * Decides and records one consume request. Runs under the account lock, so the check and the write
 * are atomic with respect to every other request of the same account.
 */
export async function consumeUnits(
  accountId: number,
  externalId: string,
  requestId: string,
  units: number,
): Promise<{ status: number; body: ConsumeBody }> {
  const at = now();
  const month = monthKey(at);

  return withAccountLock(accountId, async (db) => {
    // 1. Idempotency: a known request_id returns the original decision and changes nothing.
    const previous = (await db.query(EXISTING_SQL, [accountId, requestId])).rows[0];
    if (previous && (previous.external_id !== externalId || previous.units !== units)) {
      throw new ApiError(409, "request_id_conflict", "This request_id was already used with a different user or amount");
    }

    // 2. Load plans and usage.
    const state = (await db.query(STATE_SQL, [accountId, externalId, `${month}-01`])).rows[0];
    if (!state) throw new ApiError(404, "user_not_found", "User not found in this account");

    const accountPlan = planFromRow(state, "account_plan");
    const userPlan = planFromRow(state, "user_plan");
    let accountUsed: number = state.account_used;
    let userUsed: number = state.user_used;

    let accepted: boolean;
    let level: Level | null;
    let rule: Rule | null;

    if (previous) {
      accepted = previous.accepted;
      level = previous.rejection_level;
      rule = previous.rejection_rule;
    } else {
      // 3. Decide with both plans, then record. A rejection writes only the history row.
      const decision = checkQuota({
        account: { monthlyLimit: accountPlan.monthly_limit, maxPerRequest: accountPlan.max_per_request, usedUnits: accountUsed },
        user: { monthlyLimit: userPlan.monthly_limit, maxPerRequest: userPlan.max_per_request, usedUnits: userUsed },
        requestedUnits: units,
      });
      accepted = decision.allowed;
      level = decision.rejectionLevel;
      rule = decision.rejectionRule;

      if (accepted) {
        await db.query(ACCEPT_SQL, [accountId, state.user_id, `${month}-01`, units, requestId, at]);
        accountUsed += units;
        userUsed += units;
      } else {
        await db.query(REJECT_SQL, [accountId, state.user_id, requestId, units, level, rule, at]);
      }
    }

    const body: ConsumeBody = {
      request_id: requestId,
      accepted,
      replayed: Boolean(previous),
      units,
      month,
      rejection: accepted || !level || !rule ? null : { level, rule, message: describe(level, rule) },
      user: { external_id: externalId, plan: userPlan, used_units: userUsed, remaining_units: remainingUnits(userPlan.monthly_limit, userUsed) },
      account: { plan: accountPlan, used_units: accountUsed, remaining_units: remainingUnits(accountPlan.monthly_limit, accountUsed) },
    };
    return { status: accepted ? (previous ? 200 : 201) : 429, body };
  });
}
