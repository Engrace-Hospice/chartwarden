// @wardenx/db — `order_recovery_request` (F-199, #248; migration 0271). A PENDING attested recovery of a lab order —
// the two-person control on the duplicate-risk `not_received_by_lab` attestation (M3 break-glass's shape,
// `bge_cosigner_distinct`, migration 0210): a first person files it, a DIFFERENT person co-signs it (which executes the
// re-dispatch), or either cancels it, or its 24 h `expires_at` lapses. At most one pending request per order (partial
// UNIQUE index), the co-signer is never the requester (CHECK), and the status and its resolution columns must agree
// (CHECK); once a request leaves `pending_cosign` a trigger freezes it. `order_record_id` is a plain uuid with NO SQL FK
// (order_record is partitioned — the `order_discontinuation` precedent). RLS + FORCE + the M4 write-audit trigger (the
// contact NAME denylisted) land in the migration; the app role has SELECT/INSERT/UPDATE and no DELETE.
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businessRule } from "../../business-rules";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

/**
 * At most ONE pending recovery per order — the rule the partial unique index enforces, with what violating it means to
 * the caller. Registered so a `23505` (two first-callers racing past the service's own pre-check) answers 409 with this
 * sentence instead of a bare 500 (the F-022 / F-190 convention). Declared here, not inside `pgTable`'s config callback,
 * because Drizzle invokes that callback lazily and a registration that has not run is a rule the error handler cannot see.
 */
const ONE_PENDING_PER_ORDER_UQ = businessRule(
  "order_recovery_request_one_pending_uq",
  "A recovery for this order is already awaiting its co-signature. Co-sign or cancel it before filing another.",
);

export const orderRecoveryRequests = pgTable(
  "order_recovery_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    orderRecordId: uuid("order_record_id").notNull(),
    /** Always `not_received_by_lab` (CHECK) — `received_by_lab` sends nothing and stays single-person. */
    attestation: text("attestation").notNull(),
    /** Who at the lab was contacted — letters/space/`.'-` only (no digits); denylisted in the audit diff. */
    labContactName: text("lab_contact_name").notNull(),
    /** The lab's own reference — `[A-Za-z0-9._#/-]` only (no spaces). */
    labReference: text("lab_reference").notNull(),
    /** The order's `transmission_failure_reason` when the request was filed. */
    priorFailureReason: text("prior_failure_reason").notNull(),
    /**
     * `pending_cosign` | `executed` | `cancelled` | `expired` | `superseded` (CHECK-constrained; agrees with the
     * resolution columns). `superseded` (F-200, migration 0272) = the ORDER moved on (discontinued, corrected, delivered,
     * recovered another way) so the request could never execute; a trigger on `order_record` sets it.
     */
    status: text("status").notNull().default("pending_cosign"),
    requestedByMembershipId: uuid("requested_by_membership_id"),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    cosignedByMembershipId: uuid("cosigned_by_membership_id"),
    cosignedByUserId: uuid("cosigned_by_user_id"),
    cancelledByMembershipId: uuid("cancelled_by_membership_id"),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** The `order_transmission_attestation` row this request produced (`executed` only). */
    attestationId: uuid("attestation_id"),
    /** F-200 — a fixed token (`order_discontinued`, `transmission_transmitted`, …) — set exactly when `status = 'superseded'`. */
    supersededReason: text("superseded_reason"),
    /** F-200 — the co-signature came from a holder of `orders.transmission.cosign_escalated` (the recovery bound was reached). */
    cosignedEscalated: boolean("cosigned_escalated").notNull().default(false),
  },
  (t) => ({
    onePending: uniqueIndex(ONE_PENDING_PER_ORDER_UQ)
      .on(t.organizationId, t.orderRecordId)
      .where(sql`${t.status} = 'pending_cosign'`),
    pendingExpiry: index("order_recovery_request_pending_expiry_idx")
      .on(t.organizationId, t.expiresAt)
      .where(sql`${t.status} = 'pending_cosign'`),
    byOrder: index("order_recovery_request_order_idx").on(t.organizationId, t.orderRecordId, t.requestedAt),
  }),
);

export type OrderRecoveryRequest = typeof orderRecoveryRequests.$inferSelect;
export type NewOrderRecoveryRequest = typeof orderRecoveryRequests.$inferInsert;
