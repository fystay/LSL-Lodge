import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import Stripe from "stripe";
import {
  isolationProblems,
  isolationState,
  targetSchema,
} from "../src/server/db/isolation";
import { PRODUCTION_HOSTS } from "../src/server/ops/preflight";
import { mintAdminSession } from "./admin-auth";

/**
 * The customer-demo journey, run against a deployed staging site (or a local
 * production build as a rehearsal). Test data only: every guest uses an
 * @example.test address and every block or calendar source is labelled
 * [DEMO], so `pnpm demo reset` removes all of it.
 *
 *   STAGING_E2E=true             opt in
 *   E2E_BASE_URL=https://…       the staging site (omit for local build)
 *   DATABASE_URL=…               the staging database; must be local or
 *   DEMO_DATABASE_HOST=<host>    confirmed, and seeded by `pnpm demo seed`
 *   STAGING_STRIPE=true          the deployment has Lodge Stripe TEST keys:
 *                                runs the payment, refund and late-payment
 *                                journeys (Stripe's hosted page, test cards)
 *   STRIPE_SECRET_KEY=sk_test_…  optional, with STRIPE_WEBHOOK_SECRET: also
 *   STRIPE_WEBHOOK_SECRET=…      replays real events (duplicate, out of order)
 *   VERCEL_AUTOMATION_BYPASS_SECRET  optional, for a protected preview
 *
 * Don't run it while you are showing the site to someone: the stale-feed
 * test pauses new bookings for a few seconds.
 *
 * See docs/STAGING-SETUP.md and docs/DEMO.md.
 */
test.skip(
  process.env.STAGING_E2E !== "true",
  "staging journey: opt in with STAGING_E2E=true",
);
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const stripeOn = process.env.STAGING_STRIPE === "true";
const replayKey = process.env.STRIPE_SECRET_KEY ?? "";
const replayOn =
  stripeOn &&
  replayKey.startsWith("sk_test_") &&
  Boolean(process.env.STRIPE_WEBHOOK_SECRET);
const RUN = randomBytes(3).toString("hex");
const email = (label: string) => `staging-${RUN}-${label}@example.test`;

// ── Database (demo/staging only) ──────────────────────────────────────────

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to the staging database.");
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (!local && process.env.DEMO_DATABASE_HOST !== host)
    throw new Error(
      `Refusing to use database host "${host}": set DEMO_DATABASE_HOST=${host} to confirm it is the Lodge demo/staging database.`,
    );
  return postgres(url, { max: 2, onnotice: () => {} });
}
// Connects only when opted in, so ordinary E2E runs never need it.
const sql =
  process.env.STAGING_E2E === "true"
    ? connect()
    : (undefined as unknown as ReturnType<typeof connect>);
test.afterAll(async () => sql?.end());

test.beforeAll(async () => {
  // Staging only: never the live site.
  const base = process.env.E2E_BASE_URL;
  if (base && PRODUCTION_HOSTS.includes(new URL(base).host))
    throw new Error("Refusing: E2E_BASE_URL is the production site.");
  // On the shared staging database, only through the isolated Lodge role.
  const lodgeSchema = targetSchema();
  if (lodgeSchema !== "public") {
    const problems = isolationProblems(await isolationState(sql), lodgeSchema);
    if (problems.length > 0)
      throw new Error(`Refusing: ${problems.join("; ")}.`);
  }
  const [marker] =
    await sql`SELECT 1 FROM audit_logs WHERE action = 'demo.seeded' LIMIT 1`;
  if (!marker)
    throw new Error(
      "This database wasn't prepared with `pnpm demo seed`; refusing to run.",
    );
});

const propertyId = async () =>
  (
    await sql`SELECT id FROM properties WHERE slug = ${process.env.PROPERTY_SLUG ?? "lodge-on-the-lake"}`
  )[0].id as string;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const used = new Set<string>();
