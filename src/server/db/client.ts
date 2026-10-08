import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseEnv } from "@/server/env";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 5,
    // Supabase's transaction pooler does not support prepared statements.
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  return drizzle(client, { schema, casing: "snake_case" });
}

let cached: Database | undefined;

/** Shared application database handle (lazily created on first use). */
export function db(): Database {
  cached ??= createDatabase(databaseEnv().DATABASE_URL);
  return cached;
}
