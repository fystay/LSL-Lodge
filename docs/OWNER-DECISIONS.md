# Decisions and inputs needed from the owner

Nothing here has been assumed. Until each item is confirmed, the site shows a
clearly marked placeholder. **Never send passwords, API keys or private feed
URLs by chat or email.** Enter secrets directly in the hosting provider's
secret manager, or in the admin screen once it exists.

## Blocking Phase 2 (booking and pricing)

- [ ] **Hosting and database accounts.** Agree to Vercel (Pro needed for
      frequent calendar polling) and Supabase (UK/EU region), or name
      alternatives. Accounts should be owned by the business, with the
      developer invited.
- [ ] **Admin users.** Email addresses allowed into the admin area (MFA will
      be required).
- [ ] **Occupancy and rooms.** Maximum guests (brief says 6), bedrooms (3),
      bathrooms (2), bed configuration.
- [ ] **Check-in and check-out times**, turnover buffer (same-day turnover
      allowed?), minimum stay (and whether it varies by season or arrival day).
- [ ] **Rates.** Seasonal nightly rates, weekend rates, cleaning fee, extra
      guest charges, discounts.
- [ ] **Tax treatment.** Whether prices include VAT or any other tax. Take
      advice from an accountant; nothing is assumed.

## Blocking Phase 3 (payments and email)

- [ ] **Payment plan.** Full payment, or deposit (percentage or fixed) with the
      balance due N days before arrival; full payment if booking within N days.
- [ ] **Cancellation and refund policy**, including no-shows and owner
      cancellation. Have it legally reviewed.
- [ ] **Booking terms** (legal review recommended).
- [ ] **Stripe account** in the business's name. Test mode is used until you
      explicitly approve live mode.
- [ ] **Email provider** (Resend or Postmark), sending domain, and access to
      DNS to set SPF, DKIM and DMARC.
- [ ] **Guest data** to collect: name and email are the default; phone only if
      you need it.

## Blocking Phase 4 (calendars)

- [ ] **Airbnb export URL.** Find it in Airbnb: Calendar → Availability →
      Connect calendars → Export calendar. Enter it in admin; don't send it.
- [ ] Confirm you can **import** an external calendar URL into the Airbnb
      listing (for the website's export feed).
- [ ] **Google account and calendars** to read busy times from; agree that the
      site creates its own "bookings" calendar. A Google Cloud project with an
      OAuth consent screen is needed (we can set it up together).
- [ ] **Channel manager?** Is the iCal delay window (see INTEGRATIONS.md)
      acceptable? If not, choose a budget for a channel manager with an
      official Airbnb connection.

## Blocking launch

- [ ] Legal property/business name, address and contact details.
- [ ] Amenities, accessibility information, pet and smoking policy, parking,
      Wi-Fi, house rules, including any leisure-village rules.
- [ ] Owner-approved photography (see CONTENT.md shot list).
- [ ] Location copy and your own local recommendations.
- [ ] Privacy notice details (controller, retention periods) and legal review.
- [ ] Domain name.
- [ ] Monitoring and alerting contacts.
- [ ] Final acceptance testing and **explicit launch approval**.
