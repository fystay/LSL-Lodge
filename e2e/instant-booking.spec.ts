import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { mintAdminSession } from "./admin-auth";

/**
 * Instant booking without host approval: a guest's details create a short
 * hold while they pay; the owner sees it but has nothing to approve, can't
 * block over it, and the guest can release it. Payment itself needs Stripe
 * test keys (e2e/stripe-sandbox.spec.ts); webhook confirmation, refunds and
 * the 24-hour boundary are covered by the integration tests.
 *
 * Needs E2E_BOOKING=true and a seeded local database.
 */
test.skip(
  process.env.E2E_BOOKING !== "true",
  "instant booking journey needs a seeded local database",
);
test.describe.configure({ mode: "serial" });

// Each project uses its own weeks (they share one database). Mon → Thu.
const weeks = {
  desktop: {
    release: ["2027-04-05", "2027-04-08"],
    owner: ["2027-04-12", "2027-04-15"],
  },
  mobile: {
    release: ["2027-04-19", "2027-04-22"],
    owner: ["2027-04-26", "2027-04-29"],
  },
} as const;
type Project = keyof typeof weeks;

async function holdDates(page: Page, [checkIn, checkOut]: readonly string[]) {
  await page.goto(`/book?checkIn=${checkIn}&checkOut=${checkOut}&guests=2`);
  await page.getByLabel("Lead guest name").fill("Instant Guest");
  await page.getByLabel("Email address").fill("instant@example.test");
  await page.getByLabel(/I have read the/).check();
  await page.getByRole("button", { name: "Hold these dates" }).click();
  await expect(page).toHaveURL(/\/book\/LL-[A-Z0-9]{6}$/);
  return page.url().split("/").at(-1)!;
}

test("a confirmed booking shows its deadline and 'contact the owner to cancel'; the owner records the guest's request", async ({
  page,
  browser,
}, info) => {
  const stay = weeks[info.project.name as Project].release;
  const ref = await holdDates(page, stay);
  // Stand-in for verified payment (Stripe isn't configured in this run):
  // confirm the booking as the payment code would, 24 h deadline included.
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`
      UPDATE reservations
      SET status = 'CONFIRMED', hold_expires_at = NULL,
          confirmed_at = now(), free_cancellation_until = now() + interval '24 hours'
      WHERE public_ref = ${ref}`;
    await sql`
      UPDATE payment_schedule_items SET status = 'PAID', paid_minor = amount_minor
      WHERE reservation_id = (SELECT id FROM reservations WHERE public_ref = ${ref})`;
  } finally {
    await sql.end();
  }
  await page.reload();
  const status = page.getByRole("status").filter({ hasText: "Status:" });
  await expect(status).toContainText("Status: confirmed.");
  await expect(status).toContainText(/full refund until .* \(UK\s+time\)/);
  await expect(
    status.getByRole("link", { name: "contact the owner" }),
  ).toHaveAttribute("href", "/contact");
  // The price box shows the verified payment as paid (owner-approved).
  const schedule = page.getByRole("complementary", { name: "Your stay" });
  await expect(schedule).toContainText(/Full payment\s+paid/);
  await expect(schedule).not.toContainText("due now");
  // No guest cancellation form.
  await expect(page.getByRole("button", { name: /cancel/i })).toHaveCount(0);

  // The owner records the guest's request, received just now: inside the
  // 24 hours, so the policy refund applies (nothing was charged here).
  const context = await browser.newContext();
  await mintAdminSession(context);
  const owner = await context.newPage();
  await owner.goto("/admin/bookings");
  await owner.getByRole("link", { name: ref }).click();
  const received = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/London",
    dateStyle: "short",
    timeStyle: "short",
  })
    .format(new Date())
    .replace(" ", "T");
  await owner.getByLabel("Request received (UK time)").fill(received);
  await owner.getByLabel("Yes, the guest asked to cancel this booking").check();
  await owner
    .getByRole("button", { name: "Cancel at guest’s request" })
    .click();
  await expect(owner.getByRole("status").first()).toContainText(
    "within 24 hours of confirmation",
  );
  await context.close();

  await page.reload();
  await expect(page.getByRole("status").first()).not.toContainText(
    "Status: confirmed",
  );
  await page.goto(
    `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
  );
  await expect(page.getByText("Available for your dates")).toBeVisible();
});

test("owner sees a booking in progress, with no approval step, and can't block over it", async ({
  page,
  browser,
}, info) => {
  const stay = weeks[info.project.name as Project].owner;
  const ref = await holdDates(page, stay);

  const context = await browser.newContext();
  await mintAdminSession(context);
  const owner = await context.newPage();
  await owner.goto("/admin");
  const inProgress = owner.getByRole("region", {
    name: "Bookings in progress",
  });
  await inProgress.getByRole("link", { name: ref }).click();
  await expect(
    owner.getByRole("heading", { name: `Booking ${ref}` }),
  ).toBeVisible();
  await expect(owner.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(
    owner.getByRole("region", { name: "Stay" }).getByText(/Free cancellation/),
  ).toBeVisible();

  // Blocking the held dates is refused, naming the booking in the way.
  await owner.goto("/admin/blocks");
  const add = owner
    .locator("form")
    .filter({ has: owner.getByRole("button", { name: "Block dates" }) });
  await add.getByLabel("First night").fill(stay[0]);
  await add.getByLabel(/End date/).fill(stay[1]);
  await add.getByRole("button", { name: "Block dates" }).click();
  await expect(
    owner.getByRole("alert").filter({ hasText: `booking ${ref}` }),
  ).toBeVisible();

  // The calendar shows the hold distinctly, with its reference.
  await owner.goto(`/admin/calendar?month=${stay[0].slice(0, 7)}`);
  await expect(owner.getByRole("table")).toContainText(`Paying now ${ref}`);
  await context.close();
});
