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

  it("distinguishes awaiting approval, awaiting payment and processing", () => {
    expect(
      guestStatus(
        { status: "REQUESTED", holdExpiresAt: later, paymentStatuses: [] },
        NOW,
      ),
    ).toBe("AWAITING_APPROVAL");
    expect(
      guestStatus(
        { status: "APPROVED", holdExpiresAt: later, paymentStatuses: [] },
        NOW,
      ),
    ).toBe("APPROVED_AWAITING_PAYMENT");
    expect(
      guestStatus(
        {
          status: "APPROVED",
          holdExpiresAt: later,
          paymentStatuses: ["PROCESSING"],
        },
        NOW,
      ),
    ).toBe("PAYMENT_PROCESSING");
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
    expect(at("REFUNDED")).toBe("CANCELLED");
    expect(at("REQUIRES_REVIEW")).toBe("UNDER_REVIEW");
    expect(at("PAYMENT_DUE")).toBe("CONFIRMED_BALANCE_DUE");
  });
});
