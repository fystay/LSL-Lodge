import type { Page } from "@playwright/test";

/**
 * Waits for time-based (entrance) animations to finish, so accessibility
 * checks measure the steady state rather than text mid-fade. Scroll-driven
 * animations are excluded: they never "finish" on their own.
 */
export async function settleAnimations(page: Page) {
  await page.evaluate(async () => {
    const timed = document
      .getAnimations()
      .filter(
        (a) =>
          a.timeline instanceof DocumentTimeline &&
          a.effect?.getComputedTiming().iterations !== Infinity,
      );
    await Promise.all(timed.map((a) => a.finished.catch(() => undefined)));
  });
}
