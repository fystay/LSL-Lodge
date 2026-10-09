import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database, Executor } from "@/server/db/client";
import { adminSessions, adminUsers, auditLogs } from "@/server/db/schema";
import {
  decryptCredential,
  encryptCredential,
  type CredentialKey,
} from "@/server/crypto/credentials";
import {
  dummyPasswordHash,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  matchRecoveryCode,
  passwordProblem,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
} from "./credentials";

/**
 * Admin accounts and sessions, stored in PostgreSQL.
 *
 * Sign-in is two steps: password, then a second factor (authenticator code
 * or a one-time recovery code). Only after both does a session grant access.
 * Every outcome is audit-logged. Failed attempts on either step count
 * towards a per-account lockout that grows with repeated failures; the
 * per-IP rate limit sits in front of this (src/app/admin/actions.ts).
 */

export const SESSION = {
  /** A password-only session must complete the second factor within this time. */
  pendingMinutes: 10,
  idleMinutes: 30,
  absoluteHours: 8,
  /** Sensitive actions need the second factor re-entered within this window. */
  freshMinutes: 15,
} as const;

export const LOCKOUT = {
  /** Failures allowed before the account locks. */
  threshold: 5,
  baseMinutes: 15,
  maxMinutes: 24 * 60,
} as const;

export const ENROLMENT_HOURS = 24;

export type AdminRole = "OWNER" | "VIEWER";

const totpContext = (userId: string) => `admin_user:${userId}:totp`;

async function audit(
  db: Executor,
  action: string,
  userId: string | null,
  actor: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLogs).values({
    actorType: "OWNER",
    actorId: actor,
    action,
    targetType: "admin_user",
    targetId: userId,
    metadata,
  });
}

// --- Invitations and enrolment ---------------------------------------------------

/**
 * Creates an account (or resets an existing one) and returns a one-time
 * enrolment token. Resetting clears the password, authenticator and recovery
 * codes and signs out every session. Run from the CLI (scripts/admin.mts);
 * nothing creates accounts with preset credentials.
 */
export async function issueEnrolment(
  db: Database,
  input: { email: string; role?: AdminRole; actor: string; now?: Date },
): Promise<{ token: string; expiresAt: Date; userId: string }> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error("Invalid email");
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + ENROLMENT_HOURS * 3_600_000);
  return db.transaction(async (tx) => {
    const reset = {
      passwordHash: null,
      totpSecretEncrypted: null,
      totpLastStep: null,
      recoveryCodeHashes: null,
      enrolledAt: null,
      enrolmentTokenHash: sha256(token),
      enrolmentExpiresAt: expiresAt,
      failedAttempts: 0,
      lockedUntil: null,
    };
    const [user] = await tx
      .insert(adminUsers)
      .values({ email, role: input.role ?? "OWNER", ...reset })
      .onConflictDoUpdate({
        target: adminUsers.email,
        set: { ...reset, ...(input.role ? { role: input.role } : {}) },
      })
      .returning({ id: adminUsers.id, role: adminUsers.role });
    await tx
      .update(adminSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(adminSessions.userId, user.id), isNull(adminSessions.revokedAt)),
      );
    await audit(tx, "admin.enrolment_issued", user.id, input.actor, {
      role: user.role,
    });
    return { token, expiresAt, userId: user.id };
  });
}

async function userByEnrolmentToken(db: Executor, token: string, now: Date) {
  if (!token || token.length > 100) return null;
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.enrolmentTokenHash, sha256(token)),
        gt(adminUsers.enrolmentExpiresAt, now),
        isNull(adminUsers.disabledAt),
      ),
    );
  return user ?? null;
}

/**
 * Starts (or resumes) enrolment: returns the email and the authenticator
 * secret to show. The secret is created once and stored encrypted, so
 * reloading the page shows the same one.
 */
