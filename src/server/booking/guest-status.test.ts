import { describe, expect, it } from "vitest";
import { guestStatus } from "./guest-status";
import { RESERVATION_STATUSES } from "./reservation-state";

const NOW = new Date("2026-10-09T12:00:00Z");
const later = new Date(NOW.getTime() + 60_000);
const earlier = new Date(NOW.getTime() - 60_000);

describe("guestStatus", () => {
  it("never reports a request as confirmed", () => {
    for (const status of RESERVATION_STATUSES) {
      const shown = guestStatus(
        { status, holdExpiresAt: later, paymentStatuses: ["SUCCEEDED"] },
        NOW,
      );
      if (shown === "CONFIRMED" || shown === "CONFIRMED_BALANCE_DUE")
        expect(["CONFIRMED", "PAYMENT_DUE"]).toContain(status);
    }
  });

  it("distinguishes a held booking awaiting payment from processing", () => {
    expect(
      guestStatus(
        {
          status: "PENDING_PAYMENT",
          holdExpiresAt: later,
          paymentStatuses: [],
        },
        NOW,
      ),
    ).toBe("HOLD_AWAITING_PAYMENT");
    expect(
      guestStatus(
        {
          status: "PENDING_PAYMENT",
          holdExpiresAt: later,
          paymentStatuses: ["PROCESSING"],
        },
        NOW,
      ),
    ).toBe("PAYMENT_PROCESSING");
  });

  it("maps legacy request-mode rows safely", () => {
    expect(
      guestStatus(
        { status: "REQUESTED", holdExpiresAt: later, paymentStatuses: [] },
        NOW,
      ),
    ).toBe("UNDER_REVIEW");
    expect(
      guestStatus(
        { status: "APPROVED", holdExpiresAt: later, paymentStatuses: [] },
        NOW,
      ),
    ).toBe("HOLD_AWAITING_PAYMENT");
  });

  it("shows a lapsed request or approval as expired before the sweeper runs", () => {
    for (const status of ["REQUESTED", "APPROVED", "PENDING_PAYMENT"] as const)
      expect(
        guestStatus(
          { status, holdExpiresAt: earlier, paymentStatuses: [] },
          NOW,
        ),
      ).toBe("EXPIRED");
  });

  it("keeps a processing payment visible past the deadline", () => {
    expect(
      guestStatus(
        {
          status: "APPROVED",
          holdExpiresAt: earlier,
          paymentStatuses: ["PROCESSING"],
        },
        NOW,
      ),
    ).toBe("PAYMENT_PROCESSING");
  });

  it("maps owner and refund outcomes", () => {
    const at = (status: (typeof RESERVATION_STATUSES)[number]) =>
      guestStatus({ status, holdExpiresAt: null, paymentStatuses: [] }, NOW);
    expect(at("DECLINED")).toBe("DECLINED");
    expect(at("CANCELLED")).toBe("CANCELLED");
    // A refund is only "refunded" once Stripe confirmed it (REFUNDED).
    expect(at("REFUND_PENDING")).toBe("CANCELLED_REFUND_IN_PROGRESS");
    expect(at("REFUNDED")).toBe("CANCELLED_REFUNDED");
    expect(at("REQUIRES_REVIEW")).toBe("UNDER_REVIEW");
    expect(at("PAYMENT_DUE")).toBe("CONFIRMED_BALANCE_DUE");
  });
});
