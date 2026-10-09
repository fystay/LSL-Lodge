/**
 * Relational schema for Lodge on the Lake.
 *
 * Conventions
 * - Money is integer minor units (pence) with an explicit ISO currency.
 * - Stay dates are DATE columns holding local property calendar dates. Every
 *   date-range table also has a generated `stay` daterange column using
 *   half-open '[)' bounds: check-in inclusive, check-out exclusive.
 * - Event timestamps are `timestamptz` (stored as UTC).
 * - Overlap of active reservations is prevented by a PostgreSQL exclusion
 *   constraint added in a hand-written migration (drizzle-kit cannot express
 *   EXCLUDE constraints); see drizzle/0001_overlap_protection.sql.
 * - External calendar data is minimised: dates, UIDs and a content hash only.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "daterange";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const id = () => uuid("id").primaryKey().defaultRandom();

const stayColumns = (startColumn: string, endColumn: string) => ({
  stay: daterange("stay")
    .notNull()
    .generatedAlwaysAs(
      sql.raw(`daterange(${startColumn}, ${endColumn}, '[)')`),
    ),
});

// --- Enums -------------------------------------------------------------------

export const reservationStatus = pgEnum("reservation_status", [
  "REQUESTED",
  "APPROVED",
  "DECLINED",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_DUE",
  "CANCELLED",
  "EXPIRED",
  "REFUND_PENDING",
  "REFUNDED",
  "REQUIRES_REVIEW",
]);

/**
 * REQUEST: the guest asks, the owner approves, then the guest pays (the
 * initial, owner-chosen mode). INSTANT: the guest pays straight away; built
 * but refused at runtime until the owner approves it (see
 * src/server/booking/mode.ts).
 */
export const bookingMode = pgEnum("booking_mode", ["REQUEST", "INSTANT"]);

export const reservationSource = pgEnum("reservation_source", [
  "DIRECT",
  "OWNER_MANUAL",
]);

export const feeKind = pgEnum("fee_kind", [
  "PER_STAY",
  "PER_NIGHT",
  "PER_GUEST_PER_NIGHT",
  "PERCENT_OF_ACCOMMODATION",
]);

export const taxTreatment = pgEnum("tax_treatment", [
  "INCLUDED",
  "EXCLUDED",
  "NOT_APPLICABLE",
  "UNCONFIRMED",
]);

export const paymentPlanMode = pgEnum("payment_plan_mode", ["FULL", "DEPOSIT"]);

export const paymentKind = pgEnum("payment_kind", ["CHARGE", "REFUND"]);

export const paymentPurpose = pgEnum("payment_purpose", [
  "FULL",
  "DEPOSIT",
  "BALANCE",
]);

export const paymentStatus = pgEnum("payment_status", [
  "PENDING",
  "REQUIRES_ACTION",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "DISPUTED",
]);

export const scheduleItemStatus = pgEnum("schedule_item_status", [
  "SCHEDULED",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "WAIVED",
]);

export const calendarProvider = pgEnum("calendar_provider", [
  "GOOGLE",
  "AIRBNB_ICAL",
  "OTHER_ICAL",
  "CHANNEL_MANAGER",
]);

export const syncDirection = pgEnum("sync_direction", ["IMPORT", "EXPORT"]);

export const syncStatus = pgEnum("sync_status", [
  "NEVER_SYNCED",
  "OK",
  "STALE",
  "ERROR",
  "DISCONNECTED",
]);

export const busyPeriodStatus = pgEnum("busy_period_status", [
  "ACTIVE",
  "CANCELLED",
  "REMOVED_FROM_SOURCE",
]);

export const eventLinkState = pgEnum("event_link_state", [
  "PENDING_CREATE",
  "PENDING_UPDATE",
  "PENDING_DELETE",
  "SYNCED",
  "DELETED",
  "ERROR",
]);

export const webhookState = pgEnum("webhook_state", [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "IGNORED",
]);

export const notificationStatus = pgEnum("notification_status", [
  "PENDING",
  "SENDING",
  "SENT",
  "FAILED",
  "CANCELLED",
  /** Rendered but deliberately not delivered (email delivery switched off). */
  "SUPPRESSED",
]);

export const recipientKind = pgEnum("recipient_kind", ["GUEST", "OWNER"]);

