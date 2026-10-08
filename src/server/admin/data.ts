import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { IsoDate } from "@/lib/dates";
import type { Database, Executor } from "@/server/db/client";
import {
  auditLogs,
  externalCalendarSources,
  feeRules,
  ownerBlocks,
  paymentPolicies,
  paymentScheduleItems,
  payments,
  properties,
  rateRules,
  reservations,
} from "@/server/db/schema";
import { BLOCKING_STATUSES } from "@/server/booking/reservation-state";
import type {
  feeRuleSchema,
  paymentPolicySchema,
  propertySettingsSchema,
  rateRuleSchema,
} from "./schemas";
import type { z } from "zod";

/**
 * Admin queries and mutations. Callers must have passed requireAdmin(); the
 * actor's email is recorded in the audit log for every change. Listings are
 * bounded.
 */

const PAGE_SIZE = 50;

async function audit(
  db: Executor,
  actor: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLogs).values({
    actorType: "OWNER",
    actorId: actor,
    action,
    targetType,
    targetId,
    metadata,
  });
}

// --- Reads -----------------------------------------------------------------------

export async function upcomingStays(
  db: Executor,
  propertyId: string,
  today: IsoDate,
) {
  return db
    .select({
      id: reservations.id,
      publicRef: reservations.publicRef,
      status: reservations.status,
      checkIn: reservations.checkIn,
      checkOut: reservations.checkOut,
      guests: reservations.guests,
      guestName: reservations.guestName,
      totalMinor: reservations.totalMinor,
      currency: reservations.currency,
      holdExpiresAt: reservations.holdExpiresAt,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        inArray(reservations.status, [...BLOCKING_STATUSES]),
        gte(reservations.checkOut, today),
      ),
    )
    .orderBy(asc(reservations.checkIn))
    .limit(PAGE_SIZE);
}

export async function searchReservations(
  db: Executor,
  propertyId: string,
  query: string,
  page: number,
) {
  const q = query.trim().slice(0, 100);
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select({
      id: reservations.id,
      publicRef: reservations.publicRef,
      status: reservations.status,
      source: reservations.source,
      checkIn: reservations.checkIn,
      checkOut: reservations.checkOut,
      guestName: reservations.guestName,
      totalMinor: reservations.totalMinor,
      currency: reservations.currency,
      createdAt: reservations.createdAt,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        q
          ? or(
              ilike(reservations.publicRef, pattern),
              ilike(reservations.guestName, pattern),
              ilike(reservations.guestEmail, pattern),
            )
          : undefined,
      ),
    )
    .orderBy(desc(reservations.checkIn))
    .limit(PAGE_SIZE + 1)
    .offset(Math.max(0, page) * PAGE_SIZE);
}

export { PAGE_SIZE };

export async function reservationDetail(
  db: Executor,
  propertyId: string,
  id: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(
      and(eq(reservations.id, id), eq(reservations.propertyId, propertyId)),
    );
  if (!reservation) return null;
  const [schedule, paymentRows, history] = await Promise.all([
    db
      .select()
      .from(paymentScheduleItems)
      .where(eq(paymentScheduleItems.reservationId, id))
      .orderBy(asc(paymentScheduleItems.sequence)),
    db
      .select()
      .from(payments)
      .where(eq(payments.reservationId, id))
      .orderBy(asc(payments.createdAt)),
    db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetType, "reservation"),
          eq(auditLogs.targetId, id),
        ),
      )
      .orderBy(asc(auditLogs.createdAt))
      .limit(PAGE_SIZE),
  ]);
  return { reservation, schedule, payments: paymentRows, history };
}

export async function recentAudit(db: Executor, limit = 20) {
  return db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(limit, 100));
}

export async function activeOwnerBlocks(
  db: Executor,
  propertyId: string,
  today: IsoDate,
) {
  return db
    .select()
    .from(ownerBlocks)
    .where(
      and(
        eq(ownerBlocks.propertyId, propertyId),
        isNull(ownerBlocks.removedAt),
        gte(ownerBlocks.endsOn, today),
      ),
    )
    .orderBy(asc(ownerBlocks.startsOn))
    .limit(PAGE_SIZE);
}

export async function calendarSources(db: Executor, propertyId: string) {
  // Never select encrypted_config here: this feeds UI.
  return db
    .select({
      id: externalCalendarSources.id,
      label: externalCalendarSources.label,
      provider: externalCalendarSources.provider,
      direction: externalCalendarSources.direction,
      enabled: externalCalendarSources.enabled,
      syncStatus: externalCalendarSources.syncStatus,
      lastSuccessAt: externalCalendarSources.lastSuccessAt,
      lastErrorCode: externalCalendarSources.lastErrorCode,
    })
    .from(externalCalendarSources)
    .where(eq(externalCalendarSources.propertyId, propertyId));
}

export async function pricingOverview(db: Executor, propertyId: string) {
  const [rates, fees, policies] = await Promise.all([
    db
      .select()
      .from(rateRules)
      .where(eq(rateRules.propertyId, propertyId))
      .orderBy(desc(rateRules.active), asc(rateRules.startsOn)),
    db
      .select()
      .from(feeRules)
      .where(eq(feeRules.propertyId, propertyId))
      .orderBy(desc(feeRules.active), asc(feeRules.name)),
    db
      .select()
      .from(paymentPolicies)
      .where(
        and(
          eq(paymentPolicies.propertyId, propertyId),
          eq(paymentPolicies.active, true),
        ),
      )
      .orderBy(desc(paymentPolicies.updatedAt))
      .limit(1),
  ]);
  return { rates, fees, policy: policies[0] ?? null };
}

