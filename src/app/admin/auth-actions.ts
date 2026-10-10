"use server";

import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_COOKIE,
  adminAvailable,
  assertSameOrigin,
  getAdmin,
  PENDING_COOKIE,
  setSessionCookie,
} from "@/server/admin/auth";
import {
  completeEnrolment,
  completePasswordReset,
  issuePasswordReset,
  completeSecondFactor,
  reauthenticate,
  revokeAllSessions,
  revokeSession,
  SESSION,
  signInWithPassword,
} from "@/server/admin/accounts";
import { credentialKeys } from "@/server/crypto/keys";
import { siteUrl } from "@/lib/site";
import { getEmailSender } from "@/server/notifications/email";
import { db } from "@/server/db/client";
import {
  clientIp,
  consumeRateLimit,
  LIMITS,
} from "@/server/security/rate-limit";
import type { AuthFormState } from "./auth-state";

/**
 * Sign-in, enrolment and sign-out actions. Each checks the Origin header
 * and the per-IP rate limit before touching credentials. Error messages
 * never say which part was wrong or whether an account exists.
 */

async function guard(): Promise<boolean> {
  await assertSameOrigin();
  if (!adminAvailable()) return false;
  return consumeRateLimit(db(), LIMITS.loginPerIp, clientIp(await headers()));
}

const TOO_MANY =
  "Too many sign-in attempts from this connection. Please wait 15 minutes and try again.";
const NOT_RECOGNISED =
  "Those details weren’t recognised. Check your email and password. After several wrong attempts an account is locked for 15 minutes; you can also reset your password.";

export async function signInAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const email = String(form.get("email") ?? "")
    .trim()
    .slice(0, 254);
  await assertSameOrigin();
  if (!adminAvailable())
    return {
      status: "error",
      message: "Sign-in isn’t available right now.",
      email,
    };
  if (
    !(await consumeRateLimit(
      db(),
      LIMITS.loginPerIp,
      clientIp(await headers()),
    ))
  )
    return { status: "error", message: TOO_MANY, email };
  const result = await signInWithPassword(db(), {
    email,
    password: String(form.get("password") ?? ""),
  });
  if (!result.ok) return { status: "error", message: NOT_RECOGNISED, email };
  await setSessionCookie(
    PENDING_COOKIE,
    result.token,
    SESSION.pendingMinutes * 60,
  );
  redirect("/admin/login/verify");
}

export async function verifySecondFactorAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  await assertSameOrigin();
  if (!adminAvailable())
    return { status: "error", message: "Sign-in isn’t available right now." };
  if (
    !(await consumeRateLimit(
      db(),
      LIMITS.secondFactorPerIp,
      clientIp(await headers()),
    ))
  )
    return { status: "error", message: TOO_MANY };
  const jar = await cookies();
  const pending = jar.get(PENDING_COOKIE)?.value;
  // No pending step: either it already completed (signed in) or it lapsed.
  if (!pending)
    redirect((await getAdmin()) ? "/admin" : "/admin/login?error=expired");
  const result = await completeSecondFactor(
    db(),
    {
      pendingToken: pending,
      code: String(form.get("code") ?? "").slice(0, 40),
    },
    credentialKeys(),
  );
  if (!result.ok) {
    // A duplicate submission of a sign-in that just succeeded.
    if (result.reason === "ALREADY_COMPLETED") redirect("/admin");
    if (result.reason === "EXPIRED") redirect("/admin/login?error=expired");
    return {
      status: "error",
      message:
        "That code wasn’t accepted. Enter the newest code from your app (each code works once), or a recovery code. After several wrong codes the account is locked for 15 minutes.",
    };
  }
  jar.delete(PENDING_COOKIE);
  await setSessionCookie(
    ADMIN_COOKIE,
    result.token,
    SESSION.absoluteHours * 3600,
  );
  redirect("/admin");
}

export async function reauthAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  await assertSameOrigin();
  const next = String(form.get("next") ?? "/admin");
  const safeNext = /^\/admin(\/[A-Za-z0-9/_-]*)?$/.test(next) ? next : "/admin";
  if (!(await getAdmin())) redirect("/admin/login");
  if (
    !(await consumeRateLimit(
      db(),
      LIMITS.secondFactorPerIp,
      clientIp(await headers()),
    ))
  )
    return { status: "error", message: TOO_MANY };
  const ok = await reauthenticate(
    db(),
    {
      token: (await cookies()).get(ADMIN_COOKIE)?.value ?? "",
      code: String(form.get("code") ?? "").slice(0, 40),
    },
    credentialKeys(),
  );
  if (!ok)
    return {
      status: "error",
      message:
        "That code wasn’t accepted. Enter the newest code from your app (each code works once), or a recovery code.",
    };
  redirect(safeNext as Route);
}

