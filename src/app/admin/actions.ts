"use server";

import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, isDatabaseConfigured } from "@/server/db/client";
import {
  clientIp,
  consumeRateLimit,
  LIMITS,
} from "@/server/security/rate-limit";
import { createOwnerBlock, removeOwnerBlock } from "@/server/booking/holds";
import { approveRequest, declineRequest } from "@/server/booking/requests";
import { addIcalSource, syncIcalSource } from "@/server/calendar/sync";
import { calendarSources, setCalendarSourceEnabled } from "@/server/admin/data";
import { signInLocal, signOut } from "@/server/admin/auth";
import { adminContext } from "@/server/admin/context";
import {
  createFeeRule,
  createRateRule,
  savePaymentPolicy,
  setFeeRuleActive,
  setRateRuleActive,
  updatePropertySettings,
  updateRateRule,
} from "@/server/admin/data";
import {
  feeRuleSchema,
  fieldErrors,
  ownerBlockSchema,
  paymentPolicySchema,
  propertySettingsSchema,
  rateRuleSchema,
} from "@/server/admin/schemas";

/**
 * Every action re-authenticates via adminContext() (requireAdmin) before doing
 * anything. Results are reported by redirecting with a short status message.
 */

function back(path: string, params: { saved?: string; error?: string }): never {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
  redirect(`${path}?${query}` as Route);
}

async function ready() {
  const ctx = await adminContext();
  if (!ctx.ready) back("/admin", { error: ctx.reason });
  return ctx;
}

const firstError = (error: Parameters<typeof fieldErrors>[0]) =>
  Object.values(fieldErrors(error))[0];
const uuid = (value: FormDataEntryValue | null) => {
  const id = String(value ?? "");
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

// --- Session ----------------------------------------------------------------------

export async function signInAction(form: FormData) {
  if (isDatabaseConfigured()) {
    const ip = clientIp(await headers());
    if (!(await consumeRateLimit(db(), LIMITS.loginPerIp, ip)))
      redirect("/admin/login?error=1");
  }
  const ok = await signInLocal(
    String(form.get("email") ?? ""),
    String(form.get("password") ?? ""),
  );
  if (!ok) redirect("/admin/login?error=1");
  redirect("/admin");
}

export async function signOutAction() {
  await signOut();
  redirect("/admin/login");
}

// --- Owner blocks -------------------------------------------------------------------

export async function addOwnerBlockAction(form: FormData) {
  const ctx = await ready();
  const parsed = ownerBlockSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success)
    back("/admin/blocks", { error: firstError(parsed.error) });
  const result = await createOwnerBlock(ctx.db, {
    propertyId: ctx.property.id,
    ...parsed.data,
    createdBy: ctx.admin.email,
  });
  if (!result.ok)
    back("/admin/blocks", {
      error:
        result.reason === "CONFLICTS_WITH_BOOKING"
          ? "Those dates overlap a booking or live hold. Resolve the booking first."
          : "The end date must be after the start date.",
    });
  back("/admin/blocks", { saved: "Dates blocked." });
}

export async function removeOwnerBlockAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id || form.get("confirm") !== "yes")
    back("/admin/blocks", { error: "Tick the box to confirm removal." });
  const removed = await removeOwnerBlock(ctx.db, id, ctx.admin.email);
  back(
    "/admin/blocks",
    removed
      ? { saved: "Block removed; those dates are bookable again." }
      : { error: "That block was already removed." },
  );
}

// --- Booking requests -----------------------------------------------------------------

const CONFLICT_SOURCE: Record<string, string> = {
  OWNER_BLOCK: "one of your blocked periods",
  AIRBNB_ICAL: "an Airbnb booking",
  GOOGLE: "a Google Calendar event",
  OTHER_ICAL: "an imported calendar",
  CHANNEL_MANAGER: "a channel-manager booking",
  DIRECT_BOOKING: "another booking",
  HOLD: "another request",
};