export async function beginEnrolment(
  db: Database,
  token: string,
  keys: CredentialKey[],
  now = new Date(),
): Promise<{ email: string; secret: string } | null> {
  const user = await userByEnrolmentToken(db, token, now);
  if (!user) return null;
  if (user.totpSecretEncrypted)
    return {
      email: user.email,
      secret: decryptCredential(
        user.totpSecretEncrypted,
        keys,
        totpContext(user.id),
      ),
    };
  // Only the first writer wins, so two concurrent page loads can't show
  // different keys; everyone reads back the stored one.
  await db
    .update(adminUsers)
    .set({
      totpSecretEncrypted: encryptCredential(
        generateTotpSecret(),
        keys[0],
        totpContext(user.id),
      ),
    })
    .where(
      and(eq(adminUsers.id, user.id), isNull(adminUsers.totpSecretEncrypted)),
    );
  const [stored] = await db
    .select({ secret: adminUsers.totpSecretEncrypted })
    .from(adminUsers)
    .where(eq(adminUsers.id, user.id));
  return {
    email: user.email,
    secret: decryptCredential(stored.secret!, keys, totpContext(user.id)),
  };
}

export type EnrolmentResult =
  | { ok: true; recoveryCodes: string[] }
  | {
      ok: false;
      reason: "INVALID_LINK" | "WEAK_PASSWORD" | "BAD_CODE";
      message?: string;
    };

/** Sets the password and confirms the authenticator works. Shows recovery codes once. */
export async function completeEnrolment(
  db: Database,
  input: { token: string; password: string; code: string; now?: Date },
  keys: CredentialKey[],
): Promise<EnrolmentResult> {
  const now = input.now ?? new Date();
  const user = await userByEnrolmentToken(db, input.token, now);
  if (!user || !user.totpSecretEncrypted)
    return { ok: false, reason: "INVALID_LINK" };
  const problem = passwordProblem(input.password, user.email);
  if (problem) return { ok: false, reason: "WEAK_PASSWORD", message: problem };
  const secret = decryptCredential(
    user.totpSecretEncrypted,
    keys,
    totpContext(user.id),
  );
  const step = verifyTotp(secret, input.code, now, null);
  if (step === null) return { ok: false, reason: "BAD_CODE" };

  const { codes, hashes } = generateRecoveryCodes();
  const passwordHash = await hashPassword(input.password);
  const [done] = await db
    .update(adminUsers)
    .set({
      passwordHash,
      totpLastStep: step,
      recoveryCodeHashes: hashes,
      enrolledAt: now,
      enrolmentTokenHash: null,
      enrolmentExpiresAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    })
    // Single use: only succeeds while the token is still in place.
    .where(
      and(
        eq(adminUsers.id, user.id),
        eq(adminUsers.enrolmentTokenHash, sha256(input.token)),
      ),
    )
    .returning({ id: adminUsers.id });
  if (!done) return { ok: false, reason: "INVALID_LINK" };
  await audit(db, "admin.enrolled", user.id, user.email);
  return { ok: true, recoveryCodes: codes };
}

// --- Sign-in ---------------------------------------------------------------------------

export type SignInResult =
  { ok: true; token: string } | { ok: false; reason: "INVALID" | "LOCKED" };

function lockoutUntil(failures: number, now: Date): Date | null {
  if (failures < LOCKOUT.threshold) return null;
  const minutes = Math.min(
    LOCKOUT.maxMinutes,
    LOCKOUT.baseMinutes * 2 ** (failures - LOCKOUT.threshold),
  );
  return new Date(now.getTime() + minutes * 60_000);
}

async function recordFailure(
  db: Executor,
  user: typeof adminUsers.$inferSelect,
  step: "password" | "second_factor",
  now: Date,
) {
  const failures = user.failedAttempts + 1;
  const lockedUntil = lockoutUntil(failures, now);
  await db
    .update(adminUsers)
    .set({ failedAttempts: sql`${adminUsers.failedAttempts} + 1`, lockedUntil })
    .where(eq(adminUsers.id, user.id));
  await audit(db, "admin.sign_in_failed", user.id, null, { step, failures });
  if (lockedUntil)
    await audit(db, "admin.locked", user.id, null, {
      until: lockedUntil.toISOString(),
    });
}

