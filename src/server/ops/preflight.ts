/**
 * Read-only staging preflight: what is missing before the Lodge can be
 * demonstrated on staging. Used by scripts/staging-preflight.mts.
 *
 * Rules:
 * - Never prints a secret or a connection string. Details name variables,
 *   hosts, IDs and counts only.
 * - Never writes. Database checks run inside a READ ONLY transaction;
 *   Stripe checks only list and retrieve.
 *
 * No `server-only` import: runs from a script.
 */
import type { Sql } from "postgres";
import type Stripe from "stripe";
import {
  isolationProblems,
  isolationState,
  targetSchema,
  type Env,
} from "../db/isolation";
import {
  STRIPE_API_VERSION,
  STRIPE_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_PATH,
} from "../payments/stripe-config";

export type Status = "PASS" | "WARN" | "FAIL";
export interface Check {
  area: string;
  status: Status;
  label: string;
  detail?: string;
}

/** The live site: staging must never be configured to look like it. */
export const PRODUCTION_HOSTS = ["lsllodge.vercel.app"];

/** Jobs the scheduler should be running (src/server/jobs/definitions.ts). */
export const SCHEDULED_JOBS = [
  "expire-holds",
  "send-notifications",
  "process-refunds",
  "reconcile-payments",
  "sync-calendars",
  "maintenance",
  "data-retention",
];

const pass = (area: string, label: string, detail?: string): Check => ({
  area,
  status: "PASS",
  label,
  detail,
});
const warn = (area: string, label: string, detail?: string): Check => ({
  area,
  status: "WARN",
  label,
  detail,
});
const fail = (area: string, label: string, detail?: string): Check => ({
  area,
  status: "FAIL",
  label,
  detail,
});

// ── Environment ───────────────────────────────────────────────────────────

