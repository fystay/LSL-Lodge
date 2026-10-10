# Frontend changes against production

Status: 10 October 2026, branch `claude/instant-booking`.

Production (https://lsllodge.vercel.app) is built from
`claude/mobile-booking-form-layout-1i8qxx` at `cf39682`. Its 13 UI commits
are merged into this branch unchanged. The owner requires the production
UI to stay as it is unless they authorise a change. This file lists every
frontend difference that remains, all of them approved by the owner on
10 October 2026.

## Approved differences (guest-facing)

Both pages appear only when online booking is switched on, which it isn't
in production.

| File                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Approval                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/app/(site)/book/page.tsx`       | One sentence under "We only ask for what we need…", in that line's text style: "The 24-hour free-cancellation period starts once your payment is confirmed. After that, the booking is non-refundable."                                                                                                                                                                                                                                                                                                                                                                                       | Approved: the single explanation sentence on /book.                                                               |
| `src/app/(site)/book/[ref]/page.tsx` | Production's page, with: (1) for a confirmed booking, "Status: confirmed. Your payment has been received.", the free-cancellation deadline (or that it has passed), and "To cancel, contact the owner (link to /contact). Your cancellation counts from when your message reaches us."; (2) production's "Payment isn't switched on yet" notice shown only when payments really aren't configured; (3) a lapsed hold that was paid isn't described as "nothing was charged". Same markup and classes as the page's existing paragraphs, `<strong>` and underlined link. No cancellation form. | Approved: minimal production-style status page with confirmed status, deadline and "contact the owner to cancel". |

Screenshots: [ui-review/](ui-review/) (`production-*` vs `branch-*`). The
"held" page is the same as production's.

## Unchanged (verified)

`/`, `/stay`, `/location`, `/information`, `/contact`,
`/cancellation-policy` (draft notice), `/terms`, `/privacy`,
`/availability` (with and without a search), the guest details form, the
site header, footer, navigation, hero and booking search, and
`src/components/quote-summary.tsx` (restored to production).
`e2e/visual-regression.spec.ts` compares 11 public routes on desktop and
mobile with baselines taken from production's commit and checked against
the live site: 22/22 match.

## Not guest-facing (no visual effect)

- `src/app/(site)/book/actions.ts`: instant booking → Stripe Checkout. If
  Checkout can't be opened the hold is released and the guest sees
  production's existing form error. The unused guest pay/cancel actions
  were removed.
- `src/app/(site)/book/[ref]/checkout-cancelled/route.ts` (new, no page):
  Stripe's "back" link. It releases the unpaid hold and returns the guest
  to production's `/book` page for the same dates. It needs the booking
  cookie and the checkout's payment ID.
- `src/app/(site)/book/[ref]/access/route.ts`: email links → booking
  cookie.
- `src/app/(site)/contact/actions.ts`: rate limiting on the enquiry form.
- `src/app/admin/**`, `src/components/admin-ui.tsx`: owner dashboard,
  signed-in owners only. Includes the new "The guest asked to cancel" form
  on a booking.
- Removed: `src/app/(site)/book/[ref]/refresher.tsx` (part of the earlier
  status page; not in production).

## Known wording to review (not changed, needs approval to change)

- On the booking page after payment, the price box (production's component)
  still says "Full payment due now" rather than "paid".

## Proposed cancellation policy text (not published)

`/cancellation-policy` still shows production's draft notice. Suggested text
for the owner to approve:

> **Free cancellation for 24 hours after your booking is confirmed.** You
> can cancel for a full refund within 24 hours of your booking being
> confirmed, that is, once your payment has gone through. After that, your
> booking is non-refundable.
>
> The exact time your free cancellation ends is shown on your booking page
> and in your confirmation email. To cancel, contact us; your cancellation
> counts from when your message reaches us, and must reach us before that
> time for a refund. A cancellation received at or after it is
> non-refundable. Refunds go back to the card you paid with; we'll email
> you when our payment provider confirms the refund.

Still to decide before publishing: owner cancellations, no-shows, late
arrival or early departure, and legal review.
