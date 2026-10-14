
export type RejectionLevel = "account" | "user";
export type RejectionRule = "monthly_limit" | "max_per_request";

interface QuotaLimits {
  monthlyLimit: bigint;
  maxPerRequest: number;
  usedUnits: bigint;
}

interface QuotaCheckInput {
  account: QuotaLimits;
  user: QuotaLimits;
  requestedUnits: number;
}

interface QuotaCheckResult {
  allowed: boolean;
  rejectionLevel: RejectionLevel | null;
  rejectionRule: RejectionRule | null;
}

export function checkQuota(input: QuotaCheckInput): QuotaCheckResult {
  const { account, user, requestedUnits } = input;
  const units = BigInt(requestedUnits);

  let rejectionLevel: RejectionLevel | null = null;
  let rejectionRule: RejectionRule | null = null;

  if (requestedUnits > account.maxPerRequest) {
    rejectionLevel = "account";
    rejectionRule = "max_per_request";
  } else if (requestedUnits > user.maxPerRequest) {
    rejectionLevel = "user";
    rejectionRule = "max_per_request";
  } else if (account.usedUnits + units > account.monthlyLimit) {
    rejectionLevel = "account";
    rejectionRule = "monthly_limit";
  } else if (user.usedUnits + units > user.monthlyLimit) {
    rejectionLevel = "user";
    rejectionRule = "monthly_limit";
  }

  return {
    allowed: rejectionLevel === null,
    rejectionLevel,
    rejectionRule
  };
}
