import { describe, expect, it } from "vitest";
import { NOTIFICATION_TEMPLATES } from "./outbox";
import { escapeHtml, renderEmail, type TemplateData } from "./templates";

// Test data only.
const data: TemplateData = {
  siteName: "Lodge on the Lake",
  siteUrl: "https://example.test",
  publicRef: "LL-ABC234",
  guestName: `Ann <script>alert("x")</script> & Co`,
  checkIn: "Mon 1 Mar 2027",
  checkOut: "Thu 4 Mar 2027",
  nights: 3,
  guests: 2,
  total: "£300.00",
  amountDue: "£300.00",
  deadline: "Saturday 10 October 2026 at 12:00",
  bookingUrl: "https://example.test/book/LL-ABC234/access?t=g1.1.abc",
  adminUrl: "https://example.test/admin/bookings/x",
  freeCancellationUntil: "2:32pm on Saturday 10 October 2026",
  refundAmount: "£300.00",
};

const templates = Object.keys(
  NOTIFICATION_TEMPLATES,
) as (keyof typeof NOTIFICATION_TEMPLATES)[];

describe("email templates", () => {
  it("escapes every interpolated value in HTML", () => {
    for (const t of templates) {
      const { html } = renderEmail(t, data);
      expect(html, t).not.toContain("<script>");
    }
    expect(renderEmail("booking_confirmed", data).html).toContain(
      "Ann &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co",
    );
  });

  it("gives every message a subject with the reference and a text part", () => {
    for (const t of templates) {
      const email = renderEmail(t, data);
      expect(email.subject, t).toContain("LL-ABC234");
      expect(email.text.length, t).toBeGreaterThan(40);
      expect(email.text, t).toContain("/cancellation-policy");
    }
  });

  it("never tells a guest a booking is confirmed before payment", () => {
    const { text, subject } = renderEmail("payment_failed", data);
    expect(`${subject} ${text}`).not.toMatch(
      /booking is confirmed\b(?! only)/i,
    );
    expect(renderEmail("booking_confirmed", data).text).toContain(
      "Your booking is confirmed",
    );
  });

  it("states the free-cancellation deadline in the confirmation", () => {
    const { text, html } = renderEmail("booking_confirmed", data);
    expect(text).toContain("2:32pm on Saturday 10 October 2026");
    expect(text).toMatch(/non-refundable/i);
    expect(html).toContain("2:32pm on Saturday 10 October 2026");
  });

  it("says a refund is processing, not complete, when a guest cancels in time", () => {
    const { text } = renderEmail("guest_cancellation_confirmed", {
      ...data,
      refundAmount: "£300.00",
    });
    expect(text).toContain("£300.00");
    expect(text).toMatch(/being processed/);
    expect(text).not.toMatch(/has been refunded/i);
    const late = renderEmail("guest_cancellation_confirmed", {
      ...data,
      refundAmount: null,
    }).text;
    expect(late).toMatch(/no refund is due/);
  });

  it("keeps guest contact details out of owner emails", () => {
    for (const t of templates.filter(
      (t) => NOTIFICATION_TEMPLATES[t] === "OWNER",
    )) {
      const { text } = renderEmail(t, data);
      expect(text, t).not.toContain("Ann");
      expect(text, t).not.toContain("access?t=");
    }
  });

  it("falls back gracefully when guest links aren't configured", () => {
    const { text } = renderEmail("booking_confirmed", {
      ...data,
      bookingUrl: null,
    });
    expect(text).not.toContain("access?t=");
    expect(text).toContain("booking page");
  });

  it("escapes attribute-breaking characters", () => {
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });
});
