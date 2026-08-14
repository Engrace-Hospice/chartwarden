// @wardenx/consent — consent kind/enum type-level mirrors + the §2.3 structural descriptor.
//
// M39-T01 (spec §2.2, §2.3, §3.1, §3.2). This file is the TYPE-LEVEL home for the M39 enums
// and the per-consent-type STRUCTURAL facts the validation rules (§2.3) and the evaluate path
// (§4.3) key off — which scope shape a type carries, whether it enumerates named recipients or
// named DPOA agents, whether it can be captured post-mortem, and whether it may survive death.
// The Drizzle `pgEnum` DDL lives in packages/db/src/enums.ts (M39-T01); the per-table schema
// lands in packages/db/src/schema/consent/* at M39-T02 (§3.3). The platform-floor *values*
// (default expirations, capture-method floors, reminder cadences) are seed data that fills the
// consent_type_catalog — they are NOT here; this file carries only the structural discriminators
// that are invariant for a type regardless of tenant overlay.
//
// Design call (§2.3): a consent type's STRUCTURE (categorical vs per-recipient vs per-named-agent
// vs per-encounter; survives-death eligibility; post-mortem capture) is a platform invariant a
// tenant cannot loosen. Its POLICY (how long before expiry, which capture methods, which reminder
// cadence) is a platform FLOOR a tenant may tighten. Structure → here as data; policy → catalog seed.

// ── §3.2 enum unions (type-level mirrors of packages/db/src/enums.ts) ──────────────────────

/** The ten v1 platform-floor consent types + the post-mortem bereavement type + the
 *  tenant-extensible `custom` slot (D2). Mirrors the `consent_type_key` pgEnum. */
export type ConsentTypeKey =
  | "portal_access"
  | "dpoa_healthcare"
  | "dpoa_financial"
  | "family_caregiver_access"
  | "42_cfr_part_2_release"
  | "media_release"
  | "research_participation"
  | "telehealth_consent"
  | "advance_directive_acknowledgment"
  | "hipaa_release"
  | "bereavement_outreach_consent"
  | "custom";

/** Runtime list of every consent type — the value-level mirror of {@link ConsentTypeKey}. */
export const CONSENT_TYPE_KEYS = [
  "portal_access",
  "dpoa_healthcare",
  "dpoa_financial",
  "family_caregiver_access",
  "42_cfr_part_2_release",
  "media_release",
  "research_participation",
  "telehealth_consent",
  "advance_directive_acknowledgment",
  "hipaa_release",
  "bereavement_outreach_consent",
  "custom",
] as const satisfies readonly ConsentTypeKey[];

/** The typed scope shape a consent type carries (§2.3). Mirrors `consent_scope_discriminator`. */
export type ConsentScopeDiscriminator =
  | "categorical"
  | "per_recipient"
  | "per_named_agent"
  | "per_encounter";

/** The consent_record lifecycle (§2.2.1). Mirrors `consent_status`. Append-only: an "edit" is a
 *  new row pointing at the prior via supersedes_consent_record_id. */
export type ConsentStatus = "draft" | "active" | "superseded" | "revoked" | "expired";

/** The chain-of-authority grantor model (§2.3, D5). Mirrors `consent_grantor_kind`. */
export type ConsentGrantorKind =
  | "patient_self"
  | "dpoa_healthcare_agent"
  | "dpoa_financial_agent"
  | "court_guardian"
  | "parent_for_minor"
  | "healthcare_surrogate"
  | "bereaved_person_self";

/** How the signature evidence was captured (§2.3, D4). Mirrors `consent_capture_method`. */
export type ConsentCaptureMethod =
  | "electronic_portal_signature"
  | "typed_signature_in_app"
  | "uploaded_signed_pdf"
  | "witnessed_verbal_documented"
  | "notarized";

/** The named-recipient classes on consent_record_recipient (§2.3, D6). Mirrors
 *  `consent_recipient_kind`. The first three resolve through M40's MdmEntityProvider;
 *  `workforce_member` is the one INTERNAL class and resolves to an M2 membership id. */
export type ConsentRecipientKind =
  | "external_physician"
  | "facility"
  | "pharmacy"
  | "irb"
  | "family_member"
  | "attorney"
  | "employer"
  | "researcher"
  | "workforce_member"
  | "free_text";

/** Who performed an explicit revocation (§2.2.3, D7). Mirrors `consent_revocation_actor_kind`. */
export type ConsentRevocationActorKind =
  | "patient_self_via_portal"
  | "staff"
  | "dpoa_agent"
  | "court_order"
  | "platform_admin_break_glass";

/** Typed revocation-cascade progress (§2.2.3, D7). Mirrors `consent_revocation_cascade_status`. */
export type ConsentRevocationCascadeStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "partial_failed";

/** The platform-floor 90/30/14/7/1-day reminder cadence (§2.4, D9). Mirrors `consent_reminder_kind`. */
export type ConsentReminderKind = "90_days" | "30_days" | "14_days" | "7_days" | "1_day";

