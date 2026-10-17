import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/errors.js";

export function notFound(req: Request, res: Response) {
  res.status(404).json({ code: "not_found", message: `Route ${req.method} ${req.path} does not exist` });
}

// All errors leave the service as JSON: { code, message }.
export function errorHandler(error: any, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ApiError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ code: "invalid_json", message: "Request body is not valid JSON" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ code: "payload_too_large", message: "Request body is too large" });
  }
  const connectionProblem =
    ["ECONNREFUSED", "ETIMEDOUT", "57P01"].includes(error?.code) || String(error?.code ?? "").startsWith("08");
  if (connectionProblem) {
    return res.status(503).json({ code: "database_unavailable", message: "Database is temporarily unavailable, retry shortly" });
  }
  console.error(error);
  res.status(500).json({ code: "internal_error", message: "Unexpected server error" });
}
