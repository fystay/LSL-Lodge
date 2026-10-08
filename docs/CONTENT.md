# Content and photography

## Facts

All property facts live in `src/content/property.ts`. Each has a `status`:

- `unverified`: shown with a visible "To be confirmed" marker (or "Awaiting
  owner" if there is no value yet).
- `verified`: confirmed by the owner, shown plainly.

Initial values come from the owner's brief, which drew on the Airbnb listing
(rooms/49558875): sleeps 6, 3 bedrooms, 2 bathrooms, lake views, decking.
**No other facilities are claimed.** In particular, nothing says the lodge is
waterfront, has private lake access, a hot tub, EV charging or accessibility
features.

The guest-facing copy (headings and short descriptions) is an original draft
in the brand voice and also needs owner approval before launch. Pages awaiting
substantive content (amenities, house rules, nearby recommendations,
cancellation policy, terms, privacy) show a "Draft" notice instead of
invented text.

A site-wide preview banner and `noindex` stay in place until launch
(`SITE_INDEXABLE=false`).

## Photography

`src/content/photos.ts` is the manifest; files live in `src/assets/photos/`.

**Source and permission:** 21 photos from the owner's Airbnb listing, supplied
in October 2026 (uploaded by the developer, not scraped from Airbnb), with the
owner's permission to use them on this site. Each was re-saved without
metadata (phone photos can carry GPS coordinates). Airbnb's own graphics and
guest profile pictures are never used.

**Quality:** most files are only 720 px on the long edge (the deck/fountain
view is 1,200 px). Layouts deliberately show them at or near natural size, for
example the editorial hero frame rather than a full-screen hero. **Ask the
owner for the original camera files:** with those, the hero can go full-width
and every photo will be sharper on high-resolution screens. Swap files by
replacing them in `src/assets/photos/` under the same names.

**To confirm with the owner** (also noted as `confirm` in the manifest):

- Room grouping: main bedroom (double, floral prints), second bedroom (double,
  tall upholstered headboard), twin bedroom. This is inferred from the photos.
- Which bedroom has the walk-in wardrobe.
- Two living-room layouts appear (a stove, and a media wall with an electric
  fire). Which is current? The site leads with the media wall.
- Only one bathroom is pictured; the listing says two.
- Whether the fire table in the covered seating area is available to guests.
  The site doesn't mention it.

**Motion:** the hero crossfades four portrait photos with a slow zoom, with a
pause button, pausing on hover or focus, and no autoplay under reduced-motion
settings. Sections fade up on scroll where the browser supports scroll-driven
animations. All of it is decorative and switched off for reduced motion.

## Structured data and Open Graph images

Open Graph image: `src/app/opengraph-image.jpg` (the deck/fountain view,
1200×630). Structured data (`LodgingBusiness`/`VacationRental` JSON-LD) is
still deliberately omitted until the facts are verified (charter §3).
