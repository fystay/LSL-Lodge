import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/server/db/client";
import { auditLogs, webhookEvents } from "@/server/db/schema";
import {
  applyCheckoutSession,
  markCheckoutFailed,
  type ApplyOutcome,
} from "./checkout";
import { snapshotFromStripe } from "./gateway";

/**
 * Processes a signature-verified Stripe event exactly once.
 *
 * The event ID is recorded (unique per provider) and its effect applied in
 * the same transaction, with the event row locked. A duplicate delivery of a
 * processed event is acknowledged without doing anything; a delivery of an
 * event whose earlier processing failed is retried. Out-of-order delivery is
 * safe because applyCheckoutSession only ever moves a payment forward.
 */

export type WebhookOutcome =
  | { handled: "duplicate" }
  | { handled: "ignored"; type: string }
  | {
      handled: "applied";
      type: string;
      outcome: ApplyOutcome | "FAILED_MARKED";
    };

const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

export async function processStripeEvent(
  db: Database,
  event: Pick<Stripe.Event, "id" | "type" | "data">,
  now = new Date(),
): Promise<WebhookOutcome> {
  try {
    return await db.transaction(async (tx) => {
      await tx
        .insert(webhookEvents)
        .values({
          provider: "stripe",
          providerEventId: event.id,
          type: event.type,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.provider, "stripe"),
            eq(webhookEvents.providerEventId, event.id),
          ),
        )
        .for("update");
      if (row.state === "PROCESSED" || row.state === "IGNORED")
        return { handled: "duplicate" } as const;

      const finish = (state: "PROCESSED" | "IGNORED") =>
        tx
          .update(webhookEvents)
          .set({
            state,
            processedAt: now,
            attempts: sql`${webhookEvents.attempts} + 1`,
            lastErrorCode: null,
          })
          .where(eq(webhookEvents.id, row.id));

      if (!CHECKOUT_EVENTS.has(event.type)) {
        await finish("IGNORED");
        return { handled: "ignored", type: event.type } as const;
      }

      const session = event.data.object as Stripe.Checkout.Session;
      const outcome =
        event.type === "checkout.session.async_payment_failed"
          ? (await markCheckoutFailed(tx, session.id), "FAILED_MARKED" as const)
          : await applyCheckoutSession(tx, snapshotFromStripe(session), now);
      if (outcome === "UNKNOWN_SESSION" && session.payment_status === "paid") {
        // Money we can't tie to a booking: never drop it quietly.
        await tx.insert(auditLogs).values({
          actorType: "WEBHOOK",
          action: "payment.unmatched_session",
          targetType: "stripe_checkout_session",
          targetId: session.id,
          metadata: { eventId: event.id },
        });
        console.error("stripe.unmatched_paid_session", {
          eventId: event.id,
          sessionId: session.id,
        });
      }
      await finish("PROCESSED");
      return { handled: "applied", type: event.type, outcome } as const;
    });
  } catch (error) {
    // Record the failure outside the rolled-back transaction, then rethrow so
    // the route answers 500 and Stripe retries the delivery.
    await db
      .insert(webhookEvents)
      .values({
        provider: "stripe",
        providerEventId: event.id,
        type: event.type,
        state: "FAILED",
        attempts: 1,
        lastErrorCode: errorCode(error),
      })
      .onConflictDoUpdate({
        target: [webhookEvents.provider, webhookEvents.providerEventId],
        set: {
          state: "FAILED",
          attempts: sql`${webhookEvents.attempts} + 1`,
          lastErrorCode: errorCode(error),
        },
      });
    throw error;
  }
}

/** A short, non-sensitive code for the error (never the message or payload). */
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code).slice(0, 40);
  return error instanceof Error ? error.name.slice(0, 40) : "UNKNOWN";
}
