# CLAUDE.md — Lodge on the Lake

Project charter and implementation instructions for Claude Code.

> Also read [AGENTS.md](AGENTS.md): Next.js 16 differs from older versions; use the docs bundled in `node_modules/next/dist/docs/`.
> Current implementation status and design decisions: [docs/PLAN.md](docs/PLAN.md).

> **Purpose:** Build a bespoke, premium direct-booking website for Lodge on the Lake while Airbnb remains active. The website must provide its own authoritative booking database, accept payments through Stripe, and synchronise availability with Google Calendar and Airbnb through supported iCalendar (iCal) feeds or an explicitly approved channel-management integration.
>
> **Important limitation:** Standard Airbnb iCal feeds are not a guaranteed real-time, fully bidirectional booking API. Feed refreshes may be delayed and do not expose every reservation detail. Never promise instantaneous Airbnb synchronisation unless a supported API or channel manager provides and verifies it. Design for fast updates, frequent reconciliation, clear sync health, and conservative double-booking protection.

## 1. Mission

Create a production-ready, accessible, mobile-first website for Lodge on the Lake, a short-stay lakeside lodge at South Lakeland Leisure Village. The existing Airbnb listing is a source of property facts and inspiration, not a design or copy template.

The website should make direct booking feel trustworthy and effortless while preserving the owner's existing Airbnb channel during the transition.

### Business goals

- Build an independent brand and direct sales channel.
- Convert high-intent visitors into completed reservations with minimal friction.
- Show trustworthy availability and transparent total pricing.
- Support owner-configurable payment plans, including full payment, deposits, and due dates for the balance.
- Reduce manual calendar administration without pretending that external feeds are instantaneous.
- Give the owner clear operational visibility and a safe way to correct conflicts.
- Protect guest data and payment flows, and be maintainable by a small business.

## 2. Operating rules for Claude Code

1. Inspect the repository, runtime, package manager, existing code, and deployment setup before changing anything.
2. If the repository is empty, propose and then implement the default stack in Section 4. Record any material deviation and why it is justified.
3. Build in small vertical slices. Run formatting, linting, type checks, tests, and production builds as appropriate after meaningful changes.
4. Use current official documentation for the chosen framework, Stripe, Google APIs, and any calendar/channel-management provider. Verify API behaviour rather than relying on memory.
5. Do not fabricate property facts, testimonials, ratings, policies, prices, photos, or integration status. Mark owner-provided content and decisions clearly.
6. Never claim a test, integration, migration, sync, payment, email, or deployment succeeded unless it actually did.
7. Do not store secrets in the repository, browser bundle, logs, screenshots, test fixtures, or documentation. Provide `.env.example` with placeholders only.
8. Do not make destructive changes, deploy to production, incur paid services, send real payments, or send real guest emails without explicit owner approval.
9. Prefer simple, documented solutions over premature abstraction. Avoid unnecessary dependencies and custom cryptography.
10. Keep README.md, setup instructions, architecture notes, and this file aligned with the implemented system.
11. If a requirement conflicts with a provider's real capabilities, explain the limitation and implement the safest viable alternative. Do not simulate success.
12. Ask for owner input only when a decision is genuinely blocking. Otherwise choose a sensible, documented default and make it configurable.

## 3. Property, brand, and content

### Property identity

- Working brand: Lodge on the Lake
- Positioning: calm, considered, premium lakeside escape.
- Location reference: South Lakeland Leisure Village, near the Lake District.
- Listing reference supplied by the owner: https://www.airbnb.co.uk/rooms/49558875
- Initial property details suggested by the reference listing: three bedrooms, sleeps up to six, two bathrooms, lake views and decking. Verify every fact with the owner before publication.
- Do not imply that the lodge is waterfront, has private lake access, a hot tub, EV charging, accessibility features, or any other facility unless verified.

### Creative direction

Design an original visual identity that feels editorial, tranquil, tactile and quietly premium—not a generic holiday-let template and not a copy of Airbnb.

Suggested palette:
- Deep lake green / pine for primary actions and headings.
- Warm ivory / limestone for page backgrounds.
- Muted sage and mist grey for supporting surfaces.
- A restrained warm accent inspired by natural wood.
- Maintain WCAG-compliant contrast; never sacrifice legibility for mood.