/** A Monday → Thursday stay with nothing on it, 3–15 months ahead. */
async function freeStay(): Promise<[string, string]> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 90);
  start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7));
  const mondays = Array.from({ length: 52 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + 7 * i);
    return d;
  }).sort(() => Math.random() - 0.5);
  for (const monday of mondays) {
    const thursday = new Date(monday);
    thursday.setUTCDate(thursday.getUTCDate() + 3);
    const [a, b] = [iso(monday), iso(thursday)];
    if (used.has(a)) continue;
    // A day either side, for any changeover rule.
    const [busy] = await sql`
      SELECT
        (SELECT count(*) FROM reservations
          WHERE status IN ('REQUESTED','APPROVED','PENDING_PAYMENT','CONFIRMED','PAYMENT_DUE','REQUIRES_REVIEW')
            AND check_in < ${b}::date + 1 AND check_out > ${a}::date - 1)
      + (SELECT count(*) FROM owner_blocks
          WHERE starts_on < ${b}::date + 1 AND ends_on > ${a}::date - 1)
      + (SELECT count(*) FROM external_busy_periods
          WHERE status = 'ACTIVE' AND starts_on < ${b}::date + 1 AND ends_on > ${a}::date - 1)
        AS n`;
    if (Number(busy.n) === 0) {
      used.add(a);
      return [a, b];
    }
  }
  throw new Error("No free test week found. Run `pnpm demo reset --yes`.");
}

const reservationFor = async (guestEmail: string) =>
  (
    await sql`
      SELECT id, public_ref, status, review_reason, confirmed_at, free_cancellation_until
      FROM reservations WHERE guest_email = ${guestEmail}
      ORDER BY created_at DESC LIMIT 1`
  )[0];

async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeout = 90_000,
): Promise<T> {
  const end = Date.now() + timeout;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2_000));
    value = await read();
  }
  return value;
}

// ── Browser helpers ───────────────────────────────────────────────────────

/**
 * Lets Playwright through Vercel's deployment protection. The secret is
 * added only to requests for the staging site itself, never to Stripe.
 */
async function bypass(context: BrowserContext) {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const base = process.env.E2E_BASE_URL;
  if (!secret || !base) return;
  const origin = new URL(base).origin;
  await context.route(
    (url) => url.origin === origin,
    (route) =>
      route.continue({
        headers: {
          ...route.request().headers(),
          "x-vercel-protection-bypass": secret,
        },
      }),
  );
}

async function owner(context: BrowserContext) {
  await bypass(context);
  await mintAdminSession(context, { email: `owner-${RUN}@example.test` });
  return context.newPage();
}

async function submitDetails(
  page: Page,
  [checkIn, checkOut]: readonly string[],
  guestEmail: string,
) {
  await page.goto(`/book?checkIn=${checkIn}&checkOut=${checkOut}&guests=2`);
  await page.getByLabel("Lead guest name").fill("Demo Guest");
  await page.getByLabel("Email address").fill(guestEmail);
  await page.getByLabel(/I have read the/).check();
  await page.getByRole("button", { name: "Hold these dates" }).click();
}

/** Guest details → hold (→ Stripe's page when payments are on). */
async function hold(page: Page, stay: readonly string[], guestEmail: string) {
  await submitDetails(page, stay, guestEmail);
  if (stripeOn) await page.waitForURL(/checkout\.stripe\.com/);
  else await page.waitForURL(/\/book\/LL-[A-Z0-9]{6}$/);
  return reservationFor(guestEmail);
}

/** Pays on Stripe's hosted Checkout page with a test card. */
async function pay(page: Page, card: string) {
  await page.locator("#cardNumber").fill(card);
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  await page.locator("#billingName").fill("Demo Guest");
  const postcode = page.locator("#billingPostalCode");
  if (await postcode.isVisible()) await postcode.fill("LA1 1AA");
  await page.getByTestId("hosted-payment-submit-button").click();
}

