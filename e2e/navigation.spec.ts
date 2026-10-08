import { expect, test } from "@playwright/test";

test("skip link moves focus to the main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("mobile menu opens, is keyboard operable and closes with Escape", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile layout only");
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Menu" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("navigation", { name: "Main" });
  await expect(menu.getByRole("link", { name: "Location" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  await toggle.click();
  await menu.getByRole("link", { name: "Location" }).click();
  await expect(page).toHaveURL(/\/location$/);
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("desktop navigation reaches every primary page", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop layout only");
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const [name, path] of [
    ["The Lodge", "/stay"],
    ["Location", "/location"],
    ["Information", "/information"],
    ["Contact", "/contact"],
  ] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
});

test("gallery viewer opens from the keyboard, steps through photos and restores focus", async ({
  page,
}) => {
  await page.goto("/stay");
  const first = page.getByRole("button", { name: "View all 21 photos" });
  await first.focus();
  await page.keyboard.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Photo viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("1 of 21");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("2 of 21");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(first).toBeFocused();
});

test("contact form validates on the server and admits it cannot send yet", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter your name." }),
  ).toBeVisible();

  await page.getByLabel("Your name").fill("Test Visitor");
  await page.getByLabel("Email address").fill("visitor@example.test");
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Is the lodge available at Easter?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "has not been sent" }),
  ).toBeVisible();
  // What the visitor typed is preserved.
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Is the lodge available at Easter?",
  );
});

test("gallery opens at the photo that was clicked", async ({ page }) => {
  await page.goto("/stay");
  await page.getByRole("button", { name: "View Twin bedroom larger" }).click();
  const viewer = page.getByRole("dialog", { name: "Photo viewer" });
  await expect(viewer).toContainText("Twin bedroom");
  await expect(viewer.getByRole("img")).toHaveAttribute(
    "alt",
    /Twin bedroom with two single beds/,
  );
});

test("hero slideshow can be paused and stepped with keyboard controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const carousel = page.getByRole("group", {
    name: "Photographs of the lodge",
  });
  await expect(carousel).toContainText("The lodge from across the water");
  // Controls are hidden until focused; they still exist for keyboard users.
  const pause = carousel.getByRole("button", { name: "Pause slideshow" });
  await pause.focus();
  await page.keyboard.press("Enter");
  await expect(
    carousel.getByRole("button", { name: "Play slideshow" }),
  ).toBeVisible();
  await carousel.getByRole("button", { name: "Next photo" }).click();
  await expect(carousel).toContainText("Photo 2 of 4");
  await expect(carousel).toContainText("Living and dining");
});

test("hero slideshow never autoplays for visitors who prefer reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const carousel = page.getByRole("group", {
    name: "Photographs of the lodge",
  });
  await expect(carousel.getByRole("button", { name: /slideshow/ })).toHaveCount(
    0,
  );
  await page.waitForTimeout(7_500);
  await expect(carousel).toContainText("Photo 1 of 4");
});

test("photo viewer moves by swiping, and the counter follows", async ({
  page,
}) => {
  await page.goto("/stay");
  await page.getByRole("button", { name: "View all 21 photos" }).click();
  const viewer = page.getByRole("dialog", { name: "Photo viewer" });
  await expect(viewer).toContainText("1 of 21");
  // A swipe is a horizontal scroll of the snap track.
  await viewer
    .locator(".snap-x")
    .evaluate((track) =>
      track.scrollBy({ left: track.clientWidth, behavior: "instant" }),
    );
  await expect(viewer).toContainText("2 of 21");
});

test("arrow buttons appear only for mouse users; touch users swipe", async ({
  page,
  isMobile,
}) => {
  await page.goto("/stay");
  await page.getByRole("button", { name: "View all 21 photos" }).click();
  const next = page.getByRole("button", { name: "Next photo" });
  if (isMobile) {
    await expect(next).toBeHidden();
    await expect(page.getByText("Swipe for more")).toBeVisible();
  } else {
    await expect(next).toBeVisible();
    await next.click();
    await expect(
      page.getByRole("dialog", { name: "Photo viewer" }),
    ).toContainText("2 of 21");
  }
});

test("section links underline the section you are in", async ({ page }) => {
  await page.goto("/stay");
  const nav = page.getByRole("navigation", { name: "On this page" });
  await nav.getByRole("link", { name: "Bedrooms" }).click();
  await expect(nav.getByRole("link", { name: "Bedrooms" })).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expect(nav.locator('[aria-current="location"]')).toHaveCount(1);

  // Scrolling (not clicking) moves the marker too.
  await page.locator("#outside").scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    window.scrollTo({
      top: document.getElementById("outside")!.offsetTop - 150,
      behavior: "instant",
    }),
  );
  await expect(nav.getByRole("link", { name: "Outside" })).toHaveAttribute(
    "aria-current",
    "location",
  );
});

test("the last section is underlined at the bottom of the page", async ({
  page,
}) => {
  await page.goto("/stay");
  const nav = page.getByRole("navigation", { name: "On this page" });
  await nav.getByRole("link", { name: "Details" }).click();
  await page.waitForTimeout(1_300);
  await expect(nav.getByRole("link", { name: "Details" })).toHaveAttribute(
    "aria-current",
    "location",
  );
});
