import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { todayInTimeZone, type IsoDate } from "@/lib/dates";
import type { Database, Transaction } from "@/server/db/client";
import {
  auditLogs,
  paymentScheduleItems,
  properties,
  reservations,
} from "@/server/db/schema";
import { enqueueForReservation } from "@/server/notifications/outbox";
import {
  conflictingBlocks,
  loadBlocks,
  type BlockSource,
} from "./availability";
import { expireLapsedHolds } from "./holds";

/**
 * Owner decisions on booking requests. Every function runs in one
 * transaction that locks the property row first (the same order as
 * createHold, so they cannot deadlock), then the reservation row, and
 * re-reads state under those locks. Callers must have passed requireAdmin();
 * `actor` is the admin's email, recorded in the audit log.
 */

export type DecisionResult =
  | { ok: true; paymentDueBy?: Date }
  | {
      ok: false;
      reason: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED";
    }
  | { ok: false; reason: "CONFLICT"; sources: BlockSource[] };

async function lockReservation(
  tx: Transaction,
  propertyId: string,
  reservationId: string,
) {
  await tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .for("update");
  const [row] = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.id, reservationId),
        eq(reservations.propertyId, propertyId),
      ),
    )
    .for("update");
  return row ?? null;
}

const note = (value: string | null | undefined) =>
  value?.trim().slice(0, 1000) || null;

/**
 * Approves a pending request. The dates stay held, now until the guest's
 * payment deadline, and the guest is asked to pay the full agreed amount.
 * Nothing is charged here. Refused if the request has lapsed or if anything
 * (an owner block, an imported Airbnb or Google busy period) now overlaps it.
 */
export async function approveRequest(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    actor: string;
    ownerNote?: string | null;
    now?: Date;
  },
): Promise<DecisionResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lockReservation(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    if (r.status !== "REQUESTED")
      return { ok: false, reason: "NOT_PENDING" } as const;
    if (!r.holdExpiresAt || r.holdExpiresAt <= now) {
      await expireLapsedHolds(tx, input.propertyId, now);
      return { ok: false, reason: "EXPIRED" } as const;
    }

    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, input.propertyId));
    const stay = { start: r.checkIn as IsoDate, end: r.checkOut as IsoDate };
    const blocks = (
      await loadBlocks(tx, property.id, stay, property.turnoverNights, now)
    ).filter((b) => b.id !== r.id);
    const conflicts = conflictingBlocks(blocks, stay, property.turnoverNights);
    if (conflicts.length > 0)
      return {
        ok: false,
        reason: "CONFLICT",
        sources: [...new Set(conflicts.map((c) => c.source))],
      } as const;

    const paymentDueBy = new Date(
      now.getTime() + property.paymentWindowHours * 3_600_000,
    );
    await tx
      .update(reservations)
      .set({
        status: "APPROVED",
        approvedAt: now,
        approvedBy: input.actor,
        holdExpiresAt: paymentDueBy,
        ownerNote: note(input.ownerNote) ?? r.ownerNote,
      })
      .where(eq(reservations.id, r.id));
    // The amount due now falls due by the payment deadline (local date).
    await tx
      .update(paymentScheduleItems)
      .set({ dueOn: todayInTimeZone(property.timeZone, paymentDueBy) })
      .where(
        and(
          eq(paymentScheduleItems.reservationId, r.id),
          eq(paymentScheduleItems.sequence, 1),
        ),
      );
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: input.actor,
      action: "reservation.approved",
      targetType: "reservation",
      targetId: r.id,
      metadata: {
        paymentWindowHours: property.paymentWindowHours,
        paymentDueBy: paymentDueBy.toISOString(),
      },
    });
    await enqueueForReservation(tx, r.id, ["request_approved"]);
    return { ok: true, paymentDueBy } as const;
  });
}

/**
 * Declines a pending request (or one held for review that hasn't been paid).
 * The dates are released immediately. Nothing was charged, so nothing is
 * owed either way; any scheduled payments are cancelled.
 */
export async function declineRequest(
  db: Database,
  input: {
    propertyId: string;
    reservationId: string;
    actor: string;
    ownerNote?: string | null;
    now?: Date;
  },
): Promise<DecisionResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const r = await lockReservation(tx, input.propertyId, input.reservationId);
    if (!r) return { ok: false, reason: "NOT_FOUND" } as const;
    if (r.status !== "REQUESTED")
      return { ok: false, reason: "NOT_PENDING" } as const;

    await tx
      .update(reservations)
      .set({
        status: "DECLINED",
        declinedAt: now,
        declinedBy: input.actor,
        ownerNote: note(input.ownerNote) ?? r.ownerNote,
      })
      .where(eq(reservations.id, r.id));
    await tx
      .update(paymentScheduleItems)
      .set({ status: "CANCELLED" })
      .where(
        and(
          eq(paymentScheduleItems.reservationId, r.id),
          ne(paymentScheduleItems.status, "PAID"),
        ),
      );
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: input.actor,
      action: "reservation.declined",
      targetType: "reservation",
      targetId: r.id,
    });
    await enqueueForReservation(tx, r.id, ["request_declined"]);
    return { ok: true } as const;
  });
}