Typography:
- Pair a refined editorial serif for selected display headings with a highly legible sans serif for body copy, forms and controls.
- Use a limited, consistent type scale and comfortable line lengths.

Photography:
- Prioritise real, owner-approved images: exterior and setting, deck and view, living area, kitchen, each bedroom, bathrooms, and nearby experiences.
- Use responsive, correctly sized images, modern formats where practical, meaningful alt text, and a considered crop strategy.
- Do not hotlink images from Airbnb or scrape/reuse copyrighted images without permission.
- Do not use AI-generated imagery to represent the actual property.
- If final photography is not available, use clearly temporary placeholders and document replacement requirements.

Motion:
- Use restrained transitions for menus, date selection, galleries and status changes.
- Respect `prefers-reduced-motion`; never make motion essential to understanding or booking.

### Brand voice

Warm, specific, calm and confident. Avoid clichés, exaggerated claims, fake scarcity, and unsupported superlatives. Explain the experience clearly and make practical details easy to find.

### Core public pages

- `/` — Homepage and primary booking search.
- `/stay` — Accommodation details, gallery and amenities.
- `/availability` — Date and guest search results.
- `/book/[id]` or an equivalent secure booking flow.
- `/location` — Accurate location, directions and nearby recommendations.
- `/information` — House rules, check-in/out, accessibility and practical information.
- `/cancellation-policy` — Owner-approved policy.
- `/privacy` — Privacy notice.
- `/terms` — Booking terms.
- `/contact` — Contact details and enquiry form.
- `/booking/confirmation` — Authenticated or token-protected booking status; never expose other guest data.

Add metadata, sitemap, robots directives, Open Graph imagery and structured data only where the content is verified.

## 4. Recommended production stack

Use the latest stable, mutually compatible versions at implementation time; pin dependencies and commit the lockfile.

- **Framework:** Next.js with App Router and TypeScript, using React Server Components where appropriate.
- **Styling/UI:** Tailwind CSS plus a small, accessible component system. Prefer composable, owned components over a heavy template.
- **Database:** Managed PostgreSQL, such as Supabase Postgres or Neon. Choose one and document the decision.
- **ORM/migrations:** Prisma or Drizzle. Choose one; use committed migrations and constraints.
- **Authentication:** Managed authentication for the owner/admin area. Prefer a proven provider compatible with the stack; enforce server-side authorisation and MFA where supported.
- **Payments:** Stripe Checkout or Payment Intents as appropriate, with Stripe-hosted payment collection preferred to minimise PCI scope.
- **Calendar:** Google Calendar API using OAuth 2.0 for the owner's calendar, plus iCal import/export for Airbnb where available. If dependable two-way channel synchronisation is essential, assess a reputable channel manager before promising real-time behaviour.
- **Email:** A transactional provider such as Resend or Postmark, behind a small email service abstraction.
- **Hosting:** A managed platform compatible with Next.js and scheduled jobs, plus managed PostgreSQL.
- **Background jobs:** A reliable scheduled job/queue service for feed polling, reconciliation, reminders and retries. Do not rely on in-memory timers or a serverless process staying alive.
- **Testing:** Vitest or Jest for unit/integration tests, Playwright for end-to-end tests, and automated accessibility checks.
- **Monitoring:** Error reporting, structured logs, uptime monitoring and alerts for failed calendar sync, webhook processing and email delivery.

Before choosing vendors, check data residency, pricing, backups, limits, OAuth requirements, job reliability, and the owner's ability to administer the account. Keep provider-specific operations behind interfaces where this materially reduces lock-in.

## 5. System architecture and source of truth

The PostgreSQL database is the source of truth for website reservations, price calculations, payment schedules and internal holds. External calendars are synchronisation inputs/outputs—not the database itself.

Use clear modules, for example:

- `booking` — availability, holds, reservation lifecycle, cancellation.
- `pricing` — rates, fees, discounts, minimum stays and quote snapshots.
- `payments` — Stripe sessions/intents, webhooks, refunds and payment schedule.
- `calendar` — Google Calendar and external iCal adapters, sync jobs and conflict resolution.
- `notifications` — confirmation, payment receipts, reminders and owner alerts.
- `admin` — authenticated owner operations.
- `audit` — important changes and integration events.

Keep domain logic server-side. Client components may improve interaction but must never be trusted for price, availability, payment state, permissions or booking status.

