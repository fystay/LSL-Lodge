# Security and privacy notes

## In place (Phases 0–2)

- **Headers** (`next.config.ts`): CSP, `X-Frame-Options: DENY` /
  `frame-ancestors 'none'`, `nosniff`, a strict referrer policy, a restrictive
  Permissions-Policy, COOP, HSTS in production, and no `X-Powered-By`.
- **CSP** allows `'unsafe-inline'` scripts because nonces would force every
  page to render dynamically. Payments use a redirect to Stripe-hosted
  Checkout, so no third-party scripts or frames are allowed. Revisit with
  Next's SRI (hash-based) support before launch.
- **Input validation**: zod schemas on the server for search and enquiry
  input; values echoed back are length-bounded; the enquiry form has a
  honeypot.
- **Secrets**: only `.env.example` (no values) is committed. Server env
  access goes through `src/server/env.ts`, which reports variable names only,
  never values. Nothing secret uses `NEXT_PUBLIC_`.
- **Live payments guard**: `sk_live_` keys are rejected unless
  `STRIPE_LIVE_MODE_APPROVED=true`.
- **Credential encryption**: AES-256-GCM (Node crypto) with a random IV,
  record-bound associated data, and key versioning for rotation
  (`src/server/crypto/credentials.ts`). The key comes from the platform
  secret manager.
- **SSRF protection** for owner-supplied feed URLs
  (`src/server/calendar/safe-fetch.ts`): https and port 443 only, no
  credentials in URLs, no IP literals, optional host allowlist (Airbnb), and
  every resolved address must be public. The check runs inside the socket's
  DNS lookup, so there is no DNS-rebinding gap. Redirects are re-validated,
  with timeout and size caps. Errors are codes only: URLs never appear in
  errors or logs.
- **Data minimisation**: imported calendar events keep UID, dates, status and
  a hash only. Notification jobs reference the reservation rather than copying
  email addresses. Audit metadata must not contain PII.
- **Database integrity**: exclusion constraint, transition and immutability
  triggers, and check constraints (see docs/PLAN.md §2).
- **Indexing**: the whole site is `noindex` with `robots.txt` set to disallow
  until `SITE_INDEXABLE=true`. Availability and booking routes are always
  `noindex`.

### Added in Phase 2

- **Admin**: see "Admin authentication" below (replaced the Phase 2
  local-only shared password in October 2026).
- **Guest booking access**: a 256-bit random token per booking, stored only as
  a SHA-256 hash, in an httpOnly cookie scoped to `/book/<reference>`. A wrong
  or missing token shows the same not-found page as an unknown reference.
- **Server-authoritative booking**: holds are priced and checked inside a
  locked transaction. Client-submitted prices are ignored (tested).
  Idempotency keys make double submissions safe.
- **Job endpoints** need `Authorization: Bearer $CRON_SECRET` (32+
  characters), compared in constant time, and fail closed when unset.
- **Admin search** escapes `LIKE` wildcards; listings are capped at 50 rows.
- **Seed script** refuses any non-local database host.

### Added with the booking backend

- **Rate limiting** (Postgres-backed, `src/server/security/rate-limit.ts`):
  new bookings (holds) 5 per hour per client IP and 3 per day per guest
  email (a hold blocks dates for 30 minutes, so this limits
  calendar-hogging); payment
  starts 10 per hour per booking; admin sign-in 10 per 15 minutes per IP;
  enquiries 5 per hour per IP. Subjects are stored only as hashes and pruned
  after two days. `RATE_LIMIT_SCALE` multiplies limits for E2E runs only.
  Behind a proxy that doesn't set `X-Forwarded-For`, all clients share one
  bucket (fails safe).
- **Stripe webhook**: raw-body signature verification; event IDs recorded in
  the same transaction as their effect (unique per provider, row-locked), so
  duplicates and concurrent deliveries apply once; failures recorded with a
  code and answered 500 so Stripe retries. Logs carry event ID and type only.
- **Payment integrity**: amounts come from the stored schedule; a session is
  applied only if it is recorded against the same reservation and payment
  (metadata and `client_reference_id`), paid, and matches amount and
  currency. Card data never reaches the site (Stripe-hosted Checkout). The
  pay action redirects only to `https://checkout.stripe.com/`.
- **Guest email links**: `g1.<expiry>.<HMAC>` over reference and ID under
  `GUEST_LINK_SECRET`, valid 90 days, compared in constant time. The access
  route moves the token into the booking's httpOnly cookie and redirects, so
  it doesn't stay in the address bar. Admin previews redact it.
- **Owner-only data**: owner notes, review reasons and guest contact details
  are shown only in admin. Owner emails carry no guest contact details.
- **Calendar export feed**: HMAC token compared in constant time; same 404
  for disabled, unknown or wrong; "Not available" events only; `noindex`.
- **Admin actions** (blocks, cancellations, refunds, calendar sync) all call
  `requireAdmin()` and are scoped to the property (a source or booking from
  another property is "unknown").
- **Live Stripe and real email** each need their own explicit environment
  approval flag (`STRIPE_LIVE_MODE_APPROVED`, `EMAIL_LIVE_DELIVERY_APPROVED`).
  Instant booking itself is the owner-chosen model (October 2026); public
  bookings stay off in production until launch (`BOOKING_PREVIEW` is ignored
  there).

