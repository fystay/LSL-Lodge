import { describe, expect, it } from "vitest";
import { holdRequestSchema } from "./guest-details";

const valid = {
  checkIn: "2027-03-01",
  checkOut: "2027-03-04",
  guests: "2",
  idempotencyKey: "6f1c1b8e-6a2e-4a3c-9a55-2c7a3f0e9b11",
  name: "Sam Guest",
  email: "sam@example.test",
  phone: "",
  acceptTerms: "on",
};

describe("holdRequestSchema", () => {
  it("accepts a complete request and normalises an empty phone to null", () => {
    const result = holdRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data?.phone).toBeNull();
    expect(result.data?.guests).toBe(2);
  });

  it("requires the terms to be accepted", () => {
    const { acceptTerms: _omit, ...rest } = valid;
    void _omit;
    expect(holdRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects bad dates, keys, emails and phone numbers", () => {
    for (const patch of [
      { checkIn: "2027-02-30" },
      { idempotencyKey: "not-a-uuid" },
      { email: "nope" },
      { phone: "<script>" },
      { guests: "0" },
    ]) {
      expect(
        holdRequestSchema.safeParse({ ...valid, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("ignores any client-supplied price", () => {
    const result = holdRequestSchema.safeParse({ ...valid, totalMinor: "1" });
    expect(result.success && "totalMinor" in result.data).toBe(false);
  });
});
