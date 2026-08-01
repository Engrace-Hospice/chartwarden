// @wardenx/db — M19 On-Call Triage schema barrel (§3.3, 10 owned tables, manifest-exact). The central
// ../index.ts re-exports this barrel; the 13 M19 pgEnums live in ../../enums.ts (M19-T01, unprefixed SQL
// names — M19's §3.2 spells them without an `m19_` prefix, unlike M21's §3.1.1).
//
// SHAPE. Three layers:
//   • CONFIG — `tenant_oncall_policy` (D3/D7: the model, the tier ladder, the callback SLA, the two AI
//     gates) and `external_triage_vendor` (D13/ADR-0026: the tenant's BAA-gated binding to a vendor whose
//     canonical entity is M40's). Neither is patient data; neither is ever erased.
//   • ROSTER — `on_call_shift`, the CoP 418.100(c)(2) proof that someone was reachable, carrying the D7
//     `policy_snapshot` pinned at open so a later policy edit cannot rewrite a past night.
//   • CATALOG — `triage_protocol` + `triage_protocol_question`, D4's platform-floor-plus-tenant-overlay
//     catalog where D5's red-flag predicates and D7's mandatory-escalation tiers live.
//   • CALL — `triage_call` (D6's nine-state record), its append-only `triage_call_answer` ledger,
//     `triage_escalation` (D7's ladder) and `triage_call_state_history`, plus the M19-F08 BCP
//     `triage_paper_reentry_worklist`.
//
// TENANCY (ARCH-011 / ADR-0010 D2): every table's RLS keys on app.org_id ALONE. Eight carry
// organization_id NOT NULL; `triage_protocol` and `triage_protocol_question` carry it NULLABLE on the
// PLATFORM-FLOOR row only, paired with the `is_system_locked` discriminator and a CHECK pair in both
// directions (the M21 `comfort_kit_template` precedent) so a tenant READS the floor and can never write
// it. The four call tables additionally carry provider_entity_id NOT NULL + location_id nullable — the
// three-column rule, which the §3.3 block omits and architecture supplies (the M16 posture: PE
// denormalized from the parent, Location nullable because it is not always resolvable).
//
// NOT PARTITIONED — a documented deviation from §10 task 3 / §12, which ask for monthly partitions on
// `triage_call` / `triage_call_answer` / `triage_call_state_history`. A partitioned table's UNIQUE index
// must include the partition key, and that would destroy BOTH remaining uniqueness guarantees in this
// module: `triage_call_source_dedupe_uq` (D10's redelivery guard — §2.6's idempotency promise for the M17
// no-show / M18 late-checkout triggers) and `triage_call_answer_latest_per_q_uq` (one original answer per
// question, the base of the §2.2.3 correction-by-append model). It would also forbid the real FKs the
// three call children hang on their parent. The volume case that justified partitioning
// `administration_record` / `document_access_log` does not apply to a human-answered phone call at
// after-hours volume. See the header of triage-calls.ts for the full reasoning and the conversion path.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) and the intra-M19 parents get real FK constraints. patient_id (M5), admission_id (M6),
// caller_caregiver_id (M5), caller_portal_session_id (M31), mdm_vendor_id (M40), source_outbox_event_id
// (M1 outbox), linked_encounter_id (M8), linked_verbal_order_ids (M11), linked_visit_proposal_id (M17)
// and m17_visit_assignment_ref (M17) are LOGICAL uuid, validated at the write boundary through the owning
// module's seam. The `*_membership_id` columns keep the spec's `.references(() => memberships.id)` as the
// ORM's view of the relationship, but the NORMATIVE SQL (0107) emits a plain uuid with no FK constraint —
// M2 owns `membership`, and M17's `visit.assigned_membership_id` set that precedent.
//
// Enums + the ten tables land in migration 0107; RLS/grants, the ten M4 write-audit triggers (with the
// §3.6 denylists mirrored from `M19_AUDIT_DENYLIST` in @wardenx/types) and the §2.3 forward-transition
// guard in 0108. The ≥25-protocol platform-floor seed (§3.2 Phase E / §10 task 5) lands with the protocol
// engine in M19-T03, which owns the red-flag predicate shape the question rows encode.

export * from "./tenant-oncall-policy"; // tenant_oncall_policy
export * from "./external-triage-vendors"; // external_triage_vendor
export * from "./on-call-shifts"; // on_call_shift
export * from "./triage-protocols"; // triage_protocol (platform floor + tenant overlay)
export * from "./triage-protocol-questions"; // triage_protocol_question
export * from "./triage-calls"; // triage_call
export * from "./triage-call-answers"; // triage_call_answer (append-only)
export * from "./triage-escalations"; // triage_escalation
export * from "./triage-call-state-history"; // triage_call_state_history (append-only)
export * from "./triage-paper-reentry-worklist"; // triage_paper_reentry_worklist (M19-F08 BCP)
