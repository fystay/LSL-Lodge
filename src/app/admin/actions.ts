"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { createOwnerBlock, removeOwnerBlock } from "@/server/booking/holds";
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