export async function approveRequestAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id) back("/admin/bookings", { error: "Unknown booking." });
  const path = `/admin/bookings/${id}`;
  const result = await approveRequest(ctx.db, {
    propertyId: ctx.property.id,
    reservationId: id,
    actor: ctx.admin.email,
    ownerNote: String(form.get("ownerNote") ?? ""),
  });
  if (result.ok)
    back(path, {
      saved:
        "Approved. The guest has been asked to pay; the booking confirms only when payment is verified.",
    });
  back(path, {
    error:
      result.reason === "CONFLICT"
        ? `Can’t approve: the dates now overlap ${result.sources.map((s) => CONFLICT_SOURCE[s] ?? s).join(" and ")}. Decline the request or resolve the clash first.`
        : result.reason === "EXPIRED"
          ? "This request lapsed before it was approved; its dates have been released."
          : "This request has already been decided.",
  });
}

export async function declineRequestAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id) back("/admin/bookings", { error: "Unknown booking." });
  const path = `/admin/bookings/${id}`;
  if (form.get("confirm") !== "yes")
    back(path, { error: "Tick the box to confirm you want to decline." });
  const result = await declineRequest(ctx.db, {
    propertyId: ctx.property.id,
    reservationId: id,
    actor: ctx.admin.email,
    ownerNote: String(form.get("ownerNote") ?? ""),
  });
  back(
    path,
    result.ok
      ? { saved: "Declined. The dates are free again and nothing was charged." }
      : { error: "This request has already been decided." },
  );
}

// --- Calendar sync ----------------------------------------------------------------------

const FEED_ERROR: Record<string, string> = {
  invalid_url: "That doesn’t look like a calendar link.",
  https_required: "The link must start with https:// (or webcal://).",
  host_not_allowed:
    "Only Airbnb calendar links (airbnb.com or airbnb.co.uk) can be added here.",
  credentials_in_url: "The link must not contain a username or password.",
};

export async function addCalendarSourceAction(form: FormData) {
  const ctx = await ready();
  const label =
    String(form.get("label") ?? "")
      .trim()
      .slice(0, 80) || "Airbnb";
  const url = String(form.get("url") ?? "").slice(0, 2000);
  let result;
  try {
    result = await addIcalSource(ctx.db, {
      propertyId: ctx.property.id,
      label,
      url,
      actor: ctx.admin.email,
    });
  } catch {
    // Encryption key missing or invalid: never store the URL unencrypted.
    back("/admin/calendars", {
      error:
        "Calendar links can’t be stored securely yet: the encryption key isn’t configured.",
    });
  }
  if (!result.ok)
    back("/admin/calendars", {
      error: FEED_ERROR[result.code] ?? "That calendar link can’t be used.",
    });
  const sync = await syncIcalSource(ctx.db, result.id);
  back("/admin/calendars", {
    saved: sync.ok
      ? "Calendar added and imported."
      : `Calendar added, but the first import failed (${sync.code}). It will retry automatically.`,
  });
}

export async function syncCalendarSourceAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id) back("/admin/calendars", { error: "Unknown calendar." });
  const release = form.get("releaseHeld") === "yes";
  if (form.get("intent") === "release" && !release)
    back("/admin/calendars", {
      error: "Tick the box to confirm releasing those dates.",
    });
  const owned = await ownsSource(ctx, id);
  if (!owned) back("/admin/calendars", { error: "Unknown calendar." });
  const result = await syncIcalSource(ctx.db, id, {
    confirmHeldRemovals: release,
  });
  back(
    "/admin/calendars",
    result.ok
      ? {
          saved: result.notModified
            ? "Synced: no changes since the last import."
            : `Synced: ${result.inserted} new, ${result.updated} changed, ${result.removed} removed.`,
        }
      : {
          error: `Sync failed (${result.code}). Previously imported dates stay blocked.`,
        },
  );
}

