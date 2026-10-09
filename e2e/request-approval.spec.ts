import { settleAnimations } from "./support";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Host-approval journey across two browsers: a guest sends a request, the
 * owner approves or declines it in /admin, and the guest's page reflects the
 * server-side state. No payment is taken: the CI preview has no Stripe keys,
 * and the guest is told plainly that payment isn't switched on.
 *
 * Needs E2E_BOOKING=true, a seeded local database, and ADMIN_AUTH_MODE=local.
 */
test.skip(
  process.env.E2E_BOOKING !== "true",
  "request journey needs a seeded local database",
);
test.describe.configure({ mode: "serial" });

const email = process.env.E2E_ADMIN_EMAIL ?? "owner@example.test";
const password = process.env.ADMIN_LOCAL_PASSWORD ?? "";

// Each project uses its own weeks (they share one database). Mon → Thu.
const weeks = {
  desktop: {
    approve: ["2027-04-05", "2027-04-08"],
    decline: ["2027-04-12", "2027-04-15"],
  },
  mobile: {
    approve: ["2027-04-19", "2027-04-22"],
    decline: ["2027-04-26", "2027-04-29"],
  },
} as const;

async function sendRequest(page: Page, [checkIn, checkOut]: readonly string[]) {
  await page.goto(`/book?checkIn=${checkIn}&checkOut=${checkOut}&guests=2`);
  await page.getByLabel("Lead guest name").fill("Request Guest");
  await page.getByLabel("Email address").fill("request@example.test");
  await page.getByLabel(/I have read the/).check();
  await page.getByRole("button", { name: "Send booking request" }).click();
  await expect(page).toHaveURL(/\/book\/LL-[A-Z0-9]{6}$/);
  return page.url().split("/").at(-1)!;
}

async function ownerOpens(browser: Browser, ref: string) {
  const context = await browser.newContext();
  const owner = await context.newPage();
  await owner.goto("/admin/login");
  await owner.getByLabel("Email").fill(email);
  await owner.getByLabel("Password").fill(password);
  await owner.getByRole("button", { name: "Sign in" }).click();
  const requests = owner.getByRole("region", {
    name: "Requests awaiting your decision",
  });
  await requests.getByRole("link", { name: ref }).click();
  await expect(
    owner.getByRole("heading", { name: `Booking ${ref}` }),
  ).toBeVisible();
  return { owner, context };
}

test("owner approves a request; the guest is asked to pay, not told it's confirmed", async ({
  page,
  browser,
}, info) => {
  const stay = weeks[info.project.name as keyof typeof weeks].approve;
  const ref = await sendRequest(page, stay);

  const { owner, context } = await ownerOpens(browser, ref);
  await expect(
    owner.getByText("The guest has not been charged."),
  ).toBeVisible();
  await owner.getByRole("button", { name: "Approve request" }).click();
  await expect(owner.getByRole("status")).toContainText("Approved.");
  // Scoped: Next keeps the previous (overview) route mounted but hidden.
  await expect(
    owner
      .getByRole("region", { name: "Stay" })
      .getByText("Approved (awaiting payment)"),
  ).toBeVisible();
  await settleAnimations(owner);
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const scan = await new AxeBuilder({ page: owner })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await context.close();

  await page.reload();
  const status = page.getByRole("status").first();
  await expect(status).toContainText("Approved: awaiting your payment");
  await expect(status).toContainText("not confirmed");
  await expect(status).not.toContainText("Confirmed");
  await expect(
    page.getByText("Online payment isn’t switched on in this preview"),
  ).toBeVisible();
});

test("owner declines a request; the dates are released and nothing is owed", async ({
  page,
  browser,
}, info) => {
  const stay = weeks[info.project.name as keyof typeof weeks].decline;
  const ref = await sendRequest(page, stay);

  const { owner, context } = await ownerOpens(browser, ref);
  // Declining needs explicit confirmation.
  await owner.getByRole("button", { name: "Decline request" }).click();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Tick the box" }),
  ).toBeVisible();
  await owner.getByLabel("Yes, decline this request").check();
  await owner.getByRole("button", { name: "Decline request" }).click();
  await expect(owner.getByRole("status")).toContainText("Declined.");
  await context.close();

  await page.reload();
  await expect(page.getByRole("status").first()).toContainText(
    "Request declined",
  );
  await expect(page.getByText("Nothing was charged")).toBeVisible();

  // The dates are bookable again.
  await page.goto(
    `/availability?checkIn=${stay[0]}&checkOut=${stay[1]}&guests=2`,
  );
  await expect(page.getByText("Available for your dates")).toBeVisible();
});
