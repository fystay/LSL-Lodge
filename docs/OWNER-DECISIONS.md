# Decisions and inputs needed from the owner

Nothing here has been assumed. Until each item is confirmed, the site shows a
clearly marked placeholder or refuses to act. **Never send passwords, API
keys or private feed URLs by chat or email.** Enter secrets directly in the
hosting provider's secret manager, or in the admin screen where one exists
(the Airbnb link goes in `/admin/calendars`).

Facts gathered so far, with sources: [property-facts-and-policies.md](property-facts-and-policies.md).

## Already decided

- [x] **Booking mode: instant booking** (October 2026, replacing host
      approval). Guests pay in full when they book; the booking confirms
      once Stripe's payment is verified. You control availability by
      blocking dates.
- [x] **Payment model: full payment upfront.** Deposit plans are switched
      off.
- [x] **Guest cancellation policy:** full refund if the guest cancels
      within 24 hours of the booking being paid and confirmed;
      non-refundable after that. The 24 hours start when the server verifies
      the payment (not when the guest starts booking), the deadline is fixed
      then, and a cancellation exactly at the deadline is not refundable. Refunds within the window are sent automatically.

## Blocking test-mode payments and email (accounts)

- [ ] **Supabase project for the Lodge.** The connected Supabase account has
      two projects (one named "fystay-preview", one with a personal default name), both
      holding another application's tables and data. We did not touch them.
      Please create a dedicated project (EU/UK region), or confirm one may be
      used. Pricing tier and backups (PITR) to confirm.
- [ ] **Stripe.** The connected Stripe login shows "FYStay" (live and test)
      and "FYStay sandbox". Confirm which account the Lodge should use, then
      put its **test** secret key and webhook signing secret in the hosting
      secret manager. Live mode stays off until you approve it.
- [ ] **Resend** (or another provider), a sending domain, and DNS access for
      SPF, DKIM and DMARC. Real guest emails stay off until you approve them.
- [ ] **Admin users**: who gets an account (owner, and any read-only
      viewers). Each person sets up their own password and authenticator
      app from a one-time link; you'll need a phone authenticator app.

## Waiting for your approval (UI)

You asked that the production UI stay unchanged unless you authorise a
change. These are listed in [FRONTEND-CHANGES.md](FRONTEND-CHANGES.md)
with screenshots-based checks in [VISUAL-REGRESSION.md](VISUAL-REGRESSION.md):

- [ ] **Booking details page (`/book`)**: one added sentence, "The 24-hour
      free-cancellation period starts once your payment is confirmed. After
      that, the booking is non-refundable." Not visible on production today
      (online booking is off there).
- [ ] **Booking status page (`/book/[ref]`)**: the page guests return to
      after paying. Production has a preview version with no payment,
      confirmation, deadline or cancellation. The branch's version adds
      those, using the site's existing components. Approve it, or ask for a
      smaller version.
- [ ] **Cancellation policy page (`/cancellation-policy`)**: unchanged
      (still the draft notice). Proposed text is in FRONTEND-CHANGES.md;
      it will only be published with your approval.
- [ ] **Owner dashboard (`/admin`)**: not guest-facing; changed by the
      earlier admin-security and booking work (listed in the same file).

## Blocking real bookings (business rules)

- [ ] **Rates**: seasonal nightly rates, weekend rates, cleaning fee, extra
      guest charges, discounts. Entered in `/admin/pricing`.
- [ ] **Tax treatment**: whether prices include VAT or any other tax (ask
      your accountant). Currency assumed GBP: confirm.
- [ ] **Minimum stay**, check-in and check-out times, turnover buffer.
- [ ] **Hold length**: dates are held for 30 minutes while the guest pays
      (extended just enough to cover Stripe's 30-minute minimum once they
      open the payment page). Confirm, or choose another length.
- [ ] **Rest of the cancellation terms**: what happens if _you_ cancel a
      guest's stay, no-shows, amendments (date changes), and whether Stripe's
      processing fee is absorbed on 24-hour refunds (today the guest gets
      everything back). Legal review recommended, including whether the
      24-hour policy needs wording for UK consumer law.
- [ ] **Stale Airbnb feed**: with no approval step, should online booking
      pause automatically while the Airbnb import is failing or out of date?
      (Today guests see a "running behind" note and bookings continue; a
      clash found at payment goes to you for review.)
- [ ] **Booking terms** (legal review recommended).
- [ ] **Guest data**: name and email by default; phone optional. Anything
      else (address, age of lead guest)?
- [ ] **Late payments**: if a payment arrives after a hold lapsed and the
      dates are still free, it is flagged to you to honour or refund (if
      the dates were re-booked, or the guest had cancelled, it is refunded
      automatically). Confirm your rule.
- [ ] **Email wording**: the draft messages (confirmed with the cancellation
      deadline, cancelled, refund completed, payment failed and so on) need
      your approval before real emails are switched on. Admin shows a
      preview of each.

## Blocking calendars

- [ ] **Airbnb export link**: add it in `/admin/calendars` (Airbnb:
      Calendar → Availability → Connect calendars → Export calendar).
- [ ] Add the site's **export link** (shown in `/admin/calendars` once
      `CALENDAR_EXPORT_SECRET` is set) to Airbnb's "Import calendar".
- [ ] **Is the iCal delay acceptable?** Airbnb updates its feeds on its own
      schedule (see INTEGRATIONS.md). With instant booking there is no
      approval step to catch a clash before payment. If
      the delay is not acceptable, choose a budget for a channel manager with
      an official Airbnb connection.
- [ ] **Google Calendar**: which account and calendars to read busy times
      from; agree the site creates its own "bookings" calendar. Needs a
      Google Cloud project and OAuth consent screen. No calendar is written
      until you approve.
- [ ] **Scheduler**: Supabase `pg_cron` (recommended once the project
      exists) or Vercel Cron (plan limits apply). See SCHEDULER.md.
- [ ] **Uptime monitor** account (e.g. Better Stack or UptimeRobot) to watch
      the health endpoint and alert you if background work stops.

## Blocking launch

- [ ] Facts marked "Listing states", "Inferred" or "Unknown" in the facts
      register, notably bed sizes (Airbnb says king; the site says double),
      the "Waterfront" wording, two bathrooms, house rules, the full
      amenities list and leisure-village rules.
- [ ] Legal property/business name, address and contact details.
- [ ] Owner-approved photography (originals at higher resolution).
- [ ] Location copy and your own local recommendations.
- [ ] Privacy notice details (controller, retention periods) and legal review.
- [ ] Domain name.
- [ ] Monitoring and alerting contacts.
- [ ] Final acceptance testing and **explicit launch approval**, including
      live payments and real guest emails.