// --- Mutations -------------------------------------------------------------------

type RateInput = z.output<typeof rateRuleSchema>;
type FeeInput = z.output<typeof feeRuleSchema>;
type PolicyInput = z.output<typeof paymentPolicySchema>;
type SettingsInput = z.output<typeof propertySettingsSchema>;

export async function createRateRule(
  db: Database,
  propertyId: string,
  actor: string,
  input: RateInput,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(rateRules)
      .values({
        propertyId,
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        nightlyMinor: input.nightly,
        weekendNightlyMinor: input.weekendNightly,
        minNights: input.minNights,
        priority: input.priority,
        allowedArrivalWeekdays: input.arrivalDays,
      })
      .returning({ id: rateRules.id });
    await audit(tx, actor, "rate_rule.created", "rate_rule", row.id, {
      ...input,
    });
    return row.id;
  });
}

/** Edits bump the rule's version; existing bookings keep their quote snapshots. */
export async function updateRateRule(
  db: Database,
  propertyId: string,
  id: string,
  actor: string,
  input: RateInput,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(rateRules)
      .set({
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        nightlyMinor: input.nightly,
        weekendNightlyMinor: input.weekendNightly,
        minNights: input.minNights,
        priority: input.priority,
        allowedArrivalWeekdays: input.arrivalDays,
        version: sql`${rateRules.version} + 1`,
      })
      .where(and(eq(rateRules.id, id), eq(rateRules.propertyId, propertyId)))
      .returning({ id: rateRules.id, version: rateRules.version });
    if (!row) return false;
    await audit(tx, actor, "rate_rule.updated", "rate_rule", id, {
      ...input,
      version: row.version,
    });
    return true;
  });
}

export async function setRateRuleActive(
  db: Database,
  propertyId: string,
  id: string,
  actor: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(rateRules)
      .set({ active, version: sql`${rateRules.version} + 1` })
      .where(and(eq(rateRules.id, id), eq(rateRules.propertyId, propertyId)))
      .returning({ id: rateRules.id });
    if (row)
      await audit(
        tx,
        actor,
        active ? "rate_rule.activated" : "rate_rule.deactivated",
        "rate_rule",
        id,
      );
    return Boolean(row);
  });
}

export async function createFeeRule(
  db: Database,
  propertyId: string,
  actor: string,
  input: FeeInput,
) {
  return db.transaction(async (tx) => {
    const percent = input.kind === "PERCENT_OF_ACCOMMODATION";
    const [row] = await tx
      .insert(feeRules)
      .values({
        propertyId,
        name: input.name,
        kind: input.kind,
        amountMinor: percent ? null : input.amount,
        basisPoints: percent ? input.percent : null,
        appliesAboveGuests:
          input.kind === "PER_GUEST_PER_NIGHT"
            ? input.appliesAboveGuests
            : null,
        taxTreatment: input.taxTreatment,
      })
      .returning({ id: feeRules.id });
    await audit(tx, actor, "fee_rule.created", "fee_rule", row.id, {
      ...input,
    });
    return row.id;
  });
}

export async function setFeeRuleActive(
  db: Database,
  propertyId: string,
  id: string,
  actor: string,
  active: boolean,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(feeRules)
      .set({ active, version: sql`${feeRules.version} + 1` })
      .where(and(eq(feeRules.id, id), eq(feeRules.propertyId, propertyId)))
      .returning({ id: feeRules.id });
    if (row)
      await audit(
        tx,
        actor,
        active ? "fee_rule.activated" : "fee_rule.deactivated",
        "fee_rule",
        id,
      );
    return Boolean(row);
  });
}

/** Saving a payment policy retires the current one and creates the next version. */
export async function savePaymentPolicy(
  db: Database,
  propertyId: string,
  actor: string,
  input: PolicyInput,
) {
  return db.transaction(async (tx) => {
    const retired = await tx
      .update(paymentPolicies)
      .set({ active: false })
      .where(
        and(
          eq(paymentPolicies.propertyId, propertyId),
          eq(paymentPolicies.active, true),
        ),
      )
      .returning({ version: paymentPolicies.version });
    const version = Math.max(0, ...retired.map((r) => r.version)) + 1;
    const deposit = input.mode === "DEPOSIT";
    const [row] = await tx
      .insert(paymentPolicies)
      .values({
        propertyId,
        mode: input.mode,
        depositBasisPoints: deposit ? input.depositPercent : null,
        depositFixedMinor: deposit ? input.depositFixed : null,
        minimumDepositMinor: deposit ? input.minimumDeposit : null,
        balanceDueDaysBeforeCheckIn: deposit ? input.balanceDueDays : null,
        fullPaymentWithinDays: deposit ? input.fullPaymentWithinDays : null,
        version,
      })
      .returning({ id: paymentPolicies.id });
    await audit(tx, actor, "payment_policy.saved", "payment_policy", row.id, {
      ...input,
      version,
    });
    return row.id;
  });
}

export async function updatePropertySettings(
  db: Database,
  propertyId: string,
  actor: string,
  input: SettingsInput,
) {
  return db.transaction(async (tx) => {
    await tx
      .update(properties)
      .set({
        maxGuests: input.maxGuests!,
        defaultMinNights: input.defaultMinNights!,
        turnoverNights: input.turnoverNights,
        bookingHorizonDays: input.bookingHorizonDays!,
        checkInTime: input.checkInTime,
        checkOutTime: input.checkOutTime,
        bookingsEnabled: input.bookingsEnabled,
      })
      .where(eq(properties.id, propertyId));
    await audit(
      tx,
      actor,
      "property.settings_updated",
      "property",
      propertyId,
      { ...input },
    );
  });
}
