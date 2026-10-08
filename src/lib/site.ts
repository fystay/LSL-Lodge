/** Site-wide settings resolved from the environment at build/render time. */

export const siteUrl = (
  process.env.SITE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

/** Search indexing stays off until the owner approves launch. */
export const siteIndexable = process.env.SITE_INDEXABLE === "true";

/** Online booking is not available until Phases 2–3 ship and launch is approved. */
export const bookingOpen = false;

export const primaryNav = [
  { href: "/stay", label: "The Lodge" },
  { href: "/location", label: "Location" },
  { href: "/information", label: "Information" },
  { href: "/contact", label: "Contact" },
] as const;

export const policyNav = [
  { href: "/information", label: "Guest information" },
  { href: "/cancellation-policy", label: "Cancellation policy" },
  { href: "/terms", label: "Booking terms" },
  { href: "/privacy", label: "Privacy notice" },
] as const;
