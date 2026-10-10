import { expect, test, type Page } from "@playwright/test";

/**
 * Visual regression guard for the public site: full-page screenshots of
 * every public route, compared with baselines captured from the production
 * build (lsllodge.vercel.app; see docs/VISUAL-REGRESSION.md for how they are
 * made). A difference means the guest-facing UI changed and needs the
 * owner's approval.
 *
 * Opt-in (VISUAL_REGRESSION=true): screenshots depend on the browser build
 * and system fonts, so baselines are only comparable on the platform that
 * made them (Linux, the pinned Playwright Chromium). Runs with the booking
 * engine off, as production does.
 *
 * VISUAL_BASE_URL points the same checks at another deployment (for
 * example the live site) instead of the local server.
 */
test.skip(
  process.env.VISUAL_REGRESSION !== "true",
  "visual regression is opt-in (VISUAL_REGRESSION=true)",
);
test.skip(
  process.env.E2E_BOOKING === "true",
  "compares the public site as production serves it (booking engine off)",
);

test.use({ contextOptions: { reducedMotion: "reduce" } });

const ROUTES = [
  ["home", "/"],
  ["stay", "/stay"],
  ["location", "/location"],
  ["information", "/information"],
  ["contact", "/contact"],
  ["cancellation-policy", "/cancellation-policy"],
  ["terms", "/terms"],
  ["privacy", "/privacy"],
  ["availability", "/availability"],
  [
    "availability-search",
    "/availability?checkIn=2027-03-01&checkOut=2027-03-04&guests=2",
  ],
  ["book", "/book?checkIn=2027-03-01&checkOut=2027-03-04&guests=2"],
] as const;

async function settle(page: Page) {
  // Load lazy images (a full-page screenshot doesn't scroll), then wait for
  // every image and web font.
  await page.evaluate(() => {
    for (const img of document.querySelectorAll("img")) img.loading = "eager";
  });
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() =>
    [...document.images].every((img) => img.complete),
  );
  await page.evaluate(() => document.fonts.ready);
}

for (const [name, path] of ROUTES)
  test(`public page "${name}" matches production`, async ({ page }) => {
    const base = process.env.VISUAL_BASE_URL;
    await page.goto(base ? new URL(path, base).toString() : path);
    await settle(page);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      // Date fields default relative to today; everything else must match.
      mask: [page.locator('input[type="date"]')],
      maxDiffPixelRatio: 0.002,
    });
  });
