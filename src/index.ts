
import express from "express";
import pool from "./config/database.js";

import plansRouter from "./routes/plans.js";
import accountsRouter from "./routes/accounts.js";
import usersRouter from "./routes/users.js";
import usageRouter from "./routes/usage.js";
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use("/api/plans", plansRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/users", usersRouter);
app.use("/api/usage", usageRouter);
app.get("/", (req, res) => {
  res.json({
    message: "Quota service is running"
  });
});

app.get("/health", async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
