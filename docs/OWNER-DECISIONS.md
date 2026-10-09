# Decisions and inputs needed from the owner

Nothing here has been assumed. Until each item is confirmed, the site shows a
clearly marked placeholder or refuses to act. **Never send passwords, API
keys or private feed URLs by chat or email.** Enter secrets directly in the
hosting provider's secret manager, or in the admin screen where one exists
(the Airbnb link goes in `/admin/calendars`).

Facts gathered so far, with sources: [property-facts-and-policies.md](property-facts-and-policies.md).

## Already decided

- [x] **Booking mode: host approval.** Guests send a request; you approve or
      decline; nothing is charged before approval. Instant booking is built
      but switched off.
- [x] **Payment model: full payment**, collected after approval.

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
- [ ] **Admin users**: email addresses allowed into admin (MFA will be
      required once managed login is added).

## Blocking real bookings (business rules)

- [ ] **Rates**: seasonal nightly rates, weekend rates, cleaning fee, extra
      guest charges, discounts. Entered in `/admin/pricing`.
- [ ] **Tax treatment**: whether prices include VAT or any other tax (ask
      your accountant). Currency assumed GBP: confirm.
- [ ] **Minimum stay**, check-in and check-out times, turnover buffer.
- [ ] **Response window**: how long you have to answer a request (default
      24 hours; dates are held meanwhile).
- [ ] **Payment window**: how long an approved guest has to pay (default 24
      hours).
- [ ] **Cancellation, refund, no-show and amendment policy**, including
      owner cancellations and refund timing. Airbnb's policy is not assumed.
      Legal review recommended.
- [ ] **Booking terms** (legal review recommended).
- [ ] **Guest data**: name and email by default; phone optional. Anything
      else (address, age of lead guest)?
- [ ] **Late payments**: if a payment arrives after a booking lapsed, it is
      flagged to you. Confirm your rule: honour the booking if the dates are
      free, or always refund?

## Blocking calendars

- [ ] **Airbnb export link**: add it in `/admin/calendars` (Airbnb:
      Calendar → Availability → Connect calendars → Export calendar).
- [ ] Add the site's **export link** (shown in `/admin/calendars` once
      `CALENDAR_EXPORT_SECRET` is set) to Airbnb's "Import calendar".
- [ ] **Is the iCal delay acceptable?** Airbnb updates its feeds on its own
      schedule (see INTEGRATIONS.md). Your approval step is a safety net. If
      the delay is not acceptable, choose a budget for a channel manager with
      an official Airbnb connection.
- [ ] **Google Calendar**: which account and calendars to read busy times
      from; agree the site creates its own "bookings" calendar. Needs a
      Google Cloud project and OAuth consent screen. No calendar is written
      until you approve.
- [ ] **Scheduler**: Vercel Pro (for 5–15 minute polling) or Supabase
      `pg_cron` to call the job endpoints.

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