export type EnrolState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; recoveryCodes: string[] };

export async function enrolAction(
  _previous: EnrolState,
  form: FormData,
): Promise<EnrolState> {
  if (!(await guard()))
    return {
      status: "error",
      message: "Please wait a few minutes and try again.",
    };
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? ""))
    return { status: "error", message: "The two passwords don’t match." };
  const result = await completeEnrolment(
    db(),
    {
      token: String(form.get("token") ?? ""),
      password,
      code: String(form.get("code") ?? "").slice(0, 40),
    },
    credentialKeys(),
  );
  if (result.ok) return { status: "done", recoveryCodes: result.recoveryCodes };
  return {
    status: "error",
    message:
      result.reason === "WEAK_PASSWORD"
        ? (result.message ?? "Choose a stronger password.")
        : result.reason === "BAD_CODE"
          ? "That code didn’t match. Check your authenticator app’s time and try the newest code."
          : "This set-up link is invalid or has expired. Ask for a new one.",
  };
}

export async function signOutAction() {
  await assertSameOrigin();
  const jar = await cookies();
  if (adminAvailable()) await revokeSession(db(), jar.get(ADMIN_COOKIE)?.value);
  jar.delete(ADMIN_COOKIE);
  redirect("/admin/login");
}

export async function signOutEverywhereAction() {
  await assertSameOrigin();
  const admin = await getAdmin();
  if (admin) await revokeAllSessions(db(), admin.userId, admin.email);
  (await cookies()).delete(ADMIN_COOKIE);
  redirect("/admin/login");
}

// --- Password reset ---------------------------------------------------------------------

const RESET_SENT =
  "If that address belongs to an owner account, a reset link is on its way. It works once and expires in 30 minutes. Check your inbox (and spam folder).";

/** Same answer whether or not the account exists. */
export async function requestPasswordResetAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const email = String(form.get("email") ?? "")
    .trim()
    .slice(0, 254);
  await assertSameOrigin();
  if (!adminAvailable())
    return {
      status: "error",
      message: "This isn’t available right now.",
      email,
    };
  if (
    !(await consumeRateLimit(
      db(),
      LIMITS.passwordResetPerIp,
      clientIp(await headers()),
    ))
  )
    return { status: "error", message: TOO_MANY, email };
  const issued = await issuePasswordReset(db(), { email, actor: null });
  const sender = getEmailSender();
  if (issued && sender) {
    const link = `${siteUrl}/admin/reset?t=${issued.token}`;
    await sender
      .send({
        to: issued.email,
        subject: "Reset your Lodge on the Lake owner password",
        text: [
          "Someone (hopefully you) asked to reset the password for your Lodge on the Lake owner account.",
          "",
          `Choose a new password here (works once, within 30 minutes):`,
          link,
          "",
          "You will still need your authenticator app to sign in.",
          "If you didn't ask for this, ignore this email: your password stays the same.",
        ].join("\n"),
        idempotencyKey: `password-reset:${issued.expiresAt.getTime()}:${issued.email}`,
      })
      // Never reveal delivery problems (or the account's existence).
      .catch(() => undefined);
  }
  return { status: "info", message: RESET_SENT, email };
}

export async function resetPasswordAction(
  _previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  await assertSameOrigin();
  if (!adminAvailable())
    return { status: "error", message: "This isn’t available right now." };
  if (
    !(await consumeRateLimit(
      db(),
      LIMITS.passwordResetPerIp,
      clientIp(await headers()),
    ))
  )
    return { status: "error", message: TOO_MANY };
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? ""))
    return { status: "error", message: "The two passwords don’t match." };
  const result = await completePasswordReset(db(), {
    token: String(form.get("token") ?? ""),
    password,
  });
  if (!result.ok)
    return {
      status: "error",
      message:
        result.reason === "WEAK_PASSWORD"
          ? (result.message ?? "Choose a stronger password.")
          : "This reset link is invalid, already used or expired. Ask for a new one.",
    };
  (await cookies()).delete(ADMIN_COOKIE);
  redirect("/admin/login?notice=reset");
}
