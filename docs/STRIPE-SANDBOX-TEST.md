# Stripe test-mode (sandbox) test plan

Status (9 October 2026): **not yet run.** No Stripe test keys are configured
in any environment this work has access to. Everything below is covered by
automated tests against signed synthetic events and an in-memory gateway
(`src/server/payments/payments.integration.test.ts`), but not yet against
Stripe itself.

## API-level check against Stripe (10 October 2026)

Without app keys, the connected Stripe login was used to check our requests
against Stripe's real test API:

- A Checkout Session created with exactly the app's parameters
  (`checkoutSessionParams`) was **accepted**, including the policy message
  beside the pay button. It was paid on Stripe's hosted page with the 4242
  test card, then refunded with the app's refund parameters (**accepted**,
  `succeeded`).
- The real `checkout.session.completed` and `refund.updated` payloads are
  saved in `tests/fixtures/stripe/` and run through the real webhook path
  (`stripe-fixtures.integration.test.ts`): the booking confirms and the
  refund completes.
- **Found: Adaptive Pricing.** The account had Stripe's Adaptive Pricing on,
  so Checkout offered the guest US$702.08 (incl. a 4% conversion fee)
  instead of £510.00. Our amount check still matched (Stripe reports the
  GBP amount), but a "full refund" in GBP could give a guest back a
  different amount in their currency. The app now sends
  `adaptive_pricing: { enabled: false }` on every session.
- **Found: API version.** The account's default webhook API version is
  `2026-08-26.dahlia`; the app's SDK uses `2026-09-30`. Create the Lodge's
  webhook endpoint with the SDK's version.
- **Found: the "FYStay sandbox" is not the Lodge's.** It belongs to another
  FYStay application ("FYStay Preview") and has that app's webhook
  endpoints, so these test events were also delivered to that app's
  preview deployment (test mode only; placeholder IDs and an example.test
  email). Stopped there. **The Lodge needs its own Stripe sandbox (or
  account)** before the scenarios below are run.

## Prerequisites (owner/developer; keys never go in chat or git)

1. Create a **dedicated sandbox for the Lodge** (Stripe dashboard →
   sandboxes). Don't use "FYStay sandbox": it belongs to another app.
2. Developers → API keys → copy the **test** secret key (`sk_test_…`) into
   the environment: `.env.local` locally, or the hosting provider's
   Preview/Development environment. The app refuses `sk_live_` keys unless
   `STRIPE_LIVE_MODE_APPROVED=true`, which must stay unset.
3. Webhooks, either:
   - locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
     and put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`; or
   - on a preview deployment: add an endpoint for
     `https://<preview>/api/webhooks/stripe` with the events
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`,
     `refund.created`, `refund.updated`, `refund.failed`, and put its signing
     secret in `STRIPE_WEBHOOK_SECRET`.
4. A development database (local, or the dedicated Supabase dev project) with
   placeholder rates, `BOOKING_PREVIEW=true`, and an admin account.

## Automated run

```bash
STRIPE_SANDBOX_E2E=true E2E_BOOKING=true BOOKING_PREVIEW=true \
  DATABASE_URL=<local db> STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… \
  CREDENTIALS_ENCRYPTION_KEY=… CREDENTIALS_ENCRYPTION_KEY_VERSION=1 \
  pnpm build && pnpm test:e2e e2e/stripe-sandbox.spec.ts --project desktop
```

`e2e/stripe-sandbox.spec.ts` covers scenarios 1–4 below. It has not been run
yet; Stripe's hosted-page selectors may need adjusting the first time.

## Scenarios and expected results

| #   | Scenario                             | How                                                                                                                                             | Expected                                                                                                                                                                                    |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Guest books instantly                | Choose dates on `/availability` → details → Continue to payment                                                                                 | Redirected straight to Stripe Checkout (no approval); "The 24-hour free-cancellation period starts once your payment is confirmed" shown beside the pay button (no time quoted); dates held |
| 2   | Guest pays in test mode              | Card `4242 4242 4242 4242`, any future date, any CVC                                                                                            | Redirect back; "Confirming…", then "Confirmed"; `confirmed_at` = verification time; booking page and email show the deadline = `confirmed_at` + 24 h                                        |
| 3   | Verified webhook records the payment | `stripe listen` output shows 200; `webhook_events` row PROCESSED                                                                                | One `payments` row SUCCEEDED with the Stripe PaymentIntent ID                                                                                                                               |
| 4   | Confirmed exactly once               | Reload; let the webhook arrive after the return page confirmed                                                                                  | One `reservation.confirmed` audit entry; booking-confirmed email (with the deadline) queued once                                                                                            |
| 5   | Duplicate/retried webhook            | `stripe events resend <evt_id>`                                                                                                                 | 200; `webhook_events` unchanged (duplicate); no new audit entries                                                                                                                           |
| 6   | Invalid signature                    | `curl -X POST -H 'stripe-signature: t=1,v1=bad' -d '{}' …/api/webhooks/stripe`                                                                  | 400; nothing recorded                                                                                                                                                                       |
| 7   | Amount mismatch                      | Not reproducible with real Checkout (the amount is server-set); covered by integration tests                                                    | Booking to review, "AMOUNT_MISMATCH", owner alerted                                                                                                                                         |
| 8   | Abandoned checkout                   | On Stripe's page, "← Back"                                                                                                                      | Hold released, open session expired at Stripe, guest back on `/book` for the same dates; nothing charged                                                                                    |
| 9   | Hold expires                         | Leave Checkout open past the hold (30 min, extended to cover the session) or `stripe checkout sessions expire <cs_id>`, then run `expire-holds` | Booking EXPIRED; session expired at Stripe; dates free                                                                                                                                      |
| 10  | Late payment                         | Open Checkout, let the hold expire, then pay                                                                                                    | REQUIRES_REVIEW if the dates are still free; if re-booked or cancelled, a full refund is queued and sent automatically; owner alerted                                                       |
| 11  | Declined card                        | Card `4000 0000 0000 0002`                                                                                                                      | Stripe shows the decline; nothing recorded as paid; booking stays held until expiry                                                                                                         |
| 12  | 3-D Secure                           | Card `4000 0025 0000 3155`, complete the challenge                                                                                              | Confirms as in 2                                                                                                                                                                            |
| 13  | Cancel within 24 h                   | Guest contacts owner; owner: booking → "The guest asked to cancel", time received, confirm                                                      | "Refund started"; `refund.updated` → succeeded; booking REFUNDED; refund-completed email queued; Stripe dashboard shows one refund                                                          |
| 14  | Cancel after 24 h                    | Cancel a test booking confirmed more than 24 h earlier (the stored deadline cannot be edited)                                                   | Recorded with a received time after the deadline: CANCELLED, no refund created                                                                                                              |
| 15  | Refund send fails                    | Temporarily revoke the key or block the network, cancel within 24 h, restore, run `process-refunds`                                             | Refund PENDING, not shown as refunded; succeeds on retry with the same idempotency key (one refund in Stripe)                                                                               |

Record the actual results here (date, environment, pass/fail, notes) when run.
