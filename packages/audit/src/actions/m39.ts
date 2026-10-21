// @chartwarden/audit — Module 39 (Consent & Authorization Management) action catalog (M39-T10; §8.1).
//
// M39's APP-LEVEL logical audit events — the ones that do NOT correspond to a single owned-table
// mutation (those already flow through the M4 write-audit triggers from M39-T03 as
// `consent_record.created/updated/…`). Registered under the D9 `m39.<resource>.<verb>` namespace the
// catalog validator enforces (§4.6.7 owner-prefix). The spec §8.1 listed some of these bare
// (`consent.*`); they are namespaced to `m39.` here so the owner-prefix invariant holds (architecture
// wins over the spec). Bodies carry structural ids + a hashed reason, never raw PHI — empty denylist;
// the consent-DECISION + post-death events are Part 2 eligible (they may concern SUD consent).
import type { ModuleActionCatalog } from "./types";

/** `m39` Consent module actions (M39 §8.1). */
export const M39_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m39.consent.eval_denied",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description:
      "A ConsentEvaluator.evaluate call denied access (consentRecordId?, patientId, typeKey, callerModule, callerRoute, denyReason). Structural — no PHI in the deny reason.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m39.consent.eval_audit_read",
    moduleOwner: "m39",
    defaultRetentionClass: "operational",
    description: "A Compliance/Privacy Officer read the consent_eval_audit surface (routes 22/23; auditRead).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m39.consent.supersession_chain_extended",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description: "A new consent superseded a prior one (newConsentRecordId, supersededConsentRecordId, patientId, typeKey).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m39.consent.cascade_handler_failed",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description: "A revocation-cascade consumer exhausted its retry budget (consentRecordId, revocationId, consumerName, attemptCount).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m39.consent.tenant_overlay_published",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description: "A tenant published a tighten-only consent-type overlay (overlayId, typeKey, publishedBy, changes).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m39.consent.tenant_overlay_rejected_loosens_floor",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description: "A tenant overlay was rejected for loosening the platform floor (attemptedById, typeKey, fieldsLoosened) — §7.6.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m39.consent.post_mortem_termination",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description: "A non-surviving consent terminated on patient death (consentRecordId, patientId, typeKey, deceasedAt) — D13.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m39.consent.ai_block_validator_failed",
    moduleOwner: "m39",
    defaultRetentionClass: "compliance",
    description: "The boot AI-block validator refused an M32 prompt template that would mutate/evaluate consent (D17).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
