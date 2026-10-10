# Integrations: capabilities, limits and failure modes

## Airbnb (iCal)

**What iCal can do:** Airbnb publishes an export URL listing blocked and
reserved dates for a listing, and can import external iCal URLs to block dates
on Airbnb.

**What it cannot do:**

- It is not real-time. Airbnb refreshes its export and re-reads imported
  calendars on its own schedule. Our polling interval (target 5–15 minutes)
  only bounds _our_ side of the delay.
- It carries dates and an opaque UID, not reliable guest, price or status
  details. Event summaries such as "Reserved" or "Not available" should not be
  interpreted.
- It cannot confirm that Airbnb has received and applied our export.

**Consequence:** for a period after a booking on either channel, the other
channel may still show the dates as free. The site reduces this window
(frequent polling, manual "Sync now", short holds, a final conflict check
before confirmation) and makes it visible (sync health, stale warnings,
conflict queue). It cannot eliminate it. **We never advertise instant Airbnb
sync.**

**If a double booking happens:** the conflict appears in admin with both
sources. Follow the runbook (Phase 5): contact the guest, then rebook or
refund according to the cancellation policy. Do not delete either record.

**Feed safety:** the export URL is a secret. It is encrypted at rest, never
sent to the browser or logged, and fetched only through `fetchFeed` with SSRF
protections (see SECURITY.md).

**Failure handling:** if a refresh fails, the last known good blocks remain.
After `staleAfterMinutes` without success the source shows as stale and the
owner is alerted. A sudden empty feed does not release booked dates without
owner confirmation.

## Google Calendar

