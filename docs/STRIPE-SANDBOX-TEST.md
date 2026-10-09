# Stripe test-mode (sandbox) test plan

Status (9 October 2026): **not yet run.** No Stripe test keys are configured
in any environment this work has access to. Everything below is covered by
automated tests against signed synthetic events and an in-memory gateway
(`src/server/payments/payments.integration.test.ts`), but not yet against
Stripe itself.

## Prerequisites (owner/developer; keys never go in chat or git)

1. Confirm which Stripe account is the Lodge's (the connected login shows
   "FYStay" and "FYStay sandbox"). Use a **sandbox or test mode**.
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
     `checkout.session.async_payment_failed`, `checkout.session.expired`, and
     put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. A development database (local, or the dedicated Supabase dev project) with
   placeholder rates, `BOOKING_PREVIEW=true`, and an admin account.

## Automated run

```bash
STRIPE_SANDBOX_E2E=true E2E_BOOKING=true BOOKING_PREVIEW=true \
  DATABASE_URL=<local db> STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… \
  CREDENTIALS_ENCRYPTION_KEY=… CREDENTIALS_ENCRYPTION_KEY_VERSION=1 \
  pnpm build && pnpm test:e2e e2e/stripe-sandbox.spec.ts --project desktop
```

`e2e/stripe-sandbox.spec.ts` covers scenarios 1–5 below. It has not been run
yet; Stripe's hosted-page selectors may need adjusting the first time.

## Scenarios and expected results

| #   | Scenario                             | How                                                                                             | Expected                                                                                                                                        |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Guest submits a request              | Book dates on `/availability`                                                                   | Status "Request sent: awaiting the owner's approval"; nothing charged                                                                           |
| 2   | Owner approves                       | `/admin` → request → Approve                                                                    | "Approved: awaiting your payment"; Pay button shows the full amount                                                                             |
| 3   | Guest pays in test mode              | Pay → card `4242 4242 4242 4242`, any future date, any CVC                                      | Redirect back; "Confirming…", then "Confirmed"                                                                                                  |
| 4   | Verified webhook records the payment | `stripe listen` output shows 200; `webhook_events` row PROCESSED                                | One `payments` row SUCCEEDED with the Stripe PaymentIntent ID                                                                                   |
| 5   | Confirmed exactly once               | Reload; let the webhook arrive after the return page confirmed                                  | One `reservation.confirmed` audit entry; booking-confirmed email queued once                                                                    |
| 6   | Duplicate/retried webhook            | `stripe events resend <evt_id>`                                                                 | 200; `webhook_events` unchanged (duplicate); no new audit entries                                                                               |
| 7   | Invalid signature                    | `curl -X POST -H 'stripe-signature: t=1,v1=bad' -d '{}' …/api/webhooks/stripe`                  | 400; nothing recorded                                                                                                                           |
| 8   | Amount mismatch                      | Not reproducible with real Checkout (the amount is server-set); covered by integration tests    | Booking to review, "AMOUNT_MISMATCH", owner alerted                                                                                             |
| 9   | Abandoned checkout                   | Pay → "← Back" on Stripe's page                                                                 | "Payment was cancelled and nothing was charged"; Pay again works (same open session reused)                                                     |
| 10  | Session expiry                       | With a session open, `stripe checkout sessions expire <cs_id>`                                  | `checkout.session.expired` → payment CANCELED; booking still APPROVED; Pay again creates a new session                                          |
| 11  | Payment window expires               | Set the payment window to 1 hour, approve, wait (or run the `expire-holds` job after it passes) | Booking EXPIRED; open session expired at Stripe; guest emailed; dates free                                                                      |
| 12  | Late payment                         | Open Checkout, let the booking expire, then pay                                                 | Booking to REQUIRES_REVIEW ("payment arrived after the booking lapsed") or, if the dates were re-booked, flagged refund-required; owner alerted |
| 13  | Declined card                        | Card `4000 0000 0000 0002`                                                                      | Stripe shows the decline; nothing recorded as paid; booking stays APPROVED                                                                      |
| 14  | 3-D Secure                           | Card `4000 0025 0000 3155`, complete the challenge                                              | Confirms as in 3                                                                                                                                |

Record the actual results here (date, environment, pass/fail, notes) when run.
