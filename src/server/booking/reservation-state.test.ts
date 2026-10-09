import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  BLOCKING_STATUSES,
  canTransition,
  IllegalTransitionError,
  RESERVATION_STATUSES,
} from "./reservation-state";

describe("reservation state machine", () => {
  it("defines transitions for every status", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      [...RESERVATION_STATUSES].sort(),
    );
  });

  it("never allows reaching CONFIRMED from a terminal or freed state", () => {
    for (const from of [
      "CANCELLED",
      "EXPIRED",
      "REFUNDED",
      "REFUND_PENDING",
    ] as const) {
      expect(canTransition(from, "CONFIRMED")).toBe(false);
    }
  });

  it("only reaches CONFIRMED from approval, an instant hold, a balance or review", () => {
    const into = RESERVATION_STATUSES.filter((from) =>
      canTransition(from, "CONFIRMED"),
    ).sort();
    expect(into).toEqual(
      ["APPROVED", "PAYMENT_DUE", "PENDING_PAYMENT", "REQUIRES_REVIEW"].sort(),
    );
  });

  it("never lets a request skip approval", () => {
    expect(canTransition("REQUESTED", "CONFIRMED")).toBe(false);
    expect(canTransition("REQUESTED", "PAYMENT_DUE")).toBe(false);
    expect(canTransition("DECLINED", "APPROVED")).toBe(false);
    expect(ALLOWED_TRANSITIONS.DECLINED).toEqual([]);
  });

  it("routes a late payment on an expired hold to review only", () => {
    expect(ALLOWED_TRANSITIONS.EXPIRED).toEqual(["REQUIRES_REVIEW"]);
  });

  it("treats REFUNDED as terminal", () => {
    expect(ALLOWED_TRANSITIONS.REFUNDED).toEqual([]);
  });

  it("keeps requests, holds and review cases blocking the calendar", () => {
    expect(BLOCKING_STATUSES).toContain("REQUESTED");
    expect(BLOCKING_STATUSES).toContain("APPROVED");
    expect(BLOCKING_STATUSES).toContain("PENDING_PAYMENT");
    expect(BLOCKING_STATUSES).not.toContain("DECLINED");
    expect(BLOCKING_STATUSES).toContain("REQUIRES_REVIEW");
    expect(BLOCKING_STATUSES).not.toContain("EXPIRED");
    expect(BLOCKING_STATUSES).not.toContain("CANCELLED");
  });

  it("throws a typed error for illegal transitions", () => {
    expect(() => assertTransition("CANCELLED", "CONFIRMED")).toThrow(
      IllegalTransitionError,
    );
    expect(() =>
      assertTransition("PENDING_PAYMENT", "CONFIRMED"),
    ).not.toThrow();
  });
});
