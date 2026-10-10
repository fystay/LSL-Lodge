/**
 * Read-only staging preflight: lists what is missing before the Lodge can
 * be demonstrated on staging. Never writes, never prints a secret.
 *
 *   pnpm staging:preflight [--env-file path] [--stripe --account acct_…] [--site]
 *
 *   --env-file  read variables from a file (e.g. one pulled from Vercel's
 *               Preview environment: `vercel env pull --environment=preview
 *               --git-branch=claude/instant-booking path`). Keep that file
 *               outside the repository and delete it afterwards.
 *   --stripe    also check the Stripe TEST sandbox (key, account, webhook
 *               endpoint, events, API version). Read-only API calls.
 *   --site      also call the staging site's /api/health (GET, read-only).
 *
 * Exit code 1 if anything FAILs. See docs/STAGING-SETUP.md.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import Stripe from "stripe";
import {
  checkDatabase,
  checkEnvironment,
  checkStripe,
  formatChecks,
  type Check,
} from "../src/server/ops/preflight";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const envFile = option("--env-file");
if (envFile) process.loadEnvFile(envFile);
const env = process.env;

const journal = JSON.parse(
  readFileSync("./drizzle/meta/_journal.json", "utf8"),
) as { entries: unknown[] };
const checks: Check[] = checkEnvironment(env);

const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
if (url) {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    checks.push(...(await checkDatabase(sql, env, journal.entries.length)));
  } catch (error) {
    checks.push({
      area: "database",
      status: "FAIL",
      label: "database checks completed",
      // Error codes only: messages can echo connection details.
      detail: `error ${(error as { code?: string }).code ?? "unknown"}`,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (args.includes("--stripe")) {
  const key = env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key))
    checks.push({
      area: "stripe",
      status: "FAIL",
      label: "Stripe checks run with a TEST key only",
    });
  else
    try {
      checks.push(
        ...(await checkStripe(
          new Stripe(key, { maxNetworkRetries: 1, timeout: 15_000 }),
          env,
          option("--account"),
        )),
      );
    } catch (error) {
      checks.push({
        area: "stripe",
        status: "FAIL",
        label: "Stripe checks completed",
        detail: (error as { type?: string }).type ?? "error",
      });
    }
}

if (args.includes("--site")) {
  try {
    const base = new URL(env.SITE_URL ?? "");
    const headers: Record<string, string> = {
      authorization: `Bearer ${env.HEALTHCHECK_SECRET ?? ""}`,
    };
    if (env.VERCEL_AUTOMATION_BYPASS_SECRET)
      headers["x-vercel-protection-bypass"] =
        env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const res = await fetch(new URL("/api/health", base), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      problems?: string[];
    };
    checks.push(
      res.status === 200
        ? { area: "site", status: "PASS", label: "/api/health is healthy" }
        : res.status === 503
          ? {
              area: "site",
              status: "WARN",
              label: "/api/health is healthy",
              detail: (body.problems ?? []).join(", ") || "503",
            }
          : {
              area: "site",
              status: "FAIL",
              label: "/api/health reachable and authorised",
              detail: `HTTP ${res.status}${res.status === 302 || res.status === 401 ? " (deployment protection or HEALTHCHECK_SECRET)" : ""}`,
            },
    );
  } catch (error) {
    checks.push({
      area: "site",
      status: "FAIL",
      label: "/api/health reachable",
      detail: (error as Error).name,
    });
  }
}

console.log(formatChecks(checks));
const failed = checks.filter((c) => c.status === "FAIL").length;
const warned = checks.filter((c) => c.status === "WARN").length;
console.log(
  `\n${failed} failing, ${warned} warning(s). ${failed === 0 ? "Ready for the staging journey test." : "Not ready."}`,
);
process.exit(failed > 0 ? 1 : 0);