All dates must be handled consistently. Store reservation dates as local property calendar dates (DATE semantics) where possible, define the property's IANA time zone in configuration, and store event timestamps in UTC. Define check-in as inclusive and check-out as exclusive. Prevent off-by-one errors around daylight-saving changes.

## 6. Booking experience

### Guest journey

1. Visitor lands on a fast, image-led homepage and can immediately choose check-in, check-out and guests.
2. Validate date order, occupancy and minimum stay; show available dates and a clear total.
3. Present an itemised quote before payment: accommodation, required fees, discounts, taxes if applicable, deposit due now and balance due later.
4. Collect only necessary guest details, including name and email; gather phone/address only when operationally or legally justified.
5. Show the cancellation terms and payment schedule before the guest commits.
6. Create a short-lived reservation hold using a server-side transaction and re-check conflicts.
7. Create the appropriate Stripe checkout/payment flow on the server using a stable idempotency key.
8. Confirm the booking only after verified payment state and successful final conflict/hold checks.
9. Send confirmation and a clear payment schedule; create/update calendar events and show sync status to the owner.
10. Provide a secure way for the guest to view relevant booking details or contact the owner.

### UX requirements

- Excellent mobile-first layout, keyboard navigation and screen-reader labels.
- Date picker with clear unavailable dates, minimum-stay guidance and accessible alternatives.
- Guest selector with validated occupancy.
- Useful empty, loading, error, expired-hold and payment-cancelled states.
- Preserve entered data safely across recoverable errors without leaking sensitive data.
- No forced account creation for guests unless the owner explicitly requests it.
- Do not hide mandatory charges until the final step.
- Never claim dates are guaranteed until the server has secured a valid hold.
- Clearly explain that Airbnb and external calendar updates may have a propagation delay where iCal is used.

## 7. Availability and double-booking prevention

### Reservation states

Implement a documented state machine, for example:

- `PENDING_PAYMENT` — temporary hold, with expiry.
- `CONFIRMED` — reservation accepted and required initial payment verified.
- `PAYMENT_DUE` — confirmed reservation with an outstanding scheduled balance.
- `CANCELLED` — cancelled according to policy.
- `EXPIRED` — hold expired without a valid booking.
- `REFUND_PENDING` / `REFUNDED` — where relevant.
- `REQUIRES_REVIEW` — unresolved conflict or exceptional payment/calendar state.

Define allowed transitions explicitly. Do not let arbitrary client requests set a reservation to `CONFIRMED`.

### Atomic conflict prevention

- Store reservation date ranges and enforce conflicts at the database/transaction layer, not only in UI checks.
- For PostgreSQL, consider a date-range exclusion constraint for overlapping active stays, or use a carefully tested transaction/locking strategy that provides equivalent guarantees.
- Treat stays as `[check_in, check_out)`: one guest may check out on the same date another checks in, subject to turnover rules.
- Exclude only states that are safely non-blocking. Active holds must block availability until expiry.
- Create holds atomically; expire them with a scheduled worker and verify expiry at request time as well.
- Re-check availability immediately before creating the payment session and before final confirmation.
- Handle simultaneous requests for the same dates in automated concurrency tests.
- Use idempotency keys for hold creation, reservation creation and Stripe operations.
- If an external booking appears after a website hold has begun, flag the conflict, prevent unsafe confirmation, alert the owner and follow a documented recovery/refund process.

### Availability response

Availability must combine:
1. Internal active reservations and holds.
2. Owner-created blocked periods.
3. Imported external busy periods from Google Calendar and Airbnb feeds.
4. Safety buffers/turnover rules if configured.

Cache only with a defined short TTL and invalidation strategy. A cached result must never replace the final transactional server-side conflict check.

## 8. Airbnb and Google Calendar synchronisation

### Critical integration reality

Airbnb iCal feeds are usually asynchronous, periodically refreshed and limited in the data they expose. Importing an Airbnb calendar into Google Calendar does not make Airbnb changes instantly visible to the website. Exporting a website calendar to Airbnb also does not guarantee immediate blocking on Airbnb.

Implement honest, observable synchronisation. If the owner requires dependable two-way near-real-time synchronisation, evaluate a supported channel manager or officially available integration. Do not scrape Airbnb, automate its private interfaces, or invent an unsupported API.