/** The owner records the guest's cancellation request, received now. */
async function ownerCancels(page: Page, ref: string) {
  await page.goto("/admin/bookings");
  await page.getByRole("link", { name: ref }).click();
  const received = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/London",
    dateStyle: "short",
    timeStyle: "short",
  })
    .format(new Date())
    .replace(" ", "T");
  await page.getByLabel("Request received (UK time)").fill(received);
  await page.getByLabel("Yes, the guest asked to cancel this booking").check();
  await page.getByRole("button", { name: "Cancel at guest’s request" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "within 24 hours of confirmation",
  );
}

const refundOf = async (reservationId: string) =>
  (
    await sql`
      SELECT status FROM payments
      WHERE reservation_id = ${reservationId} AND kind = 'REFUND'
      ORDER BY created_at DESC LIMIT 1`
  )[0]?.status as string | undefined;

test.beforeEach(async ({ context }, info) => {
  test.skip(info.project.name !== "desktop", "run once, on desktop");
  await bypass(context);
});

// ── Journeys without payment ──────────────────────────────────────────────

test("the site is up and the booking engine is on", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  const stay = await freeStay();
  await page.goto(
    `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
  );
  await expect(page.getByText("Available for your dates")).toBeVisible();
  // An unsigned webhook is refused and changes nothing.
  const forged = await request.post("/api/webhooks/stripe", {
    data: { id: "evt_forged", type: "checkout.session.completed" },
    headers: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? {
          "x-vercel-protection-bypass":
            process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        }
      : {},
  });
  expect(forged.status()).toBe(stripeOn ? 400 : 503);
});

test("a hold blocks the dates for everyone else and for the owner", async ({
  page,
  browser,
}) => {
  const stay = await freeStay();
  const first = await hold(page, stay, email("first"));
  expect(first.status).toBe("PENDING_PAYMENT");

  // A second guest can't take the same dates.
  const other = await browser.newContext();
  await bypass(other);
  const second = await other.newPage();
  await second.goto(`/book?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`);
  await expect(
    second.getByRole("alert").filter({ hasText: "no longer available" }),
  ).toBeVisible();
  await other.close();

  // The owner sees it in progress and can't block over it.
  const ownerContext = await browser.newContext();
  const admin = await owner(ownerContext);
  await admin.goto("/admin");
  await expect(
    admin
      .getByRole("region", { name: "Bookings in progress" })
      .getByRole("link", { name: first.public_ref }),
  ).toBeVisible();
  await admin.goto("/admin/blocks");
  const add = admin
    .locator("form")
    .filter({ has: admin.getByRole("button", { name: "Block dates" }) });
  await add.getByLabel("First night").fill(stay[0]);
  await add.getByLabel(/End date/).fill(stay[1]);
  await add.getByLabel("Reason (private)").fill("[DEMO] over a hold");
  await add.getByRole("button", { name: "Block dates" }).click();
  await expect(
    admin.getByRole("alert").filter({ hasText: `booking ${first.public_ref}` }),
  ).toBeVisible();
  await ownerContext.close();
});

test("the owner blocks dates and guests can no longer book them", async ({
  page,
  browser,
}) => {
  const stay = await freeStay();
  const ownerContext = await browser.newContext();
  const admin = await owner(ownerContext);
  await admin.goto("/admin/blocks");
  const add = admin
    .locator("form")
    .filter({ has: admin.getByRole("button", { name: "Block dates" }) });
  await add.getByLabel("First night").fill(stay[0]);
  await add.getByLabel(/End date/).fill(stay[1]);
  await add.getByLabel("Reason (private)").fill(`[DEMO] owner stay ${RUN}`);
  await add.getByRole("button", { name: "Block dates" }).click();
  await expect(admin.getByText(`[DEMO] owner stay ${RUN}`)).toBeVisible();
  await ownerContext.close();

  await page.goto(
    `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
  );
  await expect(
    page.getByText("isn’t available for all of those nights"),
  ).toBeVisible();
  await page.goto(`/book?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`);
  await expect(
    page.getByRole("alert").filter({ hasText: "no longer available" }),
  ).toBeVisible();
});

