import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Real Stripe TEST-MODE lifecycle for instant booking: guest details → hold
 * → straight to Stripe's hosted Checkout → test card → confirmed exactly
 * once (only after server-side verification).
 *
 * Opt-in only: STRIPE_SANDBOX_E2E=true, a local E2E database
 * (E2E_BOOKING=true), and STRIPE_SECRET_KEY=sk_test_… plus
 * STRIPE_WEBHOOK_SECRET from `stripe listen --forward-to
 * localhost:3100/api/webhooks/stripe`, all in the server's environment.
 * Never runs in CI. Live keys are refused by the app itself.
 *
 * STATUS: written against Stripe Checkout's documented test flow but not yet
 * run (no test keys were available). Stripe's page selectors may need
 * adjusting on the first run.
 */
test.skip(
  process.env.STRIPE_SANDBOX_E2E !== "true" ||
    process.env.E2E_BOOKING !== "true" ||
    !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"),
  "needs Stripe test keys and STRIPE_SANDBOX_E2E=true",
);
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const stay = { checkIn: "2027-08-16", checkOut: "2027-08-19" }; // Mon → Thu

test("guest pays in full in test mode and the booking confirms once", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "run once, on desktop");

  // 1–2. Guest enters details and goes straight to Stripe (no approval).
  await page.goto(
    `/book?checkIn=${stay.checkIn}&checkOut=${stay.checkOut}&guests=2`,
  );
  await page.getByLabel("Lead guest name").fill("Sandbox Guest");
  await page.getByLabel("Email address").fill("sandbox-guest@example.test");
  await page.getByLabel(/I have read the/).check();
  await page.getByRole("button", { name: "Continue to payment" }).click();

  // 3. Guest pays on Stripe's hosted page with the standard test card. The
  // cancellation deadline is shown beside the pay button.
  await page.waitForURL(/checkout\.stripe\.com/);
  await expect(page.getByText(/Free cancellation until/)).toBeVisible();
  await page.locator("#cardNumber").fill("4242 4242 4242 4242");
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  await page.locator("#billingName").fill("Sandbox Guest");
  const postcode = page.locator("#billingPostalCode");
  if (await postcode.isVisible()) await postcode.fill("LA1 1AA");
  await page.getByTestId("hosted-payment-submit-button").click();

  // 4–5. Back on our page; confirmed only after server-side verification.
  await page.waitForURL(/\/book\/LL-[A-Z0-9]{6}/, { timeout: 60_000 });
  const ref = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("status").first()).toContainText("Confirmed", {
    timeout: 60_000,
  });

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [r] =
      await sql`SELECT id, status FROM reservations WHERE public_ref = ${ref}`;
    expect(r.status).toBe("CONFIRMED");
    const pays = await sql`
      SELECT status, amount_minor FROM payments WHERE reservation_id = ${r.id}`;
    expect(pays.filter((p) => p.status === "SUCCEEDED")).toHaveLength(1);
    const confirmed = await sql`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE target_id = ${r.id} AND action = 'reservation.confirmed'`;
    expect(confirmed[0].n).toBe(1);
    // With `stripe listen` running, the webhook arrives too and is a no-op.
    await page.waitForTimeout(5_000);
    const again = await sql`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE target_id = ${r.id} AND action = 'reservation.confirmed'`;
    expect(again[0].n).toBe(1);
  } finally {
    await sql.end();
  }
});
