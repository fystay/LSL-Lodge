import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parseIsoDate as d } from "@/lib/dates";
import { notificationJobs } from "@/server/db/schema";
import { createHold } from "@/server/booking/holds";
import { guestCancel } from "@/server/booking/resolution";
import {
  applyCheckoutSession,
  startCheckout,
} from "@/server/payments/checkout";
import { FakeGateway } from "../../../tests/support/fake-gateway";
import {
  createBookableProperty,
  resetTables,
  testDatabase,
} from "../../../tests/support/test-db";
import { dispatchNotifications, MAX_ATTEMPTS } from "./dispatch";
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
} from "./email";
import { enqueueNotification } from "./outbox";

const db = testDatabase(10);
afterAll(async () => db.$client.end());
beforeEach(async () => {
  await resetTables(db);
  vi.stubEnv("OWNER_NOTIFICATION_EMAIL", "owner@example.test");
  vi.stubEnv("GUEST_LINK_SECRET", "x".repeat(40));
});
afterEach(() => vi.unstubAllEnvs());

// Test data only. Nothing is sent anywhere: the sender is in memory.
const NOW = new Date("2026-10-08T12:00:00Z");
// Jobs are due from the database clock, so dispatch runs at (just after) real time.
const sendAt = () => new Date(Date.now() + 1_000);

class MemorySender implements EmailSender {
  readonly mode = "resend-sandbox" as const;
  readonly sent: EmailMessage[] = [];
  failWith: EmailDeliveryError | null = null;
  async send(message: EmailMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { providerMessageId: `msg_${this.sent.length}` };
  }
}

/** A paid, confirmed booking: queues the guest and owner confirmations. */
async function request() {
  const property = await createBookableProperty(db);
  const result = await createHold(db, {
    propertyId: property.id,
    checkIn: d("2027-03-01"),
    checkOut: d("2027-03-04"),
    guests: 2,
    guest: { name: "Test Guest", email: "guest@example.test" },
    idempotencyKey: randomUUID(),
    now: NOW,
  });
  if (!result.ok) throw new Error("expected hold");
  const gateway = new FakeGateway();
  await startCheckout(db, gateway, {
    reservationId: result.reservationId,
    baseUrl: "http://localhost:3000",
    now: NOW,
  });
  await applyCheckoutSession(db, gateway.pay(gateway.latest().id), NOW);
  return { property, reservationId: result.reservationId };
}

const jobs = () => db.select().from(notificationJobs);

