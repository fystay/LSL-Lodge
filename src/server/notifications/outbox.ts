import "server-only";
import type { Executor } from "@/server/db/client";
import { notificationJobs } from "@/server/db/schema";

/**
 * Transactional outbox for notifications. A job is written in the same
 * transaction as the state change it reports, so a rolled-back change never
 * sends mail and a committed one always queues it. The idempotency key makes
 * re-running the same change (a retried webhook, a re-run sweeper) a no-op.
 *
 * Jobs hold no message content or recipient address: both are rendered from
 * the reservation at send time (src/server/notifications/dispatch.ts).
 */

export const NOTIFICATION_TEMPLATES = {
  request_received: "GUEST",
  owner_new_request: "OWNER",
  request_approved: "GUEST",
  request_declined: "GUEST",
  request_expired: "GUEST",
  owner_request_expired: "OWNER",
  payment_window_expired: "GUEST",
  payment_failed: "GUEST",
  booking_confirmed: "GUEST",
  owner_booking_confirmed: "OWNER",
  owner_payment_needs_review: "OWNER",
  owner_calendar_sync_failed: "OWNER",
  owner_calendar_conflict: "OWNER",
  owner_system_alert: "OWNER",
  booking_cancelled: "GUEST",
  owner_booking_withdrawn: "OWNER",
  owner_cancellation_requested: "OWNER",
} as const;

export type NotificationTemplate = keyof typeof NOTIFICATION_TEMPLATES;

export async function enqueueNotification(
  db: Executor,
  job: {
    template: NotificationTemplate;
    reservationId: string | null;
    /** Stable for one logical event, e.g. `${template}:${reservationId}`. */
    idempotencyKey: string;
    notBefore?: Date;
  },
): Promise<void> {
  await db
    .insert(notificationJobs)
    .values({
      template: job.template,
      recipientKind: NOTIFICATION_TEMPLATES[job.template],
      reservationId: job.reservationId,
      idempotencyKey: job.idempotencyKey,
      ...(job.notBefore ? { nextAttemptAt: job.notBefore } : {}),
    })
    .onConflictDoNothing({ target: notificationJobs.idempotencyKey });
}

/** Queues one job per template for a reservation event, keyed on the reservation. */
export async function enqueueForReservation(
  db: Executor,
  reservationId: string,
  templates: readonly NotificationTemplate[],
) {
  for (const template of templates) {
    await enqueueNotification(db, {
      template,
      reservationId,
      idempotencyKey: `${template}:${reservationId}`,
    });
  }
}
