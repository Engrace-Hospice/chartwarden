// @chartwarden/db — `safety_emergency_contact_consent` (M20 §3.3 / §2.2.8, D6/D10/M20-F16). One row per
// clinician per consent purpose. The CLINICIAN is the data subject here, not a patient: this is the
// workforce's own consent to have their location captured during an SOS, streamed during an active SOS,
// and their emergency contact called when the life-safety chain reaches its terminus.
//
// `expired` IS NOT `revoked` AND THE DISTINCTION IS THE POINT (§2.2.8). Revoked means the clinician
// withdrew; expired means the tenant's rotation aged the acknowledgment out and nobody has re-asked. A
// coercion review reads exactly that difference, so the two are separate enum values and the row keeps
// `revoked_at` and `expires_at` as separate columns rather than one "ended_at".
//
// THE THREE PURPOSES ARE SEPARATELY GRANTABLE AND SEPARATELY REVOCABLE (M20-F16). Declining
// `sos_coordinates` does NOT disable SOS — the alert fans out without coordinates — and
// `continuous_location_during_sos` additionally requires the tenant's `sosContinuousLocationEnabled`
// opt-in before a single `safety_sos_location_stream` row may be written. Two independent gates, both
// required, which is why neither lives on this row alone.
//
// TENANCY: organization_id NOT NULL. No PE, no Location, no patient column — a membership's consent is
// org-wide, and a PE column here would make a clinician who covers two PEs consent twice or once by
// accident. `consent_scope_detail` holds emergency-contact PII (a spouse's phone number) and is
// §3.6 audit-denylisted and §3.5-audited at `info` on read.
//
// `acknowledgment_text_snapshot` IS NOT DENYLISTED, deliberately: it is the policy text the clinician was
// shown at grant, which is the ONE thing a consent dispute turns on. Scrubbing it from the audit trail
// would leave the trail able to prove a consent existed and unable to say what was consented to.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { safetyEmergencyContactConsentStatus } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const safetyEmergencyContactConsent = pgTable(
  "safety_emergency_contact_consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    clinicianMembershipId: uuid("clinician_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),

    /** `SafetyConsentPurpose` — vocabulary CHECK below. */
    consentPurpose: text("consent_purpose").notNull(),
    /** e.g. `{ contact: { name, phone, relationship } }` for `emergency_contact_call`. Encrypted at the
     *  application layer before the write; §3.6 audit-denylisted. */
    consentScopeDetail: jsonb("consent_scope_detail").notNull(),

    status: safetyEmergencyContactConsentStatus("status").notNull().default("granted"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Tenant rotation policy; reaching it flips `status` to `expired`, never to `revoked`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /** The policy text the clinician actually saw at grant. NOT denylisted; see the header. */
    acknowledgmentTextSnapshot: text("acknowledgment_text_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // §3.4 — the consent-check hot path, run on every SOS coordinate write.
    activePerPurposeUniq: uniqueIndex("secc_active_uniq")
      .on(t.organizationId, t.clinicianMembershipId, t.consentPurpose)
      .where(sql`status = 'granted'`),
    byClinicianIdx: index("secc_clinician_idx").on(t.clinicianMembershipId, t.consentPurpose),

    purposeVocabulary: check(
      "m20_secc_purpose_vocab",
      sql`"consent_purpose" IN ('sos_coordinates','continuous_location_during_sos','emergency_contact_call')`,
    ),
    // A revoked consent carries the instant it was revoked; a live or expired one does not. Without
    // both directions a `granted` row can carry a revocation timestamp and the §8.7 replay is ambiguous.
    revocationPair: check(
      "m20_secc_revocation_pair",
      sql`("status" = 'revoked') = ("revoked_at" IS NOT NULL)`,
    ),
    // `expired` is a rotation outcome and is meaningless without the instant it rotated past.
    expiryStamped: check(
      "m20_secc_expiry_stamped",
      sql`"status" <> 'expired' OR "expires_at" IS NOT NULL`,
    ),
    // The scope detail is an OBJECT; an array or a bare string here would make the emergency-contact
    // read silently find no contact at the moment the terminus needs to dial one.
    scopeDetailIsObject: check(
      "m20_secc_scope_object",
      sql`jsonb_typeof("consent_scope_detail") = 'object'`,
    ),
    // D10 — the purpose that exists to make a phone call must actually carry a number to call. The
    // FUNCTION form of the jsonb key-exists test, not the `?` operator: `?` is a driver placeholder in
    // several of the clients that touch this DDL, and the two spellings are otherwise identical.
    emergencyContactHasContact: check(
      "m20_secc_contact_present",
      sql`"consent_purpose" <> 'emergency_contact_call'
          OR jsonb_exists("consent_scope_detail", 'contact')`,
    ),
    snapshotNonEmpty: check(
      "m20_secc_snapshot_nonempty",
      sql`length(btrim("acknowledgment_text_snapshot")) > 0`,
    ),
  }),
);

export type SafetyEmergencyContactConsentRow = typeof safetyEmergencyContactConsent.$inferSelect;
export type NewSafetyEmergencyContactConsentRow = typeof safetyEmergencyContactConsent.$inferInsert;