### Initial recommended model

- The internal booking database remains authoritative for direct reservations.
- Import busy events from the owner's selected Google Calendar and the Airbnb-provided iCal feed into normalized external-block records.
- Export website reservations to a dedicated Google Calendar and/or a website-generated iCal feed that Airbnb can subscribe to.
- Avoid exporting imported Airbnb events back into the same source feed in a way that creates a sync loop.
- Keep source identifiers, event UIDs, last-seen timestamps, feed cursors/ETags where supported, sync status and error details.
- Store only the external event data needed to determine busy periods; do not unnecessarily retain guest details from external events.

### Google Calendar

- Use OAuth 2.0 with least-privilege scopes. Request only the scopes required for the chosen operations.
- Store refresh tokens encrypted at rest; never expose them to the browser or logs.
- Support secure connect, reconnect, revoke and disconnect flows.
- Use Google Calendar API event creation/update/deletion for the owner's designated calendar.
- Handle API quotas, pagination, time zones, cancelled events, recurring events, all-day events, 401/403/429/5xx errors and token refresh.
- Use incremental sync tokens or supported change notifications where appropriate, with periodic full reconciliation. Notifications can be delayed or missed; they are not the only sync mechanism.
- Process sync work asynchronously and idempotently.
- Distinguish website-created events from externally created events using stable identifiers/private metadata where supported.
- Never delete an event that the system cannot confidently identify as owned by this integration.
- Show connection status, last successful sync, last error and a manual "Sync now" action in the admin dashboard.

### Airbnb iCal

- Let the owner securely configure the Airbnb export/import URL as a secret. Never expose private feed URLs in frontend HTML, client logs or public error responses.
- Fetch feeds on a configurable schedule, with an initial target of every 5–15 minutes where provider/hosting limits permit, plus a manual sync button. Document that this is a polling target, not an Airbnb delivery guarantee.
- Parse events robustly; validate feed format, event UIDs, date-only events, time zones and cancelled/changed events.
- Use HTTP conditional requests (ETag/Last-Modified) if supported.
- Apply timeouts, bounded retries with exponential backoff and jitter, rate limits, and alerting after repeated failures.
- Retain the last known good import if a refresh fails; do not silently clear previously blocked dates because a feed is temporarily unavailable.
- Display the last successful import and warn the owner when the feed becomes stale.
- Provide a manual reconciliation workflow and conflict-resolution instructions.
- Validate configured URLs against SSRF risks: allow only expected protocols, block private/internal IP ranges and unsafe redirects, and enforce outbound request controls.

### Sync conflict policy

- External busy periods are treated as blocking until reconciled.
- If external sources conflict with a confirmed direct reservation, do not silently overwrite either record. Raise a high-priority admin conflict.
- Record provenance for every block: direct booking, owner block, Google event, Airbnb feed, or channel manager.
- Define explicit ownership for each type of event. Only modify or delete events created by this application.
- Avoid loops by tagging and tracking events, comparing normalized event hashes, and using stable idempotent identifiers.
- Reconcile periodically in both directions where the provider permits it.
- Alert the owner when an integration is disconnected, stale, repeatedly failing, or reports an overlap.

### If a channel manager is selected

Before implementation, document the provider, supported Airbnb integration method, booking/event webhooks, sync guarantees, costs, permissions, cancellation behaviour, test environment and failure modes. Keep a provider adapter so the booking domain is not coupled to one vendor.

## 9. Pricing and payment policies

The owner can configure:

- Full payment at booking.
- A fixed amount or percentage deposit at booking.
- Balance due on a configurable date or interval before check-in.
- Optional minimum deposit, payment deadlines and late-payment handling.
- Refund and cancellation policy text, subject to owner approval and applicable law.

### Pricing rules

- Calculate all prices on the server using integer minor units (for GBP, pence); never trust a client-submitted amount.
- Use explicit, versioned rate rules for seasonal pricing, weekday/weekend rates, minimum nights, cleaning fees, extra guest charges, discounts and taxes where applicable.
- Save an immutable quote snapshot against the reservation so later rate changes do not alter an existing booking.
- State whether displayed prices include applicable taxes and mandatory fees.
- Validate the owner's legal and tax obligations rather than assuming a tax rate or treatment.

### Stripe

