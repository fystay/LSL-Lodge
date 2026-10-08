import {
  addDays,
  daysBetween,
  eachNight,
  isoWeekday,
  type IsoDate,
} from "@/lib/dates";

/**
 * Server-side price calculation. Pure: callers load the rules (inside the
 * booking transaction) and pass them in, so the same inputs always give the
 * same quote. All money is integer minor units (pence); the client never
 * supplies an amount.
 *
 * The returned Quote is stored verbatim as the reservation's immutable
 * `quote_snapshot`, including the rule IDs and versions it was built from.
 */

export interface RateRule {
  id: string;
  name: string;
  startsOn: IsoDate;
  /** Exclusive. */
  endsOn: IsoDate;
  nightlyMinor: number;
  weekendNightlyMinor: number | null;
  minNights: number | null;
  allowedArrivalWeekdays: number[] | null;
  priority: number;
  version: number;
  active: boolean;
}

export type FeeKind =
  "PER_STAY" | "PER_NIGHT" | "PER_GUEST_PER_NIGHT" | "PERCENT_OF_ACCOMMODATION";

export type TaxTreatment =
  "INCLUDED" | "EXCLUDED" | "NOT_APPLICABLE" | "UNCONFIRMED";

export interface FeeRule {
  id: string;
  name: string;
  kind: FeeKind;
  amountMinor: number | null;
  basisPoints: number | null;
  appliesAboveGuests: number | null;
  mandatory: boolean;
  taxTreatment: TaxTreatment;
  version: number;
  active: boolean;
}

export interface PaymentPolicy {
  id: string;
  mode: "FULL" | "DEPOSIT";
  depositBasisPoints: number | null;
  depositFixedMinor: number | null;
  minimumDepositMinor: number | null;
  balanceDueDaysBeforeCheckIn: number | null;
  fullPaymentWithinDays: number | null;
  version: number;
}

export interface PricingProperty {
  currency: string;
  maxGuests: number;
  defaultMinNights: number;
}

export interface QuoteRequest {
  checkIn: IsoDate;
  checkOut: IsoDate;
  guests: number;
  /** Property-local "today", used for payment due dates. */
  today: IsoDate;
}

export interface NightPrice {
  date: IsoDate;
  amountMinor: number;
  rateRuleId: string;
  rateRuleVersion: number;
  weekend: boolean;
}

export interface QuoteLine {
  kind: "ACCOMMODATION" | "FEE";
  label: string;
  amountMinor: number;
  ruleId?: string;
  ruleVersion?: number;
  taxTreatment?: TaxTreatment;
}

export interface ScheduleItem {
  sequence: number;
  purpose: "FULL" | "DEPOSIT" | "BALANCE";
  amountMinor: number;
  dueOn: IsoDate;
}

export interface Quote {
  version: 1;
  currency: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  nights: number;
  guests: number;
  nightly: NightPrice[];
  lines: QuoteLine[];
  accommodationMinor: number;
  feesMinor: number;
  totalMinor: number;
  schedule: ScheduleItem[];
  paymentPolicy: { id: string; version: number; mode: "FULL" | "DEPOSIT" };
  /** True when any fee's tax treatment has not been confirmed by the owner. */
  taxUnconfirmed: boolean;
}

export type QuoteError =
  | { code: "INVALID_RANGE" }
  | { code: "TOO_MANY_GUESTS"; maxGuests: number }
  | { code: "NO_RATE"; dates: IsoDate[] }
  | { code: "MIN_NIGHTS"; minNights: number }
  | { code: "ARRIVAL_DAY"; allowedWeekdays: number[] };

export type QuoteResult =
  { ok: true; quote: Quote } | { ok: false; error: QuoteError };

/** Friday and Saturday nights use the weekend rate where one is set. */
const isWeekendNight = (date: IsoDate) => {
  const day = isoWeekday(date);
  return day === 5 || day === 6;
};

/**
 * The rule that prices a given night: highest priority, then the most
 * specific (shortest) range, then the latest start, then ID for determinism.
 */
export function ruleForNight(
  rules: readonly RateRule[],
  date: IsoDate,
): RateRule | undefined {
  return rules
    .filter((r) => r.active && r.startsOn <= date && date < r.endsOn)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        daysBetween(a.startsOn, a.endsOn) - daysBetween(b.startsOn, b.endsOn) ||
        (a.startsOn < b.startsOn ? 1 : a.startsOn > b.startsOn ? -1 : 0) ||
        a.id.localeCompare(b.id),
    )[0];
}

/** Integer percentage of an amount, rounded half up. */
export function applyBasisPoints(amountMinor: number, basisPoints: number) {
  return Math.floor((amountMinor * basisPoints + 5_000) / 10_000);
}

