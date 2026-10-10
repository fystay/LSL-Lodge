import { settleAnimations } from "./support";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
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
  const add = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Block dates" }) });
  await add.getByLabel("First night").fill(`${month}-06`);
  await add.getByLabel(/End date/).fill(`${month}-09`);
  await add.getByLabel("Reason (private)").fill(`Maintenance ${month}`);
  await add.getByRole("button", { name: "Block dates" }).click();
  await expect(page.getByRole("status")).toHaveText("Dates blocked.");

  // The owner can change a block's dates and label (audited).
  const row = () =>
    page.getByRole("listitem").filter({ hasText: `Maintenance ${month}` });
  await row().getByText("Change dates or label").click();
  await row().getByLabel("End date").fill(`${month}-10`);
  await row().getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Block updated.");

  // The calendar labels blocks distinctly from bookings, with the reason.
  await page.goto(`/admin/calendar?month=${month}`);
  await expect(page.getByRole("table")).toContainText(
    `Blocked: Maintenance ${month}`,
  );

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(
    `/availability?checkIn=${month}-07&checkOut=${month}-10&guests=2`,
  );
  await expect(
    guestPage.getByText(/isn’t available for all of those nights/),
  ).toBeVisible();

  // Unblocking needs explicit confirmation, then the dates are bookable.
  await page.goto("/admin/blocks");
  await row().getByLabel("Confirm").check();
  await row().getByRole("button", { name: "Unblock" }).click();
  await expect(page.getByRole("status")).toContainText("Block removed");
  await guestPage.reload();
  await expect(guestPage.getByText("Available for your dates")).toBeVisible();
  await guest.close();

  // Every change is in the audit history on the overview.
  await page.goto("/admin");
  for (const action of [
    "owner_block.created",
    "owner_block.updated",
    "owner_block.removed",
  ])
    await expect(page.getByText(action).first()).toBeVisible();
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
    // The sign-in page is checked as owners see it: signed out (signed-in
    // owners are sent straight to the dashboard).
    if (path === "/admin/login") await page.context().clearCookies();
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

test("admin pages don't scroll sideways on a phone; wide tables scroll in place", async ({
  page,
  isMobile,
}) => {
  // Phone emulation zooms out to fit wide pages, hiding the overflow; a
  // desktop browser narrowed to phone width measures it honestly.
  test.skip(isMobile, "measured in the desktop project at phone width");
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  for (const path of [
    "/admin",
    "/admin/bookings",
    "/admin/calendar",
    "/admin/blocks",
    "/admin/pricing",
    "/admin/settings",
    "/admin/calendars",
    "/admin/system",
  ]) {
    await page.goto(path);
    // Wait for the streamed content (e.g. the calendar table) to arrive.
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Loading…")).toHaveCount(0);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  // The calendar's own region still scrolls to show the whole month.
  await page.goto("/admin/calendar");
  const region = page.getByRole("region", { name: /Calendar/ });
  expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
});

test("the system page's problem list is accessible when something is wrong", async ({
  page,
}, info) => {
  // Regression: the health problems list carried role="alert" on its <ul>,
  // which strips list semantics from its <li> items (axe "listitem"). It
  // only renders while health reports a problem, so the general sweep
  // above caught it only intermittently. Force a problem deterministically.
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });
  const eventId = `evt_a11y_${info.project.name}_${Date.now()}`;
  try {
    await sql`
      INSERT INTO webhook_events (provider, provider_event_id, type, state)
      VALUES ('stripe', ${eventId}, 'checkout.session.completed', 'FAILED')`;
    await signIn(page);
    await page.goto("/admin/system");
    await settleAnimations(page);
    const alert = page.getByRole("alert").filter({
      hasText: "Some Stripe notifications failed to process",
    });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("listitem").first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  } finally {
    await sql`DELETE FROM webhook_events WHERE provider_event_id = ${eventId}`;
    await sql.end();
  }
});
