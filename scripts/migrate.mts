/**
 * Applies committed migrations in ./drizzle. Run as a controlled deployment
 * step (never automatically on app start):
 *   DATABASE_URL_UNPOOLED=... pnpm db:migrate
 *
 * Shared database (staging): DATABASE_SCHEMA=lodge puts every Lodge object
 * in its own schema, so nothing in `public` (another application's tables)
 * is created, altered or re-permissioned. The committed migrations name
 * `public` explicitly in places; those references are rewritten to the
 * target schema, and the run is refused if any survive. The connection must
 * already resolve unqualified names to that schema (the `lodge_app` role
 * has `search_path = lodge`; see scripts/staging-database.sql).
 *
 *   pnpm db:migrate --print > bundle.sql   prints the same rewritten SQL as
 *                                          one script instead of running it
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  isolationProblems,
  isolationState,
  pinFunctionsSql as pinFunctions,
  targetSchema,
  toSchema,
} from "../src/server/db/isolation";

let SCHEMA: string;
try {
  SCHEMA = targetSchema();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const isolated = SCHEMA !== "public";

type Journal = { entries: { idx: number; when: number; tag: string }[] };
const journal: Journal = JSON.parse(
  readFileSync("./drizzle/meta/_journal.json", "utf8"),
);

if (process.argv.includes("--print")) {
  if (!isolated) {
    console.error("--print is for DATABASE_SCHEMA=<schema> only.");
    process.exit(1);
  }
  const parts = [
    `-- Lodge migrations rewritten for schema "${SCHEMA}". Run as the role that owns it.`,
    `SET search_path TO ${SCHEMA};`,
    `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`,
  ];
  for (const e of journal.entries) {
    const query = toSchema(
      readFileSync(`./drizzle/${e.tag}.sql`, "utf8"),
      SCHEMA,
    );
    const hash = createHash("sha256").update(query).digest("hex");
    parts.push(
      `-- ${e.tag}`,
      `DO $guard$ BEGIN IF EXISTS (SELECT 1 FROM "${SCHEMA}"."__drizzle_migrations" WHERE created_at >= ${e.when}) THEN RAISE EXCEPTION 'already applied: ${e.tag}'; END IF; END $guard$;`,
      query.replaceAll("--> statement-breakpoint", ""),
      `INSERT INTO "${SCHEMA}"."__drizzle_migrations" (hash, created_at) VALUES ('${hash}', ${e.when});`,
    );
  }
  parts.push(pinFunctions(SCHEMA));
  console.log(parts.join("\n"));
  process.exit(0);
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "Set DATABASE_URL_UNPOOLED (or DATABASE_URL) to run migrations.",
  );
  process.exit(1);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  let folder = "./drizzle";
  if (isolated) {
    // Privilege barrier: only a role that can't reach anything in `public`
    // may apply the Lodge migrations (see src/server/db/isolation.ts).
    const problems = isolationProblems(await isolationState(client), SCHEMA);
    if (problems.length > 0)
      throw new Error(
        `Refusing to migrate schema "${SCHEMA}": ${problems.join("; ")}.`,
      );
    folder = mkdtempSync(join(tmpdir(), "lodge-migrations-"));
    mkdirSync(join(folder, "meta"));
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify(journal),
    );
    for (const e of journal.entries)
      writeFileSync(
        join(folder, `${e.tag}.sql`),
        toSchema(readFileSync(`./drizzle/${e.tag}.sql`, "utf8"), SCHEMA),
      );
  }
  await migrate(drizzle(client), {
    migrationsFolder: folder,
    ...(isolated ? { migrationsSchema: SCHEMA } : {}),
  });
  if (isolated) await client.unsafe(pinFunctions(SCHEMA));
  console.log(`Migrations applied${isolated ? ` in schema "${SCHEMA}"` : ""}.`);
} finally {
  await client.end();
}
