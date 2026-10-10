# Frontend changes against production

Status: 10 October 2026, branch `claude/instant-booking`.

The owner requires the production UI to stay unchanged unless they
authorise a change. Production (https://lsllodge.vercel.app) is built from
`claude/mobile-booking-form-layout-1i8qxx` at `cf39682`. This file lists
every frontend difference between that commit and this branch, and what
needs the owner's decision.

## What was found and fixed first

- **Production's UI was missing from this branch.** Production carries 13
  UI commits (owner's hero photos, homepage booking card, `/stay` layout
  and sticky section bar, iOS date-field fix) that were made on a separate
  branch. Merging this branch as it was would have rolled them back. They
  are now merged in unchanged; every file they touched is byte-identical to
  production.
- **The instant-booking work had changed guest-facing text without
  approval.** It is now reverted to production:
  - `/cancellation-policy`: back to production's draft notice (the
    replacement policy text is proposed below instead).
  - `/availability`: identical to production (the added policy line and
    "calendars running behind" note were removed).
  - Guest details form: identical to production (button "Hold these dates",
    original consent label).
- Holds are back to 30 minutes, so production's wording ("holds these
  dates for you for 30 minutes") stays accurate. Starting Stripe Checkout
  extends the hold just enough to cover Stripe's 30-minute session minimum.

## Verification

- Visual regression (`e2e/visual-regression.spec.ts`, see
  [VISUAL-REGRESSION.md](VISUAL-REGRESSION.md)): full-page screenshots of
  11 public routes on desktop and mobile. The baselines were captured from
  a local build of production's commit and checked against the live site
  (22/22 match). This branch's build matches them, 22/22. A deliberate
  one-class spacing change was caught, which shows the check is sensitive.
- The booking engine is off in production, so `/book` and `/book/[ref]`
  can't be reached there. They were compared locally with the engine on,
  using screenshots in [ui-review/](ui-review/).

## Remaining differences (need the owner's approval)

| File                                      | Visible?                                        | Change                                                                                                                                                                                                                                                                                                                                                                                              | Why                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/(site)/book/page.tsx`            | Only with online booking on (off in production) | One added sentence under "We only ask for what we need…": "The 24-hour free-cancellation period starts once your payment is confirmed. After that, the booking is non-refundable." Same text style as the line above.                                                                                                                                                                               | Required by the owner's cancellation decision: explain before payment that the clock starts at confirmation, without a made-up deadline. Screenshot: `ui-review/branch-desktop-2-book.png`.                                                                                               |
| `src/app/(site)/book/[ref]/page.tsx`      | Only with online booking on                     | Production has a preview page ("the secure payment step is being built", then just "Status: confirmed."). The branch shows a status box, the payment hold, "Pay now" if Stripe was interrupted, "Confirming your payment…" after Stripe, the free-cancellation deadline once confirmed, a "Cancel this booking" option and refund status. It uses the site's existing components, colours and type. | Needed for a working paid booking: confirmation after verified payment, showing the deadline after payment (owner requirement) and the guest cancellation/refund policy. Built in earlier phases, reworded for the new clock. Screenshots: `ui-review/*-3-held.png`, `*-4-confirmed.png`. |
| `src/app/(site)/book/[ref]/refresher.tsx` | Indirectly                                      | Refreshes the booking page while a payment is being verified.                                                                                                                                                                                                                                                                                                                                       | Shows "Confirmed" once Stripe's webhook lands, without the guest reloading.                                                                                                                                                                                                               |
| `src/components/quote-summary.tsx`        | Only on `/book/[ref]`                           | Optional `dueLabels` prop ("paid", "due now (dates held until …)"). Default rendering is unchanged, so `/availability` and `/book` look as in production.                                                                                                                                                                                                                                           | The price box on the booking page says "paid" once paid.                                                                                                                                                                                                                                  |

**Options for `/book/[ref]`:** (a) approve the branch's version; or (b) keep
production's preview page and add only: a "Confirmed" status line, the
deadline sentence after payment, and "Contact the owner to cancel" instead
of the cancel button. With (b), guests would cancel by contacting the owner.
The 24-hour refund rule would still be enforced when the owner records the
cancellation, but that path would need a small backend addition.

## Not guest-facing (no visual effect on public pages)

- `src/app/(site)/book/actions.ts`, `src/app/(site)/contact/actions.ts`:
  server actions (instant booking → Stripe, rate limits, cancellation).
- `src/app/(site)/book/[ref]/access/route.ts`, `src/app/calendar/[file]/route.ts`,
  `src/app/api/**`: routes with no page (email links, calendar export,
  Stripe webhook, jobs, health).
- `src/app/admin/**`, `src/components/admin-ui.tsx`: the owner dashboard
  (production's is the older version). Changed by the approved admin
  security, booking, blocking, refund and audit work. Owner-only, behind
  sign-in.

## Proposed cancellation policy text (not published)

`/cancellation-policy` still shows production's draft notice. Suggested text
for the owner to approve:

> **Free cancellation for 24 hours after your booking is confirmed.** You
> can cancel for a full refund within 24 hours of your booking being
> confirmed. The 24 hours start when your payment has gone through and we
> have confirmed your booking, not when you start booking, and they don't
> restart. After that, your booking is non-refundable.
>
> The exact time your free cancellation ends is shown on your booking page
> and in your confirmation email once your payment is confirmed. To get a
> refund, your cancellation must reach us before that time; a cancellation
> received at or after it is non-refundable. Refunds go back to the card you
> paid with; we'll email you when our payment provider confirms the refund.

Still to be decided before publishing: owner cancellations, no-shows, late
arrival or early departure, and legal review.
