// @wardenx/db — `comfort_kit_return` (M21 §3.1.10). D8/§2.6: the chain-of-custody machine that runs from
// "this patient died, the kit must come back" to a reconciled, witnessed disposal record.
// `requested → assigned → retrieving → retrieved → reconciled`, with `overdue` (30d) and `unreturnable`
// (90d, assumption of loss) as the two escape states.
//
// §3.0 / M21-F04: the `m21_return_state` machine above is normative and the §3.2 draft's
// `reconciliationStatus = 'pending'` flag plus its `returned_at NOT NULL at creation` is dropped — a return
// row is created when the obligation ARISES, long before anything has been returned, and reconciliation is
// the terminal STATE rather than a parallel status column. The draft's `reconciliation_notes` name is
// likewise dropped: §3.1 calls the column `discrepancy_notes`, and §3.0 makes §3.1 normative (D13's prose
// names the other one — that is the drift, not this).
//
// WHY THE WITNESS-DISTINCTNESS CHECK MATTERS: at-home witnessed destruction of a CII solution is the single
// most diversion-exposed moment in hospice. A witness who is also the reconciler, or also the retriever, is
// not a witness — one person then attests to their own count. The CHECK makes that row impossible rather
// than merely discouraged.
//
// NOT partitioned (§3.1.10 / D12): a return is a bounded, current-row workflow object read as "what is open
// on my desk" and "what is overdue", both of which a RANGE partition would force to fan out.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + patient_id + admission_id + provider_entity_id +
// location_id, all NOT NULL, denormalized from the dispatch. Canonical app.org_id RLS; the
// `comfort_kit_return_reconciler_eligible` ABAC predicate (§4.4) is the per-record filter at the route.
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) carry real FKs.
// `dispatch_id` is LOGICAL (its target is partitioned) and rides with `dispatch_partition_dispatched_at`.
// patient_id (M5), admission_id (M6), m13_deployment_id (M13), receipt_document_id (M22) and every
// `*_membership_id` (M2) are logical uuid.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { comfortKitDisposalMethod, comfortKitReturnState } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const comfortKitReturn = pgTable(
  "comfort_kit_return",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dispatchId: uuid("dispatch_id").notNull(), // logical FK → comfort_kit_dispatch (partitioned)
    dispatchPartitionDispatchedAt: timestamp("dispatch_partition_dispatched_at", {
      withTimezone: true,
    }).notNull(),
    /** Denormalized from the dispatch — M13 closes its drawdowns against this id (§4.5.2). */
    m13DeploymentId: uuid("m13_deployment_id").notNull(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    admissionId: uuid("admission_id").notNull(), // logical FK → M6
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    /** When the obligation arose (the M13 return-required cascade). */
    returnRequiredAt: timestamp("return_required_at", { withTimezone: true }).notNull(),
    /** The 30-day compliance clock the `return_overdue` detector measures against. */
    returnDueAt: timestamp("return_due_at", { withTimezone: true }).notNull(),

    assignedRetrievingMembershipId: uuid("assigned_retrieving_membership_id"), // logical FK → M2
    retrievingAt: timestamp("retrieving_at", { withTimezone: true }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    returnedToHubAt: timestamp("returned_to_hub_at", { withTimezone: true }),

    disposalMethod: comfortKitDisposalMethod("disposal_method"),
    /** The jurisdiction's disposal rule AS APPLIED, frozen — state law changes, this record must not. */
    disposalMethodJurisdictionPolicyDigest: text("disposal_method_jurisdiction_policy_digest"),
    disposalWitnessMembershipId: uuid("disposal_witness_membership_id"), // logical FK → M2

    reconciledByMembershipId: uuid("reconciled_by_membership_id"), // logical FK → M2
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    receiptDocumentId: uuid("receipt_document_id"), // logical FK → M22 DEA-1304-format return receipt

    state: comfortKitReturnState("state").notNull().default("requested"),

    // Free text — all three D13 audit-denylisted.
    disposalNotes: text("disposal_notes"),
    discrepancyNotes: text("discrepancy_notes"),
    unreturnableReason: text("unreturnable_reason"),
    unreturnableAttestedByMembershipId: uuid("unreturnable_attested_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index("comfort_kit_return_state_idx").on(
      t.organizationId,
      t.state,
      t.returnDueAt,
    ),
    dispatchIdx: index("comfort_kit_return_dispatch_idx").on(t.dispatchId),
    m13DeploymentIdx: index("comfort_kit_return_m13_deployment_idx").on(t.m13DeploymentId),
    openIdx: index("comfort_kit_return_overdue_idx")
      .on(t.organizationId, t.state)
      .where(sql`state IN ('requested','assigned','retrieving','retrieved')`),

    // Terminal `reconciled` requires the full disposal record — the state is what M13 and M30 act on.
    reconciledIsComplete: check(
      "m21_ckit_return_reconciled_complete",
      sql`state <> 'reconciled'
          OR (disposal_method IS NOT NULL
              AND reconciled_by_membership_id IS NOT NULL
              AND reconciled_at IS NOT NULL)`,
    ),
    homeDestructionHasWitness: check(
      "m21_ckit_return_home_witness",
      sql`disposal_method <> 'dispose_at_home_by_witnessed_destruction'
          OR disposal_witness_membership_id IS NOT NULL`,
    ),
    // See the header — a witness who is also the reconciler or the retriever is not a witness.
    witnessIsDistinct: check(
      "m21_ckit_return_witness_distinct",
      sql`disposal_witness_membership_id IS NULL
          OR (disposal_witness_membership_id IS DISTINCT FROM reconciled_by_membership_id
              AND disposal_witness_membership_id IS DISTINCT FROM assigned_retrieving_membership_id)`,
    ),
    unreturnableIsAttested: check(
      "m21_ckit_return_unreturnable_attested",
      sql`state <> 'unreturnable'
          OR (unreturnable_reason IS NOT NULL
              AND unreturnable_attested_by_membership_id IS NOT NULL)`,
    ),
    dueAfterRequired: check(
      "m21_ckit_return_due_after_required",
      sql`return_due_at >= return_required_at`,
    ),
  }),
);

export type ComfortKitReturnRow = typeof comfortKitReturn.$inferSelect;
export type NewComfortKitReturnRow = typeof comfortKitReturn.$inferInsert;