export function checkEnvironment(env: Env): Check[] {
  const A = "environment";
  const out: Check[] = [];
  const has = (k: string) => Boolean(env[k]?.trim());
  const secret = (k: string, why: string) => {
    if (!has(k)) out.push(fail(A, `${k} is set`, why));
    else if (env[k]!.length < 32)
      out.push(fail(A, `${k} is at least 32 characters`, why));
    else out.push(pass(A, `${k} is set`));
  };

  if (env.VERCEL_ENV === "production")
    out.push(
      fail(A, "not the production environment", "VERCEL_ENV is production"),
    );

  out.push(
    has("DATABASE_URL")
      ? pass(A, "DATABASE_URL is set")
      : fail(A, "DATABASE_URL is set"),
  );
  let schema = "public";
  try {
    schema = targetSchema(env);
    out.push(
      schema === "public"
        ? warn(
            A,
            "DATABASE_SCHEMA",
            "unset: only correct if the database belongs to the Lodge alone (the lsllodge project needs DATABASE_SCHEMA=lodge)",
          )
        : pass(A, "DATABASE_SCHEMA", schema),
    );
  } catch {
    out.push(fail(A, "DATABASE_SCHEMA is a plain identifier"));
  }

  try {
    const u = new URL(env.SITE_URL ?? "");
    if (u.protocol !== "https:")
      out.push(fail(A, "SITE_URL uses https", u.host));
    else if (PRODUCTION_HOSTS.includes(u.host))
      out.push(
        fail(A, "SITE_URL is not the production site", `${u.host} is live`),
      );
    else out.push(pass(A, "SITE_URL", u.host));
  } catch {
    out.push(fail(A, "SITE_URL is a valid URL"));
  }

  out.push(
    env.BOOKING_PREVIEW === "true"
      ? pass(A, "BOOKING_PREVIEW is true")
      : fail(A, "BOOKING_PREVIEW is true", "the booking engine stays off"),
  );
  try {
    new Intl.DateTimeFormat("en-GB", {
      timeZone: env.PROPERTY_TIME_ZONE || "Europe/London",
    });
    out.push(
      pass(A, "PROPERTY_TIME_ZONE", env.PROPERTY_TIME_ZONE || "Europe/London"),
    );
  } catch {
    out.push(fail(A, "PROPERTY_TIME_ZONE is a valid IANA zone"));
  }

  secret("GUEST_LINK_SECRET", "guest booking links can't be signed");
  secret("CALENDAR_EXPORT_SECRET", "the calendar export link can't be signed");
  secret("CRON_SECRET", "the scheduler can't call /api/jobs/tick");
  secret("HEALTHCHECK_SECRET", "the uptime check can't call /api/health");
  const distinct = [
    "GUEST_LINK_SECRET",
    "CALENDAR_EXPORT_SECRET",
    "CRON_SECRET",
    "HEALTHCHECK_SECRET",
  ].filter(has);
  if (new Set(distinct.map((k) => env[k])).size < distinct.length)
    out.push(fail(A, "each secret has its own value", "two are identical"));

  const key = env.CREDENTIALS_ENCRYPTION_KEY ?? "";
  out.push(
    Buffer.from(key, "base64").length === 32
      ? pass(A, "CREDENTIALS_ENCRYPTION_KEY is 32 bytes (base64)")
      : fail(A, "CREDENTIALS_ENCRYPTION_KEY is 32 bytes (base64)"),
  );

  const sk = env.STRIPE_SECRET_KEY ?? "";
  if (!sk) out.push(fail(A, "STRIPE_SECRET_KEY is set", "no payments"));
  else if (!/^(sk|rk)_test_/.test(sk))
    out.push(
      fail(A, "STRIPE_SECRET_KEY is a TEST key", "live keys are never used"),
    );
  else out.push(pass(A, "STRIPE_SECRET_KEY is a test key"));
  out.push(
    (env.STRIPE_WEBHOOK_SECRET ?? "").startsWith("whsec_")
      ? pass(A, "STRIPE_WEBHOOK_SECRET is set")
      : fail(
          A,
          "STRIPE_WEBHOOK_SECRET is set",
          "payments can't be verified (pnpm stripe:test-setup)",
        ),
  );
  const pk = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
  if (pk && !pk.startsWith("pk_test_"))
    out.push(fail(A, "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a test key"));

  for (const [k, why] of [
    ["STRIPE_LIVE_MODE_APPROVED", "live payments"],
    ["EMAIL_LIVE_DELIVERY_APPROVED", "real guest emails"],
    ["SITE_INDEXABLE", "search engine indexing"],
  ] as const)
    if (env[k] === "true")
      out.push(fail(A, `${k} is not true on staging`, `would allow ${why}`));
  const email = env.EMAIL_DELIVERY || "off";
  out.push(
    email === "resend"
      ? fail(A, "EMAIL_DELIVERY is off or resend-sandbox", "real recipients")
      : pass(A, "EMAIL_DELIVERY", email),
  );

  return out;
}

// ── Database (read-only) ──────────────────────────────────────────────────

