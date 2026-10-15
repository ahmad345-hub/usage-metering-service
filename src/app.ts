
import express from "express";
import pool from "./config/database.js";

import plansRouter from "./routes/plans.js";
import accountsRouter from "./routes/accounts.js";
import usersRouter from "./routes/users.js";
import usageRouter from "./routes/usage.js";

const app = express();

app.use(express.json());

app.use("/api/plans", plansRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/users", usersRouter);
app.use("/api/usage", usageRouter);

app.get("/", (_req, res) => {
  res.json({
    message: "Quota service is running"
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});

export default app;
