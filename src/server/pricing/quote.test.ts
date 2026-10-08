import { describe, expect, it } from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import {
  applyBasisPoints,
  calculateQuote,
  paymentSchedule,
  ruleForNight,
  type FeeRule,
  type PaymentPolicy,
  type RateRule,
} from "./quote";

// Test fixtures only. These are not real prices.
const rate = (overrides: Partial<RateRule> = {}): RateRule => ({
  id: "base",
  name: "Base",
  startsOn: d("2026-01-01"),
  endsOn: d("2028-01-01"),
  nightlyMinor: 10_000,
  weekendNightlyMinor: null,
  minNights: null,
  allowedArrivalWeekdays: null,
  priority: 0,
  version: 1,
  active: true,
  ...overrides,
});

const fee = (overrides: Partial<FeeRule>): FeeRule => ({
  id: "fee",
  name: "Fee",
  kind: "PER_STAY",
  amountMinor: 0,
  basisPoints: null,
  appliesAboveGuests: null,
  mandatory: true,
  taxTreatment: "NOT_APPLICABLE",
  version: 1,
  active: true,
  ...overrides,
});

const fullPolicy: PaymentPolicy = {
  id: "pol",
  mode: "FULL",
  depositBasisPoints: null,
  depositFixedMinor: null,
  minimumDepositMinor: null,
  balanceDueDaysBeforeCheckIn: null,
  fullPaymentWithinDays: null,
  version: 1,
};

const depositPolicy: PaymentPolicy = {
  ...fullPolicy,
  mode: "DEPOSIT",
  depositBasisPoints: 3_000,
  balanceDueDaysBeforeCheckIn: 42,
  fullPaymentWithinDays: 42,
};

const property = { currency: "GBP", maxGuests: 6, defaultMinNights: 2 };
const today = d("2026-10-08");

// 2026-11-02 is a Monday; 2026-11-06 a Friday.
const request = (checkIn: string, checkOut: string, guests = 2) => ({
  checkIn: d(checkIn),
  checkOut: d(checkOut),
  guests,
  today,
});

describe("ruleForNight", () => {
  it("prefers higher priority, then the more specific range", () => {
    const base = rate();
    const summer = rate({
      id: "summer",
      startsOn: d("2026-07-01"),
      endsOn: d("2026-09-01"),
    });
    const peak = rate({
      id: "peak",
      startsOn: d("2026-08-01"),
      endsOn: d("2026-08-08"),
      priority: 0,
    });
    const special = rate({ id: "special", priority: 5 });
    expect(ruleForNight([base, summer], d("2026-07-10"))?.id).toBe("summer");
    expect(ruleForNight([base, summer, peak], d("2026-08-03"))?.id).toBe(
      "peak",
    );
    expect(
      ruleForNight([base, summer, peak, special], d("2026-08-03"))?.id,
    ).toBe("special");
  });

  it("treats the rule end date as exclusive and ignores inactive rules", () => {
    const r = rate({ endsOn: d("2026-11-03") });
    expect(ruleForNight([r], d("2026-11-02"))?.id).toBe("base");
    expect(ruleForNight([r], d("2026-11-03"))).toBeUndefined();
    expect(
      ruleForNight([rate({ active: false })], d("2026-11-02")),
    ).toBeUndefined();
  });
});

