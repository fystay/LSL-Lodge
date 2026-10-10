import { settleAnimations } from "./support";
import { expect, test, type Page } from "@playwright/test";

/**
 * Full booking journey against a real (local) database seeded with
 * placeholder pricing (scripts/seed-dev.mts). Enabled with E2E_BOOKING=true;
 * the server must run with BOOKING_PREVIEW=true and the same DATABASE_URL.
 */
test.skip(
  process.env.E2E_BOOKING !== "true",
  "booking flow needs a seeded local database",
);
test.describe.configure({ mode: "serial" });

// Placeholder seed: £150 weeknights, £180 Fri/Sat, £60 cleaning, full payment
// when booking.
// Mon → Thu: 3 weeknights = £450 + £60 = £510. Each browser project books a
// different week, because the projects share one database.
const weeks = {
  desktop: {
    checkIn: "2027-06-07",
    checkOut: "2027-06-10",
    overlap: ["2027-06-08", "2027-06-11"],
  },
  mobile: {
    checkIn: "2027-06-14",
    checkOut: "2027-06-17",
    overlap: ["2027-06-15", "2027-06-18"],
  },
} as const;
const stayFor = (project: string) => weeks[project as keyof typeof weeks];

async function search(page: Page, checkIn: string, checkOut: string) {
  await page.goto(
    `/availability?checkIn=${checkIn}&checkOut=${checkOut}&guests=2`,
  );
}

test("guest sees an itemised price and payment schedule before committing", async ({
  page,
}, info) => {
  const stay = stayFor(info.project.name);
  await search(page, stay.checkIn, stay.checkOut);
  await expect(page.getByText("Available for your dates")).toBeVisible();
  const breakdown = page.getByRole("table", { name: "Price breakdown" });
  await expect(breakdown).toContainText("3 nights");
  await expect(breakdown).toContainText("£450");
  await expect(breakdown).toContainText("Cleaning (placeholder)");
  await expect(breakdown).toContainText("£510");
  await expect(page.getByText(/Full payment\s+due now/)).toBeVisible();
  // Production's wording, unchanged.
  await expect(
    page.getByText(/holds these dates for you for\s+30 minutes/),
  ).toBeVisible();
});

test("guest books instantly; the dates are held and unavailable to others", async ({
  page,
  browser,
}, info) => {
  const stay = stayFor(info.project.name);
  await search(page, stay.checkIn, stay.checkOut);
  await page.getByRole("link", { name: "Continue to book" }).click();
  await expect(page).toHaveURL(/\/book\?/);

  // Before payment no deadline exists yet: the page says when it starts and
  // shows no time.
  await expect(
    page.getByText(
      "The 24-hour free-cancellation period starts once your payment is confirmed.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByText(/until \d{1,2}:\d\d/)).toHaveCount(0);
  // Server-side validation first.
  await page.getByRole("button", { name: "Hold these dates" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Please check the following" }),
  ).toBeVisible();

  await page.getByLabel("Lead guest name").fill("Test Guest");
  await page.getByLabel("Email address").fill("guest@example.test");
  await page.getByLabel(/I have read the/).check();
  await page.getByRole("button", { name: "Hold these dates" }).click();

  // Without Stripe keys (this preview) the guest lands on their booking page
  // instead of Stripe's; with keys they would go straight to Checkout.
  await expect(page).toHaveURL(/\/book\/LL-[A-Z0-9]{6}$/);
  await expect(
    page.getByRole("heading", { name: /Booking reference LL-/ }),
  ).toBeVisible();
  // Production's page: a hold is never presented as a confirmed booking,
  // and no cancellation deadline exists before payment.
  const status = page.getByRole("status").filter({ hasText: "holding" });
  await expect(status).toContainText("We’re holding these dates for you");
  await expect(status).toContainText(
    "confirmed only once payment has been verified",
  );
  await expect(status).not.toContainText("Status: confirmed");
  await expect(
    page.getByText(/You can cancel for a full refund until/),
  ).toHaveCount(0);
  await expect(page.getByText("Payment isn’t switched on yet.")).toBeVisible();
  const holdUrl = page.url();

  // A different visitor (no cookie) sees the not-found page, not the booking.
  // (The status is 200 because the page streams; the content is what matters.)
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(holdUrl);
  await expect(otherPage.getByRole("heading", { level: 1 })).toHaveText(
    /couldn.t find/,
  );
  await expect(otherPage.getByText(/Booking reference/)).toHaveCount(0);
  await expect(otherPage.getByText("Test Guest")).toHaveCount(0);

  // …and cannot book overlapping dates.
  await search(otherPage, stay.overlap[0], stay.overlap[1]);
  await expect(
    otherPage.getByText(/isn’t available for all of those nights/),
  ).toBeVisible();
  await other.close();
});

test("searching invalid stays shows the pricing rule that applies", async ({
  page,
}) => {
  await search(page, "2027-07-05", "2027-07-06");
  await expect(
    page.getByRole("alert").filter({ hasText: "minimum stay" }),
  ).toBeVisible();
});

test("booking pages have no automatically detectable WCAG A/AA violations", async ({
  page,
}) => {
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const scan = async (label: string) => {
    await settleAnimations(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map((v) => `${label} ${v.id}: ${v.help}`),
    ).toEqual([]);
  };
  await search(page, "2027-08-02", "2027-08-05");
  await scan("availability");
  await page.goto(`/book?checkIn=2027-08-02&checkOut=2027-08-05&guests=2`);
  await scan("book");
});