/** Step 1. On success returns a session token that still needs the second factor. */
export async function signInWithPassword(
  db: Database,
  input: { email: string; password: string; now?: Date },
): Promise<SignInResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase().slice(0, 254);
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, email));
  const usable =
    user && user.enrolledAt && user.passwordHash && !user.disabledAt;
  // Same work whether or not the account exists, so timing reveals nothing.
  const valid = await verifyPassword(
    input.password.slice(0, 1000),
    usable ? user.passwordHash! : await dummyPasswordHash(),
  );
  if (!usable) {
    await audit(db, "admin.sign_in_failed", null, null, { step: "password" });
    return { ok: false, reason: "INVALID" };
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    await audit(db, "admin.sign_in_refused_locked", user.id, null);
    return { ok: false, reason: "LOCKED" };
  }
  if (!valid) {
    await recordFailure(db, user, "password", now);
    return { ok: false, reason: "INVALID" };
  }
  const token = randomToken();
  await db.insert(adminSessions).values({
    userId: user.id,
    tokenHash: sha256(token),
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION.pendingMinutes * 60_000),
  });
  return { ok: true, token };
}

/**
 * Checks an authenticator code or recovery code for the user. Updates the
 * replay guard / consumes the recovery code on success; counts a failure
 * towards lockout otherwise.
 */
async function checkSecondFactor(
  db: Executor,
  user: typeof adminUsers.$inferSelect,
  code: string,
  keys: CredentialKey[],
  now: Date,
): Promise<"TOTP" | "RECOVERY" | null> {
  if (user.lockedUntil && user.lockedUntil > now) return null;
  const secret = decryptCredential(
    user.totpSecretEncrypted!,
    keys,
    totpContext(user.id),
  );
  const step = verifyTotp(secret, code, now, user.totpLastStep);
  if (step !== null) {
    // Conditional update: two requests racing with the same code can't both win.
    const [ok] = await db
      .update(adminUsers)
      .set({ totpLastStep: step, failedAttempts: 0, lockedUntil: null })
      .where(
        and(
          eq(adminUsers.id, user.id),
          sql`coalesce(${adminUsers.totpLastStep}, -1) < ${step}`,
        ),
      )
      .returning({ id: adminUsers.id });
    if (ok) return "TOTP";
  }
  const index = matchRecoveryCode(code, user.recoveryCodeHashes ?? []);
  if (index >= 0) {
    const hash = user.recoveryCodeHashes![index];
    const [ok] = await db
      .update(adminUsers)
      .set({
        recoveryCodeHashes: sql`array_remove(${adminUsers.recoveryCodeHashes}, ${hash})`,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(
        and(
          eq(adminUsers.id, user.id),
          sql`${hash} = ANY(${adminUsers.recoveryCodeHashes})`,
        ),
      )
      .returning({ id: adminUsers.id });
    if (ok) return "RECOVERY";
  }
  await recordFailure(db, user, "second_factor", now);
  return null;
}

/**
 * Step 2. Verifies the second factor for a pending session and replaces it
 * with a fresh, fully authenticated session (new token: the pre-MFA token
 * stops working).
 */
export async function completeSecondFactor(
  db: Database,
  input: { pendingToken: string; code: string; now?: Date },
  keys: CredentialKey[],
): Promise<
  { ok: true; token: string } | { ok: false; reason: "INVALID" | "EXPIRED" }
> {
  const now = input.now ?? new Date();
  const found = await loadSession(db, input.pendingToken, now, {
    allowPending: true,
  });
  if (!found || found.session.mfaVerifiedAt)
    return { ok: false, reason: "EXPIRED" };
  const { session, user } = found;
  const method = await checkSecondFactor(db, user, input.code, keys, now);
  if (!method) return { ok: false, reason: "INVALID" };

  const token = randomToken();
  await db.transaction(async (tx) => {
    await tx
      .update(adminSessions)
      .set({ revokedAt: now })
      .where(eq(adminSessions.id, session.id));
    await tx.insert(adminSessions).values({
      userId: user.id,
      tokenHash: sha256(token),
      mfaVerifiedAt: now,
      reauthenticatedAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION.absoluteHours * 3_600_000),
    });
    await tx
      .update(adminUsers)
      .set({ lastLoginAt: now })
      .where(eq(adminUsers.id, user.id));
    await audit(tx, "admin.signed_in", user.id, user.email, { method });
    if (method === "RECOVERY")
      await audit(tx, "admin.recovery_code_used", user.id, user.email, {
        remaining: (user.recoveryCodeHashes?.length ?? 1) - 1,
      });
  });
  return { ok: true, token };
}

/** Re-enters the second factor for a signed-in session (step-up for sensitive actions). */
export async function reauthenticate(
  db: Database,
  input: { token: string; code: string; now?: Date },
  keys: CredentialKey[],
): Promise<boolean> {
  const now = input.now ?? new Date();
  const found = await loadSession(db, input.token, now);
  if (!found) return false;
  const method = await checkSecondFactor(db, found.user, input.code, keys, now);
  if (!method) return false;
  await db
    .update(adminSessions)
    .set({ reauthenticatedAt: now })
    .where(eq(adminSessions.id, found.session.id));
  await audit(db, "admin.reauthenticated", found.user.id, found.user.email, {
    method,
  });
  return true;
}

// --- Sessions ----------------------------------------------------------------------------

export interface AdminIdentity {
  userId: string;
  sessionId: string;
  email: string;
  role: AdminRole;
  reauthenticatedAt: Date | null;
}

/**
 * Resolves a session token. Rejects revoked, expired, idle-timed-out and
 * pending (pre-MFA) sessions, and sessions of disabled or reset accounts.
 */
export async function loadSession(
  db: Executor,
  token: string | undefined,
  now: Date,
  options: { allowPending?: boolean } = {},
) {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({ session: adminSessions, user: adminUsers })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(eq(adminSessions.tokenHash, sha256(token)));
  if (!row) return null;
  const { session, user } = row;
  if (session.revokedAt || session.expiresAt <= now) return null;
  if (
    now.getTime() - session.lastSeenAt.getTime() >
    SESSION.idleMinutes * 60_000
  )
    return null;
  if (user.disabledAt || !user.enrolledAt) return null;
  if (!session.mfaVerifiedAt && !options.allowPending) return null;
  return { session, user };
}

/** Resolves a fully authenticated session and records activity (for the idle timeout). */
export async function authenticate(
  db: Database,
  token: string | undefined,
  now = new Date(),
): Promise<AdminIdentity | null> {
  const found = await loadSession(db, token, now);
  if (!found) return null;
  const { session, user } = found;
  // Write at most once a minute.
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000)
    await db
      .update(adminSessions)
      .set({ lastSeenAt: now })
      .where(eq(adminSessions.id, session.id));
  return {
    userId: user.id,
    sessionId: session.id,
    email: user.email,
    role: user.role,
    reauthenticatedAt: session.reauthenticatedAt,
  };
}

