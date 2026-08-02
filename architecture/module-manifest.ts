/**
 * WardenX — Module Manifest (single source of truth for architecture fitness)
 * ---------------------------------------------------------------------------
 * Encodes, per logical module (the 40 in ARCHITECTURE §11):
 *   - codePaths:   the package(s) and backend route dir(s) that BELONG to the module
 *   - dependsOn:   the modules it MAY import from (verbatim from ARCHITECTURE §20 dep table)
 *   - ownedTables: the DB tables it owns. As of the M07-F02 manifest pass, ALL 40
 *                  modules are populated (453 tables) from their specs, so the ownership
 *                  check enforces the full corpus — no longer "enforces only what is
 *                  declared." A new module's tables are added here when its spec lands.
 *
 * SCOPE OF ownedTables — SERVER POSTGRESQL ONLY:
 *   ownedTables governs the central multi-tenant PostgreSQL schema only. It does NOT
 *   enumerate on-device / client-side stores. In particular, the mobile offline drafts
 *   in the @wardenx/mobile-offline package — M09 `assessment_draft` and M10
 *   `hope_assessment_draft` (encrypted sqlcipher tables, device-derived keys, defined
 *   in their specs as raw CREATE TABLE, evict-on-logout) — are deliberately OUT OF SCOPE
 *   and are not manifest-owned. They carry no org_id/RLS server contract and are never
 *   referenced by check-table-ownership.ts, which scans server source paths only. New
 *   on-device tables follow the same rule: spec-documented, manifest-exempt.
 *
 * Read by:
 *   - .dependency-cruiser.cjs   (generates the import-boundary rules)
 *   - check-table-ownership.ts  (enforces table ownership)
 *   - the seam registry         (cross-module contracts live alongside dependsOn)
 *
 * CONVENTIONS
 *   - Backend code for a module lives at  apps/backend/src/modules/<NN-slug>/
 *   - Shared domain-area logic lives in   packages/<area>/
 *   - LEAVES (importable by everyone, depend on nothing app-specific):
 *       packages/shared, packages/types, packages/domain, packages/ui
 *   - FOUNDATION HELPERS (implicitly importable by every module — see ADR-0005 D4):
 *       packages/audit, packages/auth, packages/tenancy, packages/db/src/schema.
 *       A module may call audit()/requirePermission/withOrgContext and import its
 *       own Drizzle schema TYPES without listing 1–4 in dependsOn. Data access to
 *       another module's tables is still blocked by check-table-ownership.ts and the
 *       helper-only-table rule; the no-circular rule still forbids the foundation
 *       tier (M1–M3) from closing a cycle through a helper.
 *   - A module may import from: its own codePaths + its dependsOn's codePaths +
 *       LEAVES + FOUNDATION HELPERS.
 *   - Anything else is a boundary violation and fails CI.
 *
 * SEAM / OUTBOX CONSUMPTION NEEDS NO IMPORT EDGE (ADR-0005 D1):
 *   - A `dependsOn` edge is required ONLY for a compile-time import of the
 *     producer's package (its exported repository/service/reader/types).
 *   - Consuming another module ONLY via (a) an OUTBOX event (event name + payload
 *     type in packages/types) or (b) a BOOT-REGISTERED SEAM (interface type in
 *     packages/types, implementation injected at boot, listed in REQUIRED_SEAMS and
 *     validated by validateSeams()) adds NO dependsOn edge. Both channels are
 *     leaf-typed + runtime-wired, so there is no cross-package import to forbid.
 *   - `packages/foundation` is BANNED (ADR-0005 D3): it is in no codePath and no
 *     architecture §4 package list. Seam interfaces live in packages/types; outbox
 *     helper in packages/shared; withOrgContext+RLS in packages/tenancy; audit in
 *     packages/audit. A leaf must NEVER re-export a feature package.
 *
 * When a new module is specced: fill ownedTables, confirm codePaths, and (if it
 * compile-time-imports a new module) update dependsOn. Any dependsOn delta beyond
 * this manifest is made as ONE consolidated ADR per module, with a TRANSITIVE cycle
 * analysis (not just direct edges) — ADR-0005 D5. Nothing else changes.
 *
 * ⚠ DO NOT bulk-apply the "proposed manifest patch" / "Depends on:" lists from the module
 * specs. Those are RELATIONSHIP INVENTORIES (compile imports + seams + outbox + foundation
 * helpers), NOT the edge set. Per D1/D4 above, seam/outbox consumption and foundation helpers
 * (M1–M4) are NO-EDGE; applying the spec targets verbatim creates import cycles. The add-edge
 * proposals were reviewed and confirmed all no-edge — see audit/MANIFEST_DEPENDSON_REVIEW.md.
 */

export const LEAF_PACKAGES = [
  "packages/shared",
  "packages/types",
  "packages/domain",
  "packages/ui",
] as const;

/**
 * Foundation helper packages every module may import WITHOUT a dependsOn edge
 * (ADR-0005 D4). These expose the mandated platform calls that every PHI route
 * must make — audit(), requirePermission/requireAbac/requireSession, withOrgContext
 * + the RLS generator — plus the centralized Drizzle schema TYPE surface.
 *
 * Note: these are NOT leaves (they perform I/O and have internal deps). They are
 * appended to every module's allowed-import set so a module whose dependsOn omits
 * 1–4 can still satisfy the audit/authz/tenancy mandates. Guard rails that remain:
 *   - check-table-ownership.ts still blocks reading another module's tables;
 *   - the helper-only-table rule still blocks audit_event/outbox/idempotency schema;
 *   - no-circular still forbids the foundation tier (M1–M3) from importing a helper
 *     in a way that closes a cycle (the foundation tier audits via M1's trigger
 *     mechanism, not audit()).
 * Within packages/auth, only the published guard/identity/seams barrels are the
 * intended public surface; a depcruise sub-path refinement is a follow-up.
 */
