import AxeBuilder from "@axe-core/playwright";
import { settleAnimations } from "./support";
import { expect, test } from "@playwright/test";

const publicPages = [
  { path: "/", heading: /Slow mornings/ },
  { path: "/stay", heading: "A lodge to settle into" },
  { path: "/availability", heading: "Availability" },
  { path: "/location", heading: "Finding the lodge" },
  { path: "/information", heading: "Guest information" },
  { path: "/cancellation-policy", heading: "Cancellation policy" },
  { path: "/privacy", heading: "Privacy notice" },
  { path: "/terms", heading: "Booking terms" },
  { path: "/contact", heading: "Talk to the owner" },
  { path: "/booking/confirmation", heading: "Booking status" },
];

for (const { path, heading } of publicPages) {
  test(`${path} renders, has one h1 and no automatically detectable WCAG A/AA violations`, async ({
    page,
  }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expect(page.getByRole("main")).toBeVisible();

    await settleAnimations(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
    ).toEqual([]);
  });
}

test("the page has no horizontal scroll", async ({ page }) => {
  for (const { path } of publicPages) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("unknown pages return 404", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /couldn.t find/,
  );
});

test("security headers are sent", async ({ request }) => {
  const response = await request.get("/");
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("pre-launch: robots.txt disallows everything and pages are noindex", async ({
  page,
  request,
}) => {
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toMatch(/Disallow: \/\s*$/m);
  await page.goto("/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/,
  );
});

test("unconfirmed facts are visibly marked", async ({ page }) => {
  await page.goto("/stay");
  await expect(page.getByText("To be confirmed").first()).toBeVisible();
  await expect(page.getByRole("note")).toContainText(
    "online booking is not open yet",
  );
});

test("every photograph has a meaningful description", async ({ page }) => {
  for (const path of ["/", "/stay", "/location"]) {
    await page.goto(path);
    const images = page.locator("main img");
    const count = await images.count();
    expect(count, path).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const img = images.nth(i);
      // Inactive carousel slides are hidden from assistive tech and carry alt="".
      const hidden = await img.evaluate(
        (el) => el.closest("[aria-hidden='true']") !== null,
      );
      if (!hidden)
        expect(
          (await img.getAttribute("alt"))?.length ?? 0,
          path,
        ).toBeGreaterThan(20);
    }
  }
});
