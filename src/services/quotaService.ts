// Pure business rules: no database, no HTTP. Easy to unit test and to extend with new rule types.

export type Level = "account" | "user";
export type Rule = "monthly_limit" | "max_per_request";

export interface LevelState {
  monthlyLimit: number;
  maxPerRequest: number;
  usedUnits: number;
}

export interface QuotaDecision {
  allowed: boolean;
  rejectionLevel: Level | null;
  rejectionRule: Rule | null;
}

/** Never negative: a limit lowered below existing usage shows 0 remaining. */
export function remainingUnits(monthlyLimit: number, usedUnits: number): number {
  return Math.max(0, monthlyLimit - usedUnits);
}

/**
 * Both plans apply together and the full amount is all-or-nothing.
 * Evaluation order (the first failing rule is reported): account per-request, user per-request,
 * account monthly, user monthly. Per-request rules come first because they can never succeed on a
 * retry, whereas a monthly rule may clear when allowance is raised or a new month starts.
 */
export function checkQuota(input: { account: LevelState; user: LevelState; requestedUnits: number }): QuotaDecision {
  const { account, user, requestedUnits } = input;
  const checks: Array<[Level, Rule, boolean]> = [
    ["account", "max_per_request", requestedUnits > account.maxPerRequest],
    ["user", "max_per_request", requestedUnits > user.maxPerRequest],
    ["account", "monthly_limit", account.usedUnits + requestedUnits > account.monthlyLimit],
    ["user", "monthly_limit", user.usedUnits + requestedUnits > user.monthlyLimit],
  ];
  const failed = checks.find(([, , violated]) => violated);
  return failed
    ? { allowed: false, rejectionLevel: failed[0], rejectionRule: failed[1] }
    : { allowed: true, rejectionLevel: null, rejectionRule: null };
}
