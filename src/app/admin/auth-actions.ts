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
  completeSecondFactor,
  reauthenticate,
  revokeAllSessions,
  revokeSession,
  SESSION,
  signInWithPassword,
} from "@/server/admin/accounts";
import { credentialKeys } from "@/server/crypto/keys";
import { db } from "@/server/db/client";
import {
  clientIp,
  consumeRateLimit,
  LIMITS,
} from "@/server/security/rate-limit";

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

export async function signInAction(form: FormData) {
  if (!(await guard())) redirect("/admin/login?error=1");
  const result = await signInWithPassword(db(), {
    email: String(form.get("email") ?? ""),
    password: String(form.get("password") ?? ""),
  });
  if (!result.ok) redirect("/admin/login?error=1");
  await setSessionCookie(
    PENDING_COOKIE,
    result.token,
    SESSION.pendingMinutes * 60,
  );
  redirect("/admin/login/verify");
}

export async function verifySecondFactorAction(form: FormData) {
  if (!(await guard())) redirect("/admin/login?error=1");
  const jar = await cookies();
  const pending = jar.get(PENDING_COOKIE)?.value;
  if (!pending) redirect("/admin/login?error=expired");
  const result = await completeSecondFactor(
    db(),
    {
      pendingToken: pending,
      code: String(form.get("code") ?? "").slice(0, 40),
    },
    credentialKeys(),
  );
  if (!result.ok)
    redirect(
      result.reason === "EXPIRED"
        ? "/admin/login?error=expired"
        : "/admin/login/verify?error=1",
    );
  jar.delete(PENDING_COOKIE);
  await setSessionCookie(
    ADMIN_COOKIE,
    result.token,
    SESSION.absoluteHours * 3600,
  );
  redirect("/admin");
}

export async function reauthAction(form: FormData) {
  await assertSameOrigin();
  const next = String(form.get("next") ?? "/admin");
  const safeNext = /^\/admin(\/[A-Za-z0-9/_-]*)?$/.test(next) ? next : "/admin";
  if (!(await getAdmin())) redirect("/admin/login");
  if (
    !(await consumeRateLimit(
      db(),
      LIMITS.loginPerIp,
      clientIp(await headers()),
    ))
  )
    redirect(
      `/admin/reauth?error=1&next=${encodeURIComponent(safeNext)}` as Route,
    );
  const ok = await reauthenticate(
    db(),
    {
      token: (await cookies()).get(ADMIN_COOKIE)?.value ?? "",
      code: String(form.get("code") ?? "").slice(0, 40),
    },
    credentialKeys(),
  );
  if (!ok)
    redirect(
      `/admin/reauth?error=1&next=${encodeURIComponent(safeNext)}` as Route,
    );
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
