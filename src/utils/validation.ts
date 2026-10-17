import type { Request } from "express";
import { ApiError } from "./errors.js";

export const MAX_UNITS = 2_147_483_647; // fits PostgreSQL INTEGER
export const MAX_MONTHLY_LIMIT = 1_000_000_000_000;

const invalid = (message: string) => new ApiError(400, "validation_error", message);

export function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function requireString(value: unknown, field: string, maxLength = 100): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) throw invalid(`${field} must be 1-${maxLength} characters`);
  return trimmed;
}

export function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

export const planIdOf = (value: unknown) => requireInt(value, "plan_id", 1, MAX_UNITS);

export function optionalMonth(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw invalid("month must use the YYYY-MM format, for example 2026-09");
  }
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid(`${field} must be true or false`);
}

export function optionalString(value: unknown, field: string): string | null {
  return value === undefined ? null : requireString(value, field);
}

export function pagination(query: Request["query"]): { page: number; limit: number; offset: number } {
  const read = (v: unknown, name: string, fallback: number, max: number) => {
    if (v === undefined) return fallback;
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw invalid(`${name} must be a whole number between 1 and ${max}`);
    return n;
  };
  const page = read(query.page, "page", 1, 1_000_000);
  const limit = read(query.limit, "limit", 20, 100);
  return { page, limit, offset: (page - 1) * limit };
}
