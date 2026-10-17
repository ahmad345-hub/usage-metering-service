import { app } from "./app.js";
import { pool } from "./config/database.js";
import { migrate } from "./db/migrate.js";

const port = Number(process.env.PORT ?? 3000);

async function migrateWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      return await migrate();
    } catch (error) {
      if (i >= attempts) throw error;
      console.log(`Database not ready (attempt ${i}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  await migrateWithRetry(); // creates tables and predefined plans on first start
  const server = app.listen(port, () => console.log(`Quota service listening on port ${port}`));

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
