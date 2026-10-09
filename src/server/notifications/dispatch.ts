import "server-only";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { formatStayDate, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { Database } from "@/server/db/client";
import { notificationJobs, properties, reservations } from "@/server/db/schema";
import { guestLinkSecret, signGuestLink } from "@/server/booking/guest-link";
import type { ReservationStatus } from "@/server/booking/reservation-state";
import type { Quote } from "@/server/pricing/quote";
import {
  EmailDeliveryError,
  ownerNotificationAddress,
  type EmailSender,
} from "./email";
import type { NotificationTemplate } from "./outbox";
import {
  renderEmail,
  type RenderedEmail,
  type TemplateData,
} from "./templates";

/**
 * Delivers queued notification jobs. Run by the scheduler
 * (/api/jobs/send-notifications); safe to run concurrently and repeatedly.
 *
 * - Jobs are claimed with FOR UPDATE SKIP LOCKED, so two runners never take
 *   the same job, and marked SENDING before any network call. A runner that
 *   dies mid-send leaves the job SENDING; it is reclaimed after
 *   STUCK_MINUTES, and the provider's idempotency key prevents a duplicate.
 * - Content and recipient are resolved at send time from the reservation, so
 *   no message content or address is stored in the job.
 * - A message that no longer matches the booking's state (e.g. "please pay"
 *   after it has lapsed) is cancelled, not sent.
 * - Transient failures retry with exponential backoff and jitter, up to
 *   MAX_ATTEMPTS, then the job is FAILED and shows in admin.
 */

export const MAX_ATTEMPTS = 6;
const STUCK_MINUTES = 15;
const BATCH = 20;

/** Statuses in which each guest-facing message still makes sense. */
const RELEVANT: Partial<Record<NotificationTemplate, ReservationStatus[]>> = {
  request_received: ["REQUESTED"],
  request_approved: ["APPROVED"],
  payment_failed: ["APPROVED", "PENDING_PAYMENT"],
  request_expired: ["EXPIRED"],
  payment_window_expired: ["EXPIRED"],
  booking_confirmed: ["CONFIRMED", "PAYMENT_DUE"],
};

export interface DispatchResult {
  sent: number;
  suppressed: number;
  cancelled: number;
  retried: number;
  failed: number;
}

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(60 * 60_000, 60_000 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + random()));
}

