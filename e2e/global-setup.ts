import postgres from "postgres";

/**
 * When the booking-flow tests are enabled, clear reservations in the LOCAL
 * test database so each run starts from free dates.
 */
export default async function globalSetup() {
  if (process.env.E2E_BOOKING !== "true") return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E_BOOKING requires DATABASE_URL");
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error("E2E booking tests only run against a local database");
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`TRUNCATE reservations, owner_blocks, audit_logs, rate_limits CASCADE`;
  } finally {
    await sql.end();
  }
}