- Use Stripe-hosted Checkout where practical. If Payment Intents are used, follow current Stripe guidance for authentication and SCA.
- Create Checkout Sessions/Payment Intents on the server only.
- Store Stripe customer/payment object IDs as needed; never store card numbers, CVCs or raw payment credentials.
- Use test mode in development and staging; require explicit approval before live-mode configuration.
- Verify webhook signatures using the raw request body and endpoint secret.
- Handle duplicate, delayed and out-of-order webhook delivery idempotently using persisted Stripe event IDs and a transaction.
- Verify amount, currency, reservation reference and current reservation state before applying a payment.
- Do not trust the browser redirect as proof of payment. The verified webhook and/or server-side Stripe verification determines payment status.
- Handle success, failure, cancellation, authentication-required, delayed payment, refund, dispute and partial-payment scenarios.
- Make balance-payment links secure, expiring where appropriate, and associated with the correct reservation.
- Do not store sensitive payment details in logs.
- Keep a reconciliation process for Stripe transactions versus internal payment records.
- Define what happens when payment succeeds but final booking confirmation fails: alert, reconcile and refund or safely complete the reservation according to a documented policy.

### Payment schedule and cancellation

- Display due-now and future due amounts and dates before checkout.
- Send reminders before balances are due.
- Keep payment state separate from reservation state.
- Implement cancellation/refund workflows according to the owner's approved policy; never infer refund eligibility from payment status alone.
- Record a non-sensitive audit trail of policy changes, refunds and manual adjustments.

## 10. Owner administration

Provide a protected admin area with role checks on every server-side action.

Required capabilities:
- View/search bookings and booking detail.
- View calendar with internal bookings, external blocks and source indicators.
- Add/edit owner-blocked periods.
- View payment schedule and verified payment/refund state.
- Configure rates, fees, minimum stay, guest capacity and payment policy.
- Configure check-in/out, policies and guest-facing property content.
- Connect/reconnect Google Calendar and manage Airbnb iCal feeds.
- Inspect sync status, last successful sync, stale feed warnings and conflict queue.
- Retry failed syncs and run manual reconciliation.
- Resend appropriate transactional messages without exposing private data.
- Export operational booking data in a controlled format.
- View audit logs for important admin changes.

Use confirmation steps for destructive actions. Prevent accidental deletion of reservations or external events. Require re-authentication for sensitive actions where supported.

## 11. Notifications

Use a transactional email provider with verified domain, SPF, DKIM and DMARC configured before production sending.

Emails should include, as appropriate:
- Booking request/confirmation and reference.
- Dates, guest count, itemised price, payment received and balance schedule.
- Cancellation and refund status.
- Balance reminders and failed-payment instructions.
- Pre-arrival information when approved by the owner.
- Owner alert for a new direct booking, calendar conflict, failed integration or overdue balance.

Use templates with escaped user-provided values, plain-text alternatives, clear sender identity and idempotent delivery jobs. Do not include secrets or unnecessary personal information. Track delivery outcomes and retry transient failures.

## 12. Security, privacy and compliance

- Enforce HTTPS in production and secure cookie settings.
- Validate all inputs on the server with schemas.
- Use parameterised database access; protect against SQL injection, XSS, CSRF, SSRF, open redirects and broken access control.
- Apply rate limits to booking, contact, login, payment and webhook endpoints as appropriate.
- Use secure, HTTP-only, same-site cookies and CSRF protections where relevant.
- Enforce admin authorisation server-side for every protected route, query and mutation.
- Protect secrets with the deployment platform's secret manager. Rotate compromised keys and document recovery.
- Encrypt OAuth refresh tokens and other sensitive integration credentials at rest.
- Minimise guest data collection and retention; define retention and deletion procedures.
- Provide an accurate privacy notice, cookie handling where required, and processes for applicable UK GDPR/Data Protection Act obligations. Obtain legal review where needed.
- Do not enable non-essential analytics or advertising cookies before required consent.
- Avoid logging full request bodies, contact details, calendar URLs, OAuth tokens, payment client secrets or webhook secrets.
- Add security headers, a restrictive Content Security Policy where feasible, dependency scanning and regular updates.
- Use separate development, staging and production environments and credentials.
- Back up the database, document recovery steps, and periodically test restoration.
- Provide a security contact and incident-response checklist for production.

## 13. Accessibility, performance and SEO