/** OWNER: everything. VIEWER: read-only access to the dashboard. */
export const adminRole = pgEnum("admin_role", ["OWNER", "VIEWER"]);

export const jobRunStatus = pgEnum("job_run_status", [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);

export const actorType = pgEnum("actor_type", [
  "SYSTEM",
  "OWNER",
  "GUEST",
  "WEBHOOK",
  "JOB",
]);

// --- Property and pricing ----------------------------------------------------

export const properties = pgTable(
  "properties",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    timeZone: text("time_zone").notNull().default("Europe/London"),
    currency: char("currency", { length: 3 }).notNull().default("GBP"),
    maxGuests: smallint("max_guests").notNull(),
    defaultMinNights: smallint("default_min_nights").notNull().default(1),
    /** Nights that must stay free between bookings (0 = same-day turnover). */
    turnoverNights: smallint("turnover_nights").notNull().default(0),
    checkInTime: text("check_in_time"),
    checkOutTime: text("check_out_time"),
    /** Bookable horizon in days from today. */
    bookingHorizonDays: smallint("booking_horizon_days").notNull().default(540),
    /** Reference to published, owner-approved content (e.g. a content slug). */
    contentRef: text("content_ref"),
    bookingsEnabled: boolean("bookings_enabled").notNull().default(false),
    bookingMode: bookingMode("booking_mode").notNull().default("REQUEST"),
    /** How long the owner has to approve or decline a request. */
    requestResponseHours: smallint("request_response_hours")
      .notNull()
      .default(24),
    /** How long an approved guest has to pay before the dates are released. */
    paymentWindowHours: smallint("payment_window_hours").notNull().default(24),
    ...timestamps,
  },
  (t) => [
    check(
      "properties_request_response_hours_range",
      sql`${t.requestResponseHours} BETWEEN 1 AND 168`,
    ),
    check(
      "properties_payment_window_hours_range",
      sql`${t.paymentWindowHours} BETWEEN 1 AND 168`,
    ),
    check("properties_max_guests_positive", sql`${t.maxGuests} > 0`),
    check("properties_min_nights_positive", sql`${t.defaultMinNights} > 0`),
    check("properties_turnover_non_negative", sql`${t.turnoverNights} >= 0`),
  ],
);

export const rateRules = pgTable(
  "rate_rules",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** Nights from startsOn (inclusive) to endsOn (exclusive) use this rule. */
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    nightlyMinor: integer("nightly_minor").notNull(),
    /** Optional rate for Friday and Saturday nights. */
    weekendNightlyMinor: integer("weekend_nightly_minor"),
    minNights: smallint("min_nights"),
    /** ISO weekdays (1–7) on which a stay may start; null = any day. */
    allowedArrivalWeekdays: smallint("allowed_arrival_weekdays").array(),
    /** Higher priority wins where rules overlap. */
    priority: smallint("priority").notNull().default(0),
    /** Incremented on every edit; quotes record the version they used. */
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    ...stayColumns("starts_on", "ends_on"),
    ...timestamps,
  },
  (t) => [
    check("rate_rules_range_valid", sql`${t.endsOn} > ${t.startsOn}`),
    check("rate_rules_nightly_non_negative", sql`${t.nightlyMinor} >= 0`),
    check(
      "rate_rules_weekend_non_negative",
      sql`${t.weekendNightlyMinor} IS NULL OR ${t.weekendNightlyMinor} >= 0`,
    ),
    check(
      "rate_rules_min_nights_positive",
      sql`${t.minNights} IS NULL OR ${t.minNights} > 0`,
    ),
    index("rate_rules_property_stay_idx").using("gist", t.propertyId, t.stay),
  ],
);

export const feeRules = pgTable(
  "fee_rules",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: feeKind("kind").notNull(),
    amountMinor: integer("amount_minor"),
    /** For percentage fees: 100 basis points = 1%. */
    basisPoints: integer("basis_points"),
    /** For per-guest fees: charged only for guests above this number. */
    appliesAboveGuests: smallint("applies_above_guests"),
    mandatory: boolean("mandatory").notNull().default(true),
    taxTreatment: taxTreatment("tax_treatment")
      .notNull()
      .default("UNCONFIRMED"),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check(
      "fee_rules_amount_shape",
      sql`(${t.kind} = 'PERCENT_OF_ACCOMMODATION' AND ${t.basisPoints} IS NOT NULL AND ${t.basisPoints} >= 0 AND ${t.amountMinor} IS NULL)
        OR (${t.kind} <> 'PERCENT_OF_ACCOMMODATION' AND ${t.amountMinor} IS NOT NULL AND ${t.amountMinor} >= 0 AND ${t.basisPoints} IS NULL)`,
    ),
  ],
);

