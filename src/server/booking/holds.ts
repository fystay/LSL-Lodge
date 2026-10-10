import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { todayInTimeZone, type IsoDate } from "@/lib/dates";
import type { Database, Executor } from "@/server/db/client";
import {
  auditLogs,
  ownerBlocks,
  paymentScheduleItems,
  payments,
  properties,
  reservations,
} from "@/server/db/schema";
import {
  calculateQuote,
  type Quote,
  type QuoteError,
} from "@/server/pricing/quote";
import { loadPricingInputs } from "@/server/pricing/load";
import { conflictingBlocks, loadBlocks, type Block } from "./availability";
import {
  guestLinkSecret,
  looksLikeGuestLink,
  verifyGuestLink,
} from "./guest-link";
import {
  CANCELLATION_POLICY,
  freeCancellationUntil,
} from "./cancellation-policy";
import { EXPIRING_STATUSES } from "./reservation-state";

/**
 * How long the dates are held while the guest pays. Stripe Checkout
 * sessions must stay open at least 30 minutes, so the hold covers that with
 * a margin; a session never outlives its hold (src/server/payments/checkout.ts).
 */
export const HOLD_MINUTES = 35;

export interface HoldInput {
  propertyId: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  guests: number;
  guest: { name: string; email: string; phone?: string | null };
  /** Generated once per booking form render; makes double submits safe. */
  idempotencyKey: string;
  now?: Date;
}

export type HoldResult =
  | {
      ok: true;
      reservationId: string;
      publicRef: string;
      /** Bearer secret for the guest's booking page. Only its hash is stored. */
      accessToken: string;
      holdExpiresAt: Date;
      /** Full refund if cancelled strictly before this (24 h from now). */
      freeCancellationUntil: Date;
      quote: Quote;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: "BOOKINGS_DISABLED" | "NOT_CONFIGURED" | "IDEMPOTENCY_MISMATCH";
    }
  | {
      ok: false;
      reason: "UNAVAILABLE";
      conflicts: Pick<Block, "start" | "end">[];
    }
  | { ok: false; reason: "QUOTE"; error: QuoteError };

const EXCLUSION_VIOLATION = "23P01";

export const hashToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
export function generatePublicRef(): string {
  let ref = "LL-";
  for (let i = 0; i < 6; i++)
    ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return ref;
}

/**
 * Instant booking, step 1: holds the dates while the guest pays in full.
 * Nothing is confirmed here; only a verified payment confirms
 * (src/server/payments/checkout.ts). This moment is the "booking request"
 * that starts the 24-hour free-cancellation window.
 *
 * Inside one transaction: lock the property row (serialising all booking
 * writes for the property), replay an earlier attempt with the same
 * idempotency key, expire lapsed holds, re-check every source of
 * unavailability (bookings, live holds, owner blocks, imported Airbnb and
 * Google periods, the turnover buffer), price the stay from the current
 * rules, then insert the hold, its payment schedule and an audit entry. The
 * exclusion constraint and the owner-block trigger are the database
 * backstops.
 */