### Accessibility

Target WCAG 2.2 AA:
- Semantic headings, landmarks and form labels.
- Full keyboard operation and visible focus.
- Accessible calendar interactions and clear error summaries.
- Sufficient contrast and no colour-only status communication.
- Screen-reader announcements for availability, pricing and payment status.
- Reduced-motion support and sensible touch targets.
- Automated accessibility checks plus manual keyboard and screen-reader review.

### Performance

- Optimise and responsively serve imagery; lazy-load below-the-fold images and prioritise the primary hero image appropriately.
- Avoid layout shifts and oversized client bundles.
- Cache public content safely but keep booking/availability and payment status fresh and server-validated.
- Target Core Web Vitals in the "good" range on representative mobile devices.
- Avoid third-party scripts unless their value is justified.

### SEO

- Use descriptive titles, meta descriptions, canonical URLs and crawlable public content.
- Add sitemap and robots configuration.
- Use appropriate lodging/accommodation structured data only when accurate and supported.
- Keep private booking/admin routes out of search indexes.
- Provide useful location content without keyword stuffing.
- Preserve redirects if URLs change after launch.

## 14. Data model

Design a relational schema and migrations for at least:

- **Property** — capacity, time zone, check-in/out rules and published content references.
- **RateRule** — dates/season, amounts, minimum stay and applicable constraints.
- **FeeRule** — type, amount, applicability and tax treatment.
- **Reservation** — public reference, guest contact data, dates, guest count, state, currency, quote snapshot and source.
- **ReservationHold** or equivalent — range, expiry, idempotency key and state.
- **Payment** — reservation, provider IDs, amount, currency, type, state and timestamps.
- **PaymentScheduleItem** — amount, due date, paid amount and state.
- **ExternalCalendarSource** — provider, encrypted configuration, sync state and last success.
- **ExternalBusyPeriod** — source, external UID, date range, status and provenance.
- **CalendarEventLink** — reservation, provider, external event ID and sync state.
- **OwnerBlock** — date range, reason and creator.
- **WebhookEvent** — provider event ID, processing state and timestamps.
- **NotificationJob** — template/type, recipient reference, idempotency and delivery status.
- **AuditLog** — actor, action, target, timestamp and safe metadata.

Add indexes for availability queries, stable unique constraints for provider event IDs, foreign keys, sensible deletion policies and migrations. Use a PostgreSQL exclusion constraint or a rigorously tested transactional alternative to prevent overlapping active stays.

Do not store raw iCal feed URLs in ordinary logs or expose them to client queries. Avoid copying guest names/emails from external calendars unless strictly required.

## 15. API and background-job conventions

- Keep route handlers thin and domain services testable.
- Validate payloads, authenticate/authorise, enforce idempotency and return stable error shapes.
- Use transactions for reservation and payment state changes.
- Process Stripe webhooks and calendar imports asynchronously when appropriate.
- Use durable jobs with retries, exponential backoff, jitter, dead-letter/error state and operational visibility.
- Jobs must be idempotent and safe to retry.
- Use timeouts and bounded retries for all outbound calls.
- Include correlation IDs in logs, but do not put guest PII or secrets in them.
- Apply pagination and bounded query sizes to admin listings.
- Document endpoints and state transitions.

## 16. Testing requirements

### Unit tests

Cover:
- Date range boundaries, daylight-saving changes and property time zone.
- Minimum stay, occupancy, rate calculations, fees, discounts and rounding.
- Deposit and balance schedule calculations.
- Reservation state transitions.
- Calendar event normalisation and feed parsing.
- Idempotency and duplicate webhook behaviour.
- Permission checks and input validation.

### Integration tests

Cover:
- Database conflict constraints under concurrent booking attempts.
- Hold creation, expiry and release.
- Stripe webhook signature verification and duplicate/out-of-order events.
- Payment success/failure and reconciliation.
- Google OAuth callback, token refresh and calendar API adapter behaviour using mocks or a test calendar.
- Airbnb iCal import, changed/cancelled events, stale feeds and failed refreshes.
- Retry handling, email jobs and audit logging.
- Rollback behaviour after partial failures.

### End-to-end tests

