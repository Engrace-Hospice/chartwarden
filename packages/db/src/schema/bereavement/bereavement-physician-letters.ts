// @chartwarden/db — `bereavement_physician_letter` (ADR-0109 D6, migration 1345). The condolence letter from the hospice to the
// patient's INTERNAL attending clinician: one per bereavement plan, created `pending_review` by the intake that opens the plan and
// disclosed only after a human approves it. Approval emits `m16.bereavement.document_requested` (M22 renders the PDF) in the same
// transaction as the status change; the M22 back-ref stamps `rendered_document_id` and moves the row to `rendered`.
//
// The recipient is `attending_user_id` (the care team's attending/md clinician, else the user the reviewer names) — required once the
// letter is approved. No community-physician reference. `personal_note_cipher` is the reviewer's optional note sealed with the tenant
// DEK (cipher column `bereavement_physician_letter.personal_note`); `decline_reason_redacted` is audit-denylisted prose.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// CROSS-MODULE FK POLICY: org/PE/location + the intra-M16 plan parent are real FKs; patient_id (M5), the user / membership ids (M2) and
// rendered_document_id (M22) are logical uuids.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavementPlan } from "./bereavement-plans";

export const BEREAVEMENT_PHYSICIAN_LETTER_STATUSES = [
  "pending_review",
  "approved",
  "rendered",
  "declined",
] as const;

export const bereavementPhysicianLetter = pgTable(
  "bereavement_physician_letter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical M5 patient (the decedent)

    attendingUserId: uuid("attending_user_id"), // logical M2 user; required once approved
    status: text("status", { enum: BEREAVEMENT_PHYSICIAN_LETTER_STATUSES })
      .notNull()
      .default("pending_review"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    personalNoteCipher: text("personal_note_cipher"), // sealed, <= 1000 characters of plaintext
    declineReasonRedacted: text("decline_reason_redacted"), // audit-denylisted
    reviewedByMembershipId: uuid("reviewed_by_membership_id"), // logical M2 membership
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    renderedDocumentId: uuid("rendered_document_id"), // logical M22 document
    m22RenderRequestedAt: timestamp("m22_render_requested_at", { withTimezone: true }),
    m22RenderedAt: timestamp("m22_rendered_at", { withTimezone: true }),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planUnique: uniqueIndex("berv_physician_letter_plan_uniq").on(t.planId),
    // The review queue: pending letters, oldest-due first.
    pendingIdx: index("berv_physician_letter_pending_idx")
      .on(t.organizationId, t.dueAt)
      .where(sql`status = 'pending_review'`),
    orgIdx: index("berv_physician_letter_org_ix").on(t.organizationId, t.createdAt),
    providerEntityIdx: index("berv_physician_letter_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_physician_letter_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),

    statusValues: check(
      "berv_physician_letter_status_chk",
      sql`status IN ('pending_review', 'approved', 'rendered', 'declined')`,
    ),
    reviewShape: check(
      "berv_physician_letter_review_chk",
      sql`(status = 'pending_review') = (reviewed_at IS NULL AND reviewed_by_membership_id IS NULL)`,
    ),
    attendingRequired: check(
      "berv_physician_letter_attending_chk",
      sql`status NOT IN ('approved', 'rendered') OR attending_user_id IS NOT NULL`,
    ),
    noteShape: check(
      "berv_physician_letter_note_chk",
      sql`personal_note_cipher IS NULL OR status IN ('approved', 'rendered')`,
    ),
    declineShape: check(
      "berv_physician_letter_decline_chk",
      sql`decline_reason_redacted IS NULL OR (status = 'declined' AND char_length(btrim(decline_reason_redacted)) >= 20)`,
    ),
    renderRequestShape: check(
      "berv_physician_letter_render_request_chk",
      sql`(status IN ('approved', 'rendered')) = (m22_render_requested_at IS NOT NULL)`,
    ),
    renderedShape: check(
      "berv_physician_letter_rendered_chk",
      sql`(status = 'rendered') = (rendered_document_id IS NOT NULL AND m22_rendered_at IS NOT NULL)`,
    ),
  }),
);

export type BereavementPhysicianLetterRow = typeof bereavementPhysicianLetter.$inferSelect;
export type NewBereavementPhysicianLetterRow = typeof bereavementPhysicianLetter.$inferInsert;
