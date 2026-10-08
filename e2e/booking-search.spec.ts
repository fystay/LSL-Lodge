import { expect, test } from "@playwright/test";

function isoInDays(days: number) {
  // Property dates are Europe/London; tests stay well clear of midnight edges.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("a valid search shows the dates and says plainly that booking isn't open", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_BOOKING === "true",
    "covers the closed (no booking engine) configuration",
  );
  await page.goto("/");
  const form = page.getByRole("form", { name: "Search dates" });
  await form.getByLabel("Check-in").fill(isoInDays(30));
  await form.getByLabel("Check-out").fill(isoInDays(33));
  await form.getByLabel("Guests").selectOption("4");
  await form.getByRole("button", { name: "Check availability" }).click();

  await expect(page).toHaveURL(
    /\/availability\?checkIn=.*&checkOut=.*&guests=4/,
  );
  await expect(page.getByText("3 nights · 4 guests")).toBeVisible();
  await expect(page.getByText("Online booking isn’t open yet.")).toBeVisible();
  await expect(page.getByText(/nothing has\s+been reserved/)).toBeVisible();
});

test("the server rejects invalid searches with field-level errors", async ({
  page,
}) => {
  await page.goto(
    `/availability?checkIn=${isoInDays(10)}&checkOut=${isoInDays(9)}&guests=9`,
  );
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Please check your search" });
  await expect(alert).toContainText("Check-out must be after check-in.");
  await expect(alert).toContainText("The lodge sleeps up to 6.");
  await expect(page.getByLabel("Check-out")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("the minimum stay is enforced server-side", async ({ page }) => {
  await page.goto(
    `/availability?checkIn=${isoInDays(10)}&checkOut=${isoInDays(11)}&guests=2`,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "minimum stay is 2 nights" }),
  ).toBeVisible();
});

test("past dates are rejected", async ({ page }) => {
  await page.goto(
    `/availability?checkIn=2020-01-01&checkOut=2020-01-04&guests=2`,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "can’t be in the past" }),
  ).toBeVisible();
});
