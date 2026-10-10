# Customer demo: script, reset and limitations

For showing Lodge on the Lake's direct booking to a prospective customer on
**staging** ([STAGING-SETUP.md](STAGING-SETUP.md)). Test data and Stripe
test mode only. Never demonstrate on production, with live keys, or with a
real guest's details.

## Before the demo (10 minutes)

1. If staging uses Supabase's free plan and has been idle a week, resume
   the project in the Supabase dashboard.
2. `pnpm demo status` (staging `DATABASE_URL` and `DEMO_DATABASE_HOST` in
   your shell), then `pnpm demo reset --yes` for a clean calendar.
3. Sign in to `/admin` as the owner in one browser window (password and
   authenticator code). Use a private window for the guest.
4. Open `/admin/system`: health green. Email shows "off" (expected).

## Script (about 15 minutes)

Use any free dates 1–12 months ahead, Monday to Thursday. Prices are
**placeholders** (£150 a night, £180 Friday/Saturday, £60 cleaning), not
the owner's pricing.

1. **Search.** Home → choose dates and 2 guests → availability shows the
   total, itemised, before anything is asked of the guest.
2. **Book.** Continue → name and email (`yourname+demo@example.test`), tick
   the terms. The page explains that the 24-hour free-cancellation period
   starts once payment is confirmed. "Hold these dates" goes straight to
   Stripe: the dates are now held for 30 minutes.
3. **Show the hold protects the dates.** In another private window, try the
   same dates: "no longer available". In `/admin`, the booking is under
   "Bookings in progress", and blocking those dates is refused.
4. **Pay.** On Stripe's page (it shows a "Sandbox"/test banner): card
   `4242 4242 4242 4242`, any future expiry, any CVC, any name/postcode.
5. **Confirmation.** Back on the site: "Status: confirmed. Your payment has
   been received.", the exact free-cancellation deadline (24 hours from the
   verified payment, UK time), the price box showing "paid", and how to
   cancel (contact the owner).
6. **Owner view.** `/admin` → the booking, its payment and deadline, the
   audit trail, and the confirmation email preview (not sent).
7. **Cancellation and refund.** The guest "emails" to cancel. In the
   booking's page: "The guest asked to cancel" → time received (now) →
   confirm. Within the 24 hours, the full refund goes to Stripe at once and
   the booking shows refunded once Stripe confirms (seconds in test mode).
   The dates are bookable again.
8. **Owner blocks.** `/admin/blocks` → block a week (reason starting
   `[DEMO]` so the reset removes it) → the public calendar and booking page
   refuse those dates.

Optional extras: a declined card (`4000 0000 0000 0002`) confirms nothing;
leaving Stripe with its back link releases the hold at once.

## After the demo

`pnpm demo reset --yes`. It deletes only bookings with guest emails at
`example.test`/`example.com` (or `DEMO_EMAIL_DOMAINS`), blocks and calendar
sources labelled `[DEMO]`, the test-only owner accounts the automated
journey creates, and rate-limit counters. It refuses to run on any database
that `pnpm demo seed` didn't mark as a demo database, on a non-local host
you haven't confirmed with `DEMO_DATABASE_HOST`, or with a live Stripe key.
Real bookings and real owner accounts are never selected. Stripe test-mode
payments stay in the Lodge sandbox's history (harmless; the sandbox can be
cleared in Stripe's dashboard if wanted).

## What to say about limitations

- **Prices, policies and property details are placeholders** until the
  owner confirms them.
- **Emails aren't sent** in the demo; the owner screen shows exactly what
  would be sent. Real sending needs a verified email domain.
- **Cancellation is by contacting the owner**, who records it; there is no
  guest cancel button (owner's choice). The refund is automatic within the
  24 hours.
- **Stripe test mode**: Stripe's page shows a test banner; no real money
  moves.
- **Airbnb calendar sync is by iCal feed**, polled every few minutes. It is
  not instant and Airbnb's feed shows dates only. If the feed goes stale
  (no successful import for 60 minutes), the site pauses new bookings
  rather than risk a double booking. Not connected on staging.
- **Google Calendar sync** isn't built yet.
- The "cancelled at or after the deadline" case can't be shown live
  without waiting 24 hours; it is covered by automated tests (below).
- Staging is protected: customers need the share link.

## Scenario coverage

"Staging journey" = `e2e/staging-journey.spec.ts` (run against the deployed
staging site; needs it set up). Everything else runs locally against
PostgreSQL in CI and in development.

| Scenario                                                     | Automated, local (passing 10 Oct 2026)                                                                                                                                                                                       | Staging journey (not yet run: no staging)                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Availability → hold → payment → verified webhook → confirmed | `payments`: confirms only on verified full payment; real Stripe payload fixtures (`stripe-fixtures`); E2E `instant-booking` (payment simulated)                                                                              | Pays with 4242 on Stripe's page; checks a signed webhook was processed and confirmed once |
| Guest confirmation page and owner dashboard                  | E2E `instant-booking`, `admin`                                                                                                                                                                                               | Yes                                                                                       |
| Payment failure                                              | `payments`: async payment failure; expired session                                                                                                                                                                           | Declined card 4000…0002                                                                   |
| Duplicate and out-of-order webhooks                          | `payments`: duplicates, concurrent duplicates, expired-after-completed, deadline never moved                                                                                                                                 | Replays Stripe's real event twice, then a late "expired" (needs keys in the runner)       |
| Expired holds                                                | `holds`, `overlap-protection`: expiry frees dates, never early                                                                                                                                                               | Yes (expiry simulated in the database)                                                    |
| Late payment (after the hold expired)                        | `payments`: to review if dates free; refund flagged if re-booked; automatic refund if cancelled                                                                                                                              | Yes: paid after expiry goes to the owner, not confirmed                                   |
| Double-booking conflicts                                     | `holds`, `overlap-protection`: one of many concurrent attempts wins; database exclusion constraint                                                                                                                           | Second guest refused; Airbnb dates block                                                  |
| Owner blocks; blocks can't cover bookings                    | `holds`, `overlap-protection`; E2E `instant-booking`, `admin`                                                                                                                                                                | Yes                                                                                       |
| Stale Airbnb feed                                            | `holds`: no holds while stale; `payments`: no Checkout while stale, payment goes to review; `sync`: last good import kept                                                                                                    | Yes (stand-in feed marked stale)                                                          |
| Cancellation just before the 24-hour deadline                | `refunds`: 1 ms before → full refund                                                                                                                                                                                         | Cancelled minutes after paying → refunded once Stripe confirms                            |
| Cancellation at or after the deadline                        | `refunds`: exactly at and after → no refund, owner must acknowledge                                                                                                                                                          | Not possible live (24 h wait)                                                             |
| Refund failures and retries                                  | `refunds`: retries with backoff, gives up after 6 and alerts; **new:** Stripe reporting a refund failed after it succeeded reopens the booking, alerts the owner, can be refunded again; failed is final against late events | Card 4000…5126 (refund succeeds, then fails): owner sees the alert and can refund again   |
| Forged webhook                                               | `stripe-webhook`: signature verification                                                                                                                                                                                     | Unsigned request refused                                                                  |
