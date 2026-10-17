let override: (() => Date) | null = null;

export function now(): Date {
  return override ? override() : new Date();
}

/** Test hook (e.g. to simulate a month rollover). Disabled in production. */
export function setClockForTests(fn: (() => Date) | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("clock override is not allowed in production");
  override = fn;
}

/** UTC calendar month as YYYY-MM. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