export async function toggleCalendarSourceAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id) back("/admin/calendars", { error: "Unknown calendar." });
  const enabled = form.get("enabled") === "true";
  await setCalendarSourceEnabled(
    ctx.db,
    ctx.property.id,
    id,
    ctx.admin.email,
    enabled,
  );
  back("/admin/calendars", {
    saved: enabled
      ? "Syncing resumed."
      : "Syncing paused. Dates already imported stay blocked.",
  });
}

async function ownsSource(ctx: Awaited<ReturnType<typeof ready>>, id: string) {
  const sources = await calendarSources(ctx.db, ctx.property.id);
  return sources.some((s) => s.id === id);
}

// --- Pricing -------------------------------------------------------------------------

function rateFields(form: FormData) {
  return {
    ...Object.fromEntries(form),
    arrivalDays: form.getAll("arrivalDays").map(String),
  };
}

export async function createRateRuleAction(form: FormData) {
  const ctx = await ready();
  const parsed = rateRuleSchema.safeParse(rateFields(form));
  if (!parsed.success)
    back("/admin/pricing", { error: firstError(parsed.error) });
  await createRateRule(ctx.db, ctx.property.id, ctx.admin.email, parsed.data);
  back("/admin/pricing", { saved: "Rate added." });
}

export async function updateRateRuleAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  const parsed = rateRuleSchema.safeParse(rateFields(form));
  if (!id) back("/admin/pricing", { error: "Unknown rate." });
  if (!parsed.success)
    back("/admin/pricing", { error: firstError(parsed.error) });
  const ok = await updateRateRule(
    ctx.db,
    ctx.property.id,
    id,
    ctx.admin.email,
    parsed.data,
  );
  back(
    "/admin/pricing",
    ok
      ? { saved: "Rate updated. Existing bookings keep their agreed price." }
      : { error: "Unknown rate." },
  );
}

export async function toggleRateRuleAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id) back("/admin/pricing", { error: "Unknown rate." });
  const active = form.get("active") === "true";
  await setRateRuleActive(ctx.db, ctx.property.id, id, ctx.admin.email, active);
  back("/admin/pricing", {
    saved: active ? "Rate switched on." : "Rate switched off.",
  });
}

export async function createFeeRuleAction(form: FormData) {
  const ctx = await ready();
  const parsed = feeRuleSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success)
    back("/admin/pricing", { error: firstError(parsed.error) });
  await createFeeRule(ctx.db, ctx.property.id, ctx.admin.email, parsed.data);
  back("/admin/pricing", { saved: "Fee added." });
}

export async function toggleFeeRuleAction(form: FormData) {
  const ctx = await ready();
  const id = uuid(form.get("id"));
  if (!id) back("/admin/pricing", { error: "Unknown fee." });
  const active = form.get("active") === "true";
  await setFeeRuleActive(ctx.db, ctx.property.id, id, ctx.admin.email, active);
  back("/admin/pricing", {
    saved: active ? "Fee switched on." : "Fee switched off.",
  });
}

export async function savePaymentPolicyAction(form: FormData) {
  const ctx = await ready();
  const parsed = paymentPolicySchema.safeParse(Object.fromEntries(form));
  if (!parsed.success)
    back("/admin/pricing", { error: firstError(parsed.error) });
  await savePaymentPolicy(
    ctx.db,
    ctx.property.id,
    ctx.admin.email,
    parsed.data,
  );
  back("/admin/pricing", {
    saved: "Payment plan saved. It applies to new bookings only.",
  });
}

// --- Settings ---------------------------------------------------------------------------

export async function updateSettingsAction(form: FormData) {
  const ctx = await ready();
  const parsed = propertySettingsSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success)
    back("/admin/settings", { error: firstError(parsed.error) });
  await updatePropertySettings(
    ctx.db,
    ctx.property.id,
    ctx.admin.email,
    parsed.data,
  );
  back("/admin/settings", { saved: "Settings saved." });
}