export function calculateQuote(
  property: PricingProperty,
  rates: readonly RateRule[],
  fees: readonly FeeRule[],
  policy: PaymentPolicy,
  request: QuoteRequest,
): QuoteResult {
  const { checkIn, checkOut, guests, today } = request;
  if (checkOut <= checkIn)
    return { ok: false, error: { code: "INVALID_RANGE" } };
  if (!Number.isInteger(guests) || guests < 1)
    return { ok: false, error: { code: "INVALID_RANGE" } };
  if (guests > property.maxGuests)
    return {
      ok: false,
      error: { code: "TOO_MANY_GUESTS", maxGuests: property.maxGuests },
    };

  const nights = eachNight({ start: checkIn, end: checkOut });
  const nightly: NightPrice[] = [];
  const missing: IsoDate[] = [];
  for (const date of nights) {
    const rule = ruleForNight(rates, date);
    if (!rule) {
      missing.push(date);
      continue;
    }
    const weekend = isWeekendNight(date);
    nightly.push({
      date,
      amountMinor:
        weekend && rule.weekendNightlyMinor !== null
          ? rule.weekendNightlyMinor
          : rule.nightlyMinor,
      rateRuleId: rule.id,
      rateRuleVersion: rule.version,
      weekend,
    });
  }
  if (missing.length > 0)
    return { ok: false, error: { code: "NO_RATE", dates: missing } };

  // Stay rules come from the rule that prices the arrival night.
  const arrivalRule = ruleForNight(rates, checkIn)!;
  const minNights = Math.max(
    property.defaultMinNights,
    arrivalRule.minNights ?? 0,
  );
  if (nights.length < minNights)
    return { ok: false, error: { code: "MIN_NIGHTS", minNights } };
  const allowed = arrivalRule.allowedArrivalWeekdays;
  if (allowed && allowed.length > 0 && !allowed.includes(isoWeekday(checkIn)))
    return {
      ok: false,
      error: { code: "ARRIVAL_DAY", allowedWeekdays: [...allowed].sort() },
    };

  const accommodationMinor = nightly.reduce((sum, n) => sum + n.amountMinor, 0);
  const lines: QuoteLine[] = [
    {
      kind: "ACCOMMODATION",
      label: `${nights.length} night${nights.length === 1 ? "" : "s"}`,
      amountMinor: accommodationMinor,
    },
  ];

  let taxUnconfirmed = false;
  for (const fee of fees) {
    if (!fee.active || !fee.mandatory) continue;
    const amount = feeAmount(fee, accommodationMinor, nights.length, guests);
    if (amount === 0) continue;
    if (fee.taxTreatment === "UNCONFIRMED") taxUnconfirmed = true;
    lines.push({
      kind: "FEE",
      label: fee.name,
      amountMinor: amount,
      ruleId: fee.id,
      ruleVersion: fee.version,
      taxTreatment: fee.taxTreatment,
    });
  }
  const feesMinor = lines
    .filter((l) => l.kind === "FEE")
    .reduce((sum, l) => sum + l.amountMinor, 0);
  const totalMinor = accommodationMinor + feesMinor;

  return {
    ok: true,
    quote: {
      version: 1,
      currency: property.currency,
      checkIn,
      checkOut,
      nights: nights.length,
      guests,
      nightly,
      lines,
      accommodationMinor,
      feesMinor,
      totalMinor,
      schedule: paymentSchedule(policy, totalMinor, checkIn, today),
      paymentPolicy: {
        id: policy.id,
        version: policy.version,
        mode: policy.mode,
      },
      taxUnconfirmed,
    },
  };
}

function feeAmount(
  fee: FeeRule,
  accommodationMinor: number,
  nights: number,
  guests: number,
): number {
  switch (fee.kind) {
    case "PER_STAY":
      return fee.amountMinor ?? 0;
    case "PER_NIGHT":
      return (fee.amountMinor ?? 0) * nights;
    case "PER_GUEST_PER_NIGHT": {
      const chargeable = Math.max(0, guests - (fee.appliesAboveGuests ?? 0));
      return (fee.amountMinor ?? 0) * chargeable * nights;
    }
    case "PERCENT_OF_ACCOMMODATION":
      return applyBasisPoints(accommodationMinor, fee.basisPoints ?? 0);
  }
}

/**
 * Splits the total into what is due now and later.
 *
 * - FULL policy, or a booking made inside the full-payment window, or a
 *   balance date that would already have passed: one payment due today.
 * - Otherwise a deposit today (percentage or fixed, at least the minimum,
 *   never more than the total) and the balance N days before check-in.
 */
export function paymentSchedule(
  policy: PaymentPolicy,
  totalMinor: number,
  checkIn: IsoDate,
  today: IsoDate,
): ScheduleItem[] {
  const full: ScheduleItem[] = [
    { sequence: 1, purpose: "FULL", amountMinor: totalMinor, dueOn: today },
  ];
  if (policy.mode === "FULL" || totalMinor === 0) return full;

  const daysToArrival = daysBetween(today, checkIn);
  if (
    policy.fullPaymentWithinDays !== null &&
    daysToArrival <= policy.fullPaymentWithinDays
  )
    return full;

  const balanceDueOn = addDays(
    checkIn,
    -(policy.balanceDueDaysBeforeCheckIn ?? 0),
  );
  if (balanceDueOn <= today) return full;

  let deposit =
    policy.depositBasisPoints !== null
      ? applyBasisPoints(totalMinor, policy.depositBasisPoints)
      : (policy.depositFixedMinor ?? totalMinor);
  deposit = Math.max(deposit, policy.minimumDepositMinor ?? 0);
  if (deposit >= totalMinor) return full;

  return [
    { sequence: 1, purpose: "DEPOSIT", amountMinor: deposit, dueOn: today },
    {
      sequence: 2,
      purpose: "BALANCE",
      amountMinor: totalMinor - deposit,
      dueOn: balanceDueOn,
    },
  ];
}

export function describeQuoteError(error: QuoteError): string {
  switch (error.code) {
    case "INVALID_RANGE":
      return "Those dates or guest numbers aren’t valid.";
    case "TOO_MANY_GUESTS":
      return `The lodge sleeps up to ${error.maxGuests}.`;
    case "NO_RATE":
      return "Some of those nights aren’t open for booking yet.";
    case "MIN_NIGHTS":
      return `The minimum stay for those dates is ${error.minNights} nights.`;
    case "ARRIVAL_DAY":
      return `For those dates, stays can start on ${error.allowedWeekdays
        .map((d) => WEEKDAYS[d - 1])
        .join(" or ")}.`;
  }
}

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