## Admin authentication

Implemented in `src/server/admin/{credentials,accounts,auth}.ts`, using only
Node's crypto. Supabase Auth was the original plan; app-managed accounts were
built instead because no dedicated Supabase project exists yet and this
design needs nothing beyond the database. Switching later remains possible.

- **Accounts** are created only from the CLI (`pnpm admin invite --email …`),
  which prints a one-time, 24-hour set-up link. The person sets their own
  password (scrypt, N=2^15, min 12 characters) and enrols an authenticator
  app (TOTP, RFC 6238, verified against the RFC's test vectors) and receives
  10 single-use recovery codes. No default or environment-variable
  credentials exist. `reset` revokes everything and issues a new link;
  `disable` blocks sign-in and signs the person out everywhere.
- **Sign-in** is password, then authenticator code (or recovery code). A
  password-only session opens nothing and lasts 10 minutes. On success the
  session token is replaced. Codes can't be replayed (last used time step
  is stored; updated conditionally so concurrent attempts can't both win).
- **Sessions** are random tokens stored as SHA-256 hashes, in an httpOnly,
  SameSite=Strict cookie (`__Host-` and Secure in production). Idle timeout
  30 minutes, absolute limit 8 hours, revocable ("Sign out everywhere"), and
  invalid once the account is disabled or reset.
- **Authorisation**: every admin page requires the `view` permission and
  every admin server action `manage` (OWNER only; VIEWER is read-only).
  Refusals are audit-logged. The role comes only from the database record.
- **Step-up**: pricing, payment plan, settings, adding calendar links and
  releasing held calendar removals require the second factor within the
  last 15 minutes.
- **CSRF**: Next.js rejects a server action whose Origin differs from the
  host but allows requests without an Origin; admin actions and sign-in
  additionally require a matching Origin. An E2E test proves a request
  without Origin was accepted before this check and is refused with it.
- **Brute force**: 10 attempts per IP per 15 minutes across sign-in steps;
  per-account lockout after 5 failures (password or code), 15 minutes
  doubling to 24 hours. Unknown emails take the same time as wrong
  passwords, and every message is the same generic one.
- **Audit**: enrolment issued/completed, sign-in success and failure,
  lockout, recovery-code use, step-up, sign-out, revocation, disable/enable,
  and forbidden attempts.
- **Requires** `DATABASE_URL` and `CREDENTIALS_ENCRYPTION_KEY`; without them
  the admin area shows that sign-in isn't set up.

Not yet done: a WebAuthn/passkey option, an in-dashboard user management
page (CLI only for now), and email notification of new sign-ins.

## Refunds, cancellations and operations

- Refunds are created only on the server, in three cases: (1) a guest
  cancels strictly before their stored `free_cancellation_until`
  (`confirmed_at` + 24 h, where `confirmed_at` is the server's time of
  verified payment; both set once and then immutable in the database), which queues a full
  refund in the same transaction as the cancellation; (2) money that isn't
  owed for any stay (a duplicate payment, or a payment landing on a
  cancelled or re-sold booking) is refunded in full automatically; (3) the
  owner refunds an amount of their choosing (OWNER role, fresh second
  factor, explicit confirmation). Every refund is capped at what remains
  refundable on a verified charge, sent with a fixed Stripe idempotency key
  (retries can't double-refund), audit-logged, and tracked forward-only from
  Stripe's response and `refund.*` webhooks. A refund is shown as refunded
  only once Stripe reports it `succeeded`. Failed sends retry with backoff
  (`process-refunds` job) and after 6 attempts alert the owner.
- Guests cancel only through their booking cookie credential (rate-limited);
  refund eligibility is decided from the server's receipt time, never from
  the browser. After the deadline a cancellation needs an explicit "no
  refund" acknowledgement.
- Job endpoints need `CRON_SECRET`; the health endpoint needs a separate
  read-only `HEALTHCHECK_SECRET`. Run records and alerts carry counts and
  codes only.
- Row Level Security is on for every table, and Supabase's Data API roles
  have no table privileges (tested with stand-in roles).

## Required before accepting bookings

- CSRF: server actions are POST-only with Origin checks by Next.js. The custom
  route handlers are the Stripe webhook (signature-verified), the job routes
  (bearer secret), the read-only export feed, and the email-link route, whose
  only effect is setting a cookie scoped to the booking the link is valid for.
- Run the payment flow end to end against a Stripe sandbox, and email
  against Resend's sandbox, before launch (not yet possible: no keys).
- Data retention: decide how long declined, expired and past bookings keep
  guest names and emails, then add a purge job.
- Error monitoring with PII scrubbing; structured logs with correlation IDs.
- Backups: enable Supabase PITR; document and test restoration.
- Dependency scanning (CI runs `pnpm audit --prod`; enable Dependabot).
- Incident-response checklist and a security contact.
- Retention schedule and deletion procedure for guest data; legal review of
  the privacy notice.

## Key rotation

1. Generate a new 32-byte key and add it with the next version number.
2. Deploy with both keys available for decryption and the new version used
   for encryption.
3. Re-encrypt stored credentials (a job will do this in Phase 4).
4. Remove the old key.

If a key or secret is exposed, rotate it immediately at the provider (Stripe,
Google, email), revoke OAuth grants, and re-enter the Airbnb feed after
resetting its URL in Airbnb if possible.
