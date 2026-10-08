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

## Stripe

Hosted Checkout, server-created sessions, webhook-driven state. Details are in
docs/PLAN.md §3. Test mode only; `sk_live_` keys are refused unless
`STRIPE_LIVE_MODE_APPROVED=true`.
