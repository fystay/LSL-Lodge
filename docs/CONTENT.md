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

`src/content/photos.ts` is the manifest. Every entry is currently a labelled,
abstract placeholder ("Photograph to come: …"); none depicts the lodge.

**Rules:** owner-approved photographs only. Nothing copied or hotlinked from
Airbnb, and no AI-generated images of the property.

**Shot list:** exterior and setting at golden hour; view from the deck; living
area; kitchen and dining; each bedroom; bathrooms; nearby landscape or walks.
A wide hero (landscape, at least 2400 px) and some portrait crops for mobile
are helpful.

**Delivery:** JPEG or WebP, sRGB, at least 2400 px on the long edge, with
written permission to use. For each photo, add `src`, `width`, `height`, alt
text describing what is actually in the picture, an optional `focus` crop
point, and `status: "approved"`. `next/image` handles responsive sizes and
modern formats.

## Structured data and Open Graph images

Deliberately omitted until the facts and photos are verified (charter §3).
Add `LodgingBusiness`/`VacationRental` JSON-LD and an OG image at launch.
