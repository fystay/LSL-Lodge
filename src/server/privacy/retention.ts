import "server-only";
import { and, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import {
  auditLogs,
  externalBusyPeriods,
  notificationJobs,
  reservations,
  webhookEvents,
} from "@/server/db/schema";
import { BLOCKING_STATUSES } from "@/server/booking/reservation-state";

/**
 * Data retention (UK GDPR storage limitation). Runs daily, idempotent.
 *
 * - Guest contact details (name, email, phone) and the owner's private note
 *   are removed from bookings whose stay ended more than
 *   GUEST_DATA_RETENTION_DAYS ago. The booking itself (dates, amounts,
 *   payments, audit trail) stays as the business's financial record.
 * - Processed Stripe webhook records go after 90 days, sent/cancelled email
 *   jobs after 1 year, and imported calendar dates a year after they ended.
 *
 * DEFAULTS ARE PLACEHOLDERS pending the owner's retention decision and
 * legal review (docs/OWNER-DECISIONS.md): 6 years after check-out, the
 * period UK businesses commonly keep accounting records for.
 */

const DAY = 86_400_000;
export const DEFAULT_GUEST_RETENTION_DAYS = 6 * 365;
export const REMOVED_EMAIL_DOMAIN = "removed.invalid";

export function guestRetentionDays(): number {
  const raw = Number(process.env.GUEST_DATA_RETENTION_DAYS);
  // Never shorter than 30 days: a booking may still be disputed.
  return Number.isInteger(raw) && raw >= 30
    ? raw
    : DEFAULT_GUEST_RETENTION_DAYS;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function applyRetention(
  db: Database,
  now = new Date(),
  retentionDays = guestRetentionDays(),
) {
  const cutoff = isoDate(new Date(now.getTime() - retentionDays * DAY));
  const anonymised = await db.transaction(async (tx) => {
    const rows = await tx
      .update(reservations)
      .set({
        guestName: "Removed (retention)",
        guestEmail: sql`'guest-' || ${reservations.id} || ${`@${REMOVED_EMAIL_DOMAIN}`}`,
        guestPhone: null,
        ownerNote: null,
      })
      .where(
        and(
          lt(reservations.checkOut, cutoff),
          // Anything still holding dates or awaiting the owner keeps its
          // details until it's resolved.
          notInArray(reservations.status, [...BLOCKING_STATUSES]),
          sql`${reservations.guestEmail} NOT LIKE ${`%@${REMOVED_EMAIL_DOMAIN}`}`,
        ),
      )
      .returning({ id: reservations.id });
    if (rows.length > 0)
      await tx.insert(auditLogs).values({
        actorType: "SYSTEM",
        action: "retention.guest_details_removed",
        targetType: "property",
        metadata: { bookings: rows.length, retentionDays, cutoff },
      });
    return rows.length;
  });

  const webhooks = await db
    .delete(webhookEvents)
    .where(
      and(
        inArray(webhookEvents.state, ["PROCESSED", "IGNORED"]),
        lt(webhookEvents.receivedAt, new Date(now.getTime() - 90 * DAY)),
      ),
    )
    .returning({ id: webhookEvents.id });

  const emails = await db
    .delete(notificationJobs)
    .where(
      and(
        inArray(notificationJobs.status, ["SENT", "CANCELLED", "SUPPRESSED"]),
        lt(notificationJobs.createdAt, new Date(now.getTime() - 365 * DAY)),
      ),
    )
    .returning({ id: notificationJobs.id });

  const busy = await db
    .delete(externalBusyPeriods)
    .where(
      and(
        lt(
          externalBusyPeriods.endsOn,
          isoDate(new Date(now.getTime() - 365 * DAY)),
        ),
        ne(externalBusyPeriods.status, "ACTIVE"),
      ),
    )
    .returning({ id: externalBusyPeriods.id });

  return {
    guestDetailsRemoved: anonymised,
    webhookEvents: webhooks.length,
    emailJobs: emails.length,
    calendarPeriods: busy.length,
  };
}
