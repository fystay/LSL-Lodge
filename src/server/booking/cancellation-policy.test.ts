import { describe, expect, it } from "vitest";
import {
  CANCELLATION_POLICY,
  formatDeadline,
  freeCancellationUntil,
  refundEligible,
} from "./cancellation-policy";

const requestedAt = new Date("2026-10-09T13:32:45.500Z");
const deadline = freeCancellationUntil(requestedAt);

describe("24-hour free cancellation", () => {
  it("ends exactly 24 hours after the request", () => {
    expect(CANCELLATION_POLICY.freeCancellationHours).toBe(24);
    expect(deadline.toISOString()).toBe("2026-10-10T13:32:45.500Z");
  });

  it("is refundable immediately before the deadline", () => {
    expect(refundEligible(deadline, new Date(deadline.getTime() - 1))).toBe(
      true,
    );
    expect(refundEligible(deadline, requestedAt)).toBe(true);
  });

  it("is NOT refundable exactly at the deadline (strictly-before rule)", () => {
    expect(refundEligible(deadline, new Date(deadline.getTime()))).toBe(false);
  });

  it("is not refundable immediately after the deadline", () => {
    expect(refundEligible(deadline, new Date(deadline.getTime() + 1))).toBe(
      false,
    );
  });

  it("is not refundable when no deadline was recorded", () => {
    expect(refundEligible(null, requestedAt)).toBe(false);
  });

  it("shows guests the deadline rounded down to the minute, in UK time", () => {
    // 13:32:45 UTC on 10 October is 14:32 British Summer Time.
    expect(formatDeadline(deadline, "Europe/London")).toBe(
      "2:32pm on Saturday 10 October 2026",
    );
  });

  it("handles the clocks going back (BST → GMT)", () => {
    // Booked 01:30 BST on 25 Oct 2026 = 00:30 UTC; 24 h later is 00:30 UTC
    // on 26 Oct = 00:30 GMT (the local clock reading differs by an hour).
    const atChange = freeCancellationUntil(new Date("2026-10-25T00:30:00Z"));
    expect(atChange.toISOString()).toBe("2026-10-26T00:30:00.000Z");
    expect(formatDeadline(atChange, "Europe/London")).toBe(
      "12:30am on Monday 26 October 2026",
    );
  });
});