export async function dispatchNotifications(
  db: Database,
  sender: EmailSender | null,
  options: { now?: Date; limit?: number } = {},
): Promise<DispatchResult> {
  const now = options.now ?? new Date();
  const result: DispatchResult = {
    sent: 0,
    suppressed: 0,
    cancelled: 0,
    retried: 0,
    failed: 0,
  };

  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notificationJobs.id })
      .from(notificationJobs)
      .where(
        or(
          and(
            eq(notificationJobs.status, "PENDING"),
            lte(notificationJobs.nextAttemptAt, now),
          ),
          and(
            eq(notificationJobs.status, "SENDING"),
            lte(
              notificationJobs.updatedAt,
              new Date(now.getTime() - STUCK_MINUTES * 60_000),
            ),
          ),
        ),
      )
      .orderBy(notificationJobs.nextAttemptAt)
      .limit(Math.min(options.limit ?? BATCH, 100))
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(notificationJobs)
      .set({
        status: "SENDING",
        attempts: sql`${notificationJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        inArray(
          notificationJobs.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });

  for (const job of claimed) {
    const finish = (set: Partial<typeof notificationJobs.$inferInsert>) =>
      db
        .update(notificationJobs)
        .set({ ...set, updatedAt: now })
        .where(eq(notificationJobs.id, job.id));

    const prepared = await prepare(db, job, now);
    if ("cancel" in prepared) {
      // A missing recipient is a configuration fault (e.g. no owner address):
      // show it as a failure, not a deliberate cancellation.
      const failed = prepared.cancel === "NO_RECIPIENT";
      await finish({
        status: failed ? "FAILED" : "CANCELLED",
        lastErrorCode: prepared.cancel,
      });
      if (failed) result.failed++;
      else result.cancelled++;
      continue;
    }
    if (!sender) {
      // Delivery is switched off: record it plainly, never as "sent".
      await finish({ status: "SUPPRESSED", lastErrorCode: "DELIVERY_OFF" });
      result.suppressed++;
      continue;
    }
    try {
      const { providerMessageId } = await sender.send({
        to: prepared.to,
        ...prepared.email,
        idempotencyKey: `notification:${job.idempotencyKey}`,
      });
      await finish({
        status: "SENT",
        sentAt: now,
        providerMessageId,
        lastErrorCode: sender.mode === "resend-sandbox" ? "SANDBOX" : null,
      });
      result.sent++;
    } catch (error) {
      const code =
        error instanceof EmailDeliveryError ? error.code : "UNEXPECTED";
      const retryable =
        !(error instanceof EmailDeliveryError) || error.retryable;
      if (retryable && job.attempts < MAX_ATTEMPTS) {
        await finish({
          status: "PENDING",
          lastErrorCode: code,
          nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)),
        });
        result.retried++;
      } else {
        await finish({ status: "FAILED", lastErrorCode: code });
        result.failed++;
      }
    }
  }
  return result;
}

type Job = typeof notificationJobs.$inferSelect;

/** Resolves recipient and content for a job, or a reason not to send it. */
export async function prepare(
  db: Database,
  job: Pick<Job, "template" | "recipientKind" | "reservationId">,
  now: Date,
): Promise<{ to: string; email: RenderedEmail } | { cancel: string }> {
  const template = job.template as NotificationTemplate;
  const data = await templateData(db, job.reservationId, now);
  if (!data) return { cancel: "NO_RESERVATION" };
  const relevant = RELEVANT[template];
  if (relevant && data.status && !relevant.includes(data.status))
    return { cancel: "STALE" };
  const to =
    job.recipientKind === "OWNER"
      ? ownerNotificationAddress()
      : data.guestEmail;
  if (!to) return { cancel: "NO_RECIPIENT" };
  return { to, email: renderEmail(template, data.template) };
}

/** Builds template data from the reservation (or site-level data if none). */
export async function templateData(
  db: Database,
  reservationId: string | null,
  now: Date,
): Promise<{
  template: TemplateData;
  guestEmail: string | null;
  status: ReservationStatus | null;
} | null> {
  const siteUrl = (process.env.SITE_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const base = {
    siteName: "Lodge on the Lake",
    siteUrl,
    adminUrl: `${siteUrl}/admin`,
  };
  if (!reservationId)
    return {
      template: {
        ...base,
        publicRef: "",
        guestName: "",
        checkIn: "",
        checkOut: "",
        nights: 0,
        guests: 0,
        total: "",
        amountDue: "",
        deadline: null,
        bookingUrl: null,
      },
      guestEmail: null,
      status: null,
    };

  const [row] = await db
    .select({ r: reservations, timeZone: properties.timeZone })
    .from(reservations)
    .innerJoin(properties, eq(properties.id, reservations.propertyId))
    .where(eq(reservations.id, reservationId));
  if (!row) return null;
  const { r, timeZone } = row;
  const quote = r.quoteSnapshot as Quote;
  const secret = guestLinkSecret();
  const deadline =
    r.holdExpiresAt &&
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(r.holdExpiresAt);
  return {
    template: {
      ...base,
      adminUrl: `${siteUrl}/admin/bookings/${r.id}`,
      publicRef: r.publicRef,
      guestName: r.guestName,
      checkIn: formatStayDate(r.checkIn as IsoDate),
      checkOut: formatStayDate(r.checkOut as IsoDate),
      nights: quote.nights,
      guests: r.guests,
      total: formatMoney(r.totalMinor, r.currency),
      amountDue: formatMoney(
        quote.schedule?.[0]?.amountMinor ?? r.totalMinor,
        r.currency,
      ),
      deadline: deadline || null,
      bookingUrl: secret
        ? `${siteUrl}/book/${r.publicRef}/access?t=${encodeURIComponent(
            signGuestLink(secret, r.publicRef, r.id, now.getTime()),
          )}`
        : null,
      detail: r.reviewReason,
    },
    guestEmail: r.guestEmail,
    status: r.status,
  };
}