export async function createHold(
  db: Database,
  input: HoldInput,
): Promise<HoldResult> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const [property] = await tx
        .select()
        .from(properties)
        .where(eq(properties.id, input.propertyId))
        .for("update");
      if (!property) return { ok: false, reason: "NOT_CONFIGURED" } as const;
      if (!property.bookingsEnabled)
        return { ok: false, reason: "BOOKINGS_DISABLED" } as const;

      const replay = await replayHold(tx, input);
      if (replay) return replay;

      await expireLapsedHolds(tx, property.id, now);

      const stay = { start: input.checkIn, end: input.checkOut };
      const blocks = await loadBlocks(
        tx,
        property.id,
        stay,
        property.turnoverNights,
        now,
      );
      const conflicts = conflictingBlocks(
        blocks,
        stay,
        property.turnoverNights,
      );
      if (conflicts.length > 0) {
        return {
          ok: false,
          reason: "UNAVAILABLE",
          conflicts: conflicts.map(({ start, end }) => ({ start, end })),
        } as const;
      }

      const pricing = await loadPricingInputs(tx, property);
      if (!pricing.policy)
        return { ok: false, reason: "NOT_CONFIGURED" } as const;
      const priced = calculateQuote(
        {
          currency: property.currency,
          maxGuests: property.maxGuests,
          defaultMinNights: property.defaultMinNights,
        },
        pricing.rates,
        pricing.fees,
        pricing.policy,
        {
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guests: input.guests,
          today: todayInTimeZone(property.timeZone, now),
        },
      );
      if (!priced.ok)
        return { ok: false, reason: "QUOTE", error: priced.error } as const;

      const accessToken = randomBytes(32).toString("base64url");
      const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
      const freeUntil = freeCancellationUntil(now);
      const [row] = await tx
        .insert(reservations)
        .values({
          publicRef: generatePublicRef(),
          propertyId: property.id,
          source: "DIRECT",
          status: "PENDING_PAYMENT",
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guests: input.guests,
          guestName: input.guest.name,
          guestEmail: input.guest.email,
          guestPhone: input.guest.phone ?? null,
          currency: priced.quote.currency,
          totalMinor: priced.quote.totalMinor,
          quoteSnapshot: priced.quote,
          holdExpiresAt,
          requestedAt: now,
          freeCancellationUntil: freeUntil,
          cancellationPolicy: CANCELLATION_POLICY.id,
          idempotencyKey: input.idempotencyKey,
          accessTokenHash: hashToken(accessToken),
        })
        .returning({ id: reservations.id, publicRef: reservations.publicRef });

      await tx.insert(paymentScheduleItems).values(
        priced.quote.schedule.map((item) => ({
          reservationId: row.id,
          sequence: item.sequence,
          purpose: item.purpose,
          amountMinor: item.amountMinor,
          dueOn: item.dueOn,
        })),
      );

      await tx.insert(auditLogs).values({
        actorType: "GUEST",
        action: "reservation.hold_created",
        targetType: "reservation",
        targetId: row.id,
        metadata: {
          nights: priced.quote.nights,
          totalMinor: priced.quote.totalMinor,
          holdMinutes: HOLD_MINUTES,
          freeCancellationUntil: freeUntil.toISOString(),
        },
      });

      return {
        ok: true,
        freeCancellationUntil: freeUntil,
        reservationId: row.id,
        publicRef: row.publicRef,
        accessToken,
        holdExpiresAt,
        quote: priced.quote,
        replayed: false,
      } as const;
    });
  } catch (error) {
    // Lost a race the property lock could not see (e.g. a row written by
    // another path): the database refused the overlap.
    if (pgCode(error) === EXCLUSION_VIOLATION) {
      return { ok: false, reason: "UNAVAILABLE", conflicts: [] };
    }
    throw error;
  }
}

/**
 * A repeated submission with the same idempotency key returns the original
 * hold (with a freshly rotated access token, since only hashes are stored),
 * provided it asked for the same stay.
 */
async function replayHold(
  tx: Executor,
  input: HoldInput,
): Promise<HoldResult | null> {
  const [existing] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.idempotencyKey, input.idempotencyKey));
  if (!existing) return null;
  const same =
    existing.propertyId === input.propertyId &&
    existing.checkIn === input.checkIn &&
    existing.checkOut === input.checkOut &&
    existing.guests === input.guests &&
    existing.guestEmail === input.guest.email;
  if (!same) return { ok: false, reason: "IDEMPOTENCY_MISMATCH" };

  const accessToken = randomBytes(32).toString("base64url");
  await tx
    .update(reservations)
    .set({ accessTokenHash: hashToken(accessToken) })
    .where(eq(reservations.id, existing.id));
  return {
    ok: true,
    freeCancellationUntil: existing.freeCancellationUntil!,
    reservationId: existing.id,
    publicRef: existing.publicRef,
    accessToken,
    holdExpiresAt: existing.holdExpiresAt!,
    quote: existing.quoteSnapshot as Quote,
    replayed: true,
  };
}

