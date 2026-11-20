// @chartwarden/db — `care_plan_change_proposal` (M7, WF09). A change to the plan of care that a clinician recorded while
// documenting a visit, waiting for the case manager or a supervisor to accept it. Deliberately a SEPARATE table from
// problem / goal / intervention: nothing that reads the plan (claims, HOPE, the IDG packet, the portal, version snapshots, the
// encounter picker) can see a proposal, so a visit never edits the signed plan (42 CFR 418.56: the IDG revises it).
//
// Lifecycle (status): `draft` while the visit note is being written (visible to its proposer only); `pending` once the visit
// is finalized (the review list); then `accepted` (the same service operation the manual Care Plans routes use ran, and
// `result_element_id` names the element) or `dismissed`. `withdrawn` is a draft the author discarded, or one whose visit was
// voided.
//
// `source_encounter_id` is a logical reference (M7 takes no M8 dependency). `target_element_id` / `problem_id` /
// `result_element_id` are plain uuids validated by the application, since each may name a problem, a goal or an intervention.
// `parent_proposal_id` lets a goal or intervention hang off a problem that is itself still a proposal.
//
// PHI-bearing → three-column tenancy (siting inherited from the plan, nullable like `problem`). Free text (description, goal_text,
// measurable_outcome, revised_text, resolution_note, scope_text, frequency_text, discontinue_reason) is stored in the clear like
// the element it becomes, denylisted from the M4 write-audit trigger, and erased by M7's `care_plan_record` eraser. Value sets are
// text + CHECK (no pg enum); the lists are exported here so the migration, the TypeBox contract and the tests share one source.
// RLS + grants + the audit trigger land in migration 1532: UPDATE is granted per column (the change, the Part 2 flag and the lifecycle columns), and
// a guard trigger refuses a change to the row's plan, patient, visit, proposer and creation time, whatever role writes.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { carePlans } from "./care-plans";

export const CARE_PLAN_CHANGE_PROPOSAL_KINDS = [
  "problem_add",
  "problem_resolve",
  "goal_add",
  "goal_update",
  "intervention_add",
  "intervention_discontinue",
] as const;
export const CARE_PLAN_CHANGE_PROPOSAL_STATUSES = [
  "draft",
  "pending",
  "accepted",
  "dismissed",
  "withdrawn",
] as const;
export const CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS = [
  "not_clinically_appropriate",
  "already_addressed",
  "duplicate",
  "entered_in_error",
  "defer_to_idg",
] as const;
export const CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS = [
  "terminal",
  "related",
  "unrelated",
] as const;
/** `intake_extraction` is DocLens-only, so a visit cannot claim it. */
export const CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES = [
  "clinical",
  "patient_reported",
  "family_reported",
  "history",
] as const;
/** `agent_stated` needs a DPOA consent check the visit flow does not carry. */
export const CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES = [
  "clinical",
  "patient_stated",
  "family_stated",
] as const;
/** The status moves the goal lifecycle allows; `not_started` is never a move. */
export const CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES = [
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
] as const;
export const CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "md_np",
  "pt",
  "ot",
  "st",
  "volunteer",
  "music_therapy",
  "dietitian",
  "bereavement",
] as const;

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IS NULL OR ${column} IN (${quoted(values)})`);
const T = "care_plan_change_proposal";

export const carePlanChangeProposals = pgTable(
  T,
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    sourceEncounterId: uuid("source_encounter_id").notNull(), // M8 encounter (logical; no cross-module FK)
    kind: text("kind").notNull(),
    status: text("status").notNull().default("draft"),
    /** Part 2: copied from the problem the change touches (or flagged by the proposer on `problem_add`). */
    sudRelated: boolean("sud_related").notNull().default(false),

    // What the change points at.
    targetElementId: uuid("target_element_id"),
    problemId: uuid("problem_id"),
    parentProposalId: uuid("parent_proposal_id").references(
      (): AnyPgColumn => carePlanChangeProposals.id,
    ),
    goalRefs: uuid("goal_refs").array().notNull().default(sql`'{}'::uuid[]`),

    // problem_add
    description: text("description"),
    icd10Code: text("icd10_code"),
    snomedCode: text("snomed_code"),
    problemKind: text("problem_kind"),
    problemSource: text("problem_source"),
    onsetAt: timestamp("onset_at", { withTimezone: true }),
    // problem_resolve
    resolutionNote: text("resolution_note"),
    // goal_add / goal_update
    goalText: text("goal_text"),
    goalSource: text("goal_source"),
    measurableOutcome: text("measurable_outcome"),
    targetAt: timestamp("target_at", { withTimezone: true }),
    revisedText: text("revised_text"),
    goalStatus: text("goal_status"),
    // intervention_add
    scopeText: text("scope_text"),
    frequencyText: text("frequency_text"),
    frequencyValue: text("frequency_value"),
    discipline: text("discipline"),
    responsibleRole: text("responsible_role"),
    // intervention_discontinue
    discontinueReason: text("discontinue_reason"),

    // Lifecycle.
    proposedByMembershipId: uuid("proposed_by_membership_id")
      .notNull()
      .references(() => memberships.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    decidedByMembershipId: uuid("decided_by_membership_id").references(() => memberships.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    resultElementId: uuid("result_element_id"),
    dismissalReason: text("dismissal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index(`${T}_encounter_ix`).on(t.organizationId, t.sourceEncounterId, t.status),
    index(`${T}_patient_ix`).on(t.organizationId, t.patientId, t.status),
    index(`${T}_plan_status_ix`).on(t.carePlanId, t.status),
    index(`${T}_parent_ix`).on(t.parentProposalId).where(sql`parent_proposal_id IS NOT NULL`),
    check(`${T}_kind_known`, sql.raw(`kind IN (${quoted(CARE_PLAN_CHANGE_PROPOSAL_KINDS)})`)),
    check(
      `${T}_status_known`,
      sql.raw(`status IN (${quoted(CARE_PLAN_CHANGE_PROPOSAL_STATUSES)})`),
    ),
    check(
      `${T}_problem_kind_known`,
      oneOf("problem_kind", CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS),
    ),
    check(
      `${T}_problem_source_known`,
      oneOf("problem_source", CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES),
    ),
    check(`${T}_goal_source_known`, oneOf("goal_source", CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES)),
    check(`${T}_goal_status_known`, oneOf("goal_status", CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES)),
    check(`${T}_discipline_known`, oneOf("discipline", CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES)),
    check(
      `${T}_dismissal_reason_known`,
      oneOf("dismissal_reason", CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS),
    ),
  ],
);

export type CarePlanChangeProposal = typeof carePlanChangeProposals.$inferSelect;
export type NewCarePlanChangeProposal = typeof carePlanChangeProposals.$inferInsert;
