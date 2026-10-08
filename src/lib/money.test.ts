import { describe, expect, it } from "vitest";
import { formatMoney } from "./money";

describe("formatMoney", () => {
  it("formats pence as pounds", () => {
    expect(formatMoney(12_345)).toBe("£123.45");
    expect(formatMoney(30_000)).toBe("£300");
    expect(formatMoney(5)).toBe("£0.05");
    expect(formatMoney(123_456_700)).toBe("£1,234,567");
  });
});
