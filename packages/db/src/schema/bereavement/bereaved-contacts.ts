// @wardenx/db — `bereaved_contact` (M16 §3.3.2). D1's middle tier: one row per surviving person, because
// the CoP 418.64(d) obligation runs to EACH survivor — consent, opt-out, risk tier, schedule and portal
// scope are all per-person, never collapsed onto the plan.
//
// The three `*_cipher` columns are DEK envelope-encrypted at the application layer (M34 key ring); they are
// deliberately NOT on the D11 audit denylist — the ciphertext is already unreadable, and denylisting it
// would throw away the only change-detection signal an audit row has for a contact-channel edit.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable — denormalized from the plan
// at roster seed so the compliance seams roll up per CCN without joining. RLS keys on organization_id ALONE;
// the D10 volunteer reduced-PHI scope is M3 ABAC (`volunteer_visible_only` is the row's hint to it), never a
// second permissive policy.
//
// CROSS-MODULE FK POLICY: organization/provider_entity/location (M1 core) + the intra-M16 plan parent carry
// real FKs. caregiver_id_from_m5 / patient_caregiver_id_from_m5 (M5), portal_account_id (M31) and
// consent_record_id (M39 `bereavement_outreach_consent`) are LOGICAL uuid, app-validated.
import { sql } from "drizzle-orm";
import {
  boolean,
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
  bereavedContactRelationship,
  bereavedContactStatus,
  bereavementRiskTier,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavementPlan } from "./bereavement-plans";

export const bereavedContact = pgTable(
  "bereaved_contact",
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

    status: bereavedContactStatus("status").notNull().default("proposed"),
    version: integer("version").notNull().default(0), // §2.5 If-Match

    // Identity — counselor-provided; a bereaved person need not be an M5 caregiver row at all.
    displayName: text("display_name").notNull(),
    caregiverIdFromM5: uuid("caregiver_id_from_m5"), // logical FK → M5 caregiver
    patientCaregiverIdFromM5: uuid("patient_caregiver_id_from_m5"), // logical FK → M5 patient_caregiver
    // M38 owns the authoritative relationship-to-decedent value set (§2.5); the enum mirrors it locally.
    relationshipCode: bereavedContactRelationship("relationship_code").notNull(),

    // Contact channels — envelope-encrypted ciphertext (never plaintext PHI at rest).
    emailCipher: text("email_cipher"),
    phoneCipher: text("phone_cipher"),
    mailingAddressCipher: text("mailing_address_cipher"),

    portalAccountId: uuid("portal_account_id"), // logical FK → M31 portal_account
    consentRecordId: uuid("consent_record_id"), // logical FK → M39 consent_record (D6)

    // D9/§2.5 — the allowed-modality set the schedule generator and the outreach validator read.
    outreachPreferencesJsonb: jsonb("outreach_preferences_jsonb")
      .notNull()
      .default(
        sql`'{"allowed_kinds":["phone_call","sympathy_card","sympathy_letter","anniversary_letter","email"]}'::jsonb`,
      ),
    preferredLanguageIso639: text("preferred_language_iso639").notNull().default("en"),

    // D10 — narrows which fields a bereavement volunteer may read (enforced by M3 ABAC at the route).
    volunteerVisibleOnly: boolean("volunteer_visible_only").notNull().default(false),

    // Rollup of the latest per-contact deterministic score (the score rows themselves are immutable).
    currentRiskTier: bereavementRiskTier("current_risk_tier"),
    currentRiskScoreId: uuid("current_risk_score_id"), // intra-M16 soft ref (no FK: score rows are append-only)

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    unreachableAt: timestamp("unreachable_at", { withTimezone: true }),
    // §4.9 `m16-unreachable-detector` dedupe: the `contact_at` of the newest `no_response` log row the last
    // 3-strikes PROPOSAL covered. The detector re-proposes only when a strictly newer strike exists.
    unreachableProposedThroughAt: timestamp("unreachable_proposed_through_at", {
      withTimezone: true,
    }),
    // Route 34 "keep trying": the `unreachable_proposed_through_at` value the counselor dismissed. Dismissed while >= it.
    unreachableProposalDismissedAt: timestamp("unreachable_proposal_dismissed_at", {
      withTimezone: true,
    }),
    deceasedAt: timestamp("deceased_at", { withTimezone: true }),
    ineligibleAt: timestamp("ineligible_at", { withTimezone: true }),
    ineligibleReasonRedacted: text("ineligible_reason_redacted"), // D11 audit-denylisted

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index("berv_contact_plan_idx").on(t.planId),
    statusIdx: index("berv_contact_status_idx").on(t.organizationId, t.status),
    caregiverM5Idx: index("berv_contact_caregiver_m5_idx")
      .on(t.caregiverIdFromM5)
      .where(sql`caregiver_id_from_m5 IS NOT NULL`),
    portalIdx: index("berv_contact_portal_idx")
      .on(t.portalAccountId)
      .where(sql`portal_account_id IS NOT NULL`),
    // D6 — the M39 revocation cascade looks a contact up BY its consent record id.
    consentIdx: index("berv_contact_consent_idx")
      .on(t.consentRecordId)
      .where(sql`consent_record_id IS NOT NULL`),
    // D6 — a consent record backs at most one contact per tenant (migration 0495).
    consentUniq: uniqueIndex("berv_contact_consent_uniq")
      .on(t.organizationId, t.consentRecordId)
      .where(sql`consent_record_id IS NOT NULL`),
  }),
);

export type BereavedContactRow = typeof bereavedContact.$inferSelect;
export type NewBereavedContactRow = typeof bereavedContact.$inferInsert;
