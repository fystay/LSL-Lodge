# Visual regression check

`e2e/visual-regression.spec.ts` guards the public site against unintended
UI changes. It takes full-page screenshots of 11 public routes (home, stay,
location, information, contact, cancellation policy, terms, privacy,
availability, an availability search and the booking details page) on
desktop and mobile, with motion reduced, and compares them with baselines
in `e2e/visual-regression.spec.ts-snapshots/`. Date fields are masked (they
default relative to today). Allowed difference: 0.2% of pixels.

The baselines are **production**: captured on 10 October 2026 from a local
build of production's commit (`cf39682`, branch
`claude/mobile-booking-form-layout-1i8qxx`) and confirmed to match the live
site https://lsllodge.vercel.app on all 22 screenshots.

## Running it

Opt-in, because screenshots depend on the browser build and fonts
(baselines are Linux, the repository's pinned Playwright Chromium). The
booking engine must be off, as in production.

```bash
pnpm build
VISUAL_REGRESSION=true pnpm test:e2e e2e/visual-regression.spec.ts
```

Against a deployment instead of the local build:

```bash
VISUAL_REGRESSION=true VISUAL_BASE_URL=https://lsllodge.vercel.app \
  pnpm test:e2e e2e/visual-regression.spec.ts
```

A failure writes the expected, actual and diff images to `test-results/`.
Any difference is a UI change that needs the owner's approval.

## Updating the baselines

Only after the owner approves a UI change, or when production itself
changes:

1. Check out and build the commit production runs (Vercel shows it on the
   deployment).
2. Start it with the booking engine off and run the spec with
   `--update-snapshots`.
3. Re-run against `VISUAL_BASE_URL=https://lsllodge.vercel.app` to confirm
   the new baselines match the live site, then commit them.
