# Property facts and policies register

Last checked: 9 October 2026.

This register records what is known about Lodge on the Lake, where each fact
came from, and whether the owner has confirmed it. **Nothing here is a
published policy.** The website shows unconfirmed facts with a "To be
confirmed" marker (see `src/content/property.ts`), and the booking engine
refuses to quote or take payment without owner-entered configuration.

Status key:

- **Owner-confirmed**: the owner has confirmed it for the direct-booking site.
- **Listing states**: shown on the Airbnb listing; owner must confirm before
  the site relies on it.
- **Inferred**: deduced from photos; owner must confirm.
- **Unknown**: not available from any source we can read.

## Sources

| Source                                                                   | How it was read                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Airbnb listing [rooms/49558875](https://www.airbnb.co.uk/rooms/49558875) | Fetched on 9 October 2026. The page's server-rendered text was readable, but only part of it: 5 of the 55 amenities, no check-in/out times, and no listing cancellation policy. The full amenities list and house rules need the owner's copy. |
| Owner's brief (CLAUDE.md, master engineering brief)                      | Three bedrooms, sleeps up to six, two bathrooms, lake views, decking. Full payment chosen as the direct-booking model. Host approval required.                                                                                                 |
| Owner-supplied photos (`src/content/photos.ts`)                          | 21 photos supplied with permission in October 2026.                                                                                                                                                                                            |
| Existing preview site [lsllodge.vercel.app](https://lsllodge.vercel.app) | Fetched on 9 October 2026. It shows booking as "not open yet" and unconfirmed facts as "To be confirmed". It is consistent with this register.                                                                                                 |

Airbnb's own booking, payment, service-fee and cancellation terms are **not**
assumed to apply to direct bookings.

## Property details

| Fact               | Value                                                                                                                               | Source        | Status                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Listing title      | "Lodge on the lake South Lakeland leisure village"                                                                                  | Airbnb        | Listing states                                                                                                                  |
| Setting            | South Lakeland Leisure Village; listing calls it "the Gateway to the Lake District"                                                 | Airbnb, brief | Listing states                                                                                                                  |
| Position           | "On a small lake away from the main road"                                                                                           | Airbnb        | Listing states                                                                                                                  |
| Property type      | Airbnb category "Holiday park"                                                                                                      | Airbnb        | Listing states                                                                                                                  |
| Maximum guests     | 6                                                                                                                                   | Airbnb, brief | Listing states                                                                                                                  |
| Bedrooms           | 3                                                                                                                                   | Airbnb, brief | Listing states                                                                                                                  |
| Beds               | 4: bedroom 1 king, bedroom 2 king, bedroom 3 two singles                                                                            | Airbnb        | Listing states. **Conflicts with the site**, which says "double" for bedrooms 1 and 2 (inferred from photos). Owner to confirm. |
| Bathrooms          | 2                                                                                                                                   | Airbnb, brief | Listing states (only one bathroom is pictured)                                                                                  |
| Outside space      | Private outside space with lakeside decking                                                                                         | Airbnb, brief | Listing states                                                                                                                  |
| Parking            | Parking for two cars                                                                                                                | Airbnb        | Listing states                                                                                                                  |
| Amenities shown    | Lake view, Waterfront, Kitchen, Wifi, Dedicated workspace                                                                           | Airbnb        | Listing states. The other 50 amenities were not readable.                                                                       |
| "Waterfront"       | Airbnb amenity tag                                                                                                                  | Airbnb        | Listing states. The charter forbids implying waterfront or private lake access until the owner confirms the wording.            |
| Fishing            | Three lakes (pike and carp), free to guests; rod licence required                                                                   | Airbnb        | Listing states. Leisure-village rules may apply.                                                                                |
| Leisure facilities | Gym, spa, pool on site at extra cost; bar and restaurant. Leisure passes not included; bought daily or weekly at the leisure centre | Airbnb        | Listing states. Village facilities, not the lodge's. Prices and opening times unknown.                                          |
| Nearby             | Yorkshire Dales National Park about 1 hour's drive                                                                                  | Airbnb        | Listing states                                                                                                                  |
| Address            | Not published by Airbnb before booking                                                                                              | none          | Unknown                                                                                                                         |
| Rating and reviews | 4.96 from 83 reviews; Superhost                                                                                                     | Airbnb        | **Not to be republished.** Airbnb reviews belong to that platform; the site shows no ratings or testimonials.                   |

## Guest rules

| Rule                      | Value                                                                                  | Source | Status                                                       |
| ------------------------- | -------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| Groups                    | "Make or Female groups not permitted ie stag or hen parties" (verbatim; likely "Male") | Airbnb | Listing states. Owner to confirm exact wording for the site. |
| Check-in time             | Not shown                                                                              | none   | Unknown                                                      |
| Check-out time            | Not shown                                                                              | none   | Unknown                                                      |
| Pets                      | Not shown                                                                              | none   | Unknown                                                      |
| Smoking                   | Not shown                                                                              | none   | Unknown                                                      |
| Quiet hours / parties     | Not shown beyond the group rule                                                        | none   | Unknown                                                      |
| Minimum age of lead guest | Not shown                                                                              | none   | Unknown                                                      |
| Safety devices            | Not shown (smoke/CO alarms etc.)                                                       | none   | Unknown                                                      |
| Accessibility             | Not shown                                                                              | none   | Unknown                                                      |

## Commercial rules for direct bookings

None of these may be invented. Until the owner enters them in `/admin`,
quoting fails with a clear "not configured" message.

| Item                                | Status                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Booking mode                        | **Owner-confirmed: host approval required.** Instant booking is built but disabled (see PLAN.md §8).                         |
| Payment model                       | **Owner-confirmed in principle: full payment**, collected only after approval. Timing windows below still need confirmation. |
| Currency                            | GBP assumed from the UK location and Airbnb .co.uk listing. Owner to confirm.                                                |
| Nightly / seasonal rates            | Unknown. The local seed data is clearly fake and refuses to run outside localhost.                                           |
| Minimum stay                        | Unknown. The site shows a 2-night search default only as a placeholder.                                                      |
| Cleaning and other fees             | Unknown                                                                                                                      |
| Extra-guest charges, discounts      | Unknown                                                                                                                      |
| Taxes (VAT etc.)                    | Unknown. Needs the owner's accountant.                                                                                       |
| Security/damage deposit             | Unknown                                                                                                                      |
| Owner response time for requests    | Default **24 hours** (configurable in admin). Operational default, needs confirmation.                                       |
| Guest payment window after approval | Default **24 hours** (configurable in admin). Operational default, needs confirmation.                                       |
| Cancellation and refund policy      | Unknown. Airbnb's policy is not assumed. `/cancellation-policy` shows a draft notice.                                        |
| No-show and amendment policy        | Unknown                                                                                                                      |
| Refund timing                       | Unknown                                                                                                                      |
| Booking terms                       | Unknown. `/terms` shows a draft notice. Legal review recommended.                                                            |
| Licensing / compliance              | Unknown (e.g. any local short-let registration, leisure-village owner rules on letting, insurance). Owner to confirm.        |

## Missing or conflicting information

1. **Bed sizes:** Airbnb says king beds in bedrooms 1 and 2; the site says
   double. Fix after the owner confirms.
2. **"Waterfront":** Airbnb tags it; the charter forbids the claim until the
   owner confirms the wording (for example "deck over the water" versus
   "private lake access").
3. **Two bathrooms, one pictured.**
4. **Full amenities list (50 not readable) and house rules:** ask the owner
   for screenshots or the listing text.
5. **Village rules:** the leisure village may have its own rules for guests
   (passes, quiet hours, vehicles). Ask the owner.

## Decisions requiring owner confirmation

See also [OWNER-DECISIONS.md](OWNER-DECISIONS.md).

- Every row marked "Listing states", "Inferred" or "Unknown" above.
- Rates, fees, minimum stay, taxes and currency, entered in `/admin/pricing`.
- Response and payment windows for host-approved requests (defaults 24 h / 24 h).
- Cancellation, refund, no-show and amendment policy; booking terms.
- Whether payment may ever be taken before approval (not the default; see PLAN.md §8 for the trade-offs).
- When, if ever, to enable instant booking.
