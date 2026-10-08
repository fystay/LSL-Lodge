import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { todayInTimeZone, type IsoDate } from "@/lib/dates";
import type { Database, Executor } from "@/server/db/client";
import {
  auditLogs,
  ownerBlocks,
  paymentScheduleItems,
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

/** How long a guest has to complete payment before the hold lapses. */
export const HOLD_MINUTES = 30;

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
 * Places a short-lived hold on the dates, atomically.
 *
 * Inside one transaction: lock the property row (serialising all booking
 * writes for the property), replay an earlier attempt with the same
 * idempotency key, expire lapsed holds, re-check every source of
 * unavailability including the turnover buffer, price the stay from the
 * current rules, then insert the reservation, its payment schedule and an
 * audit entry. The exclusion constraint backstops the overlap check.
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
        },
      });

      return {
        ok: true,
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
    reservationId: existing.id,
    publicRef: existing.publicRef,
    accessToken,
    holdExpiresAt: existing.holdExpiresAt!,
    quote: existing.quoteSnapshot as Quote,
    replayed: true,
  };
}

/** Marks lapsed holds EXPIRED. Safe to run any time; used by the sweeper job too. */
export async function expireLapsedHolds(
  db: Executor,
  propertyId: string | null,
  now: Date,
): Promise<string[]> {
  const expired = await db
    .update(reservations)
    .set({ status: "EXPIRED" })
    .where(
      and(
        eq(reservations.status, "PENDING_PAYMENT"),
        lte(reservations.holdExpiresAt, now),
        propertyId ? eq(reservations.propertyId, propertyId) : sql`true`,
      ),
    )
    .returning({ id: reservations.id });
  if (expired.length > 0) {
    await db.insert(auditLogs).values(
      expired.map((r) => ({
        actorType: "SYSTEM" as const,
        action: "reservation.hold_expired",
        targetType: "reservation",
        targetId: r.id,
      })),
    );
  }
  return expired.map((r) => r.id);
}

/** Looks up a guest's reservation by reference plus bearer token (matched by its SHA-256 hash). */
export async function findReservationForGuest(
  db: Executor,
  publicRef: string,
  token: string,
) {
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

export type OwnerBlockResult =
  | { ok: true; id: string }
  | { ok: false; reason: "INVALID_RANGE" | "CONFLICTS_WITH_BOOKING" };

/**
 * Blocks dates for the owner. Refuses to cover an existing booking or live
 * hold (cancel that first); overlapping external busy periods is fine.
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
  return db.transaction(async (tx) => {
    await tx
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.id, input.propertyId))
      .for("update");
    const blocks = await loadBlocks(
      tx,
      input.propertyId,
      { start: input.startsOn, end: input.endsOn },
      0,
      now,
    );
    const clash = conflictingBlocks(
      blocks.filter(
        (b) => b.source === "DIRECT_BOOKING" || b.source === "HOLD",
      ),
      { start: input.startsOn, end: input.endsOn },
      0,
    );
    if (clash.length > 0)
      return { ok: false, reason: "CONFLICTS_WITH_BOOKING" } as const;

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
      metadata: { startsOn: input.startsOn, endsOn: input.endsOn },
    });
    return { ok: true, id: row.id } as const;
  });
}

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
      .returning({ id: ownerBlocks.id });
    if (!row) return false;
    await tx.insert(auditLogs).values({
      actorType: "OWNER",
      actorId: actor,
      action: "owner_block.removed",
      targetType: "owner_block",
      targetId: id,
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