export async function revokeSession(
  db: Database,
  token: string | undefined,
  now = new Date(),
) {
  if (!token) return;
  const [row] = await db
    .update(adminSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(adminSessions.tokenHash, sha256(token)),
        isNull(adminSessions.revokedAt),
      ),
    )
    .returning({ userId: adminSessions.userId });
  if (row) await audit(db, "admin.signed_out", row.userId, null);
}

/** Signs a user out everywhere (e.g. a lost device). */
export async function revokeAllSessions(
  db: Database,
  userId: string,
  actor: string,
  now = new Date(),
) {
  await db
    .update(adminSessions)
    .set({ revokedAt: now })
    .where(
      and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt)),
    );
  await audit(db, "admin.sessions_revoked", userId, actor);
}

export async function setAdminDisabled(
  db: Database,
  email: string,
  disabled: boolean,
  actor: string,
  now = new Date(),
) {
  const [user] = await db
    .update(adminUsers)
    .set({ disabledAt: disabled ? now : null })
    .where(eq(adminUsers.email, email.trim().toLowerCase()))
    .returning({ id: adminUsers.id });
  if (!user) return false;
  if (disabled) await revokeAllSessions(db, user.id, actor, now);
  await audit(
    db,
    disabled ? "admin.disabled" : "admin.enabled",
    user.id,
    actor,
  );
  return true;
}

/** Removes sessions that expired more than a day ago. */
export async function pruneSessions(db: Executor, now = new Date()) {
  await db
    .delete(adminSessions)
    .where(
      sql`${adminSessions.expiresAt} < ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
    );
}
