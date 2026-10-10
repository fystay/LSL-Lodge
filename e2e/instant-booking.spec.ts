import { expect, test, type Page } from "@playwright/test";
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

test("guest releases an unpaid hold; nothing is charged and the dates free up", async ({
  page,
}, info) => {
  const stay = weeks[info.project.name as Project].release;
  await holdDates(page, stay);
  await page.getByText("Cancel and release these dates").click();
  await page.getByLabel("Yes, release these dates").check();
  await page.getByRole("button", { name: "Release dates" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "nothing was charged" }),
  ).toBeVisible();
  await expect(page.getByRole("status").first()).toContainText("Cancelled");
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