Scopes (verified against Google's Calendar API scope list, October 2026):

| Scope                                                      | Use                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `https://www.googleapis.com/auth/calendar.app.created`     | Create and manage the site's own secondary calendar and its events. Cannot touch other calendars. |
| `https://www.googleapis.com/auth/calendar.events.freebusy` | Read busy/free times on calendars the owner selects. No event content.                            |

Busy periods from free/busy are converted to blocked property-local nights
using the same conservative rule as iCal timed events (any part of a day
blocks that night). Free/busy has no incremental sync token, so selected
calendars are polled over the booking horizon. Change notifications (push)
are not available for free/busy, and in any case notifications can be
missed, so polling plus periodic reconciliation is the mechanism.

Google may require OAuth app verification for these scopes before
non-test users can connect. For a single owner account, the app can stay in
"testing" with the owner as a test user, but refresh tokens then expire
after 7 days. Budget time for verification or plan for reconnects. This must
be confirmed when the Google Cloud project is set up.

## Channel manager (if required)

If the owner needs dependable two-way, near-real-time sync, evaluate a
channel manager with an official Airbnb API connection before Phase 4.
Document for the chosen provider: integration method, webhooks, sync
guarantees, cost, permissions, cancellation behaviour, test environment and
failure modes. It is integrated behind a provider adapter so the booking
domain doesn't depend on one vendor. No provider has been chosen.

## Airbnb: what is implemented

- **Import** (`src/server/calendar/sync.ts`, `/admin/calendars`,
  `/api/jobs/sync-calendars`): the owner pastes the Airbnb export link in
  admin. It must be an `https` (or `webcal`) link on airbnb.com or
  airbnb.co.uk, and is stored only encrypted. The job polls due sources with
  ETag/Last-Modified, then schedules the next poll at a quarter of the stale
  window (15 minutes by default), with exponential backoff (up to 6 hours)
  after failures. "Sync now" runs it immediately.
- **Health**: working / failing / out of date (no success within 60 minutes),
  last success, last attempt, imported period count, failure count and a
  plain-language error. After 3 consecutive failures the owner gets one alert
  per outage.
- **Safety stop when data is stale (default since 10 October 2026).** An
  enabled import that has never synced, or has had no success within its
  stale window (60 minutes by default), means Airbnb bookings may be
  missing. While that is true: no new holds are taken (the guest sees the
  form's existing "Online booking isn't available right now"), Checkout
  isn't started, and a payment that arrives goes to the owner for review
  (`CALENDAR_STALE`) instead of confirming. The dates stay held and the
  money recorded; the owner checks Airbnb and confirms or cancels and
  refunds. One failed poll with a recent success doesn't trigger it.
  Existing confirmed bookings are never changed. Code:
  `staleImportSources` in `src/server/calendar/sync.ts`; tests in
  `holds.integration.test.ts` and `payments.integration.test.ts`. With no
  Airbnb source configured there is nothing to check, so connecting the
  Airbnb feed is a launch blocker.
- **Clashes after confirmation**: an Airbnb booking that appears over a
  confirmed website booking is listed under "Clashes to resolve" and
  alerted; neither record is changed.
- **Export** (`/calendar/<token>.ics`): website bookings, live holds and
  owner blocks as "Not available". Imported periods are never exported, so
  Airbnb and the site can't echo each other. The token is an HMAC under
  `CALENDAR_EXPORT_SECRET`; changing the secret revokes the link.

### Race windows that remain (iCal cannot close them)

| Window                                                                           | What protects it                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An Airbnb booking exists, but its export hasn't updated or we haven't polled yet | Checkout and payment both re-check imported periods; a clash found then goes to owner review, not confirmation. A clash Airbnb reveals only later is alerted. Stale sync is shown to guests and the owner. |
| A website hold or booking exists, but Airbnb hasn't read our export yet          | Holds and bookings are exported immediately; Airbnb's read delay is outside our control.                                                                                                                   |
| Airbnb booking imported after a website booking was paid                         | Listed under "Clashes to resolve" and alerted. Neither record changes; the owner contacts a guest.                                                                                                         |
| Airbnb's feed empties by mistake                                                 | Removals are held until the owner confirms them.                                                                                                                                                           |

## Stripe

Hosted Checkout, server-created sessions, webhook-driven state. Test mode
only; `sk_live_` keys are refused unless `STRIPE_LIVE_MODE_APPROVED=true`.
Lifecycle: docs/PLAN.md §3.

- **Events handled** at `/api/webhooks/stripe`:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`. Others
  are acknowledged and recorded as ignored.
- **Payment methods**: `allowed_payment_method_types: ["card"]` (wallets are
  card payments), so a payment can't still be settling when the dates' hold
  ends. Asynchronous events are still handled defensively.
- **Session expiry**: never later than the reservation's hold. Stripe needs at
  least 30 minutes, so a payment started near the deadline extends the hold
  to cover the session (by at most about 30 minutes).
- **Return page**: re-fetches the session from Stripe server-side; the
  redirect itself proves nothing. The webhook settles it independently.

### Testing webhooks locally (test mode)

1. Put test keys in `.env.local`: `STRIPE_SECRET_KEY=sk_test_…`.
2. Install the Stripe CLI and run
   `stripe listen --forward-to localhost:3000/api/webhooks/stripe`. Copy the
   `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET`.
3. Start the app with the booking preview (see README), choose dates,
   continue to payment, and pay with the test card `4242 4242 4242 4242`.
4. `stripe trigger checkout.session.completed` sends synthetic events, which
   are recorded and, lacking a matching payment, safely ignored.

No test-mode keys were available while building this, so the Stripe adapter
has been exercised against signed synthetic events and an in-memory gateway
(`tests/support/fake-gateway.ts`), not yet against Stripe's sandbox.

## Email (Resend)

`EMAIL_DELIVERY` is `off` by default: messages are recorded as "not sent" and
can be previewed in admin. `resend-sandbox` sends everything to Resend's test
inbox (`delivered@resend.dev`). `resend` sends to real guests and also needs
`EMAIL_LIVE_DELIVERY_APPROVED=true`, a verified sending domain (SPF, DKIM,
DMARC) and the owner's approval. Requests use Resend's `Idempotency-Key`
header, so a retried job can't send twice. Not yet exercised against Resend.
