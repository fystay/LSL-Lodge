/**
 * Sets up the Lodge's Stripe TEST-MODE webhook endpoint for a staging
 * deployment. Run by the operator on their own machine, never in CI.
 *
 *   STRIPE_SECRET_KEY=sk_test_… STAGING_URL=https://… \
 *   [VERCEL_AUTOMATION_BYPASS_SECRET=…] \
 *     pnpm stripe:test-setup --account acct_… [--apply] [--secret-file path]
 *
 * Without --apply it only reports what it would do.
 *
 * Safety:
 * - Test keys only (sk_test_ / rk_test_). Live keys are refused.
 * - --account must name the account the key belongs to, so the key of an
 *   unrelated Stripe account or sandbox can't be used by mistake.
 * - Refuses if the account already has webhook endpoints for other hosts
 *   (a sign that it is shared with another app) unless
 *   --allow-other-endpoints is passed.
 * - Idempotent: an existing endpoint for the same URL is updated, not
 *   duplicated. Nothing is ever deleted.
 * - The signing secret is shown once, by Stripe, when the endpoint is
 *   created. It is printed only to an interactive terminal, or written to
 *   --secret-file (mode 600). Never paste it into chat, code or docs; put it
 *   in the host's secret manager as STRIPE_WEBHOOK_SECRET.
 */
import { writeFileSync } from "node:fs";
import Stripe from "stripe";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

/** Events the webhook handler acts on (src/server/payments/webhook.ts). */
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
];
/** The API version the app's Stripe SDK (stripe@23) is built for. */
const API_VERSION = "2026-09-30.endive";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_test_/.test(key))
  fail("Refusing: STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_…).");
const expectedAccount = option("--account");
if (!expectedAccount?.startsWith("acct_"))
  fail("Pass --account acct_… (the Lodge's own Stripe sandbox account).");
const base = process.env.STAGING_URL ?? "";
let endpointUrl = "";
try {
  const u = new URL(base);
  if (u.protocol !== "https:") throw new Error();
  const endpoint = new URL("/api/webhooks/stripe", u.origin);
  // A Vercel preview behind Deployment Protection only lets Stripe through
  // with the automation-bypass secret in the URL (Vercel's documented query
  // parameter). It is masked in everything this script prints.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) endpoint.searchParams.set("x-vercel-protection-bypass", bypass);
  endpointUrl = endpoint.toString();
} catch {
  fail("Set STAGING_URL to the staging site's https:// address.");
}
const apply = flag("--apply");
const secretFile = option("--secret-file");

const stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 15_000 });

const account = await stripe.accounts.retrieveCurrent();
if (account.id !== expectedAccount)
  fail(
    `Refusing: this key belongs to ${account.id}, not ${expectedAccount}. Use the Lodge's own sandbox key.`,
  );
console.log(
  `Account ${account.id} (${account.settings?.dashboard?.display_name ?? "unnamed"}), test mode.`,
);

const endpoints = await stripe.webhookEndpoints
  .list({ limit: 100 })
  .autoPagingToArray({ limit: 1000 });
const host = new URL(endpointUrl).host;
const shown = (url: string) =>
  url.replace(/(x-vercel-protection-bypass=)[^&]+/, "$1***");
const others = endpoints.filter((e) => new URL(e.url).host !== host);
if (others.length > 0 && !flag("--allow-other-endpoints"))
  fail(
    `Refusing: this account already sends webhooks to ${others.length} other host(s) (${[...new Set(others.map((e) => new URL(e.url).host))].join(", ")}). It may belong to another app. Use a dedicated Lodge sandbox, or pass --allow-other-endpoints if you are sure.`,
  );

const path = (url: string) => {
  const u = new URL(url);
  return u.host + u.pathname;
};
const existing = endpoints.find((e) => path(e.url) === path(endpointUrl));
const metadata = { app: "lodge-on-the-lake", environment: "staging" };

if (existing) {
  const missing = EVENTS.filter((e) => !existing.enabled_events.includes(e));
  console.log(
    `Endpoint exists: ${existing.id} → ${shown(existing.url)} (status ${existing.status}, API ${existing.api_version ?? "account default"}).`,
  );
  if (existing.api_version && existing.api_version !== API_VERSION)
    console.warn(
      `Warning: endpoint API version is ${existing.api_version}; the app expects ${API_VERSION}. Stripe can't change it on an existing endpoint: create a new one in the Dashboard and retire this one.`,
    );
  if (
    missing.length === 0 &&
    existing.status === "enabled" &&
    existing.url === endpointUrl
  ) {
    console.log("Nothing to change.");
  } else if (!apply) {
    console.log(
      `Would enable it with events: ${EVENTS.join(", ")}. Re-run with --apply.`,
    );
  } else {
    await stripe.webhookEndpoints.update(existing.id, {
      url: endpointUrl,
      enabled_events: [
        ...new Set([...existing.enabled_events, ...EVENTS]),
      ] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
      disabled: false,
      metadata,
    });
    console.log("Endpoint updated.");
  }
  console.log(
    "Its signing secret was shown when it was created. If you no longer have it, roll it in the Stripe Dashboard (Developers → Webhooks).",
  );
} else if (!apply) {
  console.log(
    `Would create ${shown(endpointUrl)} (API ${API_VERSION}) for: ${EVENTS.join(", ")}. Re-run with --apply.`,
  );
} else {
  const created = await stripe.webhookEndpoints.create({
    url: endpointUrl,
    api_version: API_VERSION as Stripe.WebhookEndpointCreateParams.ApiVersion,
    enabled_events: EVENTS,
    description: "Lodge on the Lake staging (test mode)",
    metadata,
  });
  console.log(`Created ${created.id} → ${shown(created.url)}.`);
  if (secretFile) {
    writeFileSync(secretFile, `${created.secret}\n`, { mode: 0o600 });
    console.log(
      `Signing secret written to ${secretFile} (mode 600). Put it in the host's secret manager as STRIPE_WEBHOOK_SECRET, then delete the file.`,
    );
  } else if (process.stdout.isTTY) {
    console.log(
      `Signing secret (shown once; store it as STRIPE_WEBHOOK_SECRET in the host's secret manager, nowhere else):\n${created.secret}`,
    );
  } else {
    console.log(
      "Not printing the signing secret: output isn't a terminal. Roll it in the Stripe Dashboard, or re-run on a fresh endpoint with --secret-file.",
    );
  }
}