test("Airbnb dates block direct bookings; a stale feed pauses new bookings", async ({
  page,
}) => {
  const property = await propertyId();
  const stay = await freeStay();
  const [source] = await sql`
    INSERT INTO external_calendar_sources
      (property_id, provider, direction, label, enabled, sync_status, last_success_at, last_attempt_at)
    VALUES (${property}, 'AIRBNB_ICAL', 'IMPORT', ${`[DEMO] Airbnb ${RUN}`}, true, 'OK', now(), now())
    RETURNING id`;
  try {
    await sql`
      INSERT INTO external_busy_periods
        (source_id, property_id, external_uid, starts_on, ends_on, content_hash)
      VALUES (${source.id}, ${property}, ${`demo-${RUN}@airbnb.test`}, ${stay[0]}, ${stay[1]}, 'demo')`;
    // Airbnb's booking blocks the website.
    await page.goto(
      `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
    );
    await expect(
      page.getByText("isn’t available for all of those nights"),
    ).toBeVisible();

    // The feed goes stale (no successful import for 2 hours): the site
    // takes no new bookings, even for free dates.
    await sql`
      UPDATE external_calendar_sources
      SET last_success_at = now() - interval '2 hours', sync_status = 'STALE'
      WHERE id = ${source.id}`;
    const free = await freeStay();
    await submitDetails(page, free, email("stale"));
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Online booking isn’t available right now." }),
    ).toBeVisible();
    expect(await reservationFor(email("stale"))).toBeUndefined();
  } finally {
    await sql`DELETE FROM external_busy_periods WHERE source_id = ${source.id}`;
    await sql`DELETE FROM external_calendar_sources WHERE id = ${source.id}`;
  }
});

test("an expired hold frees the dates", async ({ page }) => {
  const stay = await freeStay();
  const r = await hold(page, stay, email("expired"));
  // Stand-in for 30 minutes passing.
  await sql`
    UPDATE reservations SET hold_expires_at = now() - interval '1 minute'
    WHERE id = ${r.id}`;
  await page.goto(`/book/${r.public_ref}`);
  await expect(
    page.getByText(/released and nothing was charged/),
  ).toBeVisible();
  await page.goto(
    `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
  );
  await expect(page.getByText("Available for your dates")).toBeVisible();
});

// ── Payment journeys (Stripe test mode) ───────────────────────────────────

test.describe("with Stripe test mode", () => {
  test.skip(!stripeOn, "needs STAGING_STRIPE=true (Lodge Stripe test keys)");

  let paid: {
    id: string;
    ref: string;
    session: string;
    stay: readonly string[];
  };
  const startedAt = new Date();

  test("guest pays, the verified payment confirms the booking, the owner sees it", async ({
    page,
    browser,
  }) => {
    const stay = await freeStay();
    const guest = email("paid");
    await hold(page, stay, guest);
    await expect(
      page.getByText(/starts once your payment is confirmed/),
    ).toBeVisible();
    await pay(page, "4242 4242 4242 4242");

    await page.waitForURL(/\/book\/LL-[A-Z0-9]{6}/, { timeout: 60_000 });
    const status = page.getByRole("status").filter({ hasText: "Status:" });
    await expect(status).toContainText("Status: confirmed.", {
      timeout: 60_000,
    });
    await expect(status).toContainText(/full refund until .* \(UK\s+time\)/);
    await expect(
      page.getByRole("complementary", { name: "Your stay" }),
    ).toContainText(/Full payment\s+paid/);

    const r = await reservationFor(guest);
    expect(r.status).toBe("CONFIRMED");
    expect(r.free_cancellation_until.getTime() - r.confirmed_at.getTime()).toBe(
      24 * 3_600_000,
    );
    const [payment] = await sql`
      SELECT stripe_checkout_session_id AS session FROM payments
      WHERE reservation_id = ${r.id} AND kind = 'CHARGE' AND status = 'SUCCEEDED'`;
    paid = { id: r.id, ref: r.public_ref, session: payment.session, stay };

    // Stripe's signed webhook reaches the deployment and is processed
    // (whichever of it and the return page got there first, the booking
    // confirmed once; the other is a no-op).
    const [delivered] = await until(
      () => sql`
        SELECT count(*)::int AS n FROM webhook_events
        WHERE provider = 'stripe' AND type = 'checkout.session.completed'
          AND state = 'PROCESSED' AND received_at >= ${startedAt}`,
      (rows) => rows[0].n > 0,
    );
    expect(
      delivered.n,
      "a signed checkout webhook was processed",
    ).toBeGreaterThan(0);
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE target_id = ${r.id} AND action = 'reservation.confirmed'`;
    expect(n).toBe(1);

    const ownerContext = await browser.newContext();
    const admin = await owner(ownerContext);
    await admin.goto("/admin/bookings");
    await admin.getByRole("link", { name: r.public_ref }).click();
    await expect(
      admin.getByRole("heading", { name: `Booking ${r.public_ref}` }),
    ).toBeVisible();
    await expect(
      admin
        .getByRole("region", { name: "Stay" })
        .getByText(/Free cancellation/),
    ).toBeVisible();
    await ownerContext.close();
  });

  test("duplicate and out-of-order webhooks change nothing", async ({
    request,
  }) => {
    test.skip(
      !replayOn,
      "needs STRIPE_SECRET_KEY (sk_test_) and STRIPE_WEBHOOK_SECRET in the runner",
    );
    const stripe = new Stripe(replayKey);
    const events = await stripe.events.list({
      type: "checkout.session.completed",
      limit: 50,
    });
    const event = events.data.find(
      (e) => (e.data.object as { id: string }).id === paid.session,
    );
    expect(event, "Stripe's completed event for this session").toBeTruthy();
    const post = (payload: string) =>
      request.post("/api/webhooks/stripe", {
        data: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": stripe.webhooks.generateTestHeaderString({
            payload,
            secret: process.env.STRIPE_WEBHOOK_SECRET!,
          }),
          ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            ? {
                "x-vercel-protection-bypass":
                  process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
              }
            : {}),
        },
      });
    const [recorded] = await sql`
      SELECT state FROM webhook_events WHERE provider_event_id = ${event!.id}`;
    expect(recorded?.state, "Stripe's own delivery was processed").toBe(
      "PROCESSED",
    );
    const payload = JSON.stringify(event);
    // Stripe delivers it again (twice).
    expect((await post(payload)).status()).toBe(200);
    expect((await post(payload)).status()).toBe(200);
    // A late "session expired" for the paid session arrives afterwards.
    const late = JSON.stringify({
      ...event,
      id: `evt_test_late_${RUN}`,
      type: "checkout.session.expired",
      data: { object: { ...event!.data.object, status: "expired" } },
    });
    expect((await post(late)).status()).toBe(200);

    const r = await reservationFor(email("paid"));
    expect(r.status).toBe("CONFIRMED");
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE target_id = ${paid.id} AND action = 'reservation.confirmed'`;
    expect(n).toBe(1);
    const charges = await sql`
      SELECT status FROM payments WHERE reservation_id = ${paid.id} AND kind = 'CHARGE'`;
    expect(charges.map((c) => c.status)).toEqual(["SUCCEEDED"]);
  });

  test("cancelled before the deadline: refunded in full once Stripe confirms", async ({
    page,
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const admin = await owner(ownerContext);
    await ownerCancels(admin, paid.ref);
    await ownerContext.close();
    expect(
      await until(
        () => refundOf(paid.id),
        (s) => s === "SUCCEEDED",
      ),
    ).toBe("SUCCEEDED");
    const r = await until(
      () => reservationFor(email("paid")),
      (x) => x.status === "REFUNDED",
    );
    expect(r.status).toBe("REFUNDED");
    // The dates are free again.
    await page.goto(
      `/availability?checkIn=${paid.stay[0]}&checkOut=${paid.stay[1]}&guests=2`,
    );
    await expect(page.getByText("Available for your dates")).toBeVisible();
  });

  test("a declined card confirms nothing; leaving Stripe releases the hold", async ({
    page,
  }) => {
    const stay = await freeStay();
    const guest = email("declined");
    const r = await hold(page, stay, guest);
    await pay(page, "4000 0000 0000 0002");
    await expect(page.getByText(/declined/i).first()).toBeVisible({
      timeout: 30_000,
    });
    expect((await reservationFor(guest)).status).toBe("PENDING_PAYMENT");

    // Stripe's "back" link (its cancel URL) releases the hold.
    const [payment] = await sql`
      SELECT id FROM payments WHERE reservation_id = ${r.id} AND kind = 'CHARGE'`;
    await page.goto(`/book/${r.public_ref}/checkout-cancelled?p=${payment.id}`);
    await expect(page).toHaveURL(/\/book\?checkIn=/);
    expect((await reservationFor(guest)).status).toBe("CANCELLED");
    await page.goto(
      `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
    );
    await expect(page.getByText("Available for your dates")).toBeVisible();
  });

  test("a refund Stripe later fails is flagged to the owner and can be retried", async ({
    page,
    browser,
  }) => {
    const stay = await freeStay();
    const guest = email("refundfail");
    await hold(page, stay, guest);
    // Stripe test card: the refund succeeds, then fails (refund.failed).
    await pay(page, "4000 0000 0000 5126");
    await page.waitForURL(/\/book\/LL-[A-Z0-9]{6}/, { timeout: 60_000 });
    const r = await until(
      () => reservationFor(guest),
      (x) => x.status === "CONFIRMED",
    );
    expect(r.status).toBe("CONFIRMED");

    const ownerContext = await browser.newContext();
    const admin = await owner(ownerContext);
    await ownerCancels(admin, r.public_ref);
    expect(
      await until(
        () => refundOf(r.id),
        (s) => s === "FAILED",
        180_000,
      ),
    ).toBe("FAILED");
    const flagged = await reservationFor(guest);
    expect([flagged.status, flagged.review_reason]).toEqual([
      "REFUND_PENDING",
      "REFUND_FAILED_AT_PROVIDER",
    ]);
    await admin.reload();
    await expect(
      admin.getByText("Stripe reported a refund as failed"),
    ).toBeVisible();
    // The full amount can be refunded again.
    await expect(
      admin.getByRole("button", { name: "Refund", exact: true }),
    ).toBeVisible();
    await ownerContext.close();
  });

  test("a payment that arrives after the hold expired goes to the owner, not confirmed", async ({
    page,
  }) => {
    const stay = await freeStay();
    const guest = email("late");
    const r = await hold(page, stay, guest);
    // The hold lapses while the guest is still on Stripe's page (stand-in
    // for the expiry job running when Stripe couldn't be reached).
    await sql`
      UPDATE reservations
      SET status = 'EXPIRED', hold_expires_at = now() - interval '1 minute'
      WHERE id = ${r.id}`;
    await pay(page, "4242 4242 4242 4242");
    const late = await until(
      () => reservationFor(guest),
      (x) => x.status !== "EXPIRED",
    );
    expect([late.status, late.review_reason]).toEqual([
      "REQUIRES_REVIEW",
      "PAYMENT_AFTER_EXPIRY",
    ]);
    expect(late.confirmed_at).toBeNull();
  });
});
