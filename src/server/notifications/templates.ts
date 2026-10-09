import type { NotificationTemplate } from "./outbox";

/**
 * Email templates. Pure functions of verified backend data: nothing here is
 * taken from the client. Every interpolated value is HTML-escaped, and each
 * message has a plain-text part.
 *
 * The copy states facts (what happened, what's next, deadlines, amounts) and
 * links to the site's own terms and cancellation pages. It deliberately
 * contains no policy wording of its own: those pages hold the owner-approved
 * text. Owner emails carry the booking reference and dates but no guest
 * contact details; those stay in /admin.
 */

export interface TemplateData {
  siteName: string;
  siteUrl: string;
  publicRef: string;
  guestName: string;
  checkIn: string; // formatted for display
  checkOut: string;
  nights: number;
  guests: number;
  total: string; // formatted money
  amountDue: string;
  /** Formatted deadline (owner response or guest payment), if any. */
  deadline: string | null;
  /** Signed guest link to the booking page, or null if links aren't configured. */
  bookingUrl: string | null;
  adminUrl: string;
  /** Owner-only context, e.g. a review reason. */
  detail?: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A paragraph of text with optional link, kept as data so it renders to both formats. */
type Block =
  { p: string } | { link: string; href: string } | { list: string[] };

function render(
  subject: string,
  blocks: Block[],
  d: TemplateData,
): RenderedEmail {
  const footer: Block[] = [
    {
      p: `Booking terms: ${d.siteUrl}/terms · Cancellation policy: ${d.siteUrl}/cancellation-policy`,
    },
  ];
  const all = [...blocks, ...footer];
  const text = all
    .map((b) =>
      "p" in b
        ? b.p
        : "link" in b
          ? `${b.link}: ${b.href}`
          : b.list.map((item) => `- ${item}`).join("\n"),
    )
    .join("\n\n");
  const html = [
    `<!doctype html><html lang="en-GB"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2a24;max-width:36rem">`,
    `<p style="font-size:1.1rem;font-weight:600">${escapeHtml(d.siteName)}</p>`,
    ...all.map((b) =>
      "p" in b
        ? `<p>${escapeHtml(b.p)}</p>`
        : "link" in b
          ? `<p><a href="${escapeHtml(b.href)}">${escapeHtml(b.link)}</a></p>`
          : `<ul>${b.list.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`,
    ),
    `</body></html>`,
  ].join("");
  return {
    subject: d.publicRef ? `${subject} (${d.publicRef})` : subject,
    text,
    html,
  };
}

const stayLines = (d: TemplateData) => [
  `Reference: ${d.publicRef}`,
  `Arrive: ${d.checkIn}`,
  `Leave: ${d.checkOut}`,
  `${d.nights} ${d.nights === 1 ? "night" : "nights"}, ${d.guests} ${d.guests === 1 ? "guest" : "guests"}`,
  `Total: ${d.total}`,
];

const bookingLink = (d: TemplateData, label: string): Block =>
  d.bookingUrl
    ? { link: label, href: d.bookingUrl }
    : {
        p: "You can see your booking at any time from the booking page in the browser you used.",
      };

const adminLink = (d: TemplateData): Block => ({
  link: "Open in admin",
  href: d.adminUrl,
});

export const TEMPLATES: Record<
  NotificationTemplate,
  (d: TemplateData) => RenderedEmail
> = {
  request_received: (d) =>
    render(
      "We’ve received your booking request",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: "Thank you for your booking request. It has been sent to the owner for approval. This is not yet a confirmed booking, and nothing has been charged.",
        },
        { list: stayLines(d) },
        {
          p: `The owner will reply by ${d.deadline} (UK time). Your dates are held for you until then. If the request is approved, we’ll email you a secure link to pay the full amount.`,
        },
        bookingLink(d, "View your request"),
      ],
      d,
    ),
  owner_new_request: (d) =>
    render(
      "New booking request to review",
      [
        { p: "A guest has sent a booking request." },
        { list: stayLines(d) },
        {
          p: `Please approve or decline by ${d.deadline} (UK time). After that the request lapses and the dates are released.`,
        },
        adminLink(d),
      ],
      d,
    ),
  request_approved: (d) =>
    render(
      "Your booking request has been approved: payment needed",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: `Good news: the owner has approved your request. To confirm the booking, please pay the full amount of ${d.amountDue} by ${d.deadline} (UK time).`,
        },
        { list: stayLines(d) },
        {
          p: "Your booking is confirmed only once payment has gone through. If payment isn’t made by the deadline, the dates are released.",
        },
        bookingLink(d, "Pay securely and confirm"),
      ],
      d,
    ),
  request_declined: (d) =>
    render(
      "Your booking request",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: "Sorry, the owner wasn’t able to accept your booking request. Nothing has been charged, and the dates have been released.",
        },
        { list: stayLines(d) },
        { link: "Look for other dates", href: `${d.siteUrl}/availability` },
      ],
      d,
    ),
  request_expired: (d) =>
    render(
      "Your booking request has lapsed",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: "We’re sorry: the owner wasn’t able to reply in time, so your booking request has lapsed. Nothing has been charged.",
        },
        { list: stayLines(d) },
        { link: "Search again", href: `${d.siteUrl}/availability` },
      ],
      d,
    ),
  owner_request_expired: (d) =>
    render(
      "A booking request lapsed without a reply",
      [
        {
          p: "This request wasn’t approved or declined in time, so it has lapsed and the dates are free again. The guest has been told.",
        },
        { list: stayLines(d) },
        adminLink(d),
      ],
      d,
    ),
  payment_window_expired: (d) =>
    render(
      "Your approved booking has lapsed",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: "Payment wasn’t completed by the deadline, so the approved booking has lapsed and the dates have been released. Nothing has been charged.",
        },
        { list: stayLines(d) },
        { link: "Search again", href: `${d.siteUrl}/availability` },
      ],
      d,
    ),
  payment_failed: (d) =>
    render(
      "Your payment didn’t go through",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: `Your payment for this booking didn’t go through, so the booking isn’t confirmed. You can try again until ${d.deadline ?? "the payment deadline"} (UK time).`,
        },
        { list: stayLines(d) },
        bookingLink(d, "Try again"),
      ],
      d,
    ),
  booking_confirmed: (d) =>
    render(
      "Your booking is confirmed",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: `Your booking is confirmed and we’ve received your payment of ${d.amountDue}.`,
        },
        { list: stayLines(d) },
        bookingLink(d, "View your booking"),
      ],
      d,
    ),
  owner_booking_confirmed: (d) =>
    render(
      "Booking confirmed and paid",
      [
        { p: "Payment has been verified and this booking is confirmed." },
        { list: stayLines(d) },
        adminLink(d),
      ],
      d,
    ),
  owner_payment_needs_review: (d) =>
    render(
      "Action needed: a payment needs your review",
      [
        {
          p: `A payment for this booking couldn’t be applied automatically${d.detail ? ` (${d.detail.replaceAll("_", " ").toLowerCase()})` : ""}. Please review it in admin; it may need a refund.`,
        },
        { list: stayLines(d) },
        adminLink(d),
      ],
      d,
    ),
  owner_calendar_conflict: (d) =>
    render(
      "Calendar clash: an imported booking overlaps a website booking",
      [
        {
          p: "An imported calendar (such as Airbnb) now shows these dates as busy, and they overlap a website request or booking. Neither has been changed. Please check both and decide which stands; if a guest must be moved or refunded, contact them directly.",
        },
        { list: stayLines(d) },
        adminLink(d),
      ],
      d,
    ),
  owner_system_alert: (d) =>
    render(
      "Booking system needs attention",
      [
        {
          p: "A routine check found a problem with the booking system's background work (for example emails not being sent, payment notifications failing, calendar sync out of date, or a scheduled job not running). Details are on the System page in admin.",
        },
        { link: "Open the System page", href: `${d.siteUrl}/admin/system` },
      ],
      d,
    ),
  owner_calendar_sync_failed: (d) =>
    render(
      "Calendar sync is failing",
      [
        {
          p: `${d.detail ?? "An imported calendar"} has failed to sync repeatedly. Dates booked elsewhere may not be blocked on the website until it recovers. Previously imported dates remain blocked.`,
        },
        { link: "Check calendar connections", href: d.adminUrl },
      ],
      d,
    ),
};

export function renderEmail(
  template: NotificationTemplate,
  data: TemplateData,
): RenderedEmail {
  return TEMPLATES[template](data);
}