/**
 * Marks lapsed requests, approvals and holds EXPIRED, freeing their dates.
 * Safe to run any time; used inside every booking transaction and by the
 * sweeper job. An approved request whose payment is still being processed by
 * Stripe is left alone: it moves on when the payment settles or fails.
 */
export async function expireLapsedHolds(
  db: Executor,
  propertyId: string | null,
  now: Date,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const lapsed = await tx
      .select({ id: reservations.id, status: reservations.status })
      .from(reservations)
      .where(
        and(
          inArray(reservations.status, [...EXPIRING_STATUSES]),
          lte(reservations.holdExpiresAt, now),
          propertyId ? eq(reservations.propertyId, propertyId) : sql`true`,
          sql`NOT EXISTS (SELECT 1 FROM ${payments} WHERE ${payments.reservationId} = ${reservations.id} AND ${payments.status} = 'PROCESSING')`,
        ),
      )
      .for("update");
    const expired: string[] = [];
    for (const row of lapsed) {
      const [updated] = await tx
        .update(reservations)
        .set({ status: "EXPIRED" })
        .where(
          and(eq(reservations.id, row.id), eq(reservations.status, row.status)),
        )
        .returning({ id: reservations.id });
      if (!updated) continue;
      expired.push(row.id);
      await tx.insert(auditLogs).values({
        actorType: "SYSTEM",
        action:
          row.status === "REQUESTED"
            ? "reservation.request_expired"
            : row.status === "APPROVED"
              ? "reservation.payment_window_expired"
              : "reservation.hold_expired",
        targetType: "reservation",
        targetId: row.id,
      });
    }
    return expired;
  });
}

/**
 * Looks up a guest's reservation by reference plus a bearer credential: the
 * random access token from the booking form (matched by its SHA-256 hash), or
 * a signed link from one of our emails.
 */
export async function findReservationForGuest(
  db: Executor,
  publicRef: string,
  token: string,
) {
  if (looksLikeGuestLink(token)) {
    const secret = guestLinkSecret();
    if (!secret) return null;
    const [row] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.publicRef, publicRef));
    return row && verifyGuestLink(secret, token, publicRef, row.id)
      ? row
      : null;
  }
  const [row] = await db
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.publicRef, publicRef),
        eq(reservations.accessTokenHash, hashToken(token)),
      ),
    );
  return row ?? null;
}

// --- Owner blocks --------------------------------------------------------------

export interface ClashingBooking {
  id: string;
  publicRef: string;
  status: string;
  checkIn: string;
  checkOut: string;
}

export type OwnerBlockResult =
  | { ok: true; id: string }
  | { ok: false; reason: "INVALID_RANGE" | "NOT_FOUND" }
  | {
      ok: false;
      reason: "CONFLICTS_WITH_BOOKING";
      /** The bookings in the way, so the owner can resolve them first. */
      bookings: ClashingBooking[];
    };

/**
 * Bookings (confirmed, under review, or a hold that hasn't lapsed) whose
 * nights overlap [start, end). Owner blocks never cover these: the owner
 * must cancel or move the booking first, through its own workflow.
 */
