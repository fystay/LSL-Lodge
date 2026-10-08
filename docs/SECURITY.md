# Security and privacy notes

## In place (Phases 0–1)

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

## Required before accepting bookings

- Rate limiting on booking, contact, login, payment and webhook endpoints
  (e.g. Upstash/Vercel KV or a Postgres-backed limiter).
- Admin auth with MFA and server-side role checks on every route and action;
  re-authentication for sensitive actions.
- CSRF: server actions are POST-only with Origin checks by Next.js; any custom
  route handlers that change state must verify Origin too.
- Webhook endpoint: raw-body signature verification (prototype done) and
  idempotent persistence.
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