Using test data and Stripe test mode:
1. Guest searches dates and receives accurate availability.
2. Guest sees transparent price and payment schedule.
3. Guest completes a test booking and receives confirmation.
4. Payment is not marked successful from a redirect alone.
5. A second guest cannot reserve overlapping dates.
6. A hold expires and dates become available only when safe.
7. External calendar busy periods block dates after import.
8. A direct booking creates the expected calendar event.
9. A disconnected or stale calendar displays a warning.
10. Owner can block dates, update rates and resolve a conflict.
11. Guest cancellation follows the configured policy.
12. Booking and admin journeys work on mobile and keyboard-only navigation.

### Quality gates

Before merging:
- Formatting passes.
- Lint passes.
- Type checking passes.
- Unit and integration tests pass.
- Production build succeeds.
- Critical end-to-end tests pass in CI.
- Accessibility and dependency checks are reviewed.
- No secrets or real guest data are committed.

Do not weaken or delete tests simply to get a green build. Explain any skipped test and its risk.

## 17. Environments, deployment and operations

Maintain distinct local, staging and production environments.

### Environment configuration

Provide `.env.example` documenting names and purpose without values, such as:
- Database connection string.
- Authentication provider configuration.
- Stripe publishable key, secret key and webhook signing secret.
- Google OAuth client ID/secret and redirect URI.
- Encryption key reference for stored integration credentials.
- Transactional email API key and sender address.
- App base URL and property time zone.
- Background job/cron authentication secret.
- Monitoring DSN.

Never put private keys in `NEXT_PUBLIC_*` variables.

### Deployment checklist

- Configure production domain and HTTPS.
- Configure OAuth redirect URIs and calendar permissions.
- Configure Stripe live-mode products/prices if required by the chosen design, webhook endpoint and payment methods.
- Verify transactional email domain authentication.
- Configure durable scheduled jobs and alerts.
- Run migrations using a controlled deployment step.
- Confirm backups and test recovery.
- Check security headers, robots/sitemap, monitoring and error reporting.
- Run smoke tests for public pages, booking, payment webhook and calendar status.
- Verify a rollback procedure and document who can execute it.
- Obtain owner approval before enabling live payments or accepting public reservations.

### Operational monitoring

Alert on:
- Repeated calendar sync failure or stale feeds.
- External/direct booking overlap.
- Webhook processing failure.
- Stripe/internal payment mismatch.
- Failed or overdue balance processing.
- High error rate, database connectivity issues or job backlog.
- Email delivery failure.

Provide a runbook for restoring calendar connectivity, reconciling payment state, handling duplicate bookings, restoring database backups and disabling new bookings during an incident.

## 18. Implementation phases

### Phase 0 — Discovery and technical proof

- Inspect repo and confirm stack.
- Confirm verified property facts, policies, pricing model and branding assets.
- Determine the actual Airbnb iCal import/export options available to the owner.
- Prototype Google Calendar OAuth and sync, Airbnb feed parsing, and Stripe test-mode webhook handling.
- Document integration limitations and whether a channel manager is needed.

**Exit gate:** Architecture, providers, risks and required owner inputs are documented.

### Phase 1 — Foundation and visual system

- Set up application, database, migrations, CI, error handling and design tokens.
- Build responsive layout, navigation, footer, typography, accessible primitives and image gallery.
- Create core public pages with verified content.

**Exit gate:** Production build passes and public pages are responsive and accessible.

### Phase 2 — Booking and pricing

- Implement availability service, price rules, quote snapshots, holds and database-level conflict prevention.
- Build date/guest search, checkout journey and reservation lifecycle.
- Add admin calendar and owner blocks.

**Exit gate:** Concurrent booking tests prove that overlapping stays cannot both be confirmed.

### Phase 3 — Stripe and communications

- Implement configurable payment plans, checkout, webhooks, balance schedule, refunds and reconciliation.
- Add transactional emails and owner notifications.

**Exit gate:** Stripe test-mode end-to-end scenarios pass, including duplicate webhooks and failed payments.

### Phase 4 — Calendar synchronisation

- Implement Google Calendar connection, event sync and reconciliation.
- Implement secure Airbnb iCal import/export and sync-health UI.
- Add retries, conflict queue, manual sync and alerting.
- If required, integrate a supported channel manager after the owner approves its costs and access.

**Exit gate:** Documented test cases prove expected sync behaviour and visible failure handling. No unsupported real-time guarantee is made.

### Phase 5 — Hardening and launch