export const FOUNDATION_HELPER_PACKAGES = [
  "packages/audit", // audit() / auditRead()  (M4)
  "packages/auth", // requireSession / requirePermission / requireAbac  (M2/M3)
  "packages/tenancy", // withOrgContext() + RLS policy generator  (M1)
  "packages/db/src/schema", // Drizzle schema TYPES (ownership enforced separately)
] as const;

/**
 * Tables that are written ONLY through a foundation helper, never by direct
 * insert/select from a feature module. The ownership check treats direct schema
 * imports of these from a non-owner module as a violation EXCEPT where the module
 * goes through the named helper (audit via packages/audit, outbox/idempotency via
 * packages/shared middleware). They are intentionally not "owned" by feature modules.
 */
export const HELPER_ONLY_TABLES = {
  audit_event: "packages/audit (audit()/auditRead() — never direct)",
  outbox_event: "packages/shared (outbox dispatcher — never direct)",
  idempotency_key: "packages/shared (idempotency middleware — never direct)",
} as const;

/**
 * Vendor npm packages that may be imported ONLY inside their adapter package
 * (ARCHITECTURE §25.14 adapter mandate). Any other import is a violation.
 */
export const VENDOR_ADAPTERS: Record<string, string> = {
  // npm package (regex)        ->  the only package allowed to import it
  "better-auth": "packages/auth",
  // Stripe is M35 Subscription Billing's vendor SDK (the former M34 `packages/saas` stub was
  // removed when M34's codePaths were renamed to packages/saas-tenant-platform).
  stripe: "packages/subscription-billing",
  twilio: "packages/messaging",
  postmark: "packages/messaging",
  "@anthropic-ai/sdk": "packages/ai-platform",
  "xero-node": "packages/xero-client", // ADR-0028
  "@gusto/embedded-api": "packages/gusto-client", // ADR-0028
  // DoseSpot client is hand-rolled in packages/dosespot. Xero/Gusto SDKs are registered
  // above (ADR-0028) so they cannot leak out of their adapter; evv-aggregators and
  // triage-vendors are hand-rolled HTTP (no single SDK) but are codePath-governed.
};

export type ModuleId = number;

export interface ModuleDef {
  id: ModuleId;
  name: string;
  /** glob-able path prefixes this module owns */
  codePaths: string[];
  /** module ids this module may import from (ARCHITECTURE §20) */
  dependsOn: ModuleId[];
  /** DB tables owned by this module ([] until specced) */
  ownedTables: string[];
}