describe("dispatchNotifications", () => {
  it("sends each queued message once, to the right recipient", async () => {
    await request();
    const sender = new MemorySender();
    expect(
      await dispatchNotifications(db, sender, { now: sendAt() }),
    ).toMatchObject({
      sent: 2,
    });
    expect(sender.sent.map((m) => m.to).sort()).toEqual([
      "guest@example.test",
      "owner@example.test",
    ]);
    const guest = sender.sent.find((m) => m.to === "guest@example.test")!;
    expect(guest.subject).toMatch(/confirmed/i);
    expect(guest.text).toMatch(/\/book\/LL-[A-Z0-9]{6}\/access\?t=g1\./);
    // The free-cancellation deadline, 24 h after booking, in UK time.
    expect(guest.text).toContain("1:00pm on Friday 9 October 2026");
    expect(guest.idempotencyKey).toMatch(/^notification:booking_confirmed:/);

    // A second run finds nothing to do.
    expect(
      await dispatchNotifications(db, sender, { now: sendAt() }),
    ).toMatchObject({
      sent: 0,
    });
    expect(sender.sent).toHaveLength(2);
    expect((await jobs()).every((j) => j.status === "SENT")).toBe(true);
  });

  it("records suppressed (not sent) when delivery is off", async () => {
    await request();
    expect(
      await dispatchNotifications(db, null, { now: sendAt() }),
    ).toMatchObject({
      suppressed: 2,
      sent: 0,
    });
    expect((await jobs()).map((j) => j.status)).toEqual([
      "SUPPRESSED",
      "SUPPRESSED",
    ]);
  });

  it("cancels a message that no longer matches the booking", async () => {
    const { property, reservationId } = await request();
    await guestCancel(db, {
      propertyId: property.id,
      reservationId,
      receivedAt: new Date(NOW.getTime() + 60_000),
    });
    // "Booking confirmed" is now stale; the cancellation messages are current.
    const sender = new MemorySender();
    const result = await dispatchNotifications(db, sender, { now: sendAt() });
    expect(result).toMatchObject({ cancelled: 1, sent: 3 });
    const byTemplate = Object.fromEntries(
      (await jobs()).map((j) => [j.template, [j.status, j.lastErrorCode]]),
    );
    expect(byTemplate.booking_confirmed).toEqual(["CANCELLED", "STALE"]);
    expect(byTemplate.guest_cancellation_confirmed[0]).toBe("SENT");
    const cancelled = sender.sent.find((m) =>
      m.idempotencyKey.includes("guest_cancellation_confirmed"),
    )!;
    expect(cancelled.text).toContain("full refund of £300 ");
    expect(cancelled.text).toMatch(/being processed/);
  });

  it("retries transient failures with backoff, then gives up", async () => {
    await request();
    const sender = new MemorySender();
    sender.failWith = new EmailDeliveryError("HTTP_503", true);
    let at = sendAt();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await dispatchNotifications(db, sender, { now: at });
      expect(result.sent).toBe(0);
      at = new Date(at.getTime() + 2 * 3_600_000);
    }
    const rows = await jobs();
    expect(rows.every((j) => j.status === "FAILED")).toBe(true);
    expect(rows.every((j) => j.attempts === MAX_ATTEMPTS)).toBe(true);
    expect(rows[0].lastErrorCode).toBe("HTTP_503");
  });

  it("fails (not cancels) owner alerts when no owner address is set", async () => {
    vi.stubEnv("OWNER_NOTIFICATION_EMAIL", "");
    await request();
    const result = await dispatchNotifications(db, new MemorySender(), {
      now: sendAt(),
    });
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    const owner = (await jobs()).find((j) => j.recipientKind === "OWNER")!;
    expect([owner.status, owner.lastErrorCode]).toEqual([
      "FAILED",
      "NO_RECIPIENT",
    ]);
  });

  it("does not retry a permanent failure", async () => {
    await request();
    const sender = new MemorySender();
    sender.failWith = new EmailDeliveryError("HTTP_422", false);
    expect(
      await dispatchNotifications(db, sender, { now: sendAt() }),
    ).toMatchObject({
      failed: 2,
    });
  });

  it("never lets two concurrent runners send the same job", async () => {
    await request();
    const sender = new MemorySender();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        dispatchNotifications(db, sender, { now: sendAt() }),
      ),
    );
    expect(sender.sent).toHaveLength(2);
  });

  it("reclaims a job left mid-send by a crashed runner", async () => {
    const { reservationId } = await request();
    await db
      .update(notificationJobs)
      .set({ status: "SENDING", updatedAt: new Date() })
      .where(eq(notificationJobs.reservationId, reservationId));
    const sender = new MemorySender();
    // Recently claimed: left alone, as the runner may still be sending.
    expect(
      (await dispatchNotifications(db, sender, { now: sendAt() })).sent,
    ).toBe(0);
    const later = new Date(Date.now() + 20 * 60_000);
    expect((await dispatchNotifications(db, sender, { now: later })).sent).toBe(
      2,
    );
  });

  it("enqueueing the same event twice creates one job", async () => {
    const { reservationId } = await request();
    for (let i = 0; i < 3; i++)
      await enqueueNotification(db, {
        template: "owner_payment_needs_review",
        reservationId,
        idempotencyKey: `owner_payment_needs_review:${reservationId}`,
      });
    expect(
      (await jobs()).filter((j) => j.template === "owner_payment_needs_review"),
    ).toHaveLength(1);
  });
});
