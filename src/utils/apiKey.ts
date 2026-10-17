import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  return `qk_${randomBytes(32).toString("hex")}`;
}

/** Keys are 256-bit random values, so a plain SHA-256 is sufficient (no salting/stretching needed). */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}
