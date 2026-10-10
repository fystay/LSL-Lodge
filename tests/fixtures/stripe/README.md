# Stripe payload fixtures

Real event payloads from a Stripe **test-mode** sandbox (10 October 2026):
a Checkout Session created with the app's exact parameters, paid with the
4242 test card, then refunded with the app's refund parameters. Test data
only (example.test email, placeholder reservation and payment IDs, test
card). Used by `src/server/payments/stripe-fixtures.integration.test.ts`,
which rewrites the IDs to rows in the test database and runs the payloads
through the real webhook path.

Note: this session was paid with Adaptive Pricing on (presentment in USD).
The app now disables Adaptive Pricing per session.