export const paymentPolicies = pgTable(
  "payment_policies",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    mode: paymentPlanMode("mode").notNull(),
    depositBasisPoints: integer("deposit_basis_points"),
    depositFixedMinor: integer("deposit_fixed_minor"),
    minimumDepositMinor: integer("minimum_deposit_minor"),
    /** Balance falls due this many days before check-in. */
    balanceDueDaysBeforeCheckIn: smallint("balance_due_days_before_check_in"),
    /** Bookings made closer to check-in than this pay in full. */
    fullPaymentWithinDays: smallint("full_payment_within_days"),
    cancellationPolicyRef: text("cancellation_policy_ref"),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check(
      "payment_policies_deposit_shape",
      sql`${t.mode} = 'FULL'
        OR (${t.balanceDueDaysBeforeCheckIn} IS NOT NULL AND ${t.balanceDueDaysBeforeCheckIn} >= 0
            AND ((${t.depositBasisPoints} IS NOT NULL AND ${t.depositBasisPoints} BETWEEN 1 AND 10000)
              OR (${t.depositFixedMinor} IS NOT NULL AND ${t.depositFixedMinor} > 0)))`,
    ),
  ],
);

// --- Reservations ------------------------------------------------------------

/**
 * Requests, holds and bookings share one table, so a single exclusion
 * constraint covers them all. A reservation in REQUESTED, APPROVED or
 * PENDING_PAYMENT holds its dates until `holdExpiresAt` (the "ReservationHold
 * or equivalent"): the owner's response deadline, the guest's payment
 * deadline, or the instant-booking hold respectively.
 */
export const reservations = pgTable(
  "reservations",
  {
    id: id(),
    publicRef: text("public_ref").notNull().unique(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    source: reservationSource("source").notNull().default("DIRECT"),
    status: reservationStatus("status").notNull(),
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
    guests: smallint("guests").notNull(),
    guestName: text("guest_name").notNull(),
    guestEmail: text("guest_email").notNull(),
    guestPhone: text("guest_phone"),
    currency: char("currency", { length: 3 }).notNull(),
    totalMinor: integer("total_minor").notNull(),
    /** Immutable itemised quote (rule versions, line items, schedule). */
    quoteSnapshot: jsonb("quote_snapshot").notNull(),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Admin email of the approver. */
    approvedBy: text("approved_by"),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declinedBy: text("declined_by"),
    /** Owner-only note; never shown to the guest. */
    ownerNote: text("owner_note"),
    /** Machine-readable reason a reservation needs the owner (e.g. PAYMENT_AFTER_EXPIRY). */
    reviewReason: text("review_reason"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** SHA-256 of the guest's booking-access token; the token is never stored. */
    accessTokenHash: text("access_token_hash").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Optimistic-concurrency counter, incremented on every state change. */
    lockVersion: integer("lock_version").notNull().default(0),
    ...stayColumns("check_in", "check_out"),
    ...timestamps,
  },
  (t) => [
    check("reservations_range_valid", sql`${t.checkOut} > ${t.checkIn}`),
    check("reservations_guests_positive", sql`${t.guests} > 0`),
    check("reservations_total_non_negative", sql`${t.totalMinor} >= 0`),
    check(
      "reservations_hold_has_expiry",
      sql`${t.status} NOT IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT') OR ${t.holdExpiresAt} IS NOT NULL`,
    ),
    check(
      "reservations_approved_has_approver",
      sql`${t.status} <> 'APPROVED' OR ${t.approvedAt} IS NOT NULL`,
    ),
    index("reservations_property_stay_idx").using("gist", t.propertyId, t.stay),
    index("reservations_status_idx").on(t.status),
    index("reservations_hold_expiry_idx")
      .on(t.holdExpiresAt)
      .where(sql`${t.status} IN ('REQUESTED', 'APPROVED', 'PENDING_PAYMENT')`),
  ],
);

export const paymentScheduleItems = pgTable(
  "payment_schedule_items",
  {
    id: id(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "restrict" }),
    sequence: smallint("sequence").notNull(),
    purpose: paymentPurpose("purpose").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    paidMinor: integer("paid_minor").notNull().default(0),
    status: scheduleItemStatus("status").notNull().default("SCHEDULED"),
    ...timestamps,
  },
  (t) => [
    unique("payment_schedule_items_reservation_sequence").on(
      t.reservationId,
      t.sequence,
    ),
    check("payment_schedule_items_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "payment_schedule_items_paid_bounds",
      sql`${t.paidMinor} >= 0 AND ${t.paidMinor} <= ${t.amountMinor}`,
    ),
    index("payment_schedule_items_due_idx").on(t.status, t.dueOn),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "restrict" }),
    scheduleItemId: uuid("schedule_item_id").references(
      () => paymentScheduleItems.id,
      {
        onDelete: "restrict",
      },
    ),
    kind: paymentKind("kind").notNull(),
    purpose: paymentPurpose("purpose").notNull(),
    status: paymentStatus("status").notNull().default("PENDING"),
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    stripeRefundId: text("stripe_refund_id").unique(),
    /** When the Stripe Checkout Session stops accepting payment. */
    checkoutExpiresAt: timestamp("checkout_expires_at", { withTimezone: true }),
    /** Provider failure code only; never card details or raw messages. */
    failureCode: text("failure_code"),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("payments_amount_positive", sql`${t.amountMinor} > 0`),
    index("payments_reservation_idx").on(t.reservationId),
  ],
);

