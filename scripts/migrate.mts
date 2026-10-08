/**
 * Applies committed migrations in ./drizzle. Run as a controlled deployment
 * step (never automatically on app start):
 *   DATABASE_URL_UNPOOLED=... pnpm db:migrate
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "Set DATABASE_URL_UNPOOLED (or DATABASE_URL) to run migrations.",
  );
  process.exit(1);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} finally {
  await client.end();
}
