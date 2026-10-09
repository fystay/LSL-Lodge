import { describe, expect, it } from "vitest";
import {
  feeRuleSchema,
  ownerBlockSchema,
  parsePounds,
  paymentPolicySchema,
  propertySettingsSchema,
  rateRuleSchema,
} from "./schemas";

describe("parsePounds", () => {
  it.each([
    ["150", 15_000],
    ["150.5", 15_050],
    ["150.05", 15_005],
    ["£1,200.00", 120_000],
    ["0", 0],
  ])("%s → %d pence", (input, pence) => {
    expect(parsePounds(input)).toBe(pence);
  });

  it.each(["", "abc", "-5", "1.234", "1e3", "12345678"])(
    "rejects %s",
    (input) => {
      expect(parsePounds(input)).toBeNull();
    },
  );
});

describe("admin form schemas", () => {
  it("validates owner block ranges", () => {
    expect(
      ownerBlockSchema.safeParse({
        startsOn: "2027-01-05",
        endsOn: "2027-01-05",
      }).success,
    ).toBe(false);
    expect(
      ownerBlockSchema.safeParse({
        startsOn: "2027-01-05",
        endsOn: "2027-01-08",
        reason: "",
      }).data,
    ).toEqual({
      startsOn: "2027-01-05",
      endsOn: "2027-01-08",
      reason: null,
    });
  });

  it("parses rate rules in pounds and normalises arrival days", () => {
    const result = rateRuleSchema.safeParse({
      name: "Summer",
      startsOn: "2027-06-01",
      endsOn: "2027-09-01",
      nightly: "175",
      weekendNightly: "210.50",
      minNights: "3",
      priority: "",
      arrivalDays: ["5", "1", "5"],
    });
    expect(result.data).toMatchObject({
      nightly: 17_500,
      weekendNightly: 21_050,
      minNights: 3,
      priority: 0,
      arrivalDays: [1, 5],
    });
    // All seven days means "any day".
    const any = rateRuleSchema.safeParse({
      name: "x",
      startsOn: "2027-06-01",
      endsOn: "2027-06-02",
      nightly: "1",
      arrivalDays: ["1", "2", "3", "4", "5", "6", "7"],
    });
    expect(any.data?.arrivalDays).toBeNull();
  });

  it("requires the right amount field for each fee kind", () => {
    const base = { name: "Fee", taxTreatment: "UNCONFIRMED" };
    expect(
      feeRuleSchema.safeParse({ ...base, kind: "PER_STAY", amount: "60" }).data
        ?.amount,
    ).toBe(6_000);
    expect(feeRuleSchema.safeParse({ ...base, kind: "PER_STAY" }).success).toBe(
      false,
    );
    expect(
      feeRuleSchema.safeParse({
        ...base,
        kind: "PERCENT_OF_ACCOMMODATION",
        percent: "2.5",
      }).data?.percent,
    ).toBe(250);
    expect(
      feeRuleSchema.safeParse({
        ...base,
        kind: "PERCENT_OF_ACCOMMODATION",
        percent: "101",
      }).success,
    ).toBe(false);
  });

  it("requires a coherent deposit policy", () => {
    expect(paymentPolicySchema.safeParse({ mode: "FULL" }).success).toBe(true);
    expect(
      paymentPolicySchema.safeParse({ mode: "DEPOSIT", balanceDueDays: "42" })
        .success,
    ).toBe(false);
    expect(
      paymentPolicySchema.safeParse({
        mode: "DEPOSIT",
        depositPercent: "30",
        depositFixed: "100",
        balanceDueDays: "42",
      }).success,
    ).toBe(false);
    expect(
      paymentPolicySchema.safeParse({
        mode: "DEPOSIT",
        depositPercent: "30",
        balanceDueDays: "42",
      }).data,
    ).toMatchObject({
      depositPercent: 3_000,
      balanceDueDays: 42,
    });
  });

  it("validates property settings", () => {
    const ok = propertySettingsSchema.safeParse({
      maxGuests: "6",
      defaultMinNights: "2",
      turnoverNights: "",
      bookingHorizonDays: "540",
      checkInTime: "16:00",
      checkOutTime: "",
      bookingsEnabled: "on",
      requestResponseHours: "24",
      paymentWindowHours: "48",
    });
    expect(ok.data).toEqual({
      maxGuests: 6,
      defaultMinNights: 2,
      turnoverNights: 0,
      bookingHorizonDays: 540,
      checkInTime: "16:00",
      checkOutTime: null,
      bookingsEnabled: true,
      requestResponseHours: 24,
      paymentWindowHours: 48,
    });
    const windows = (
      requestResponseHours: string,
      paymentWindowHours: string,
    ) =>
      propertySettingsSchema.safeParse({
        maxGuests: "6",
        defaultMinNights: "2",
        bookingHorizonDays: "540",
        requestResponseHours,
        paymentWindowHours,
      }).success;
    expect(windows("1", "168")).toBe(true);
    expect(windows("0", "24")).toBe(false);
    expect(windows("24", "169")).toBe(false);
    expect(windows("", "24")).toBe(false);
    expect(
      propertySettingsSchema.safeParse({
        maxGuests: "6",
        defaultMinNights: "2",
        bookingHorizonDays: "540",
        checkInTime: "4pm",
      }).success,
    ).toBe(false);
  });
});
