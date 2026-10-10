import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { IsoDate } from "@/lib/dates";
import type { Executor } from "@/server/db/client";
import {
  feeRules,
  paymentPolicies,
  properties,
  rateRules,
} from "@/server/db/schema";
import type { FeeRule, PaymentPolicy, RateRule } from "./quote";

export type PropertyRow = typeof properties.$inferSelect;

export interface PricingInputs {
  property: PropertyRow;
  rates: RateRule[];
  fees: FeeRule[];
  policy: PaymentPolicy | null;
}

export async function loadPropertyBySlug(db: Executor, slug: string) {
  const [row] = await db
    .select()
    .from(properties)
    .where(eq(properties.slug, slug));
  return row ?? null;
}

/** Loads the active pricing rules for a property (call inside the booking transaction). */
export async function loadPricingInputs(
  db: Executor,
  property: PropertyRow,
): Promise<PricingInputs> {
  const [rates, fees, policies] = await Promise.all([
    db
      .select()
      .from(rateRules)
      .where(
        and(eq(rateRules.propertyId, property.id), eq(rateRules.active, true)),
      ),
    db
      .select()
      .from(feeRules)
      .where(
        and(eq(feeRules.propertyId, property.id), eq(feeRules.active, true)),
      ),
    db
      .select()
      .from(paymentPolicies)
      .where(
        and(
          eq(paymentPolicies.propertyId, property.id),
          eq(paymentPolicies.active, true),
        ),
      )
      .orderBy(desc(paymentPolicies.updatedAt))
      .limit(1),
  ]);

  return {
    property,
    rates: rates.map((r) => ({
      id: r.id,
      name: r.name,
      startsOn: r.startsOn as IsoDate,
      endsOn: r.endsOn as IsoDate,
      nightlyMinor: r.nightlyMinor,
      weekendNightlyMinor: r.weekendNightlyMinor,
      minNights: r.minNights,
      allowedArrivalWeekdays: r.allowedArrivalWeekdays,
      priority: r.priority,
      version: r.version,
      active: r.active,
    })),
    fees: fees.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      amountMinor: f.amountMinor,
      basisPoints: f.basisPoints,
      appliesAboveGuests: f.appliesAboveGuests,
      mandatory: f.mandatory,
      taxTreatment: f.taxTreatment,
      version: f.version,
      active: f.active,
    })),
    policy: policies[0]
      ? {
          id: policies[0].id,
          // Instant booking takes the full amount at booking (owner's
          // requirement, October 2026). Deposit plans stay in the data model
          // but are not offered; the stored policy's id and version are still
          // recorded on each quote.
          mode: "FULL" as const,
          depositBasisPoints: policies[0].depositBasisPoints,
          depositFixedMinor: policies[0].depositFixedMinor,
          minimumDepositMinor: policies[0].minimumDepositMinor,
          balanceDueDaysBeforeCheckIn: policies[0].balanceDueDaysBeforeCheckIn,
          fullPaymentWithinDays: policies[0].fullPaymentWithinDays,
          version: policies[0].version,
        }
      : null,
  };
}