// --- Owner blocks and external calendars -------------------------------------

export const ownerBlocks = pgTable(
  "owner_blocks",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    /** Soft delete: blocks are never hard-deleted, for auditability. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...stayColumns("starts_on", "ends_on"),
    ...timestamps,
  },
  (t) => [
    check("owner_blocks_range_valid", sql`${t.endsOn} > ${t.startsOn}`),
    index("owner_blocks_property_stay_idx").using("gist", t.propertyId, t.stay),
  ],
);

export const externalCalendarSources = pgTable(
  "external_calendar_sources",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    provider: calendarProvider("provider").notNull(),
    direction: syncDirection("direction").notNull(),
    label: text("label").notNull(),
    /**
     * AES-256-GCM ciphertext of provider configuration (feed URL, OAuth
     * refresh token, calendar ID). Never selected into client-facing queries.
     */
    encryptedConfig: text("encrypted_config"),
    encryptionKeyVersion: smallint("encryption_key_version"),
    enabled: boolean("enabled").notNull().default(true),
    syncStatus: syncStatus("sync_status").notNull().default("NEVER_SYNCED"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Sanitised error code/message; must never contain URLs or tokens. */
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    httpEtag: text("http_etag"),
    httpLastModified: text("http_last_modified"),
    providerSyncToken: text("provider_sync_token"),
    staleAfterMinutes: integer("stale_after_minutes").notNull().default(60),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    /** While set in the future, a sync of this source is in progress. */
    syncLeaseUntil: timestamp("sync_lease_until", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("external_calendar_sources_next_sync_idx").on(
      t.enabled,
      t.nextSyncAt,
    ),
  ],
);

export const externalBusyPeriods = pgTable(
  "external_busy_periods",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => externalCalendarSources.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    externalUid: text("external_uid").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    status: busyPeriodStatus("status").notNull().default("ACTIVE"),
    /** Hash of the normalised event, used for change detection and loop avoidance. */
    contentHash: text("content_hash").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...stayColumns("starts_on", "ends_on"),
    ...timestamps,
  },
  (t) => [
    unique("external_busy_periods_source_uid").on(t.sourceId, t.externalUid),
    check(
      "external_busy_periods_range_valid",
      sql`${t.endsOn} > ${t.startsOn}`,
    ),
    index("external_busy_periods_property_stay_idx").using(
      "gist",
      t.propertyId,
      t.stay,
    ),
  ],
);

