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
  /** "2:32pm on Saturday 10 October 2026", or null for older bookings. */
  freeCancellationUntil?: string | null;
  /** Formatted refund amount for refund messages. */
  refundAmount?: string | null;
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
        d.freeCancellationUntil
          ? {
              p: `Cancellation: you can cancel for a full refund before ${d.freeCancellationUntil} (UK time), 24 hours after your payment was confirmed. After that the booking is non-refundable. To cancel, contact us through the contact page on our website; your cancellation counts from when your message reaches us.`,
            }
          : { p: "Cancellation: see the cancellation policy below." },
        bookingLink(d, "View or cancel your booking"),
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
  booking_cancelled: (d) =>
    render(
      "Your booking has been cancelled",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: "Your booking has been cancelled by the owner and the dates have been released. If you have made a payment, the owner will contact you about it.",
        },
        { list: stayLines(d) },
        bookingLink(d, "View your booking"),
      ],
      d,
    ),
  guest_cancellation_confirmed: (d) =>
    render(
      "Your booking has been cancelled",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: d.refundAmount
            ? `As requested, your booking has been cancelled. You cancelled within the free-cancellation period, so a full refund of ${d.refundAmount} is being processed to your card. We’ll email you when it’s complete; banks usually take a few working days to show it.`
            : "As requested, your booking has been cancelled. It was cancelled after the 24-hour free-cancellation period, so under the cancellation policy no refund is due.",
        },
        { list: stayLines(d) },
        bookingLink(d, "View your booking"),
      ],
      d,
    ),
  refund_completed: (d) =>
    render(
      "Your refund has been processed",
      [
        { p: `Hello ${d.guestName},` },
        {
          p: `Your refund of ${d.refundAmount ?? "the amount due"} has been processed by our payment provider. Your bank may take a few working days to show it.`,
        },
        { list: stayLines(d) },
      ],
      d,
    ),
  owner_guest_cancelled: (d) =>
    render(
      "A guest has cancelled",
      [
        {
          p: d.refundAmount
            ? `The guest cancelled within 24 hours of the booking being confirmed, so a full refund of ${d.refundAmount} is being issued automatically. The dates are free again.`
            : "The guest cancelled after the 24-hour free-cancellation period, so no refund was issued. The dates are free again.",
        },
        { list: stayLines(d) },
        adminLink(d),
      ],
      d,
    ),
  owner_refund_failed: (d) =>
    render(
      "Action needed: a refund couldn’t be issued",
      [
        {
          p: "An automatic refund still hasn’t gone through after several attempts. The guest is owed this money. Please check the booking and Stripe.",
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
          p: `${d.detail ?? "An imported calendar"} has failed to sync repeatedly. Previously imported dates remain blocked. Once it has had no successful sync for its stale period (60 minutes by default), the website stops taking new bookings, and any payment that arrives goes to you for review instead of confirming, until the calendar syncs again.`,
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