describe("calculateQuote", () => {
  it("prices each night and totals accommodation", () => {
    const result = calculateQuote(
      property,
      [rate()],
      [],
      fullPolicy,
      request("2026-11-02", "2026-11-05"),
    );
    expect(result.ok && result.quote.accommodationMinor).toBe(30_000);
    expect(result.ok && result.quote.nights).toBe(3);
    expect(result.ok && result.quote.totalMinor).toBe(30_000);
  });

  it("charges the weekend rate on Friday and Saturday nights only", () => {
    const result = calculateQuote(
      property,
      [rate({ weekendNightlyMinor: 15_000 })],
      [],
      fullPolicy,
      request("2026-11-05", "2026-11-09"), // Thu, Fri, Sat, Sun nights
    );
    expect(result.ok && result.quote.nightly.map((n) => n.amountMinor)).toEqual(
      [10_000, 15_000, 15_000, 10_000],
    );
  });

  it("uses different rules for nights that cross a season boundary", () => {
    const winter = rate({
      id: "winter",
      startsOn: d("2026-11-04"),
      endsOn: d("2027-03-01"),
      nightlyMinor: 8_000,
    });
    const result = calculateQuote(
      property,
      [rate(), winter],
      [],
      fullPolicy,
      request("2026-11-02", "2026-11-06"),
    );
    expect(result.ok && result.quote.nightly.map((n) => n.rateRuleId)).toEqual([
      "base",
      "base",
      "winter",
      "winter",
    ]);
    expect(result.ok && result.quote.accommodationMinor).toBe(36_000);
  });

  it("records rule versions in the quote", () => {
    const result = calculateQuote(
      property,
      [rate({ version: 7 })],
      [],
      fullPolicy,
      request("2026-11-02", "2026-11-04"),
    );
    expect(result.ok && result.quote.nightly[0].rateRuleVersion).toBe(7);
  });

  it("refuses nights without a rate", () => {
    const result = calculateQuote(
      property,
      [rate({ endsOn: d("2026-11-03") })],
      [],
      fullPolicy,
      request("2026-11-02", "2026-11-05"),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "NO_RATE", dates: ["2026-11-03", "2026-11-04"] },
    });
  });

  it("enforces the larger of the property and arrival-rule minimum stay", () => {
    expect(
      calculateQuote(
        property,
        [rate()],
        [],
        fullPolicy,
        request("2026-11-02", "2026-11-03"),
      ),
    ).toEqual({
      ok: false,
      error: { code: "MIN_NIGHTS", minNights: 2 },
    });
    expect(
      calculateQuote(
        property,
        [rate({ minNights: 4 })],
        [],
        fullPolicy,
        request("2026-11-02", "2026-11-05"),
      ),
    ).toEqual({ ok: false, error: { code: "MIN_NIGHTS", minNights: 4 } });
  });

  it("enforces allowed arrival days", () => {
    const fridayOrMonday = rate({ allowedArrivalWeekdays: [5, 1] });
    expect(
      calculateQuote(
        property,
        [fridayOrMonday],
        [],
        fullPolicy,
        request("2026-11-03", "2026-11-06"),
      ),
    ).toEqual({
      ok: false,
      error: { code: "ARRIVAL_DAY", allowedWeekdays: [1, 5] },
    });
    expect(
      calculateQuote(
        property,
        [fridayOrMonday],
        [],
        fullPolicy,
        request("2026-11-06", "2026-11-09"),
      ).ok,
    ).toBe(true);
  });

  it("enforces occupancy", () => {
    expect(
      calculateQuote(
        property,
        [rate()],
        [],
        fullPolicy,
        request("2026-11-02", "2026-11-05", 7),
      ),
    ).toEqual({
      ok: false,
      error: { code: "TOO_MANY_GUESTS", maxGuests: 6 },
    });
  });

  it("applies each fee type", () => {
    const fees = [
      fee({
        id: "clean",
        name: "Cleaning",
        kind: "PER_STAY",
        amountMinor: 6_000,
      }),
      fee({ id: "linen", name: "Linen", kind: "PER_NIGHT", amountMinor: 500 }),
      fee({
        id: "extra",
        name: "Extra guests",
        kind: "PER_GUEST_PER_NIGHT",
        amountMinor: 1_000,
        appliesAboveGuests: 4,
      }),
      fee({
        id: "svc",
        name: "Service",
        kind: "PERCENT_OF_ACCOMMODATION",
        amountMinor: null,
        basisPoints: 250,
      }),
    ];
    const result = calculateQuote(
      property,
      [rate()],
      fees,
      fullPolicy,
      request("2026-11-02", "2026-11-05", 6),
    );
    expect(
      result.ok && result.quote.lines.map((l) => [l.label, l.amountMinor]),
    ).toEqual([
      ["3 nights", 30_000],
      ["Cleaning", 6_000],
      ["Linen", 1_500],
      ["Extra guests", 6_000], // 2 extra guests × 3 nights × £10
      ["Service", 750], // 2.5% of £300
    ]);
    expect(result.ok && result.quote.totalMinor).toBe(44_250);
  });

  it("omits per-guest fees when no extra guests and ignores optional or inactive fees", () => {
    const fees = [
      fee({
        id: "extra",
        kind: "PER_GUEST_PER_NIGHT",
        amountMinor: 1_000,
        appliesAboveGuests: 4,
      }),
      fee({ id: "opt", amountMinor: 999, mandatory: false }),
      fee({ id: "off", amountMinor: 999, active: false }),
    ];
    const result = calculateQuote(
      property,
      [rate()],
      fees,
      fullPolicy,
      request("2026-11-02", "2026-11-05", 4),
    );
    expect(result.ok && result.quote.lines).toHaveLength(1);
  });

  it("flags unconfirmed tax treatment", () => {
    const result = calculateQuote(
      property,
      [rate()],
      [fee({ amountMinor: 100, taxTreatment: "UNCONFIRMED" })],
      fullPolicy,
      request("2026-11-02", "2026-11-05"),
    );
    expect(result.ok && result.quote.taxUnconfirmed).toBe(true);
  });
});