export const calendarEventLinks = pgTable(
  "calendar_event_links",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => externalCalendarSources.id, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id").references(() => reservations.id, {
      onDelete: "restrict",
    }),
    ownerBlockId: uuid("owner_block_id").references(() => ownerBlocks.id, {
      onDelete: "restrict",
    }),
    externalEventId: text("external_event_id"),
    state: eventLinkState("state").notNull().default("PENDING_CREATE"),
    contentHash: text("content_hash"),
    attempts: integer("attempts").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (t) => [
    unique("calendar_event_links_source_event").on(
      t.sourceId,
      t.externalEventId,
    ),
    unique("calendar_event_links_source_reservation").on(
      t.sourceId,
      t.reservationId,
    ),
    unique("calendar_event_links_source_owner_block").on(
      t.sourceId,
      t.ownerBlockId,
    ),
    check(
      "calendar_event_links_one_target",
      sql`num_nonnulls(${t.reservationId}, ${t.ownerBlockId}) = 1`,
    ),
  ],
);

// --- Integrations, notifications and audit ------------------------------------

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    state: webhookState("state").notNull().default("RECEIVED"),
    attempts: integer("attempts").notNull().default(0),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
  },
  (t) => [
    unique("webhook_events_provider_event").on(t.provider, t.providerEventId),
    index("webhook_events_state_idx").on(t.state),
  ],
);

export const notificationJobs = pgTable(
  "notification_jobs",
  {
    id: id(),
    template: text("template").notNull(),
    recipientKind: recipientKind("recipient_kind").notNull(),
    /** Recipient is resolved at send time from the reservation, not copied here. */
    reservationId: uuid("reservation_id").references(() => reservations.id, {
      onDelete: "restrict",
    }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: notificationStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("notification_jobs_due_idx").on(t.status, t.nextAttemptAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    /** Safe, non-sensitive metadata only (no PII, secrets or card data). */
    metadata: jsonb("metadata").notNull().default({}),
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_target_idx").on(t.targetType, t.targetId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

/**
 * Fixed-window rate-limit counters (src/server/security/rate-limit.ts).
 * Keys hold a purpose and a hashed subject (never a raw IP or email).
 * Old windows are deleted by the sweeper.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [index("rate_limits_window_idx").on(t.windowStart)],
);

// --- Admin accounts ---------------------------------------------------------------

/**
 * Dashboard accounts (src/server/admin/auth.ts). Passwords are scrypt hashes;
 * TOTP secrets are AES-256-GCM encrypted; recovery codes and enrolment
 * tokens are stored only as SHA-256 hashes. An account can't sign in until
 * its owner has completed enrolment (password + authenticator).
 */
export const adminUsers = pgTable(
  "admin_users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    role: adminRole("role").notNull(),
    passwordHash: text("password_hash"),
    totpSecretEncrypted: text("totp_secret_encrypted"),
    /** Last accepted TOTP time step, so a code can't be replayed. */
    totpLastStep: integer("totp_last_step"),
    recoveryCodeHashes: text("recovery_code_hashes").array(),
    enrolmentTokenHash: text("enrolment_token_hash").unique(),
    enrolmentExpiresAt: timestamp("enrolment_expires_at", {
      withTimezone: true,
    }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      "admin_users_enrolled_has_credentials",
      sql`${t.enrolledAt} IS NULL OR (${t.passwordHash} IS NOT NULL AND ${t.totpSecretEncrypted} IS NOT NULL)`,
    ),
  ],
);

/**
 * Server-side admin sessions. The cookie holds a random token; only its hash
 * is stored. A session is usable only after the second factor
 * (`mfaVerifiedAt`), expires after idle time and an absolute limit, and can
 * be revoked.
 */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
    /** Last time the second factor was re-entered, for sensitive actions. */
    reauthenticatedAt: timestamp("reauthenticated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("admin_sessions_user_idx").on(t.userId)],
);

// --- Background jobs ----------------------------------------------------------------

/**
 * One row per job name. A runner holds the lease until `leasedUntil`; a
 * runner that dies simply lets it expire. Prevents overlapping runs.
 */
export const jobLeases = pgTable("job_leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
});

/** History of job runs, for the admin System page and the health endpoint. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    name: text("name").notNull(),
    status: jobRunStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    /** Counts only (e.g. {"expired": 2}); never personal data. */
    summary: jsonb("summary").notNull().default({}),
    errorCode: text("error_code"),
  },
  (t) => [index("job_runs_name_started_idx").on(t.name, t.startedAt)],
);
