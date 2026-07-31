// @wardenx/db — `bereavement_plan` (M16 §3.3.1). The D1 program ROOT: exactly one row per
// discharged-by-death admission, carrying the single 13-month CoP 418.64(d) clock and the counselor
// caseload entry. Created `eligible` on `m6.bereavement.eligible` (BOTH D16 source branches), `initiating`
// once a counselor is assigned, `active` once the roster + schedule seed; the four closes are distinct on
// purpose so a surveyor can reconstruct WHY a program ended (§2.2).
//
// D12 / §3.6: NOT partitioned. One plan per decedent admission per tenant is trivial volume, and every read
// is a current-row read (caseload, dashboard, plan detail) that a RANGE partition would force to fan out.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + provider_entity_id NOT NULL, location_id nullable —
// denormalized from the admission at intake so the §4.6 BereavementComplianceProvider rolls up per CCN /
// location without joining through the M5/M6 schemas (the M15-F05 precedent; `BereavementScope` in
// @wardenx/types already declares the same pair). location_id is nullable because the decedent's service
// location is an admission-time attribute that post-death transfers can leave unresolved — matching the
// already-published `BereavementPlanView.locationId: LocationId | null`. RLS pivots on organization_id ALONE.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) carry real FK constraints. patient_id (M5), admission_id (M6), care_plan_version_id_at_discharge
// (M7), legal_hold_id (M4) and both `*_user_id` assignment columns (M2 membership ids — the spec's `user_id`
// NAME is kept, but @wardenx/types already types them `MembershipId`) are LOGICAL uuid, app-validated at
// the write boundary. RLS + grants + the M4 write-audit trigger land in migration 0102.
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  bereavementPlanPauseKind,
  bereavementPlanStatus,
  bereavementRiskTier,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const bereavementPlan = pgTable(
  "bereavement_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5 (decedent; retained, never cascaded)
    admissionId: uuid("admission_id").notNull(), // logical FK → M6
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    status: bereavementPlanStatus("status").notNull().default("eligible"),
    version: integer("version").notNull().default(0), // §2.5 If-Match optimistic concurrency

    // D4 — the schedule anchor. Death, not discharge: a late-filed discharge (M6 W-DC-01) must never
    // silently shorten the survivor's program.
    deathDate: date("death_date").notNull(),
    deathTime: timestamp("death_time", { withTimezone: true }),

    // Assignment (§7.2). Both are M2 membership ids; `discipline_can_provide_bereavement` (D5) and, for the
    // volunteer, M15's `volunteer_gates_satisfied` are checked at assignment time by the service layer.
    assignedCounselorUserId: uuid("assigned_counselor_user_id"),
    assignedCounselorAssignedAt: timestamp("assigned_counselor_assigned_at", { withTimezone: true }),
    assignedVolunteerUserId: uuid("assigned_volunteer_user_id"),
    assignedVolunteerAssignedAt: timestamp("assigned_volunteer_assigned_at", { withTimezone: true }),

    openedAt: timestamp("opened_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseKind: bereavementPlanPauseKind("pause_kind"),
    pauseReasonRedacted: text("pause_reason_redacted"), // D11 audit-denylisted; full reason lives in audit context
    closedAt: timestamp("closed_at", { withTimezone: true }),

    // IPOC inheritance from `m7.care_plan.discharged` — the pre-death bereavement intent, carried forward.
    ipocBereavementIntentSummaryRedacted: text("ipoc_bereavement_intent_summary_redacted"),
    carePlanVersionIdAtDischarge: uuid("care_plan_version_id_at_discharge"), // logical FK → M7

    // Latest PLAN-LEVEL risk rollup (per-contact tiers live on bereaved_contact).
    currentRiskTier: bereavementRiskTier("current_risk_tier"),
    currentRiskComputedAt: timestamp("current_risk_computed_at", { withTimezone: true }),

    // D16 provenance — NULL for internal-clinician-recorded deaths. Shape locked by
    // `BereavementExternalSourceMetadata` in @wardenx/types. Read-only after insert EXCEPT the D18
    // cosign-receipt update, which flips `cosignStatus` to 'cosigned' and stamps the medical director.
    externalSourceMetadata: jsonb("external_source_metadata"),

    legalHoldId: uuid("legal_hold_id"), // logical FK → M4 legal_hold

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // D1 — one program per death. Not partial: a re-admitted-then-died patient is a NEW admission.
    uniqueAdmission: uniqueIndex("berv_plan_unique_admission").on(t.organizationId, t.admissionId),
    patientIdx: index("berv_plan_patient_idx").on(t.organizationId, t.patientId),
    statusIdx: index("berv_plan_status_idx").on(t.organizationId, t.status),
    counselorIdx: index("berv_plan_counselor_idx").on(t.assignedCounselorUserId),
    deathDateIdx: index("berv_plan_death_date_idx").on(t.organizationId, t.deathDate),
    // §4.6 BereavementComplianceProvider rollups (the M15-F05 per-PE/location pattern).
    providerEntityIdx: index("berv_plan_provider_entity_idx").on(
      t.organizationId,
      t.providerEntityId,
      t.locationId,
      t.status,
    ),
    // D18 — the coordinator's pending-cosign queue. Expression index on the jsonb discriminator.
    externalPendingCosignIdx: index("idx_bereavement_plan_external_pending_cosign")
      .on(sql`(external_source_metadata->>'cosignStatus')`)
      .where(
        sql`external_source_metadata IS NOT NULL AND external_source_metadata->>'cosignStatus' = 'pending'`,
      ),

    // §3.3.1 status × required-field invariants (the machine in §2.2 is truth; these are the safety net).
    activeRequiresCounselor: check(
      "berv_plan_active_requires_counselor",
      sql`status NOT IN ('active', 'paused') OR assigned_counselor_user_id IS NOT NULL`,
    ),
    openedAtRequired: check(
      "berv_plan_opened_at_required",
      sql`status NOT IN ('active','paused','closed_completed','closed_declined','closed_early','closed_legal_hold_extended')
          OR opened_at IS NOT NULL`,
    ),
    closedAtRequired: check(
      "berv_plan_closed_at_required",
      sql`status NOT IN ('closed_completed','closed_declined','closed_early','closed_legal_hold_extended')
          OR closed_at IS NOT NULL`,
    ),
    pauseRequiresKind: check(
      "berv_plan_pause_requires_kind",
      sql`status <> 'paused' OR pause_kind IS NOT NULL`,
    ),
  }),
);

export type BereavementPlanRow = typeof bereavementPlan.$inferSelect;
export type NewBereavementPlanRow = typeof bereavementPlan.$inferInsert;
