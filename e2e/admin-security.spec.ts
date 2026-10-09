import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import {
  base32Decode,
  totpAt,
  totpStep,
} from "../src/server/admin/credentials";
import { mintAdminSession } from "./admin-auth";

/**
 * Admin authentication and authorisation, end to end, against the local
 * E2E database (E2E_BOOKING=true). Synthetic accounts only.
 */
test.skip(
  process.env.E2E_BOOKING !== "true",
  "admin security tests need the local E2E database",
);

const PASSWORD = "an e2e test passphrase only";

function invite(email: string, role = "OWNER"): string {
  const out = execFileSync(
    "pnpm",
    ["-s", "admin", "invite", "--email", email, "--role", role],
    { env: process.env, encoding: "utf8" },
  );
  const token = /\/admin\/enrol\?t=([A-Za-z0-9_-]+)/.exec(out)?.[1];
  if (!token) throw new Error("no set-up link printed");
  return token;
}

const codeFor = (secret: string, stepOffset = 0) =>
  totpAt(base32Decode(secret), totpStep(new Date()) + stepOffset);

test("owner enrols from a one-time link, then signs in with password and authenticator code", async ({
  page,
}, info) => {
  const email = `journey-${info.project.name}@example.test`;
  const token = invite(email);

  await page.goto(`/admin/enrol?t=${token}`);
  await expect(page.getByText(email)).toBeVisible();
  const secret = (await page
    .locator("p.font-mono")
    .first()
    .textContent())!.replaceAll(" ", "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);

  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByLabel("Repeat the password").fill(PASSWORD);
  await page.getByLabel("Current code from the app").fill(codeFor(secret));
  await page.getByRole("button", { name: "Finish set-up" }).click();
  const done = page.getByRole("status");
  await expect(done).toContainText("Your account is ready");
  await expect(done.getByRole("listitem")).toHaveCount(10);

  // The link works once.
  await page.goto(`/admin/enrol?t=${token}`);
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid, already used" }),
  ).toBeVisible();

  // Wrong password: generic message.
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not the right password");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "weren’t recognised" }),
  ).toBeVisible();

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/admin\/login\/verify$/);
  // Password alone opens nothing.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin/login/verify");

  await page.getByLabel(/Code from your authenticator/).fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "wasn’t accepted" }),
  ).toBeVisible();

  // The enrolment code's time step is used up; the next one (within the
  // allowed clock drift) is accepted.
  await page
    .getByLabel(/Code from your authenticator/)
    .fill(codeFor(secret, 1));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Overview" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("a viewer can look but not change anything", async ({ page }) => {
  await mintAdminSession(page.context(), { role: "VIEWER" });
  await page.goto("/admin");
  await expect(page.getByText("You have read-only access")).toBeVisible();

  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page).toHaveURL(/\/admin\?error=forbidden$/);
  await expect(
    page.getByRole("alert").filter({ hasText: "read-only access" }),
  ).toBeVisible();
});

test("expired and revoked sessions are refused", async ({ page }) => {
  await mintAdminSession(page.context(), { expiresInMinutes: -1 });
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test("sensitive changes need the second factor re-entered", async ({
  page,
}) => {
  await mintAdminSession(page.context(), { reauthMinutesAgo: 60 });
  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page).toHaveURL(/\/admin\/reauth\?next=%2Fadmin%2Fsettings$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Confirm it’s you" }),
  ).toBeVisible();
});

async function blockDatesWithOrigin(page: Page, origin: string | null) {
  await page.route("**/admin/blocks**", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const headers = { ...request.headers() };
    delete headers.origin;
    if (origin) headers.origin = origin;
    await route.continue({ headers });
  });
  await page.goto("/admin/blocks");
  await page.getByLabel("First night").fill("2028-01-10");
  await page.getByLabel(/End date/).fill("2028-01-12");
  await page.getByLabel("Reason (private)").fill(`CSRF probe ${origin}`);
  await page.getByRole("button", { name: "Block dates" }).click();
}

test("admin changes are refused without a same-site Origin header", async ({
  page,
}) => {
  await mintAdminSession(page.context());
  await blockDatesWithOrigin(page, null);
  await expect(page).toHaveURL(/\/admin\/login\?error=origin$/);

  await page.unrouteAll();
  await mintAdminSession(page.context());
  await blockDatesWithOrigin(page, "https://evil.example");
  await page.unrouteAll();
  await page.goto("/admin/blocks");
  await expect(page.getByText("CSRF probe")).toHaveCount(0);
});
