/**
 * Guest-facing property content.
 *
 * Every fact carries a verification status. Nothing marked `unverified` may
 * be presented as settled: the UI shows it with an "awaiting confirmation"
 * marker, and it must be confirmed by the owner before launch. Initial values
 * come from the owner's brief and the Airbnb listing they referenced
 * (https://www.airbnb.co.uk/rooms/49558875); no copy, images or reviews have
 * been taken from that listing.
 *
 * To confirm a fact: update the value if needed and set `status: "verified"`.
 * See docs/CONTENT.md.
 */

export type FactStatus = "verified" | "unverified";

export interface Fact<T> {
  value: T;
  status: FactStatus;
  /** Where the value came from, for the owner's review. */
  source: string;
}

const fromBrief = <T>(value: T): Fact<T> => ({
  value,
  status: "unverified",
  source: "Owner brief / reference listing — confirm before launch",
});

const placeholder = <T>(value: T): Fact<T> => ({
  value,
  status: "unverified",
  source: "Placeholder — owner to supply",
});

export const property = {
  name: "Lodge on the Lake",
  tagline: "A quiet lakeside lodge on the edge of the Lake District",
  location: {
    setting: fromBrief("South Lakeland Leisure Village"),
    region: fromBrief("near the Lake District"),
    /** Full postal address. Not published until the owner confirms it. */
    address: placeholder<string | null>(null),
    /** Directions copy, supplied by the owner. */
    directions: placeholder<string | null>(null),
  },
  sleeps: fromBrief(6),
  bedrooms: fromBrief(3),
  bathrooms: fromBrief(2),
  /** Room-by-room bed configuration, supplied by the owner. */
  bedConfiguration: placeholder<string[] | null>(null),
  /** Only features the owner has confirmed may be listed here as verified. */
  features: [fromBrief("Lake views"), fromBrief("Decking")],
  checkInTime: placeholder<string | null>(null),
  checkOutTime: placeholder<string | null>(null),
  minimumStayNights: placeholder<number | null>(null),
  pets: placeholder<string | null>(null),
  smoking: placeholder<string | null>(null),
  accessibility: placeholder<string | null>(null),
  parking: placeholder<string | null>(null),
  wifi: placeholder<string | null>(null),
  contact: {
    email: placeholder<string | null>(null),
    phone: placeholder<string | null>(null),
    /** Legal trading name and address for terms and privacy notice. */
    legalName: placeholder<string | null>(null),
  },
} as const;

export const isVerified = (fact: Fact<unknown>) => fact.status === "verified";

/** Booking-search limits used before the booking engine reads them from the database. */
export const searchLimits = {
  maxGuests: property.sleeps.value,
  /** Conservative default until the owner sets a minimum stay. */
  minNights: property.minimumStayNights.value ?? 2,
  maxNights: 28,
  horizonDays: 540,
};
