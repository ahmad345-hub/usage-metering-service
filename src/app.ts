import express from "express";
import { pool } from "./config/database.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import accountRoutes from "./routes/accounts.js";
import planRoutes from "./routes/plans.js";
import usageRoutes from "./routes/usage.js";
import userRoutes from "./routes/users.js";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", database: "connected" });
});

app.use("/api/accounts", accountRoutes);
app.use("/api/users", userRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/usage", usageRoutes);

app.use(notFound);
app.use(errorHandler);