export const MODULES: ModuleDef[] = [
  {
    id: 1,
    name: "Foundation",
    codePaths: [
      "packages/db",
      "packages/shared",
      "packages/types",
      "packages/tenancy",
      "apps/backend/src/bootstrap",
      "apps/web/src/shell",
    ],
    dependsOn: [],
    ownedTables: [
      "organization",
      "provider_entity",
      "location",
      "user",
      "membership",
      "session",
      "account",
      "verification",
      "audit_event",
      "system_status",
      "feature_flag",
      "idempotency_key",
      "outbox_event",
      // M01-F02: declared in the M1 spec but previously absent here (enforcement hole).
      "feature_flag_evaluation",
      "organization_settings_registry",
      "outbox_event_catalog",
    ],
  },
  {
    id: 2,
    name: "Identity & Org",
    codePaths: [
      "packages/auth/src/identity",
      "apps/backend/src/modules/02-identity",
      "apps/web/src/modules/02-identity",
    ],
    dependsOn: [1],
    // M02-F04: tenant_step_up_policy_override added (M2's step-up subsystem table).
    ownedTables: [
      "two_factor",
      "passkey",
      "organization_invitation",
      "tenant_step_up_policy_override",
    ],
  },
  {
    id: 3,
    name: "Authorization",
    codePaths: [
      "packages/auth/src/rbac",
      "packages/auth/src/abac",
      "packages/auth/src/permissions",
      "packages/auth/src/roles",
      "packages/auth/src/breakglass",
      "packages/auth/src/engagements",
      "apps/backend/src/modules/03-authorization",
      "apps/web/src/modules/03-authorization",
    ],
    dependsOn: [1, 2], // +1: M3's production RBAC data layer (effective-permission Drizzle store) needs
    // M1's Drizzle client (@wardenx/db), like M2's db-session-store; its §2.2 join also
    // reads the M1-owned `membership` table.
    ownedTables: [
      "role",
      "permission",
      "role_permission",
      "membership_role",
      "break_glass_event",
      "auditor_engagement",
    ],
  },
  {
    id: 4,
    name: "Audit & Compliance Log",
    codePaths: [
      "packages/audit",
      "apps/backend/src/modules/04-audit",
      "apps/web/src/modules/04-audit",
    ],
    dependsOn: [1, 2, 3],
    // M04-F02: audit_denylist_catalog + audit_action_catalog added (platform-shared reference tables
    // the M4 spec creates). The audit_event table itself stays M1-owned + helper-only.
    ownedTables: [
      "legal_hold",
      "destruction_certificate",
      "state_retention_override",
      "audit_export",
      "audit_seal",
      "audit_denylist_catalog",
      "audit_action_catalog",
    ],
  },
  {
    id: 36,
    name: "Secure Messaging & Alerts",
    codePaths: [
      "packages/messaging",
      "apps/backend/src/modules/36-messaging",
      "apps/web/src/modules/36-messaging",
    ],
    dependsOn: [1, 2, 3, 4],
    ownedTables: [
      "alert",
      "alert_payload_catalog",
      "alert_rule",
      "channel",
      "channel_member",
      "delivery_endpoint",
      "message",
      "message_attachment",
      "message_receipt",
      "notification_delivery",
      "presence",
      "tenant_alert_routing_override",
      "user_notification_preferences",
      "notification_template",
      "tenant_notification_template_overlay",
    ], // filled from M36 spec; +notification_template +overlay per ADR-0024 (moved from M14)
  },
  {
    id: 38,
    name: "Clinical Terminology Service",
    codePaths: [
      "packages/terminology",
      "apps/backend/src/modules/38-terminology",
      "apps/web/src/modules/38-terminology",
    ],
    dependsOn: [1, 2, 3, 4],
    ownedTables: [
      "code_system",
      "code_system_version",
      "concept_embedding",
      "concept_icd10cm",
      "concept_loinc",
      "concept_rxnorm",
      "concept_snomed",
      "deprecation_mapping",
      "terminology_update_log",
      "value_set",
      "value_set_expansion",
      "value_set_member",
      "value_set_tenant_extension",
    ],
  },
  {
    id: 40,
    name: "Master Data Management",
    codePaths: ["packages/mdm", "apps/backend/src/modules/40-mdm", "apps/web/src/modules/40-mdm"],
    dependsOn: [1, 2, 3, 4],
    ownedTables: [
      "entity_relationship",
      "external_physician",
      "external_physician_tenant_overlay",
      "facility",
      "mdm_baa_record",
      "mdm_baa_required",
      "mdm_provisional",
      "merge_request",
      "nppes_sync_coordination",
      "nppes_sync_log",
      "payer",
    ],
  },
  {
    id: 5,
    name: "Patient & Demographics",
    codePaths: ["apps/backend/src/modules/05-patient", "apps/web/src/modules/05-patient"],
    dependsOn: [1, 2, 3, 4, 36, 38, 40], // +1: M5 closes M1 boot-gate seams via the M1-owned bootstrap registry (M5-T07)
    ownedTables: [
      "patient",
      "patient_identifier",
      "patient_name_alias",
      "patient_address",
      "patient_phone",
      "patient_email",
      "patient_payer",
      "caregiver",
      "patient_caregiver",
      "emergency_contact",
      "patient_assignment",
      "patient_communication_preference",
      "patient_privacy_flag_snapshot",
      "patient_amendment_request",
      "patient_match_review",
      "patient_merge",
    ], // M07-F02 analogue
  },
  {
    id: 39,
    name: "Consent & Authorization Management",
    codePaths: [
      "packages/consent",
      "apps/backend/src/modules/39-consent",
      "apps/web/src/modules/39-consent",
    ],
    // ADR-0006: dropped 22 to break the manifest's 22↔39 cycle. Consent consumes
    // Module 22 document rendering/storage via a boot-registered forward seam
    // (DocumentRenderer/DocumentStorageProvider, deny-stub) — no import edge (ADR-0005 D1).
    dependsOn: [1, 2, 3, 4, 5],
    ownedTables: [
      "consent_document_link",
      "consent_eval_audit",
      "consent_expiration_reminder",
      "consent_record",
      "consent_record_dpoa_agent",
      "consent_record_recipient",
      "consent_renewal_cycle",
      "consent_revocation",
      "consent_type_catalog",
      "delegated_access",
      "tenant_consent_type_overlay",
    ],
  },
  {
    id: 6,
    name: "Admission, Election & Certification",
    codePaths: ["apps/backend/src/modules/06-admission", "apps/web/src/modules/06-admission"],
    dependsOn: [1, 5, 38, 40, 39], // +1: M6 registers its §4.7 reader seams via the M1-owned bootstrap registry (M6-T05)
    ownedTables: [
      "admission",
      "election_period",
      "election_statement",
      "certification_of_terminal_illness",
      "face_to_face_encounter",
      "level_of_care_period",
      "revocation_event",
      "discharge_event",
      "transfer_event",
      "referral",
      "notice_of_rights_acknowledgment",
      "compliance_window",
    ],
  },
  {
    id: 7,
    name: "Care Plan (IPOC)",
    codePaths: ["apps/backend/src/modules/07-care-plan", "apps/web/src/modules/07-care-plan"],
    dependsOn: [1, 6, 38, 39], // +1: M7 registers its §7.8 CarePlanReader seam via the M1-owned bootstrap registry (M7-T04); +web: Track B in-task screens (ADR-0030), land in M7-T09
    ownedTables: [
      "care_plan",
      "care_plan_version",
      "care_plan_signature",
      "problem",
      "goal",
      "intervention",
    ],
  }, // M07-F02
  {
    id: 8,
    name: "Encounters & Visit Notes",
    codePaths: [
      "apps/backend/src/modules/08-encounters",
      "packages/hearthnote",
      "packages/narrative-vocab",
      "apps/web/src/modules/08-encounters",
    ], // +web: Track B in-task screens (ADR-0030), land in M8-T12
    dependsOn: [1, 6, 7, 36, 38], // +1: M8 registers its §4.7 owned seams (+ consumes M7's CarePlanReader) via the M1-owned bootstrap registry (M8-T08)
    ownedTables: [
      "encounter",
      "encounter_signature",
      "encounter_addendum",
      "encounter_care_plan_link",
      "cosignature_request",
      "vitals",
      "mileage",
      "hearthnote_selection",
      "hearthnote_assembled_output",
      "hearthnote_llm_modification",
    ],
  },
  {
    id: 9,
    name: "Clinical Assessments Suite",
    codePaths: [
      "packages/assessments",
      "apps/backend/src/modules/09-assessments",
      "apps/web/src/modules/09-assessments",
    ],
    dependsOn: [1, 38], // +1: M9 registers its §4.7/D7 LatestAssessmentProvider + ScaleSeriesProvider seams via the M1-owned bootstrap registry (M9-T04); +web: Track B in-task screens (ADR-0030), land in M9-T07
    ownedTables: [
      "clinical_assessment",
      "assessment_cosignature",
      "significant_change_event",
      "scale_license",
      "scale_policy",
    ],
  },
  {
    id: 10,
    name: "HOPE Engine",
    codePaths: [
      "packages/hope",
      "packages/iqies-client",
      "apps/backend/src/modules/10-hope",
      "apps/web/src/modules/10-hope",
    ],
    dependsOn: [1, 9, 36, 38], // +M1: registers HOPE seams into the M1-owned bootstrap registry (M10-T05); +iqies-client ADR-0028; +web: Track B in-task screens (ADR-0030), land in M10-T08
    ownedTables: [
      "hope_timepoint_schedule",
      "hope_assessment",
      "symptom_follow_up_visit",
      "hope_validation_finding",
      "hope_submission",
      "hope_submission_item",
    ],
  },
  {
    id: 11,
    name: "Orders",
    codePaths: [
      "packages/orders",
      "apps/backend/src/modules/11-orders",
      "apps/web/src/modules/11-orders",
    ],
    dependsOn: [1, 6, 36, 38, 40], // +M1: the bootstrap seam registry (registerSeam/getSeam) M11's backend module wires its §2.8/§4.3 owned seams into (M11-T05; M6..M10 seam-task precedent); +packages/orders: §3.1 M11-owned feature pkg (kinds/catalog/seams/alerts), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M11-T08
    ownedTables: [
      "order_record",
      "order_signature",
      "verbal_order",
      "standing_order",
      "standing_order_instance",
      "order_discontinuation",
      "order_verbal_policy",
    ],
  },
  {
    id: 12,
    name: "DoseSpot Integration",
    codePaths: [
      "packages/dosespot",
      "apps/backend/src/modules/12-dosespot",
      "apps/web/src/modules/12-dosespot",
    ], // +web: Track B in-task screens (ADR-0030), land in M12-T09
    dependsOn: [1, 5, 11, 38, 40], // +M1: the bootstrap seam registry (registerSeam/getSeam) M12's backend module wires its §2.10 D17 owned seams (MedicationOrderProvider/RefillInboxProvider) into (M12-T07; M6..M11 seam-task precedent)
    ownedTables: [
      "dosespot_prescriber",
      "dosespot_webhook_event",
      "epcs_signing_attempt",
      "medication_order",
      "medication_order_transmission",
      "refill_request",
    ],
  },
  {
    id: 13,
    name: "eMAR & Med Administration",
    codePaths: [
      "packages/emar",
      "apps/backend/src/modules/13-emar",
      "apps/web/src/modules/13-emar",
    ], // +packages/emar: §3.1 M13-owned feature pkg (mode catalog → lifecycle/schedule-parser/five-rights), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M13-T10
    dependsOn: [1, 12, 36, 38], // +M1: the bootstrap seam registry (registerSeam/getSeam) M13's backend module wires its §2.12 D16 owned seams (MedicationAdministrationProvider/ReconciliationProvider) into (M13-T07; M6..M12 seam-task precedent)
    ownedTables: [
      "administration_offline_queue",
      "administration_policy",
      "administration_record",
      "administration_witness",
      "barcode_scan_event",
      "comfort_kit_deployment",
      "comfort_kit_drawdown",
      "medication_reconciliation_decision",
      "medication_reconciliation_worksheet",
      "missed_dose",
      "prn_administration",
      "scheduled_dose",
    ],
  },
  {
    id: 14,
    name: "IDG",
    codePaths: ["packages/idg", "apps/backend/src/modules/14-idg", "apps/web/src/modules/14-idg"], // +packages/idg: §3.1 M14-owned feature pkg (quorum/schedule/discipline-view policy → lifecycle/packet-builder), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M14-T07
    dependsOn: [1, 7, 8, 36], // +M1: the bootstrap seam registry (registerSeam/getSeam) M14's backend module wires its §4.8 owned seams (IdgPacketProvider/IdgDecisionProvider/IdgScheduleProvider) into (M14-T05; M6..M13 seam-task precedent)
    ownedTables: [
      "idg_meeting",
      "idg_recurring_policy",
      "idg_attendance",
      "idg_agenda_item",
      "idg_decision",
      "idg_action_item",
      "idg_minutes",
      "idg_minutes_amendment",
      "idg_patient_packet",
    ],
  }, // ADR-0024: notification_template + tenant_notification_template_overlay moved to M36 (notification composition is M36-owned per SD-017)
  {
    id: 15,
    name: "Discipline Care Plans",
    codePaths: [
      "packages/discipline-plans",
      "apps/backend/src/modules/15-discipline-care-plans",
      "apps/web/src/modules/15-discipline-care-plans",
    ], // +packages/discipline-plans: §3.1 M15-owned feature pkg (cadence/signer/volunteer-ratio policy → per-kind TypeBox + lifecycle), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M15-T07
    dependsOn: [1, 7, 8], // +M1: the bootstrap seam registry (getSeam) M15 resolves the §4.3 CONSUMED seams through — M7 CarePlanReader + M8 SignedEncountersReader (M15-T03); M15's own published seams register there in M15-T05 (M6..M14 seam-task precedent)
    ownedTables: [
      "aide_supervisory_visit",
      "discipline_assessment",
      "discipline_care_plan",
      "discipline_care_plan_signature",
      "discipline_care_plan_version",
      "discipline_goal",
      "discipline_intervention",
      "volunteer_assignment",
      "volunteer_compliance_gate",
      "volunteer_hour_entry",
      "volunteer_hour_ledger",
    ],
  },
  {
    id: 16,
    name: "Bereavement",
    codePaths: [
      "packages/bereavement",
      "apps/backend/src/modules/16-bereavement",
      "apps/web/src/modules/16-bereavement",
    ], // +packages/bereavement: §3.1 M16-owned feature pkg (D4 cadence floor / D3+D17 risk rubric / D15 outreach-kind + D18 external-source gate policy → lifecycle), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M16-T07
    // +M1: M16-T03's §4.3.1 intake CONSUMES M6's DeathDischargeReader/AdmissionStatusReader + M5's
    // PatientReader through the M1 boot seam registry (`apps/backend/src/bootstrap`), which is M1 code.
    dependsOn: [1, 5, 6, 36],
    ownedTables: [
      "bereaved_contact",
      "bereavement_anniversary_reminder",
      "bereavement_contact_log",
      "bereavement_opt_out",
      "bereavement_outreach",
      "bereavement_plan",
      "bereavement_plan_closure",
      "bereavement_risk_score",
      "tenant_bereavement_external_source_gate_override",
    ],
  },
  {
    id: 17,
    name: "Scheduling & Route Optimization",
    codePaths: [
      "packages/routing-client",
      "packages/scheduling",
      "apps/backend/src/modules/17-scheduling",
      "apps/web/src/modules/17-scheduling",
    ], // +packages/scheduling: §3.1 M17-owned feature pkg (cancellation value-set/RRULE-subset/visit-purpose→discipline policy → state machine/proposers), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M17-T08
    dependsOn: [1, 5, 8, 40], // +M1: the bootstrap seam registry (registerSeam/getSeam) M17's backend module wires its §4.3 owned seams (VisitReader/VisitAssignmentReader/PortalVisitReader/VisitMetricsProvider) into (M17-T05; M6..M14 seam-task precedent)
    ownedTables: [
      "clinician_availability",
      "recurring_visit",
      "route_segment",
      "time_off",
      "visit",
      "visit_proposal",
      "visit_state_history",
    ],
  },
  {
    id: 18,
    name: "EVV",
    codePaths: [
      "packages/evv-aggregators",
      "apps/backend/src/modules/18-evv",
      "apps/web/src/modules/18-evv",
    ],
    dependsOn: [1, 17], // +M1: the bootstrap seam registry (registerSeam/getSeam) M18's backend module wires its six §4.3 owned seams (EvvBracketResolver/EvvComplianceReader/EvvAggregatorReferenceReader/EvvLocationProvider/EvvMetricsProvider/EvvVerificationProvider) into (M18-T05; M6..M17 seam-task precedent)
    ownedTables: [
      "evv_aggregator_submission",
      "evv_device",
      "evv_event",
      "evv_geofence_evaluation",
      "evv_geofence_policy",
      "evv_missing_resolution",
    ],
  },
  {
    id: 19,
    name: "On-Call Triage",
    codePaths: [
      "packages/triage-vendors",
      "apps/backend/src/modules/19-oncall",
      "apps/web/src/modules/19-oncall",
    ], // +web: Track B in-task screens (ADR-0030), land in M19-T08. NOTE: the spec's §3.1 layout also
    // proposes a `packages/oncall` feature package — NOT adopted. Wave P2-2 acceptance #1 limits this
    // wave's manifest changes to the triage-vendors codePath (already applied, ADR-0028) and the two
    // Track B web codePaths, so M19's leaf CONTRACTS live in `packages/types/src/oncall.ts` (ADR-0005
    // D1/D2) and its domain services under `apps/backend/src/modules/19-oncall` (the M6 precedent).
    dependsOn: [1, 5, 17, 36], // +M1 (M19-T02): the M1 FOUNDATION edge every implemented module carries — `@wardenx/db`
    // (the ten owned tables), `@wardenx/tenancy`'s withOrgContext, and the bootstrap eraser registry the
    // §3.7 `triage_record` eraser registers into. Not a widening of the module graph: it is the same edge
    // M15/M16/M18/M21 each added at their first backend task, and Wave P2-2 acceptance #1 governs
    // codePaths (no `packages/oncall`), which is unchanged.
    ownedTables: [
      "external_triage_vendor",
      "on_call_shift",
      "tenant_oncall_policy",
      "triage_call",
      "triage_call_answer",
      "triage_call_state_history",
      "triage_escalation",
      "triage_paper_reentry_worklist",
      "triage_protocol",
      "triage_protocol_question",
    ],
  },
  {
    id: 20,
    name: "Field Safety",
    codePaths: [
      "apps/backend/src/modules/20-field-safety",
      "apps/web/src/modules/20-field-safety",
    ], // +web: Track B in-task screens (ADR-0030), land in M20-T07. NOTE: the spec's §3.1 layout also
    // proposes a `packages/safety-client` leaf package (seams / events / alert payloads / policy floor)
    // — NOT adopted. Wave P2-2 acceptance #1 limits this wave's manifest changes to the triage-vendors
    // codePath (ADR-0028, already applied) and the two Track B web codePaths, so M20's leaf CONTRACTS
    // live in `packages/types/src/safety.ts` (ADR-0005 D1/D2) — including the §3.2 Phase-E
    // `SAFETY_POLICY_FLOOR` constant §3.1 puts in that package — and its domain services under
    // `apps/backend/src/modules/20-field-safety` (the M6 / M19 precedent for a module with no feature
    // package).
    dependsOn: [1, 17, 36], // +M1 (M20-T02): the M1 FOUNDATION edge every implemented module carries —
    // `@wardenx/db` (the thirteen owned tables), `@wardenx/tenancy`'s withOrgContext, and the bootstrap
    // eraser registry the §3.7 `safety_record` eraser registers into. Not a widening of the module graph:
    // it is the same edge M15/M16/M18/M19/M21 each added at their first backend task, and Wave P2-2
    // acceptance #1 governs codePaths (no `packages/safety-client`), which is unchanged.
    ownedTables: [
      "safety_acknowledgment",
      "safety_check_in",
      "safety_check_in_schedule",
      "safety_emergency_contact_consent",
      "safety_high_risk_area",
      "safety_incident",
      "safety_incident_state_history",
      "safety_policy",
      "safety_policy_version",
      "safety_sos_alert",
      "safety_sos_alert_state_history",
      "safety_sos_location_stream",
      "safety_supervisor_subscription",
    ],
  },
  {
    id: 21,
    name: "Supplies, DME & Comfort Kits",
    codePaths: [
      "packages/supplies",
      "apps/backend/src/modules/21-supplies",
      "apps/web/src/modules/21-supplies",
    ], // +packages/supplies: §2 M21-owned feature pkg (D1 per-kind TypeBox / D2 lifecycle graph / D3 kit floor / D4 routing ladder / D8 reconciliation math), leaf-import only; +web: Track B in-task screens (ADR-0030), land in M21-T06
    // +M1: M21-T04's §4.5.1 inbound consumers resolve M11's `OrderProvider` and M6's
    // `AdmissionStatusReader`/`DeathDischargeReader` through the M1 boot seam registry
    // (`apps/backend/src/bootstrap`), which is M1 code; M21's own §4.8 seams register there in M21-T05.
    dependsOn: [1, 11, 40],
    ownedTables: [
      "supply_item",
      "tenant_supply_item_extension",
      "comfort_kit_template",
      "comfort_kit_template_medication",
      "vendor_routing_rule",
      "par_stock",
      "supply_request",
      "comfort_kit_dispatch",
      "comfort_kit_dispatched_content",
      "comfort_kit_return",
      "comfort_kit_returned_content",
    ],
  }, // M21-F06
  {
    id: 22,
    name: "Document Management",
    codePaths: [
      "packages/forms",
      "packages/intake-extraction",
      "apps/backend/src/modules/22-documents",
      "apps/web/src/modules/22-documents",
    ], // +web: Track B in-task screens (ADR-0030); empty slice scaffolded at M22-T01, real screens land in a later M22 task

    dependsOn: [1, 5],
    ownedTables: [
      "classified_page",
      "document",
      "document_access_log",
      "document_legal_hold",
      "document_tag",
      "document_version",
      "extraction_candidate",
      "extraction_decision",
      "extraction_discrepancy",
      "extraction_job",
      "extraction_provenance",
      "extraction_review",
      "form_fill",
      "form_template",
      "form_template_version",
      "intake_upload_batch",
      "tenant_template_overlay",
    ],
  },
  {
    id: 23,
    name: "Billing — Medicare",
    codePaths: [
      "packages/billing",
      "packages/x12-837-client",
      "apps/backend/src/modules/23-billing-medicare",
      "apps/web/src/modules/23-billing-medicare",
    ],
    // +M1: the cap-projection adapter imports getSeam from apps/backend/src/bootstrap (the M1 SeamRegistry)
    // to resolve M26's CapProjectionProvider for the §11.A cap rules — a real compile edge (the M27 [1,…]
    // precedent). The §4.4 seam/outbox consumers otherwise stay no-edge per ADR-0005.
    dependsOn: [1, 6, 8, 22, 38, 40],
    ownedTables: [
      "claim",
      "claim_acknowledgment",
      "claim_line",
      "claim_state_history",
      "claim_submission",
      "eligibility_check",
      "hipps_calculation",
      "mac_submitter_credential",
      "noe_record",
      "notr_record",
      "sequestration_policy",
      "sia_calculation",
      "validation_override",
      "validation_result",
      "validation_rule_config",
      "validation_run",
      "wage_index_factor",
    ],
  },
  {
    id: 24,
    name: "Billing — Medicaid",
    codePaths: [
      "packages/medicaid-adapters",
      "apps/backend/src/modules/24-billing-medicaid",
      "apps/web/src/modules/24-billing-medicaid",
    ],
    dependsOn: [1, 23, 40],
    ownedTables: [
      "medicaid_claim",
      "medicaid_claim_line",
      "medicaid_claim_line_encounter",
      "medicaid_claim_state_history",
      "medicaid_submission",
      "medicaid_acknowledgment",
      "medicaid_validation_run",
      "medicaid_validation_result",
      "medicaid_validation_override",
      "medicaid_validation_rule_config",
      "medicaid_eligibility_check",
      "rb_arrangement",
      "rb_day",
      "state_medicaid_trading_partner_credential",
    ],
  },
  {
    id: 25,
    name: "Remittance & Denials",
    codePaths: [
      "packages/x12-835-client",
      "apps/backend/src/modules/25-remittance",
      "apps/web/src/modules/25-remittance",
    ],
    dependsOn: [1, 23, 36],
    ownedTables: [
      "appeal_case",
      "appeal_case_event",
      "denial_case",
      "denial_case_assignment",
      "denial_taxonomy_overlay",
      "patient_responsibility_ledger",
      "remittance_adjustment",
      "remittance_advice",
      "remittance_line",
      "remittance_remark",
      "remittance_service_line",
    ],
  },
  {
    id: 26,
    name: "Cap Management",
    codePaths: [
      "packages/cap-management",
      "apps/backend/src/modules/26-cap",
      "apps/web/src/modules/26-cap",
    ],
    // ADR-0005: genuine compile-time edges only. +M1: the backend repos/services/abac resolver/seam impls
    // import the @wardenx/db barrel (packages/db/src/index.ts) — a real compile edge, so M1 is declared (the
    // M25 [1,23,36] / M27 [1,23,26,38] precedent). The broader read-direction inventory (M2-6/M25/M38/M40
    // foundation + seam/outbox consumers) stays no-edge per D1/D4 — do not bulk-apply the §13 relationship list.
    dependsOn: [1, 23, 36],
    ownedTables: [
      "cap_beneficiary_accrual",
      "cap_beneficiary_accrual_line",
      "cap_inpatient_accrual",
      "cap_inpatient_day_line",
      "cap_period",
      "cap_period_methodology_lock",
      "cap_period_platform_constant",
      "cap_projection_snapshot",
      "cap_psr_import",
      "cap_psr_reconciliation",
      "cap_settlement",
      "cap_threshold_event",
    ],
  },
  {
    id: 27,
    name: "Cost Report",
    codePaths: [
      "packages/cost-report",
      "packages/xero-client",
      "packages/gusto-client",
      "apps/backend/src/modules/27-cost-report",
      "apps/web/src/modules/27-cost-report",
    ],
    // ADR-0005: genuine compile-time edges only. +M1: the backend repos/services/workers/eraser import
    // the @wardenx/db barrel + the M1-owned bootstrap registry (registerEraser) — a real compile edge, so
    // M1 is declared (the M5..M18 "+M1: the bootstrap seam registry" precedent). The broader relationship
    // inventory (M2/M3/M4 foundation helpers reached via the always-importable packages/auth/tenancy/audit;
    // M6/M8/M12/M13/M22/M36/M40 seam+outbox consumers; M23/M26 forward-seam deny-stubs) stays no-edge per
    // D1/D4. M23/M26 are not yet locked → consumed as deny-stubs (D12/D13).
    dependsOn: [1, 23, 26, 38],
    ownedTables: [
      "bad_debt_record",
      "cost_center_mapping",
      "cost_report",
      "cost_report_compliance_window",
      "cost_report_snapshot",
      "cost_report_validation",
      "cost_report_validation_override",
      "cost_report_validation_result",
      "cost_report_validation_rule",
      "cost_report_worksheet",
      "ecr_submission",
      "statistic_data",
      "trial_balance_import",
      "wage_data_import",
    ],
  },
  {
    id: 28,
    name: "FHIR Gateway",
    codePaths: ["packages/fhir", "apps/backend/src/modules/28-fhir"],
    dependsOn: [5, 6, 7, 8, 11, 12, 13, 38, 40],
    ownedTables: [
      "fhir_bulk_export_artifact",
      "fhir_bulk_export_job",
      "fhir_capability_snapshot",
      "fhir_client",
      "fhir_client_credential",
      "fhir_client_session",
      "fhir_inbound_resource",
      "tenant_fhir_config",
    ],
  },
  {
    id: 29,
    name: "External Interfaces",
    codePaths: ["apps/backend/src/modules/29-external-interfaces"],
    dependsOn: [5, 11, 40],
    ownedTables: [
      "external_feed",
      "external_feed_credential",
      "external_feed_health",
      "hl7_inbound_proposal",
      "hl7_message_inbound",
      "hl7_message_outbound",
      "lab_observation",
      "lab_observation_inbound_link",
      "lab_observation_value",
      "nppes_provider",
      "nppes_sync_run",
    ],
  },
  {
    id: 30,
    name: "HQRP & Quality",
    codePaths: [
      "apps/backend/src/modules/30-quality",
      "apps/web/src/modules/30-quality",
      "packages/quality",
      "packages/cahps-vendors",
    ],
    dependsOn: [1, 2, 3, 4, 10, 23, 27, 36, 38],
    ownedTables: [
      "cahps_decedent_sample",
      "cahps_result_summary",
      "cahps_vendor_binding",
      "cop_compliance_status",
      "incident_report",
      "infection_outbreak_case",
      "infection_surveillance_event",
      "measure_recompute_queue",
      "mortality_review",
      "qapi_governance_minutes",
      "qapi_indicator",
      "qapi_pip",
      "qapi_program",
      "qapi_project",
      "quality_measure_value",
      "sra_cycle",
      "sra_finding",
      "sra_remediation",
    ],
  },
  {
    id: 31,
    name: "Patient/Family Portal & Telehealth",
    codePaths: ["packages/telehealth-client", "apps/portal", "apps/backend/src/modules/31-portal"],
    dependsOn: [1, 5, 7, 8, 22, 36, 39], // +1: M31-T03 consumes the M39 ConsentEvaluator + M16 BereavedPortalScopeProvider seams OPAQUELY via the M1-owned bootstrap registry (getSeam); the seam-task precedent every consuming module carries
    ownedTables: ["portal_account", "portal_access_grant", "telehealth_visit"],
  },
  {
    id: 32,
    name: "AI Platform",
    codePaths: ["packages/ai-platform", "apps/backend/src/modules/32-ai-platform"],
    // "parallel from Module 5 onward" — AI Platform provides capabilities; it depends on foundation only.
    dependsOn: [1, 2, 3, 4],
    ownedTables: [
      "ai_capability",
      "ai_capability_calibration",
      "ai_capability_lifecycle_event",
      "ai_clinician_opt_out",
      "ai_evaluation_run",
      "ai_hallucination_report",
      "ai_invocation",
      "ai_kill_switch_state",
      "ai_model_backend",
      "ai_prompt_template",
      "ai_routing_override",
      "ai_tenant_opt_in_record",
      "ai_token_ledger",
    ],
  },
  {
    id: 33,
    name: "Reporting & Dashboards",
    codePaths: [
      "packages/reporting",
      "apps/backend/src/modules/33-reporting",
      "apps/web/src/modules/33-reporting",
    ],
    // M33 consumes every clinical/billing module THROUGH SEAMS (the runtime M1 SeamRegistry getSeam +
    // the outbox) — never an import edge — so the broad "all clinical + billing" relationship inventory
    // drops out of dependsOn (per ADR-0005 that list is NOT the compile-edge set). The real compile edges:
    // M1 (@wardenx/db client + apps/backend/src/bootstrap getSeam + envelope/idempotency helpers), M2/M3/
    // M4 (auth/audit/tenancy), M36 (@wardenx/messaging alert types). Mirrors the M34 [1,2,3,4,36] posture.
    dependsOn: [1, 2, 3, 4, 36],
    ownedTables: [
      "dashboard_tile_cache",
      "materialized_view_metadata",
      "report_base_catalog",
      "report_definition",
      "report_definition_version",
      "report_drilldown_audit",
      "report_metric_catalog",
      "report_run",
      "report_schedule",
      "report_schedule_run",
      "report_share",
      "report_view",
    ],
  },
  {
    id: 34,
    name: "SaaS Tenant Platform",
    codePaths: [
      "packages/saas-tenant-platform",
      "packages/admin-ui-shell",
      "apps/backend/src/modules/34-saas-tenant-platform",
      "apps/web/src/modules/34-saas",
    ],
    // M1 (Foundation) is a genuine compile-time edge: M34's repositories import the @wardenx/db client
    // + schema barrel and the backend module imports the apps/backend/src/bootstrap seam registry
    // (getSeam) — both M1-owned codePaths — plus the M1 envelope/MinIO/idempotency helpers. Same posture
    // as every peer DB-consuming module (M4 [1,2,3], M40 [1,2,3,4], M22 [1,5]). The spec §13/D23 listed
    // [2,3,4,36] treating M1 as a no-edge foundation, but the implementation consumes the M1 client/
    // bootstrap directly, so the edge is real (NOT the broader [1,2,3,4,22,36] relationship inventory —
    // M22 stays out until the DSAR worker actually imports it).
    dependsOn: [1, 2, 3, 4, 36],
    ownedTables: [
      "dsar_export_job",
      "dsar_export_job_event",
      "onboarding_task",
      "onboarding_task_template",
      "platform_tenant_baa_record",
      "support_consent_grant",
      "support_session",
      "support_session_event",
      "tenant_account",
      "tenant_account_status_event",
      "tenant_invitation",
      "tenant_export_job",
      "tenant_export_job_event",
      "tenant_key_destruction_log",
      "tenant_key_ring",
      "tenant_signup_intent",
      "tenant_signup_token",
    ],
  },
  {
    id: 35,
    name: "Subscription Billing",
    codePaths: ["apps/backend/src/modules/35-subscription", "packages/subscription-billing"],
    dependsOn: [],
    /* ADR-0025: M34<->M35 seam-based both ways (no edge); minimal edge set finalized in M35's ADR-0005 D5 pass */ ownedTables:
      [
        "dunning_state",
        "invoice",
        "invoice_line",
        "patient_active_period",
        "patient_pseudonym_key",
        "payment_method",
        "plan",
        "plan_meter",
        "platform_retained_invoice",
        "platform_retained_invoice_line",
        "promo_code",
        "promo_code_application",
        "refund",
        "revenue_recognition_snapshot",
        "stripe_api_call_audit",
        "stripe_webhook_event",
        "subscription",
        "subscription_state_history",
        "usage_event",
        "usage_period_aggregate",
        "user_active_period",
      ] /* M35-F06: platform-retention tables replace in-place org_id rewrite (ARCH-186/085/251) */,
  },
  {
    id: 37,
    name: "Inpatient Unit (IPU) Management",
    codePaths: ["apps/backend/src/modules/37-ipu", "packages/inpatient"],
    dependsOn: [6, 8, 11, 13, 17, 23],
    ownedTables: [
      "gip_admission_criteria",
      "gip_criteria_reassessment",
      "inpatient_unit",
      "ipu_admission",
      "ipu_admission_state_history",
      "ipu_admission_transition",
      "ipu_bed",
      "ipu_bed_assignment",
      "ipu_bed_cleaning_event",
      "ipu_body_release",
      "ipu_census_snapshot",
      "ipu_equipment",
      "ipu_equipment_inspection",
      "ipu_equipment_maintenance",
      "ipu_iv_safety_overlay",
      "ipu_meal_service",
      "ipu_remote_inpatient_episode",
      "ipu_restraint_event",
      "ipu_restraint_reassessment",
      "ipu_rn_coverage_window",
      "ipu_room",
      "ipu_shift",
      "ipu_staff_assignment",
      "ipu_visitor",
      "ipu_visitor_restriction",
      "irc_episode",
    ],
  },
];

/** Convenience maps */
export const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));

/** Every code path that belongs to some module, for orphan detection. */
export const ALL_OWNED_PATHS = MODULES.flatMap((m) => m.codePaths);

/** Resolve the set of paths a module is allowed to import from.
 *  = own codePaths + dependsOn codePaths + LEAVES + FOUNDATION HELPERS (ADR-0005 D4).
 *  Seam/outbox consumption needs no dependsOn edge (ADR-0005 D1): seam interface
 *  types live in packages/types (a leaf) and are universally importable already. */
export function allowedImportPaths(id: ModuleId): string[] {
  const m = MODULE_BY_ID.get(id);
  if (!m) throw new Error(`Unknown module ${id}`);
  const deps = m.dependsOn.flatMap((d) => MODULE_BY_ID.get(d)?.codePaths ?? []);
  return [...m.codePaths, ...deps, ...LEAF_PACKAGES, ...FOUNDATION_HELPER_PACKAGES];
}

/** Resolve the set of tables a module may touch directly (owned only; helpers excepted). */
export function allowedTables(id: ModuleId): string[] {
  return MODULE_BY_ID.get(id)?.ownedTables ?? [];
}
