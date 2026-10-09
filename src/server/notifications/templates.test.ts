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
    expect(renderEmail("request_received", data).html).toContain(
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

  it("never tells a guest a request is confirmed before payment", () => {
    for (const t of [
      "request_received",
      "request_approved",
      "payment_failed",
    ] as const) {
      const { text, subject } = renderEmail(t, data);
      expect(`${subject} ${text}`).not.toMatch(
        /booking is confirmed\b(?! only)/i,
      );
    }
    expect(renderEmail("request_received", data).text).toContain(
      "nothing has been charged",
    );
    expect(renderEmail("booking_confirmed", data).text).toContain(
      "Your booking is confirmed",
    );
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
    const { text } = renderEmail("request_approved", {
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