- Run full test suite, accessibility audit, performance review and security review.
- Verify policies, SEO, backups, monitoring, incident runbooks and production secrets.
- Conduct owner acceptance testing and obtain explicit launch approval.

**Exit gate:** All launch-critical acceptance criteria below pass.

## 19. Definition of done and acceptance criteria

The project is not complete until all launch-critical criteria are demonstrated.

### Public website
- [ ] Original, coherent visual identity and responsive layouts.
- [ ] Owner-approved property facts, photography, pricing and policies.
- [ ] Fast, accessible navigation, gallery and booking search.
- [ ] Clear total pricing and payment terms before checkout.
- [ ] Contact, privacy, terms and cancellation pages are published.

### Booking integrity
- [ ] Server is authoritative for dates, prices, guest capacity and state.
- [ ] Database-backed holds expire reliably.
- [ ] Concurrent overlapping booking attempts cannot both confirm.
- [ ] Check-in inclusive/check-out exclusive behaviour is tested.
- [ ] Reservation and payment state transitions are explicit and audited.
- [ ] Failure after payment does not silently lose or duplicate the payment/booking.

### Stripe
- [ ] Test-mode checkout succeeds and fails correctly.
- [ ] Webhook signatures are verified.
- [ ] Duplicate and out-of-order events are handled idempotently.
- [ ] Full payment, deposit and balance schedule work.
- [ ] Amounts are server-calculated and reconciled.
- [ ] Refund/cancellation handling matches owner-approved policy.
- [ ] No card data or secrets are stored in application logs/database.

### Calendar and Airbnb
- [ ] Google Calendar OAuth connection, refresh, disconnect and recovery work.
- [ ] Website reservations create/update only integration-owned calendar events.
- [ ] Imported Google/Airbnb busy dates block direct-booking availability.
- [ ] iCal polling failures preserve last known good blocks and show stale status.
- [ ] Retries, manual sync, reconciliation and owner alerts work.
- [ ] Conflict provenance is visible and conflicts require explicit resolution.
- [ ] Sync latency and provider limitations are documented; no false real-time claim.
- [ ] A channel manager is used if owner-approved requirements exceed iCal capabilities.

### Administration and security
- [ ] Only authorised owners/admins can access operational controls.
- [ ] Rates, blocks, payment plans and property content can be maintained safely.
- [ ] Secrets and OAuth tokens are protected.
- [ ] Input validation, rate limiting, security headers and backup procedures are in place.
- [ ] Privacy, retention and incident-response procedures are documented.

### Quality and launch
- [ ] CI quality gates pass.
- [ ] Critical end-to-end tests pass.
- [ ] WCAG 2.2 AA review has no unresolved critical issues.
- [ ] Performance and SEO have been checked.
- [ ] Monitoring, alerts, backups and rollback are verified.
- [ ] Owner has completed acceptance testing and explicitly approved live launch.

## 20. Decisions requiring owner confirmation

Do not invent these. Use clearly marked configuration placeholders until confirmed. (Tracked in [docs/OWNER-DECISIONS.md](docs/OWNER-DECISIONS.md).)

- Legal property name, address, contact details and final brand assets.
- Maximum occupancy, room configuration, amenities, accessibility and pet policy.
- Check-in/check-out times, turnaround buffer and minimum stay.
- Seasonal rates, fees, discounts and tax treatment.
- Cancellation/refund terms and no-show policy.
- Deposit percentage/fixed amount and balance deadline defaults.
- Guest identity/contact information required.
- Calendar account, target Google Calendar and Airbnb iCal feed URLs.
- Whether a paid channel manager is acceptable and the budget.
- Hosting, domain, transactional email and monitoring accounts.
- Privacy, retention and legal review.

## 21. First task for Claude Code

Start by inspecting the repository. Then produce a short implementation plan with:
1. The chosen stack and rationale.
2. The proposed data model and overlap-prevention strategy.
3. The Stripe booking/payment lifecycle.
4. The Google Calendar and Airbnb sync design, including the iCal latency limitation.
5. Required owner decisions and credentials (never ask the owner to paste secrets into chat or commit them).
6. Phased milestones and test gates.

After the plan, implement Phase 0 and Phase 1 in the repository. Do not enable live payments or publish the website until the owner has approved the relevant policies, integrations and launch checklist.
