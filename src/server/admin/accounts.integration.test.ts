import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminSessions, adminUsers, auditLogs } from "@/server/db/schema";
import { parseCredentialKey } from "@/server/crypto/credentials";
import { resetTables, testDatabase } from "../../../tests/support/test-db";
import {
  authenticate,
  beginEnrolment,
  completeEnrolment,
  completePasswordReset,
  completeSecondFactor,
  issuePasswordReset,
  passwordResetValid,
  RESET_MINUTES,
  issueEnrolment,
  LOCKOUT,
  reauthenticate,
  revokeAllSessions,
  revokeSession,
  SESSION,
  setAdminDisabled,
  signInWithPassword,
} from "./accounts";
import { base32Decode, totpAt, totpStep } from "./credentials";

const db = testDatabase(10);
afterAll(async () => db.$client.end());
beforeEach(async () => resetTables(db));

// Synthetic accounts and a throwaway encryption key only.
const keys = [parseCredentialKey(randomBytes(32).toString("base64"), 1)];
const T0 = new Date("2026-10-09T12:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const PASSWORD = "a long test passphrase";
const code = (secret: string, now: Date, offsetSteps = 0) =>
  totpAt(base32Decode(secret), totpStep(now) + offsetSteps);

/** Creates and fully enrols an account; returns its TOTP secret and recovery codes. */
async function enrolled(
  email = "owner@example.test",
  role: "OWNER" | "VIEWER" = "OWNER",
) {
  const { token, userId } = await issueEnrolment(db, {
    email,
    role,
    actor: "test",
    now: T0,
  });
  const { secret } = (await beginEnrolment(db, token, keys, T0))!;
  const done = await completeEnrolment(
    db,
    { token, password: PASSWORD, code: code(secret, T0), now: T0 },
    keys,
  );
  if (!done.ok) throw new Error(done.reason);
  return { userId, secret, recoveryCodes: done.recoveryCodes };
}

/** Full sign-in at `now`; returns the session token. */
async function signIn(secret: string, now: Date, email = "owner@example.test") {
  const first = await signInWithPassword(db, {
    email,
    password: PASSWORD,
    now,
  });
  if (!first.ok) throw new Error(first.reason);
  const second = await completeSecondFactor(
    db,
    { pendingToken: first.token, code: code(secret, now), now },
    keys,
  );
  if (!second.ok) throw new Error(second.reason);
  return second.token;
}

const actions = async (userId: string) =>
  (await db.select().from(auditLogs).where(eq(auditLogs.targetId, userId))).map(
    (a) => a.action,
  );

describe("enrolment", () => {
  it("stores no plaintext secrets and only works once", async () => {
    const { token } = await issueEnrolment(db, {
      email: "Owner@Example.test",
      actor: "test",
      now: T0,
    });
    const { email, secret } = (await beginEnrolment(db, token, keys, T0))!;
    expect(email).toBe("owner@example.test");
    // Reloading shows the same key.
    expect((await beginEnrolment(db, token, keys, T0))!.secret).toBe(secret);

    expect(
      await completeEnrolment(
        db,
        { token, password: "short", code: code(secret, T0), now: T0 },
        keys,
      ),
    ).toMatchObject({ ok: false, reason: "WEAK_PASSWORD" });
    expect(
      await completeEnrolment(
        db,
        { token, password: PASSWORD, code: "000000", now: T0 },
        keys,
      ),
    ).toMatchObject({ ok: false, reason: "BAD_CODE" });
    const done = await completeEnrolment(
      db,
      { token, password: PASSWORD, code: code(secret, T0), now: T0 },
      keys,
    );
    expect(done).toMatchObject({ ok: true });
    expect(
      await completeEnrolment(
        db,
        { token, password: PASSWORD, code: code(secret, T0), now: T0 },
        keys,
      ),
    ).toMatchObject({ ok: false, reason: "INVALID_LINK" });

    const [row] = await db.select().from(adminUsers);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(PASSWORD);
    expect(row.enrolmentTokenHash).toBeNull();
  });

  it("expires set-up links after 24 hours", async () => {
    const { token } = await issueEnrolment(db, {
      email: "a@example.test",
      actor: "test",
      now: T0,
    });
    expect(await beginEnrolment(db, token, keys, at(25 * 60 * MIN))).toBeNull();
  });
});

describe("sign-in", () => {
  it("needs both password and second factor before a session works", async () => {
    const { secret } = await enrolled();
    const first = await signInWithPassword(db, {
      email: "owner@example.test",
      password: PASSWORD,
      now: T0,
    });
    if (!first.ok) throw new Error("expected password step to pass");
    // A password-only session grants nothing.
    expect(await authenticate(db, first.token, T0)).toBeNull();

    const second = await completeSecondFactor(
      db,
      { pendingToken: first.token, code: code(secret, at(MIN)), now: at(MIN) },
      keys,
    );
    if (!second.ok) throw new Error("expected second factor to pass");
    expect(second.token).not.toBe(first.token);
    expect(await authenticate(db, second.token, at(MIN))).toMatchObject({
      email: "owner@example.test",
      role: "OWNER",
    });
    // The pre-MFA token can't be reused: just after success it is
    // recognised as a duplicate (no new session), later it has expired.
    const reuse = (now: Date) =>
      completeSecondFactor(
        db,
        { pendingToken: first.token, code: code(secret, now), now },
        keys,
      );
    expect(await reuse(at(2 * MIN))).toEqual({
      ok: false,
      reason: "ALREADY_COMPLETED",
    });
    expect(await reuse(at(4 * MIN))).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("gives the same answer for unknown emails and wrong passwords", async () => {
    await enrolled();
    expect(
      await signInWithPassword(db, {
        email: "nobody@example.test",
        password: PASSWORD,
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "INVALID" });
    expect(
      await signInWithPassword(db, {
        email: "owner@example.test",
        password: "wrong password!",
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("refuses accounts that haven't finished enrolment", async () => {
    await issueEnrolment(db, {
      email: "pending@example.test",
      actor: "test",
      now: T0,
    });
    expect(
      await signInWithPassword(db, {
        email: "pending@example.test",
        password: PASSWORD,
        now: T0,
      }),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("locks the account after repeated failures, even for the right password", async () => {
    const { userId, secret } = await enrolled();
    for (let i = 0; i < LOCKOUT.threshold; i++)
      await signInWithPassword(db, {
        email: "owner@example.test",
        password: `wrong password ${i}`,
        now: T0,
      });
    expect(
      await signInWithPassword(db, {
        email: "owner@example.test",
        password: PASSWORD,
        now: at(MIN),
      }),
    ).toEqual({ ok: false, reason: "LOCKED" });
    expect(await actions(userId)).toContain("admin.locked");
    // Unlocks after the lockout period.
    const later = at((LOCKOUT.baseMinutes + 1) * MIN);
    expect(await signIn(secret, later)).toBeTruthy();
  });

  it("counts wrong second-factor codes towards the lockout", async () => {
    const { secret } = await enrolled();
    for (let i = 0; i < LOCKOUT.threshold; i++) {
      const first = await signInWithPassword(db, {
        email: "owner@example.test",
        password: PASSWORD,
        now: T0,
      });
      if (!first.ok) break;
      await completeSecondFactor(
        db,
        { pendingToken: first.token, code: "000000", now: T0 },
        keys,
      );
    }
    expect(
      await signInWithPassword(db, {
        email: "owner@example.test",
        password: PASSWORD,
        now: at(MIN),
      }),
    ).toEqual({ ok: false, reason: "LOCKED" });
    void secret;
  });

  it("refuses a replayed authenticator code", async () => {
    const { secret } = await enrolled();
    const now = at(10 * MIN);
    await signIn(secret, now);
    const first = await signInWithPassword(db, {
      email: "owner@example.test",
      password: PASSWORD,
      now,
    });
    if (!first.ok) throw new Error("expected password step");
    expect(
      await completeSecondFactor(
        db,
        { pendingToken: first.token, code: code(secret, now), now },
        keys,
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("accepts each recovery code once", async () => {
    const { recoveryCodes } = await enrolled();
    const use = async (now: Date) => {
      const first = await signInWithPassword(db, {
        email: "owner@example.test",
        password: PASSWORD,
        now,
      });
      if (!first.ok) throw new Error("expected password step");
      return completeSecondFactor(
        db,
        { pendingToken: first.token, code: recoveryCodes[0], now },
        keys,
      );
    };
    expect((await use(at(MIN))).ok).toBe(true);
    expect(await use(at(2 * MIN))).toEqual({ ok: false, reason: "INVALID" });
  });
});

describe("sessions", () => {
  it("expire after idle time and the absolute limit", async () => {
    const { secret } = await enrolled();
    const token = await signIn(secret, at(MIN));
    expect(
      await authenticate(db, token, at((SESSION.idleMinutes + 2) * MIN)),
    ).toBeNull();

    const active = await signIn(secret, at(40 * MIN));
    // Keep it busy every 20 minutes until past the absolute limit.
    let t = 40;
    let last = null;
    while (t < 40 + SESSION.absoluteHours * 60 + 30) {
      t += 20;
      last = await authenticate(db, active, at(t * MIN));
      if (!last) break;
    }
    expect(last).toBeNull();
    expect(t).toBeGreaterThanOrEqual(40 + SESSION.absoluteHours * 60);
  });

  it("stop working when signed out, signed out everywhere, disabled or reset", async () => {
    const { userId, secret } = await enrolled();
    const a = await signIn(secret, at(MIN));
    await revokeSession(db, a, at(2 * MIN));
    expect(await authenticate(db, a, at(3 * MIN))).toBeNull();

    const b = await signIn(secret, at(4 * MIN));
    const c = await signIn(secret, at(5 * MIN));
    await revokeAllSessions(db, userId, "owner@example.test", at(6 * MIN));
    expect(await authenticate(db, b, at(6 * MIN))).toBeNull();
    expect(await authenticate(db, c, at(6 * MIN))).toBeNull();

    const d = await signIn(secret, at(7 * MIN));
    await setAdminDisabled(db, "owner@example.test", true, "test", at(8 * MIN));
    expect(await authenticate(db, d, at(8 * MIN))).toBeNull();
    await setAdminDisabled(
      db,
      "owner@example.test",
      false,
      "test",
      at(9 * MIN),
    );
    // Re-enabling doesn't revive the revoked session.
    expect(await authenticate(db, d, at(9 * MIN))).toBeNull();

    const e = await signIn(secret, at(10 * MIN));
    await issueEnrolment(db, {
      email: "owner@example.test",
      actor: "test",
      now: at(11 * MIN),
    });
    expect(await authenticate(db, e, at(11 * MIN))).toBeNull();
    expect(await actions(userId)).toEqual(
      expect.arrayContaining([
        "admin.enrolled",
        "admin.signed_in",
        "admin.signed_out",
        "admin.sessions_revoked",
        "admin.disabled",
      ]),
    );
  });

  it("reject unknown, malformed and tampered tokens", async () => {
    const { secret } = await enrolled();
    const token = await signIn(secret, at(MIN));
    for (const bad of [
      undefined,
      "",
      "x".repeat(200),
      `${token}x`,
      token.slice(1),
    ])
      expect(await authenticate(db, bad, at(MIN))).toBeNull();
  });

  it("only refreshes step-up when a fresh code is entered", async () => {
    const { secret } = await enrolled();
    const token = await signIn(secret, at(MIN));
    const now = at(30 * MIN);
    expect(await reauthenticate(db, { token, code: "000000", now }, keys)).toBe(
      false,
    );
    expect(
      await reauthenticate(db, { token, code: code(secret, now), now }, keys),
    ).toBe(true);
    const [s] = await db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.mfaVerifiedAt, at(MIN)));
    expect(s.reauthenticatedAt).toEqual(now);
  });
});

describe("roles", () => {
  it("keeps a viewer a viewer: role comes only from the account record", async () => {
    const { secret } = await enrolled("viewer@example.test", "VIEWER");
    const token = await signIn(secret, at(MIN), "viewer@example.test");
    expect(await authenticate(db, token, at(MIN))).toMatchObject({
      role: "VIEWER",
    });
    // Re-inviting without a role keeps the existing role (no silent upgrade).
    await issueEnrolment(db, {
      email: "viewer@example.test",
      actor: "test",
      now: at(2 * MIN),
    });
    const [row] = await db.select().from(adminUsers);
    expect(row.role).toBe("VIEWER");
  });
});

describe("duplicate submissions of the code step (double tap on a phone)", () => {
  async function pending(now: Date) {
    const first = await signInWithPassword(db, {
      email: "owner@example.test",
      password: PASSWORD,
      now,
    });
    if (!first.ok) throw new Error(first.reason);
    return first.token;
  }
  const failures = async (userId: string) =>
    (await db.select().from(adminUsers).where(eq(adminUsers.id, userId)))[0]
      .failedAttempts;

  it("two simultaneous submissions of a valid code: one signs in, the other is recognised as a duplicate, not a failure", async () => {
    const { userId, secret } = await enrolled();
    const now = at(5 * MIN);
    const token = await pending(now);
    const submit = () =>
      completeSecondFactor(
        db,
        { pendingToken: token, code: code(secret, now), now },
        keys,
      );
    const results = await Promise.all([submit(), submit()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "ALREADY_COMPLETED" },
    ]);
    // Neither counted as a wrong code, and only one session was created.
    expect(await failures(userId)).toBe(0);
    expect(
      (await actions(userId)).filter((a) => a === "admin.sign_in_failed"),
    ).toEqual([]);
    const sessions = await db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.userId, userId));
    expect(
      sessions.filter((s) => s.mfaVerifiedAt && !s.revokedAt),
    ).toHaveLength(1);
  });

  it("a late duplicate is recognised for two minutes, then treated as expired", async () => {
    const { secret } = await enrolled();
    const now = at(5 * MIN);
    const token = await pending(now);
    const ok = await completeSecondFactor(
      db,
      { pendingToken: token, code: code(secret, now), now },
      keys,
    );
    expect(ok.ok).toBe(true);
    const again = (later: number) =>
      completeSecondFactor(
        db,
        {
          pendingToken: token,
          code: code(secret, now),
          now: at(5 * MIN + later),
        },
        keys,
      );
    expect(await again(10_000)).toEqual({
      ok: false,
      reason: "ALREADY_COMPLETED",
    });
    expect(await again(3 * MIN)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("replay protection is unchanged: the same code can't start a second sign-in", async () => {
    const { secret } = await enrolled();
    const now = at(5 * MIN);
    await signIn(secret, now);
    const token = await pending(now);
    expect(
      await completeSecondFactor(
        db,
        { pendingToken: token, code: code(secret, now), now },
        keys,
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("accepts the previous code (30 s grace) but not older ones", async () => {
    const { secret } = await enrolled();
    const now = at(10 * MIN);
    const prev = await pending(now);
    expect(
      (
        await completeSecondFactor(
          db,
          { pendingToken: prev, code: code(secret, now, -1), now },
          keys,
        )
      ).ok,
    ).toBe(true);
    const later = at(20 * MIN);
    const old = await pending(later);
    expect(
      await completeSecondFactor(
        db,
        { pendingToken: old, code: code(secret, later, -2), now: later },
        keys,
      ),
    ).toEqual({ ok: false, reason: "INVALID" });
  });

  it("a pending sign-in not finished within 10 minutes expires", async () => {
    const { secret } = await enrolled();
    const now = at(5 * MIN);
    const token = await pending(now);
    const late = at(5 * MIN + SESSION.pendingMinutes * MIN + 1);
    expect(
      await completeSecondFactor(
        db,
        { pendingToken: token, code: code(secret, late), now: late },
        keys,
      ),
    ).toEqual({ ok: false, reason: "EXPIRED" });
  });
});

describe("password reset", () => {
  it("issues single-use, expiring links and gives nothing for unknown accounts", async () => {
    const { userId, secret } = await enrolled();
    expect(
      await issuePasswordReset(db, {
        email: "nobody@example.test",
        actor: null,
        now: T0,
      }),
    ).toBeNull();
    const issued = await issuePasswordReset(db, {
      email: "OWNER@example.test ",
      actor: null,
      now: T0,
    });
    expect(issued?.email).toBe("owner@example.test");
    // Only the hash is stored.
    const [row] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, userId));
    expect(row.passwordResetTokenHash).not.toBe(issued!.token);
    expect(
      await passwordResetValid(db, issued!.token, at(RESET_MINUTES * MIN - 1)),
    ).toBe(true);
    expect(
      await passwordResetValid(db, issued!.token, at(RESET_MINUTES * MIN + 1)),
    ).toBe(false);

    const session = await signIn(secret, at(MIN));
    expect(
      await completePasswordReset(db, {
        token: issued!.token,
        password: "short",
        now: at(2 * MIN),
      }),
    ).toMatchObject({ ok: false, reason: "WEAK_PASSWORD" });
    expect(
      await completePasswordReset(db, {
        token: issued!.token,
        password: "a brand new long passphrase",
        now: at(2 * MIN),
      }),
    ).toEqual({ ok: true });
    // Single use, and every session was signed out.
    expect(
      await completePasswordReset(db, {
        token: issued!.token,
        password: "another brand new passphrase",
        now: at(3 * MIN),
      }),
    ).toEqual({ ok: false, reason: "INVALID_LINK" });
    expect(await authenticate(db, session, at(3 * MIN))).toBeNull();
    // The new password works; the authenticator is still required.
    const next = await signInWithPassword(db, {
      email: "owner@example.test",
      password: "a brand new long passphrase",
      now: at(4 * MIN),
    });
    expect(next.ok).toBe(true);
    expect(await actions(userId)).toEqual(
      expect.arrayContaining([
        "admin.password_reset_requested",
        "admin.password_reset",
      ]),
    );
  });

  it("an expired link can't be used, and a reset clears a lockout", async () => {
    const { userId } = await enrolled();
    for (let i = 0; i < LOCKOUT.threshold; i++)
      await signInWithPassword(db, {
        email: "owner@example.test",
        password: "wrong password!!",
        now: at(MIN),
      });
    let [row] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, userId));
    expect(row.lockedUntil).not.toBeNull();
    const expired = await issuePasswordReset(db, {
      email: "owner@example.test",
      actor: null,
      now: T0,
    });
    expect(
      await completePasswordReset(db, {
        token: expired!.token,
        password: "a brand new long passphrase",
        now: at(RESET_MINUTES * MIN + 1),
      }),
    ).toEqual({ ok: false, reason: "INVALID_LINK" });
    const fresh = await issuePasswordReset(db, {
      email: "owner@example.test",
      actor: null,
      now: at(2 * MIN),
    });
    expect(
      (
        await completePasswordReset(db, {
          token: fresh!.token,
          password: "a brand new long passphrase",
          now: at(3 * MIN),
        })
      ).ok,
    ).toBe(true);
    [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(row.lockedUntil).toBeNull();
    expect(row.failedAttempts).toBe(0);
  });
});