/** The renewal-cycle lifecycle (§2.4, D8). Mirrors `consent_renewal_cycle_status`. */
export type ConsentRenewalCycleStatus =
  | "open"
  | "renewed"
  | "closed_expired"
  | "closed_revoked"
  | "closed_no_longer_applicable";

/** primary + alternate ordering on consent_record_dpoa_agent (§2.3, D5). Mirrors
 *  `consent_dpoa_agent_kind`. Partial-unique-indexed: ≤1 of each per consent record. */
export type ConsentDpoaAgentKind = "primary" | "alternate_1" | "alternate_2";

/** When DPOA authority becomes operative (§2.3, D5). Mirrors `consent_dpoa_activation_condition`. */
export type ConsentDpoaActivationCondition =
  | "immediate"
  | "upon_incapacity_attested"
  | "upon_physician_determination"
  | "upon_incompetence_court_order";

/** The per-agent authority scope (§2.3, D5). Mirrors `consent_dpoa_scope_kind`. */
export type ConsentDpoaScopeKind =
  | "healthcare_full"
  | "healthcare_end_of_life_only"
  | "financial_narrow"
  | "financial_broad";

/** The per-agent term (§2.3, D5). Mirrors `consent_dpoa_term_kind`. */
export type ConsentDpoaTermKind = "indefinite" | "until_date" | "event_driven";

/** The delegated_access projection scope tiers (§2.3, D10). Mirrors `consent_delegated_access_scope`. */
export type ConsentDelegatedAccessScope =
  | "view_only_minimal"
  | "view_only_full"
  | "view_and_message"
  | "view_message_and_decisions";

// ── §2.3 structural descriptor (data-as-config) ───────────────────────────────────────────

/**
 * The platform-invariant STRUCTURE of a consent type. Drives §2.3 validation:
 * - `scopeDiscriminator` — which TypeBox scope_descriptor union binds + whether recipient / DPOA
 *   join rows are legal for the type.
 * - `isPerRecipient` — the four explicitly per-recipient types (D6): a `consent_record_recipient`
 *   row enumerates each named recipient; evaluate returns `no_active_recipient_matches` with zero.
 * - `isPerNamedAgent` — the DPOA types (D5): `consent_record_dpoa_agent` rows enumerate the agents.
 * - `survivesDeathEligible` — only these three may set `survives_death=true` (§2.3); for every
 *   other type the post-death evaluate path returns `consent_terminated_on_death` (D13).
 * - `isPostMortemEligible` — captured post-death with `grantor_kind='bereaved_person_self'` (D14).
 *
 * Tenant overlays tighten POLICY (expiration / capture / reminders), never this STRUCTURE.
 */
export interface ConsentTypeStructure {
  readonly typeKey: ConsentTypeKey;
  readonly scopeDiscriminator: ConsentScopeDiscriminator;
  readonly isPerRecipient: boolean;
  readonly isPerNamedAgent: boolean;
  readonly survivesDeathEligible: boolean;
  readonly isPostMortemEligible: boolean;
}

/** Per-type structural facts (§2.3, D5/D6/D13/D14). `custom` is tenant-defined categorical with no
 *  platform structure beyond the floor; tenant overlay supplies its TypeBox scope at registration. */
export const CONSENT_TYPE_STRUCTURE: {
  readonly [K in ConsentTypeKey]: ConsentTypeStructure & { typeKey: K };
} = {
  portal_access: {
    typeKey: "portal_access",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  dpoa_healthcare: {
    typeKey: "dpoa_healthcare",
    scopeDiscriminator: "per_named_agent",
    isPerRecipient: false,
    isPerNamedAgent: true,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  dpoa_financial: {
    typeKey: "dpoa_financial",
    scopeDiscriminator: "per_named_agent",
    isPerRecipient: false,
    isPerNamedAgent: true,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  family_caregiver_access: {
    typeKey: "family_caregiver_access",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
    isPerNamedAgent: false,
    survivesDeathEligible: true,
    isPostMortemEligible: false,
  },
  "42_cfr_part_2_release": {
    typeKey: "42_cfr_part_2_release",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  media_release: {
    typeKey: "media_release",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
    isPerNamedAgent: false,
    survivesDeathEligible: true,
    isPostMortemEligible: false,
  },
  research_participation: {
    typeKey: "research_participation",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
    isPerNamedAgent: false,
    survivesDeathEligible: true,
    isPostMortemEligible: false,
  },
  telehealth_consent: {
    typeKey: "telehealth_consent",
    scopeDiscriminator: "per_encounter",
    isPerRecipient: false,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  advance_directive_acknowledgment: {
    typeKey: "advance_directive_acknowledgment",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  hipaa_release: {
    typeKey: "hipaa_release",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
  bereavement_outreach_consent: {
    typeKey: "bereavement_outreach_consent",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: true,
  },
  custom: {
    typeKey: "custom",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
    isPerNamedAgent: false,
    survivesDeathEligible: false,
    isPostMortemEligible: false,
  },
} as const;