async function bookingsInRange(
  tx: Executor,
  propertyId: string,
  range: { start: IsoDate; end: IsoDate },
  now: Date,
): Promise<ClashingBooking[]> {
  return tx
    .select({
      id: reservations.id,
      publicRef: reservations.publicRef,
      status: reservations.status,
      checkIn: reservations.checkIn,
      checkOut: reservations.checkOut,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        sql`${reservations.stay} && daterange(${range.start}::date, ${range.end}::date, '[)')`,
        sql`(${reservations.status} IN ('CONFIRMED', 'PAYMENT_DUE', 'REQUIRES_REVIEW')
          OR (${reservations.status} IN ('PENDING_PAYMENT', 'REQUESTED', 'APPROVED')
              AND ${reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
      ),
    )
    .orderBy(reservations.checkIn)
    .limit(20);
}

const lockProperty = (tx: Executor, propertyId: string) =>
  tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .for("update");

/**
 * Blocks dates for the owner. Refuses to cover an existing booking or live
 * hold (resolve that first; nothing is cancelled or changed silently).
 * Overlapping external busy periods is fine. The database trigger
 * `owner_blocks_refuse_booking_overlap` enforces the same rule.
 */
export async function createOwnerBlock(
  db: Database,
  input: {
    propertyId: string;
    startsOn: IsoDate;
    endsOn: IsoDate;
    reason: string | null;
    createdBy: string;
    now?: Date;
  },
): Promise<OwnerBlockResult> {
  if (input.endsOn <= input.startsOn)
    return { ok: false, reason: "INVALID_RANGE" };
  const now = input.now ?? new Date();
  const range = { start: input.startsOn, end: input.endsOn };
  return db.transaction(async (tx) => {
    await lockProperty(tx, input.propertyId);
    const clash = await bookingsInRange(tx, input.propertyId, range, now);
    if (clash.length > 0)
      return {
        ok: false,
        reason: "CONFLICTS_WITH_BOOKING",
        bookings: clash,
      } as const;

    const [row] = await tx
      .insert(ownerBlocks)
      .values({
        propertyId: input.propertyId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        reason: input.reason,
        createdBy: input.createdBy,
      })
      .returning({ id: ownerBlocks.id });
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: input.createdBy,
      action: "owner_block.created",
      targetType: "owner_block",
      targetId: row.id,
      metadata: {
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        reason: input.reason,
      },
    });
    return { ok: true, id: row.id } as const;
  });
}

/**
 * Changes a block's dates or label. The new range is checked like a new
 * block (the old range is released in the same transaction). Audited with
 * the before and after values.
 */
export async function updateOwnerBlock(
  db: Database,
  input: {
    propertyId: string;
    id: string;
    startsOn: IsoDate;
    endsOn: IsoDate;
    reason: string | null;
    actor: string;
    now?: Date;
  },
): Promise<OwnerBlockResult> {
  if (input.endsOn <= input.startsOn)
    return { ok: false, reason: "INVALID_RANGE" };
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockProperty(tx, input.propertyId);
    const [before] = await tx
      .select()
      .from(ownerBlocks)
      .where(
        and(
          eq(ownerBlocks.id, input.id),
          eq(ownerBlocks.propertyId, input.propertyId),
          sql`${ownerBlocks.removedAt} IS NULL`,
        ),
      )
      .for("update");
    if (!before) return { ok: false, reason: "NOT_FOUND" } as const;
    const clash = await bookingsInRange(
      tx,
      input.propertyId,
      { start: input.startsOn, end: input.endsOn },
      now,
    );
    if (clash.length > 0)
      return {
        ok: false,
        reason: "CONFLICTS_WITH_BOOKING",
        bookings: clash,
      } as const;
    await tx
      .update(ownerBlocks)
      .set({
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        reason: input.reason,
      })
      .where(eq(ownerBlocks.id, input.id));
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: input.actor,
      action: "owner_block.updated",
      targetType: "owner_block",
      targetId: input.id,
      metadata: {
        before: {
          startsOn: before.startsOn,
          endsOn: before.endsOn,
          reason: before.reason,
        },
        after: {
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          reason: input.reason,
        },
      },
    });
    return { ok: true, id: input.id } as const;
  });
}

/** Unblocks dates (soft delete, so the history stays). Audited. */
export async function removeOwnerBlock(
  db: Database,
  id: string,
  actor: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(ownerBlocks)
      .set({ removedAt: now })
      .where(and(eq(ownerBlocks.id, id), sql`${ownerBlocks.removedAt} IS NULL`))
      .returning({
        id: ownerBlocks.id,
        startsOn: ownerBlocks.startsOn,
        endsOn: ownerBlocks.endsOn,
        reason: ownerBlocks.reason,
      });
    if (!row) return false;
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: actor,
      action: "owner_block.removed",
      targetType: "owner_block",
      targetId: id,
      metadata: {
        startsOn: row.startsOn,
        endsOn: row.endsOn,
        reason: row.reason,
      },
    });
    return true;
  });
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string")
      return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