export async function checkDatabase(
  sql: Sql,
  env: Env,
  journalEntries: number,
  now = new Date(),
): Promise<Check[]> {
  const A = "database";
  const out: Check[] = [];
  const schema = targetSchema(env);
  const slug = env.PROPERTY_SLUG || "lodge-on-the-lake";
  await sql.begin("READ ONLY", async (tx) => {
    const [{ version }] =
      await tx`SELECT current_setting('server_version') AS version`;
    out.push(pass(A, "connects", `PostgreSQL ${version}`));

    if (schema !== "public") {
      const problems = isolationProblems(await isolationState(tx), schema);
      out.push(
        problems.length === 0
          ? pass(A, `isolated to schema "${schema}"`)
          : fail(A, `isolated to schema "${schema}"`, problems.join("; ")),
      );
      // Unqualified names below would resolve outside the Lodge schema (e.g.
      // to another application's `public.properties`): read nothing more.
      if (problems.length > 0) return;
    } else {
      const [{ n }] = await tx`
        SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN ('User', 'Booking', '_prisma_migrations')`;
      out.push(
        n === 0
          ? pass(A, "no other application's tables alongside")
          : fail(
              A,
              "no other application's tables alongside",
              "another application's tables are in public: set DATABASE_SCHEMA=lodge and connect as lodge_app",
            ),
      );
    }

    const journal = schema === "public" ? "drizzle" : schema;
    // Savepoints: a missing table must not abort the read-only transaction.
    const applied = await tx
      .savepoint((sp) =>
        sp.unsafe(
          `SELECT count(*)::int AS n FROM "${journal}"."__drizzle_migrations"`,
        ),
      )
      .then((rows) => rows[0].n as number)
      .catch(() => 0);
    out.push(
      applied === journalEntries
        ? pass(A, "all migrations applied", `${applied} of ${journalEntries}`)
        : fail(
            A,
            "all migrations applied",
            `${applied} of ${journalEntries}: run pnpm db:migrate`,
          ),
    );
    if (applied !== journalEntries) return;

    const [property] = await tx`
      SELECT id, bookings_enabled FROM properties WHERE slug = ${slug}`;
    if (!property) {
      out.push(fail(A, `property "${slug}" exists`, "run pnpm demo seed"));
    } else {
      out.push(pass(A, `property "${slug}" exists`));
      out.push(
        property.bookings_enabled
          ? pass(A, "online booking switched on")
          : fail(A, "online booking switched on", "/admin/settings"),
      );
      const today = now.toISOString().slice(0, 10);
      const [rates] = await tx`
        SELECT count(*)::int AS n FROM rate_rules
        WHERE property_id = ${property.id} AND active
          AND starts_on <= ${today}::date + 90 AND ends_on > ${today}::date + 90`;
      out.push(
        rates.n > 0
          ? pass(A, "prices set for the next 3 months")
          : warn(
              A,
              "prices set for the next 3 months",
              "demo dates may have no price",
            ),
      );
      const [policy] = await tx`
        SELECT count(*)::int AS n FROM payment_policies
        WHERE property_id = ${property.id} AND active`;
      out.push(
        policy.n > 0
          ? pass(A, "payment plan configured")
          : fail(A, "payment plan configured", "run pnpm demo seed"),
      );
    }

    const [marker] = await tx`
      SELECT count(*)::int AS n FROM audit_logs WHERE action = 'demo.seeded'`;
    out.push(
      marker.n > 0
        ? pass(A, "marked as a demo database (demo reset allowed)")
        : warn(
            A,
            "marked as a demo database",
            "pnpm demo reset will refuse until pnpm demo seed has run",
          ),
    );

    const [owners] = await tx`
      SELECT count(*)::int AS n FROM admin_users
      WHERE role = 'OWNER' AND enrolled_at IS NOT NULL AND disabled_at IS NULL
        AND password_hash IS DISTINCT FROM 'unusable'`;
    out.push(
      owners.n > 0
        ? pass(A, "an owner account is set up", `${owners.n}`)
        : fail(A, "an owner account is set up", "pnpm admin invite --email …"),
    );

    // Scheduler: recent job runs, and the pg_cron entry where visible.
    const runs = await tx`
      SELECT name, max(started_at) AS last FROM job_runs
      WHERE status = 'SUCCEEDED' GROUP BY name`;
    const last = new Map(runs.map((r) => [r.name as string, r.last as Date]));
    const recent = (name: string, minutes: number) => {
      const at = last.get(name);
      return (
        at !== undefined && now.getTime() - at.getTime() <= minutes * 60_000
      );
    };
    out.push(
      recent("expire-holds", 15)
        ? pass(A, "scheduler is running", "expire-holds ran in the last 15 min")
        : warn(
            A,
            "scheduler is running",
            "no job run in the last 15 min (scripts/staging-scheduler.sql); the demo still works without it",
          ),
    );
    const never = SCHEDULED_JOBS.filter((j) => !last.has(j));
    if (never.length > 0 && never.length < SCHEDULED_JOBS.length)
      out.push(warn(A, "every job has run at least once", never.join(", ")));
    const cron = await tx
      .savepoint(
        (sp) =>
          sp`SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'lodge-jobs-tick'`,
      )
      .then((r) => r[0].n as number)
      .catch(() => null);
    if (cron !== null)
      out.push(
        cron > 0
          ? pass(A, "pg_cron entry lodge-jobs-tick exists")
          : warn(
              A,
              "pg_cron entry lodge-jobs-tick exists",
              "scripts/staging-scheduler.sql",
            ),
      );

    // Calendar feeds: a stale import pauses bookings (safety stop).
    const sources = await tx`
      SELECT label, provider, last_success_at, stale_after_minutes
      FROM external_calendar_sources
      WHERE enabled AND direction = 'IMPORT'`;
    if (sources.length === 0)
      out.push(
        warn(
          A,
          "calendar feeds",
          "no Airbnb feed connected: nothing imported, and the stale-feed stop has nothing to check",
        ),
      );
    for (const s of sources) {
      const stale =
        !s.last_success_at ||
        now.getTime() - (s.last_success_at as Date).getTime() >
          (s.stale_after_minutes as number) * 60_000;
      out.push(
        stale
          ? fail(
              A,
              `calendar feed "${s.label}" is fresh`,
              "stale or never synced: NEW BOOKINGS ARE PAUSED until it syncs",
            )
          : pass(
              A,
              `calendar feed "${s.label}" is fresh`,
              s.provider as string,
            ),
      );
    }
  });
  return out;
}

