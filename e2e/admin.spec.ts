import { settleAnimations } from "./support";
import { expect, test, type Page } from "@playwright/test";
import { mintAdminSession } from "./admin-auth";

/**
 * Admin journeys against the seeded local database (E2E_BOOKING=true). The
 * signed-in owner session is created directly in the local test database;
 * the real sign-in journey is covered in admin-security.spec.ts.
 */
test.skip(
  process.env.E2E_BOOKING !== "true",
  "admin tests need a seeded local database",
);
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await mintAdminSession(page.context());
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { level: 1, name: "Overview" }),
  ).toBeVisible();
}

test("admin pages require sign-in", async ({ page }) => {
  for (const path of [
    "/admin",
    "/admin/bookings",
    "/admin/calendar",
    "/admin/blocks",
    "/admin/pricing",
    "/admin/settings",
    "/admin/calendars",
    "/admin/account",
    "/admin/system",
    "/admin/reauth",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin\/login$/);
  }
});

test("owner blocks dates, sees them on the calendar, and guests can't book them", async ({
  page,
  browser,
}, info) => {
  // Each browser project uses its own month (they share one database).
  const month = info.project.name === "desktop" ? "2027-09" : "2027-10";
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Admin" })
    .getByRole("link", { name: "Blocked dates" })
    .click();
  await page.getByLabel("First night").fill(`${month}-06`);
  await page.getByLabel(/End date/).fill(`${month}-09`);
  await page.getByLabel("Reason (private)").fill("Maintenance (test)");
  await page.getByRole("button", { name: "Block dates" }).click();
  await expect(page.getByRole("status")).toHaveText("Dates blocked.");

  await page.goto(`/admin/calendar?month=${month}`);
  await expect(page.getByRole("table")).toContainText("Owner block");

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(
    `/availability?checkIn=${month}-07&checkOut=${month}-10&guests=2`,
  );
  await expect(
    guestPage.getByText(/isn’t available for all of those nights/),
  ).toBeVisible();
  await guest.close();

  // Removal needs explicit confirmation.
  await page.goto("/admin/blocks");
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "Maintenance (test)" });
  await row.getByLabel("Confirm").check();
  await row.getByRole("button", { name: "Remove block" }).click();
  await expect(page.getByRole("status")).toContainText("Block removed");
});

test("owner adds a higher-priority rate and new quotes use it", async ({
  page,
}, info) => {
  const month = info.project.name === "desktop" ? "2027-11" : "2027-12";
  await signIn(page);
  await page.goto("/admin/pricing");
  await page.getByText("Add a rate").click();
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add rate" }) });
  await form.getByLabel("Name").fill(`Test season ${month}`);
  await form.getByLabel("From (first night)").fill(`${month}-01`);
  await form.getByLabel("Until (not including)").fill(`${month}-28`);
  await form.getByLabel("Nightly rate (£)").fill("200");
  await form.getByLabel("Priority").fill("10");
  await form.getByRole("button", { name: "Add rate" }).click();
  await expect(page.getByRole("status")).toHaveText("Rate added.");

  // Mon–Thu, 3 nights at £200 + £60 placeholder cleaning = £660.
  const monday = month === "2027-11" ? "2027-11-08" : "2027-12-06";
  const thursday = month === "2027-11" ? "2027-11-11" : "2027-12-09";
  await page.goto(
    `/availability?checkIn=${monday}&checkOut=${thursday}&guests=2`,
  );
  await expect(
    page.getByRole("table", { name: "Price breakdown" }),
  ).toContainText("£660");
});

test("invalid admin input is rejected with a clear message", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/admin/settings");
  await page.getByLabel("Maximum guests").fill("0");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Maximum guests" }),
  ).toBeVisible();
});

test("calendar sync only accepts Airbnb links and explains the delay", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/admin/calendars");
  await expect(
    page.getByText(/can take a while to\s+appear here/),
  ).toBeVisible();
  await page
    .getByLabel("Airbnb export link")
    .fill("https://example.com/cal.ics");
  await page.getByRole("button", { name: "Add calendar" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Only Airbnb calendar links" }),
  ).toBeVisible();
});

test("admin pages have no automatically detectable WCAG A/AA violations", async ({
  page,
}) => {
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  await signIn(page);
  for (const path of [
    "/admin",
    "/admin/bookings",
    "/admin/calendar",
    "/admin/blocks",
    "/admin/pricing",
    "/admin/settings",
    "/admin/calendars",
    "/admin/account",
    "/admin/system",
    "/admin/login",
  ]) {
    await page.goto(path);
    await settleAnimations(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((v) => `${path} ${v.id}: ${v.help}`)).toEqual(
      [],
    );
  }
});