describe("applyBasisPoints", () => {
  it("rounds half up in integer pence", () => {
    expect(applyBasisPoints(1_001, 5_000)).toBe(501); // 500.5 → 501
    expect(applyBasisPoints(999, 3_333)).toBe(333); // 332.97 → 333
    expect(applyBasisPoints(100, 0)).toBe(0);
  });
});

describe("paymentSchedule", () => {
  it("takes full payment under a FULL policy", () => {
    expect(paymentSchedule(fullPolicy, 50_000, d("2027-06-01"), today)).toEqual(
      [{ sequence: 1, purpose: "FULL", amountMinor: 50_000, dueOn: today }],
    );
  });

  it("splits a deposit and balance due N days before arrival", () => {
    expect(
      paymentSchedule(depositPolicy, 50_000, d("2027-06-01"), today),
    ).toEqual([
      { sequence: 1, purpose: "DEPOSIT", amountMinor: 15_000, dueOn: today },
      {
        sequence: 2,
        purpose: "BALANCE",
        amountMinor: 35_000,
        dueOn: "2027-04-20",
      },
    ]);
  });

  it("deposit plus balance always equals the total", () => {
    for (const total of [1, 99, 10_001, 33_333, 123_457]) {
      const items = paymentSchedule(
        depositPolicy,
        total,
        d("2027-06-01"),
        today,
      );
      expect(items.reduce((s, i) => s + i.amountMinor, 0)).toBe(total);
    }
  });

  it("requires full payment inside the full-payment window", () => {
    // 42 days before arrival.
    expect(
      paymentSchedule(depositPolicy, 50_000, d("2026-11-19"), today),
    ).toEqual([
      { sequence: 1, purpose: "FULL", amountMinor: 50_000, dueOn: today },
    ]);
    // 43 days before arrival: deposit allowed.
    expect(
      paymentSchedule(depositPolicy, 50_000, d("2026-11-20"), today)[0].purpose,
    ).toBe("DEPOSIT");
  });

  it("supports a fixed deposit with a minimum, capped at the total", () => {
    const fixed = {
      ...depositPolicy,
      depositBasisPoints: null,
      depositFixedMinor: 10_000,
    };
    expect(
      paymentSchedule(fixed, 50_000, d("2027-06-01"), today)[0].amountMinor,
    ).toBe(10_000);
    const withMinimum = { ...depositPolicy, minimumDepositMinor: 20_000 };
    expect(
      paymentSchedule(withMinimum, 50_000, d("2027-06-01"), today)[0]
        .amountMinor,
    ).toBe(20_000);
    expect(paymentSchedule(fixed, 8_000, d("2027-06-01"), today)).toHaveLength(
      1,
    );
  });
});