// ── Stripe (test mode, read-only) ─────────────────────────────────────────

export async function checkStripe(
  stripe: Stripe,
  env: Env,
  expectedAccount: string | undefined,
): Promise<Check[]> {
  const A = "stripe";
  const out: Check[] = [];
  const account = await stripe.accounts.retrieveCurrent();
  if (!expectedAccount)
    out.push(
      warn(
        A,
        "the key belongs to the Lodge's own sandbox",
        `key is for ${account.id}; pass --account acct_… to check it`,
      ),
    );
  else
    out.push(
      account.id === expectedAccount
        ? pass(A, "the key belongs to the Lodge's own sandbox", account.id)
        : fail(
            A,
            "the key belongs to the Lodge's own sandbox",
            `key is for ${account.id}, not ${expectedAccount}`,
          ),
    );

  const host = (() => {
    try {
      return new URL(env.SITE_URL ?? "").host;
    } catch {
      return "";
    }
  })();
  const endpoints = await stripe.webhookEndpoints
    .list({ limit: 100 })
    .autoPagingToArray({ limit: 1000 });
  const ours = endpoints.filter((e) => {
    const u = new URL(e.url);
    return u.host === host && u.pathname === STRIPE_WEBHOOK_PATH;
  });
  const others = [
    ...new Set(
      endpoints.map((e) => new URL(e.url).host).filter((h) => h !== host),
    ),
  ];
  out.push(
    others.length === 0
      ? pass(A, "sandbox sends webhooks to this site only")
      : fail(
          A,
          "sandbox sends webhooks to this site only",
          `also sends to ${others.join(", ")}: a shared sandbox (never reuse another app's)`,
        ),
  );
  const endpoint = ours[0];
  if (!endpoint) {
    out.push(
      fail(
        A,
        `webhook endpoint for ${host}${STRIPE_WEBHOOK_PATH}`,
        "run pnpm stripe:test-setup --apply",
      ),
    );
    return out;
  }
  out.push(pass(A, `webhook endpoint for ${host}`, endpoint.id));
  out.push(
    endpoint.status === "enabled"
      ? pass(A, "webhook endpoint enabled")
      : fail(A, "webhook endpoint enabled", endpoint.status),
  );
  const missing = STRIPE_WEBHOOK_EVENTS.filter(
    (e) =>
      !endpoint.enabled_events.includes(e) &&
      !endpoint.enabled_events.includes("*"),
  );
  out.push(
    missing.length === 0
      ? pass(A, "webhook endpoint has every event the site handles")
      : fail(
          A,
          "webhook endpoint has every event the site handles",
          `missing ${missing.join(", ")}`,
        ),
  );
  out.push(
    endpoint.api_version === STRIPE_API_VERSION
      ? pass(A, "webhook API version matches the app", STRIPE_API_VERSION)
      : warn(
          A,
          "webhook API version matches the app",
          `${endpoint.api_version ?? "account default"} vs ${STRIPE_API_VERSION}`,
        ),
  );
  out.push(
    warn(
      A,
      "webhook signing secret matches STRIPE_WEBHOOK_SECRET",
      "can't be read back from Stripe; proven only by a signed delivery (staging journey test)",
    ),
  );
  return out;
}

/** One line per check; details never contain values of secrets. */
export function formatChecks(checks: Check[]): string {
  return checks
    .map(
      (c) =>
        `${c.status.padEnd(4)}  [${c.area}] ${c.label}${c.detail ? `  (${c.detail})` : ""}`,
    )
    .join("\n");
}
