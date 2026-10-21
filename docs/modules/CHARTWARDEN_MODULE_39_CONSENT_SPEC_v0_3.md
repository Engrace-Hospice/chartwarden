# Module 39 — Consent & Authorization Management Specification

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) are ground truth for as-built behavior. Mechanism choices named here may be superseded — see ADR-0036…0040 and ADR-0030/0032/0035 for the recorded divergences (outbox not Socket.IO, TypeScript not Python sidecars, app-layer AES-256-GCM not pgcrypto, pure transition tables not XState, hand-rolled HTTP hardening not `@fastify/*`, Vite + react-router not TanStack Start).


**Spec version:** v0.3 — the outbox events + M36 alert payloads migrated to the `m39.consent.*`
namespace per M01 D8 / M36 D10 / M03 D9 (events: created/signed/revoked/expired/expiring_soon/
recipient_added/recipient_removed/renewal_cycle_opened/renewed/supersedes/repointed; alerts:
revoked_cascade_failed/expiration_imminent/renewal_overdue/recipient_disclosure_attempted_without_consent).
Consumer ref updated (M16). Permission keys (`consent.read`, `consent.author`, `consent.sign`,
`consent.revoke`, …), the `consent.evaluate` seam method, ABAC predicates, and schema fields are
unchanged (separate, feature-prefixed namespaces). (Prior: v0.2.)

**Module ID:** 39
**Phase:** 1 (foundation/cross-cutting — the consent platform the entire authorization stack consults; many already-locked clinical modules ship with `ConsentEvaluator` deny-stubs that resolve to this module on lock)
**Depends on:** 1 (Foundation — `withOrgContext`, `audit()`, outbox dispatcher + idempotency helper, RLS generator, per-tenant DEK envelope encryption, partitioned-table conventions, the M1 `SeamRegistry` + boot validator), 2 (Identity & Org — `MembershipReader`, `CredentialReader`, the `SESSION_POLICY` constants including the new `consent_management` step-up profile this module declares, the four session-class shapes including portal-session and external-collaborator scoping, the auditor mint surface), 3 (Authorization — RBAC catalog + named-predicate registry; M39 contributes eleven predicate resolvers that other modules consume by name), 4 (Audit & Compliance Log — PHI write-audit trigger generator with per-table denylist, `auditRead()` helper, retention-class registration including the `compliance` class, destruction-cert workflow + `eraseFn` registration, legal-hold tombstone propagation, the §164.528 accounting-of-disclosures sink), 5 (Patient & Demographics — `PatientReader` for grantor/subject identity resolution; `patient.privacy_flag_snapshot` is downstream of M39 — M5 subscribes to `m39.consent.signed` and `m39.consent.revoked` and recomputes its snapshot per M5 D10; `patient.deceased` state gates post-death consent semantics per D13), 22 (Documents — `DocumentRenderer` seam for the `consent_record` template (already in M22's template catalog at the `consent_record` key per M22 D14); M39 emits `m39.consent.signed` and consumes M22's `m22.document.rendered` back-ref to stamp `consent_record.document_id`; M39 also reads `IntakeMetricsProvider` indirectly via the `uploaded_signed_pdf` capture method whose source artifact is an M22 intake batch), 36 (Secure Messaging & Alerts — typed alert payloads for `m39.consent.expiration_imminent`, `m39.consent.revoked_cascade_failed`, `consent.dpoa_agent_appointed`, `m39.consent.recipient_disclosure_attempted_without_consent`, `m39.consent.renewal_overdue`; the `consent_management_steward` recipient resolver M39 registers; per-tenant channel for compliance), 38 (Clinical Terminology — recipient-class value set (`Hospital`, `Specialty Pharmacy`, `Research IRB`, `Family Member`, `Attorney`, `Employer`, etc.), language ISO-639 for consent-of-translation indicators, jurisdiction-code value set (state-by-state advance-directive variants), purpose-of-disclosure code list bound to HL7 v3 ActReason value set; `asOfDate` lookups for survey-grade historical reconstruction), 40 (MDM — `ExternalPhysicianReader` for NPI-backed recipient identity when the consent names an external physician; `FacilityReader` for hospital/SNF/IRB recipient resolution; `PharmacyReader` for pharmacy-recipient disclosure consents; the `discipline` taxonomy used by the consent-management-steward alert recipient resolver)

**Consumed by:** 5 (Patient — subscribes to `m39.consent.*` to recompute `patient.privacy_flag_snapshot`; consults `evaluate(patientId, 'hipaa_release', sessionContext)` on §164.524 right-of-access exports), 6 (Admission — hospice election form is a separate compliance artifact owned by M6, but M6 consults M39 on SUD-flagged narrative content before rendering election statements per M6 §1.3), 7 (Care Plan — consults `consent.evaluate(patientId, '42_cfr_part_2_release', sessionContext)` and `consent.evaluate(patientId, 'dpoa_healthcare', sessionContext)` via the `sud_disclosure_allowed` and `dpoa_active` predicates per M7 D7), 8 (Encounters — consults `sud_disclosure_allowed` on every SUD-flagged encounter row per M8 D8; HearthNote Layer-2 narrative paths gate on consent per AI Governance §2.1.4), 9 (Clinical Assessments — AIMS scale + future SUD-context scales gate on `sud_disclosure_allowed` per M9 §4.7), 11 (Orders — SUD-flagged medication orders egress paths gate on consent per M11 D7), 12 (DoseSpot/Prescribing — SUD-treatment medications gate per M12; same predicate chain), 13 (eMAR — SUD-treatment medication administration disclosure consults `consent.evaluate` per M13 D7), 14 (IDG — IDG packet projection consults `sud_disclosure_allowed` and `dpoa_active` per M14 §4.8 consumed seams), 15 (Discipline Care Plans — MSW/Spiritual/Aide/Volunteer plans gate on `sud_disclosure_allowed`, `dpoa_active`, and the new `family_violence_disclosure_allowed` predicate (M15 contributes the registration but M39 owns the evaluation) per M15 §4.5), 16 (Bereavement — per-bereaved-contact `bereavement_outreach_consent` records owned by M39 with M16 holding the `bereaved_contact.consent_record_id` FK; M39 emits `m39.consent.revoked` and M16's listener cascades to opt-out per M16 §2.6 D6), 17 (Scheduling — portal-side `/api/v1/portal/upcoming` route gates on `family_caregiver_access` per M17 §4.2), 18 (EVV — coordinate disclosure to caregiver-portal session gates on `family_caregiver_access` per M18 §1.3), 19 (On-Call Triage — caregiver-initiated triage calls gate on `family_caregiver_access`; AI-protocol-suggestion governance consults the consent registry for SUD-flagged red flags per M19 §4.4), 22 (Documents — disclosure subsetter calls `evaluateForDisclosure(patientId, recipientClass, asOf)` on every signed-URL mint and PHI-bundle assembly per M22 §1.3), 23 (Billing — SUD-flagged ICD-10 D9 diagnosis line items on a 81X claim gate on `42_cfr_part_2_release` consent presence before rendering the claim CMS-1450; release without consent is a hard-blocker), 27 (Cost Report — patient-aggregate read paths consult `evaluateBulk` for SUD/HIV/MH/Genetic redaction in aggregate views), 28 (FHIR Gateway — calls `evaluateForDisclosure(patientId, recipientClientId, asOf)` synchronously on every egress per M28 D3; `OperationOutcome` with `filtered for 42 CFR Part 2; consent absent` is the surfaced narrative), 29 (External Interfaces — calls `evaluateForIngressRedaction(patientId)` before persisting an HL7 inbound frame containing SUD/HIV/MH/Genetic content per M29 D15 W-XI-14), 30 (HQRP & Quality — aggregate measures consult `evaluateBulk` to filter SUD-flagged patient denominator entries when the measure's compliance posture requires consent gating per M30 D19), 31 (Patient/Family Portal — Phase-2 surface; M39 publishes `m39.consent.portal_access.granted`/`revoked` and `m39.consent.family_caregiver_access.granted`/`revoked` events M31 subscribes to; M31 consults `evaluate(patientId, 'portal_access', sessionContext)` on every portal-session mint and on every PHI-bearing route within the session; M31 owns the session-termination side of the revocation cascade — M39's `PortalSessionTerminator` is a forward-seam deny-stub until M31 lands), 33 (Reporting — drilldown narrowing per M33 D16 calls `evaluateBulk` to filter rows the actor cannot see by reason of consent; the M-X target module enforces; M33 only narrows the rendered drilldown URL set), 34 (Tenant SaaS Platform — Phase-2 surface; tenant offboarding workflow consults M39 to ensure no active research-participation consents are mid-flight before destruction-cert eligibility), 36 (Messaging — bereavement channel membership is bound to `family_caregiver_access` consent on the deceased patient per M36 §2.3; M39 publishes `BereavementOutreachConsentProvider` consumed by M36's `recipient_resolver='bereavement'`)

**Spec status:** Re-locked v0.3 (Phase-3 audit remediation; supersedes Locked v0.2)

> **Re-lock remediation banners (full disposition in the Remediation Changelog below; ADR-0005/0006/0013/0014):**
> - **M39-F03 (BLOCKER) — consent EVALUATION ≠ DISCLOSURE.** §164.528 accounting-of-disclosures is
>   owned by **Module 4** and records **actual disclosures** at each egress (written by the disclosing
>   module — M28/M22/M05/M29/M32 — per ADR-0013). M39's `consent_eval_audit` logs `evaluate()`
>   *decision* calls (which fire on internal access, not only disclosures) — it is a **consent-decision
>   audit, NOT the §164.528 feeder**. The "§164.528 feeder" claim is struck from route 23 and §1.4;
>   M39's job is the access-time `ConsentEvaluator` gate, not disclosure accounting.
> - **M39-F02 (BLOCKER) — dependsOn / cycle.** Per ADR-0006 the manifest `M39.dependsOn = [1,2,3,4,5]`
>   (22 dropped — Consent consumes M22 `DocumentRenderer` via a **forward seam**, no edge, breaking the
>   22↔39 cycle). M36/M38/M40 are consumed via outbox/seam/terminology (no edge, ADR-0005 D1). The D22
>   patch's `[1,2,3,4,5,22,36,38,40]` is superseded.
> - **M39-F01 (BLOCKER) — no schema in a leaf.** All consent **Drizzle schema** moves from
>   `packages/domain/consent` to **`packages/consent`** (the manifest codePath). `packages/domain` may
>   hold pure consent *types/invariants* only — never tables (ADR-0005 D2). Read every
>   `packages/domain/consent/schema.*` reference below as `packages/consent/...`.
> - **M39-F05 (Part 2, ADR-0014).** Each sensitive-category redaction flag (`redactHiv*`,
>   `redactMentalHealth*`, `redactGenetic*`) must be **backed by a consent type or M5 PrivacyFlag**
>   that authoritatively drives it, default **redact/deny** when no release consent names the
>   recipient; flags M39 cannot authoritatively decide are delegated to M5. Part 2/PHI-Sensitive extra
>   controls (segmentation, §2.31 per-recipient grant, enforced re-disclosure gate) are enumerated.
> - **M39-F08.** Cross-module revocation/recipient-change outbox events are emitted from the **service
>   layer** via the M1 outbox helper in the same transaction — **not** from DB triggers (ARCH-144/264);
>   triggers may maintain derived columns only.

## Remediation Changelog — Phase 3 (v0.3, 2026-06-11)

| Finding | Sev | Resolution |
|---|---|---|
| **M39-F01** | BLOCKER | Consent Drizzle schema moved from the leaf `packages/domain/consent` to `packages/consent`; `packages/domain` holds pure types only (ADR-0005 D2). |
| **M39-F02** | BLOCKER | Manifest `dependsOn = [1,2,3,4,5]` (ADR-0006: 22 dropped, M22 via forward seam; 36/38/40 via outbox/seam/terminology — no edge). D22's expanded list superseded; 22↔39 cycle broken. |
| **M39-F03** | BLOCKER | `consent_eval_audit` relabeled a **consent-decision audit**; the §164.528-feeder claim struck from route 23 + §1.4. §164.528 disclosure records are written by the disclosing module to M4's sink at egress (ADR-0013). |
| M39-F04 | MAJOR | Eraser registered under the data-class key the boot validator expects (`consent`); eraser no longer DELETEs the immutable `consent_eval_audit` — routed through M4's audit-retention/destruction-cert workflow. |
| M39-F05 | MAJOR | Each sensitive-category redaction flag backed by a consent type / M5 PrivacyFlag, default redact/deny; Part 2 / PHI-Sensitive extra controls enumerated (ADR-0014). |
| M39-F06 | MAJOR | Consent-record retention clock anchored to **patient-relationship end + the §164.530(j)(2)/CoP floor** (not consent `expires_at`), per §24.1 "lifetime + 6 years" reconciled to 7 (ADR-0004). |
| M39-F07 | MAJOR | Invented manifest fields (`publishedSeams`/`registers*`/…) dropped — registrations live in boot code + the seam registry, not `ModuleDef` (ARCH-146). |
| M39-F08 | MAJOR | Cross-module revocation/recipient-change outbox events emitted from the **service layer** via the M1 outbox helper in-transaction, not from DB triggers (ARCH-144/264). |
| M39-F09 | MAJOR | `m39.consent.expiration_imminent` re-tiered off CRITICAL for routine expiry; the M20/Twilio-Voice SOS escalation removed from consent reminders (INT-031 voice = field-safety SOS only). |
| M39-F10..F15 | MINOR | M3 SoD constraint cited by ID not asserted (OPEN-021); per-route ABAC attribute sets made explicit (F11 — §4.11); OPEN-022 note (M4 owns `state_retention_override`); draft TTL labeled housekeeping NOT a §24 retention commitment (F13 — §2.2.1 + §4.9); **cursor pagination** on all PHI list/audit routes 18, 22, 23 (F14 — §4.12); per-resource synchronous eval-audit on bulk FHIR egress batched to once-per-recipient/request boundary (F15 — §4.3 `evaluateBulk` + §9.7). |

## Changelog

- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves twenty-two decisions (D1–D22) including the append-only versioned consent-record model with explicit supersession chains (D1), the platform consent-type catalog plus tenant-tighten-only overlay (D2 + D8), the four primary capture methods plus the notarization escalator (D4), the chain-of-authority grantor model with self-referential validation that prevents a DPOA record from being signed by its own future agent (D5), the per-recipient grant model for the four explicitly per-recipient consent types (D6), the typed revocation cascade with idempotent per-consumer handlers (D7), the platform-floor expiration cadences with tenant-tighten-only enforcement (D8), the platform-floor 90/30/14/7/1-day reminder cadence (D9), the `DelegatedAccess` projection model that keeps the consent record as the source of truth (D10), the `ConsentEvaluator` seam shape with four typed query methods serving the entire downstream consumer set (D11), the consent-version-aware audit row written on every `evaluate()` call so a Compliance Officer can reconstruct *what the system knew about consent on date X when staff accessed record Y* (D12), the pre-death/post-death scope semantics aligned to 42 CFR Part 2 §2.31 and HHS guidance (D13), the post-mortem bereavement outreach consent as a first-class consent type owned by M39 (D14), the M22 signed-PDF rendering integration (D15), the AI-prohibited boundary with boot-validated denial of any M32 prompt template that would create, modify, revoke, or evaluate consent (D17), the step-up auth requirement for staff-side consent management surfaces (D16), the `compliance`-class retention with 7-year floor and state overrides (D18, D20), the forward-seam deny-stub pattern for M31 portal-session-termination (D18), and the manifest patch wiring M39 into the dependency-cruiser graph with eleven owned tables and the forward-seam consumer set (D22). Establishes the eleven owned tables (`consent_type_catalog`, `tenant_consent_type_overlay`, `consent_record`, `consent_record_recipient`, `consent_record_dpoa_agent`, `consent_revocation`, `consent_expiration_reminder`, `delegated_access`, `consent_document_link`, `consent_eval_audit`, `consent_renewal_cycle`), the eleven ABAC predicates M39 resolves into M3's named-predicate registry, the fourteen outbox event types, the fifteen permission keys M39 contributes to M3, and the workflow acceptance criteria covering every consent type's full lifecycle including the SUD-detection-from-M22-DocLens loop (W-CON-04), the bereavement post-death-grant path (W-CON-11), and the DPOA chain-of-authority validation (W-CON-08). Wires the manifest patch updating `M39.dependsOn` from the prior incorrect placeholder to `[1, 2, 3, 4, 5, 22, 36, 38, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)* and adding the forward-seam consumer declarations for M27, M28, M29, M31, M33. Lock-grade sign-off.

> **Phase boundary (binding):** Phase 1 delivers everything in this spec **except** (a) the M31 patient/family portal-session termination side of the revocation cascade — M39's `PortalSessionTerminator` ships as a forward-seam deny-stub today, with M39 emitting the typed `m39.consent.portal_access.revoked` event the future M31 will subscribe to; the cascade is operative but the portal session-kill side is a logged-deferral until M31 lands; (b) the M32 LLM consent-state-aware advisory surface on read paths — Module 32 owns model selection and prompt registry; M39 publishes the `ConsentStateAdvisoryProvider` seam M32 will consume on lock, deny-stubbed today; (c) the M28 patient-facing "who has accessed my data via FHIR" portal view per M28 §5.3 Phase 2; M39's consent-aware disclosure audit feeds that view but the portal surface is M31-owned; (d) the cross-state consent-portability adapter for tenants operating in multiple states with conflicting consent-form requirements — Phase 1 ships per-tenant state-addendum overlays via the M22 template overlay mechanism (already operative), the cross-tenant federation layer is Phase 2. The "done" gate for M39 is: the eleven-table schema with append-only version chains and the per-recipient/per-DPOA-agent join tables, the ten v1 consent types seeded in the catalog with their typed scope discriminators and platform-floor expiration policies, the `ConsentEvaluator` seam published with all four query methods registered at boot via `SeamRegistry`, the eleven ABAC predicates registered with M3 at boot with the named-predicate-registry pattern, the consent-version-aware `consent_eval_audit` partitioned monthly and the M4 audit denylist for free-text PHI columns, the revocation-cascade outbox publisher with typed per-consumer handlers, the platform-floor expiration reminder cron with M36 typed alerts, the `delegated_access` projection consumed by M17/M18 for portal-side scope checks, the M22 signed-PDF render integration with the `consent_record` template, the eraser registered with M4 destruction-cert workflow, the AI-prohibited boundary validator wired at boot, the step-up auth profile registered with M2 `SESSION_POLICY`, the test plan green across unit/integration/RLS-isolation/E2E/k6 layers — not gated on M31/M32/M27-cost-report-aggregate-paths existing. The M27/M28/M29/M30/M31/M33/M34 consumers are wired through the seam registry; their absence today is a deny-stub on consume by design.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 39 owns **what the patient (or legal representative) has authorized the agency to do with the patient's data, identity, and care-decision authority** — the chain of consent-bearing facts that says "this disclosure to this recipient on this date was permitted by an active, on-file, captured-with-required-evidence consent record signed by a grantor with documented authority." It is the module a federal SUD-confidentiality (42 CFR Part 2) auditor opens first when investigating an alleged unauthorized re-disclosure. It is the module a HIPAA Privacy Officer queries when the OCR sends a complaint about an unauthorized access. It is the module the Medicare hospice surveyor consults to verify the patient was given (and acknowledged) Notice of Privacy Practices and Notice of Rights at admission. It is the module M31 Patient/Family Portal will gate every login on; it is the module M28 FHIR Gateway gates every external disclosure through; it is the module M16 Bereavement gates per-bereaved-person outreach on; it is the module M19 On-Call Triage gates caregiver-initiated calls on; it is the module M22 Document Disclosure Subsetter consults on every signed-URL mint.

Concretely M39 delivers:

- **The ten platform-floor consent types** (D2) — `portal_access`, `dpoa_healthcare`, `dpoa_financial`, `family_caregiver_access`, `42_cfr_part_2_release`, `media_release`, `research_participation`, `telehealth_consent`, `advance_directive_acknowledgment`, `hipaa_release` — each with a typed scope discriminator (categorical | per-recipient | per-named-agent | per-encounter), a platform-floor expiration policy, a platform-floor capture-evidence requirement, a platform-floor reminder cadence, and a typed revocation-cascade descriptor. Plus the post-mortem `bereavement_outreach_consent` type owned by M39 with M16 as primary consumer (D14). Plus the tenant-extensible custom-consent-type slot for compliance-officer-curated organization-specific consents (D2 — tenant cannot loosen platform-floor types but can add additional types).
- **The append-only versioned ConsentRecord with explicit supersession chains** (D1) — every "edit" is a new `consent_record` row pointing at the prior via `supersedes_consent_record_id`; the prior row stays alive with `superseded_at` stamped; the version chain is the surveyor's audit narrative; point-in-time evaluation (`asOf` parameter on the seam) reconstructs the consent state on any past date by walking the chain.
- **The chain-of-authority grantor model with self-referential validation** (D5) — `grantor_kind ∈ {patient_self, dpoa_healthcare_agent, dpoa_financial_agent, court_guardian, parent_for_minor, healthcare_surrogate, bereaved_person_self}`; non-self grantors carry an `acting_consent_id` FK pointing at the consent record that *proves* the authority (e.g., the DPOA-Healthcare consent record proves DPOA authority for a clinical-care decision); the validation refuses a chicken-and-egg DPOA record where the grantor would be that DPOA's own future agent.
- **The per-recipient grant model** (D6) — for the four explicitly per-recipient consent types (`42_cfr_part_2_release`, `hipaa_release`, `family_caregiver_access`, `research_participation`), separate `consent_record_recipient` rows enumerate named recipients (entity FK to M40 + optional purpose-limitation code + per-recipient expiration); one consent record can have many recipients added incrementally without re-signing as long as the consent scope hasn't materially changed; a material scope change forces a new consent record.
- **The named-agent model for DPOA records** (D5 sibling) — `consent_record_dpoa_agent` rows enumerate the named agent + alternate(s), the activation condition (immediate | upon-incapacity | upon-physician-determination | upon-incompetence-court-order), the per-agent scope (healthcare | end-of-life | financial-narrow | financial-broad), and the per-agent term (indefinite | until-date | event-driven).
- **The typed `ConsentEvaluator` seam** (D11) — four primary query methods (`evaluate`, `evaluateForDisclosure`, `evaluateForIngressRedaction`, `evaluateBulk`) serving the entire downstream consumer set with one well-typed surface; eleven ABAC predicates resolve through this seam into M3's named-predicate registry.
- **The consent-version-aware audit trail** (D12) — every evaluate call writes a `consent_eval_audit` row carrying `{consent_record_id, consent_version_at_eval, allowed, asOf, caller_module, caller_route, session_class, redacted_categories}`; this is the audit the Compliance Officer queries to reconstruct "what the system knew about consent on date X when staff accessed record Y"; partitioned monthly because volume is high (every PHI route call writes one).
- **The typed revocation cascade** (D7) — typed per-consent-type handlers emit outbox events that consumers subscribe to with idempotent per-consumer dedup; M2 portal-session terminate, M22 signed-URL revoke, M28 FHIR rebind, M16 bereavement opt-out cascade, M7 DPOA agent revocation re-routes signing authority back to patient or alternate; M39 emits the canonical event but does **not** mutate downstream module rows.
- **The expiration policy + renewal cycle** (D8 + D13) — platform-floor expiration per consent type (e.g., `42_cfr_part_2_release` defaults 1 year; `hipaa_release` defaults 6 months; `dpoa_healthcare` indefinite-unless-revoked; `telehealth_consent` per-session; `media_release` 3 years; `research_participation` until-study-completion+3-years; `advance_directive_acknowledgment` indefinite; `portal_access` indefinite); tenant can tighten not loosen; the `consent_renewal_cycle` row drives the M36-routed reminder + the re-capture workflow; the new consent record points at the prior via `renewed_from_consent_record_id` so the renewal chain is auditable independently from the supersession chain.
- **The DelegatedAccess projection** (D10) — query-optimized projection from `family_caregiver_access` consent records; one `delegated_access` row per named family member + scope; the consent record remains the source of truth; M31 portal session-minter consults this projection (forward seam) to bind portal-session scope.
- **The signed PDF artifact via M22** (D15) — every signed consent triggers `m39.consent.signed` → M22 renders the `consent_record` template (already in M22's catalog) → M22 emits `m22.document.rendered` → M39's `m22-document-backref.ts` consumer stamps `consent_record.document_id` and `document_version_id` via the `consent_document_link` join.
- **The post-mortem semantics** (D13 + D14) — patient's own consents other than `family_caregiver_access` and `bereavement_outreach_consent` terminate on death-discharge per 42 CFR Part 2 §2.31 and HHS guidance ("consent doesn't transfer to surviving family"); `family_caregiver_access` may persist into the bereavement window if grantor specified `survives_death=true` at consent capture; `bereavement_outreach_consent` is a separate consent type captured **post-death** with the bereaved person themselves as the grantor (`grantor_kind='bereaved_person_self'`).
- **The eleven ABAC predicates** (D10 — M3 §4.2 alignment) — M39 registers resolvers for `sud_consent_present`, `sud_disclosure_allowed`, `dpoa_active`, `family_caregiver_access_active`, `portal_access_active`, `telehealth_consent_active`, `media_release_active`, `research_participation_active`, `advance_directive_acknowledged`, `hipaa_release_active`, `family_violence_disclosure_allowed` (this last one registered by M15 with M39 as the resolver per M15 §4.5).
- **The eraser + retention** (D20) — `compliance` retention class with 7-year HIPAA §164.530(j)(2) floor and state-override hook; eraser registered with M4 destruction-cert workflow; deletes the consent-record subtree (record + version chain + recipients + DPOA agents + revocations + reminders + renewal-cycles + delegated-access projections + eval-audit history) atomically with the M5-triggered patient eraser; legal holds supersede.

### 1.2 What This Module Does Not Do

- **Authenticate users or maintain sessions.** Module 2 owns Better Auth, the four session classes, MFA, the `SESSION_POLICY` constants. M39 *contributes* a step-up profile (`consent_management`) that M2's session-policy registry consumes; M39 does not implement authentication, does not mint sessions, does not validate passkey assertions.
- **Decide RBAC.** Module 3 owns the role catalog, the per-role permission grants, the named-predicate registry mechanics, and the authorization decision engine. M39 declares the fifteen permission keys it contributes (§4.6), registers the eleven predicate resolvers it owns (§4.7), and obeys M3's decision. M39 never queries the role table directly; it always asks M3.
- **Authenticate the patient or caregiver into the portal.** Module 31 owns the patient/family portal session. M31 consults M39 (`evaluate('portal_access', sessionContext)`) on every login and every PHI-bearing route within the session, but M31 owns the session lifecycle; M39 emits the m39.consent.revoked event and M31's session-terminator subscribes.
- **Authenticate external collaborators or magic-link recipients.** Module 2 owns the magic-link mint surface (per M2 §1.1 four session classes); M39 records the underlying consent (e.g., a recipient-class `Specialty Pharmacy` named in a `hipaa_release` consent record) but does not issue or validate magic links.
- **Own the patient's privacy flag.** Module 5 owns `patient.privacy_flag_snapshot`. M39 publishes `m39.consent.signed` and `m39.consent.revoked`; M5 subscribes and recomputes the snapshot per M5 D10. The flag is a derived projection; the consent record is the source of truth.
- **Store the PDF bytes of signed consents.** Module 22 owns documents — bytes, MinIO objects, signed URLs, retention class, intake extraction. M39 stores the `consent_document_link` join row (consent_record_id ↔ document_id + version_id); M22 holds the PDF. M39 emits `m39.consent.signed` and M22's `m39-consent-document-render-requested.ts` consumer renders.
- **Own the hospice election statement, Notice of Rights, Notice of Privacy Practices acknowledgment, F2F attestation, certification of terminal illness, or revocation form.** Module 6 owns the regulatory state of the hospice relationship and the compliance artifacts that go with it. M6 may consult M39 (`sud_disclosure_allowed`) when rendering an election statement narrative that mentions an SUD diagnosis, but the election-statement record itself is M6's; the NPP acknowledgment is M6's; the F2F attestation is M6's.
- **Own the bereavement plan, the outreach schedule, the bereaved-contact roster, the risk score.** Module 16 owns the 13-month bereavement program and every workflow within it. M39 owns the `bereavement_outreach_consent` consent type and the consent-record state; M16 holds the `bereaved_contact.consent_record_id` FK and runs the schedule.
- **Own the advance directive form itself (POLST/MOLST/AD).** Module 22 owns the form template (`code_status_directive` per M22 D14 template catalog); M5/M7 hold the `code_status_directive_doc_ref` FK on the patient/care-plan rows; M39 owns the `advance_directive_acknowledgment` consent record proving the patient was offered, reviewed, and signed-or-declined the directive at admission. The directive is the artifact; the acknowledgment is the consent that the artifact exists and is current.
- **Own the IRB study definition or the research protocol.** The agency's research-participation relationship to an IRB-approved study is recorded as a `research_participation` consent record per study × per patient; the IRB itself, the protocol document, the study lifecycle, the consent-form revision pipeline are out of scope for M39 (a future Research Studies module would own those; v1 supports recording the per-patient consent against a free-text study identifier + the IRB-approved consent-form document version reference).
- **Mint, validate, or store the OAuth scope a SMART-on-FHIR app uses to access a patient's data.** Module 28 (FHIR Gateway) owns the SMART OAuth client model, the scope grammar, and the bearer-token validation. M28 consults M39 (`evaluateForDisclosure(patientId, recipientClientId, asOf)`) on every egress; M28 owns the OAuth surface; M39 owns the consent that gates the disclosure.
- **Run AI rewrites or LLM evaluations of consent records.** Module 32 owns model selection and prompt registry. M39 surfaces no AI-derived consent state, no LLM-generated consent narrative, no AI-suggested-recipient additions. `validateM39AIBlock` at boot refuses any M32 prompt template that would mutate consent state or evaluate consent (D17). M32 may, on read-only paths, surface consent-state-aware advisories ("Patient has SUD consent for HIE recipient X only; do not include OB recipient Y") via the `ConsentStateAdvisoryProvider` seam M39 publishes — but the LLM cannot create, modify, revoke, or override a consent record.
- **Be a "rules engine" for arbitrary consent logic.** M39 ships ten typed consent types with typed scope discriminators (D2). The custom-consent-type slot is bounded: a tenant can add a compliance-officer-curated additional consent type with a typed scope and a typed expiration policy, but cannot create arbitrary conditional logic; ABAC composition is M3's mechanics, not M39's, and M3's architecture is "named typed predicates, not a generic rules engine" (M3 D5).
- **Decide authorization.** Module 3 decides; Module 39 declares permissions (§4.6), exposes ABAC predicates (§4.7), and obeys the answer.

### 1.3 Regulatory & Operational Drivers

| Driver | Requirement | How Module 39 satisfies it |
|---|---|---|
| **HIPAA §164.508 — Authorization for uses and disclosures** | Written authorization required for uses/disclosures of PHI beyond TPO; specific content elements (description, recipient, purpose, expiration, revocation rights, signature) | The `hipaa_release` consent type's TypeBox payload requires every §164.508(c)(1) content element (description, named recipient, purpose, expiration_at, signature_evidence, revocation_notice_acknowledged); `consent_record_recipient` row enumerates named recipients; capture-method `electronic_portal_signature` or `typed_signature_in_app` or `uploaded_signed_pdf` proves the signature; the M22 rendered PDF is the §164.508(c)(2) writing |
| **HIPAA §164.524 — Right of Access** | Patient may obtain copy of PHI | M5 owns the right-of-access export workflow; M39's role is to verify (via `evaluate('hipaa_release', sessionContext)`) that any third-party-delivery destination is named in an active consent record before M5's workflow ships PHI off-perimeter |
| **HIPAA §164.526 — Right to amend** | Statement of disagreement attaches to subsequent disclosures | Out-of-scope for M39; M5 owns the amendment workflow; M22 renders the Statement of Disagreement; M39 may receive a `consent.recipient_disclosure_attempted` audit row when the M22 disclosure subsetter notices an attempted disclosure was blocked because no consent named the recipient |
| **HIPAA §164.508(c)(1)(iv) — Description of revocation rights** | Authorization must describe revocation procedure | The M22 `consent_record` template (M22 D14) includes the platform-floor revocation notice text rendered into every signed consent PDF; tenant overlay may add jurisdictional language but cannot remove (M22 D16 golden-template-diff validator) |
| **HIPAA §164.508(b)(5) — Revocation in writing** | Patient may revoke at any time in writing | `consent.revoke` route accepts patient-side (via M31 portal) or staff-side (with documented patient writing per the captured revocation reason ≥ 40 chars + uploaded revocation evidence document); `m39.consent.revoked` event cascades per D7 |
| **HIPAA §164.508(c)(2) — Authorization documentation** | Provider must obtain and retain written authorization for 6 years | `consent_document_link` to M22 signed PDF; `compliance` retention class with 7-year HIPAA §164.530(j)(2) floor per M4 D1 (the 7-year hospice extension supersedes the 6-year §164.508 floor); state overrides via M4 retention-override hook |
| **42 CFR §2.11 — SUD record confidentiality** | SUD-treatment records require heightened access controls | M39 evaluates `sud_disclosure_allowed` (named predicate) which returns true only when an active, on-file `42_cfr_part_2_release` consent record names the requesting recipient with an unexpired effective window |
| **42 CFR §2.31 — Consent for SUD disclosure** | Specific written consent required; per-recipient; per-purpose; explicit revocation rights | `42_cfr_part_2_release` consent type with per-recipient (`consent_record_recipient`) join; the TypeBox payload requires every §2.31 content element (patient name, recipient name, kind+amount of information, purpose, period covered, signature, date, revocation notice statement); capture-method enforced |
| **42 CFR §2.32 — Prohibition on re-disclosure** | "Federal law protects ... may not be re-disclosed" notice required on every disclosure | M22 renders the §2.32 notice on every PDF rendered against a `42_cfr_part_2_release` consent record; M28 FHIR Gateway includes the §2.32 notice in `Bundle.text.div` for any resource subset disclosed under a §2.31 consent; M39 publishes the platform-floor notice text constant |
| **42 CFR §2.13 — Heightened access** | Even within a treating provider, SUD records subject to heightened access | M5 owns the `patient.privacy_flag_snapshot` derived from M39 state; M3's `sud_disclosure_allowed` predicate (resolved by M39) gates SUD-flagged content at the route level on every consuming module |
| **State advance directive statutes** (varies — OR, WA, CA, etc.) | Per-state form validity; per-state witness requirements; per-state revocation procedure | `advance_directive_acknowledgment` consent records carry a `jurisdiction_code` field (M38 value set); per-state addendum is the M22 template-overlay mechanism per M22 D16; M39 does not embed state logic, it references the captured-at-time jurisdiction |
| **State DPOA statutes** | Per-state DPOA execution requirements (witness signatures, notarization, capacity attestation) | The `dpoa_healthcare` capture-method may require `notarized` (D4) per tenant policy; per-state additional fields land on the `consent_record_dpoa_agent` row's `state_specific_jsonb` per the platform-tighten-only pattern |
| **CMS hospice CoP 418.52 — Patient rights** | Written NoR; written NPP; patient acknowledgment | M6 owns the NoR + NPP acknowledgment workflow; M39 does not duplicate (the acknowledgment is a M6 compliance artifact, not a patient-authorized consent in the §164.508 sense); architecture v0.11 §11 M39 description called this out — "election form is now in M6" — and the v0.2 spec respects that boundary |
| **CMS hospice CoP 418.78(b) — Volunteer compliance** | Volunteer must pass background check etc. before patient-facing activity | Out-of-scope for M39; M15 owns volunteer compliance gates; M39's role is to record a `volunteer_confidentiality_agreement` consent record only when the volunteer is also a *patient's family member* whose access is governed by `family_caregiver_access` |
| **HHS Guidance on post-death consent transfer (2017)** | Patient consent does not transfer to surviving family; family-side consents must be separately captured | D13 + D14: patient's own consents terminate on death-discharge (except `family_caregiver_access` if `survives_death=true` at capture); `bereavement_outreach_consent` is a separate consent type captured post-death with the bereaved person as grantor |
| **ONC §170.315(b)(10) — Consent management certification criterion** | Cures Act §4001 information-blocking exceptions require provider-tracked patient consent for certain disclosures | M39's per-recipient consent model + version chain + signed-PDF artifact + evaluate-time audit row provides the §170.315(b)(10) certification basis; M28 FHIR Gateway's OperationOutcome surfacing per M28 D3 closes the information-blocking exception loop |

### 1.4 Competitive Context

Legacy hospice EHRs (Homecare Homebase, WellSky Hospice & Palliative, MatrixCare, Axxess, Netsmart MyUnity) all carry some form of "consent on file" tracking, but each suffers from one or more of these well-documented operational pains, which Module 39 is explicitly designed to avoid:

- **"Consent on file" as a boolean checkbox.** The legacy pattern is a single yes/no on the patient record ("HIPAA consent on file") with no recipient, no expiration, no scope, no version history. M39 ships ten typed consent types with typed scope discriminators, explicit recipients per consent, platform-floored expiration, and append-only version chains.
- **No SUD-specific consent surface.** Most legacy systems treat 42 CFR Part 2 as a "privacy flag" set manually on the patient record, with no per-recipient consent enumeration and no auditable proof of compliance with §2.31's specific-content-elements rule. M39 ships a per-recipient `42_cfr_part_2_release` consent record with TypeBox-validated payload covering every §2.31 content element and the §2.32 re-disclosure notice rendered on every PDF.
- **No version history on consent edits.** Legacy systems UPDATE the consent record in-place when the patient changes recipients or expiration — losing the audit narrative required by an OCR breach investigation. M39 is append-only with explicit supersession chains and consent-version-aware evaluation: a query at `asOf` reconstructs the consent state on any past date.
- **No revocation cascade.** When a patient revokes consent, the typical legacy system flips the boolean and trusts downstream surfaces to honor the change "on next access" — leaving active portal sessions running, in-flight FHIR queries serving data, scheduled disclosures rendering PDFs. M39 publishes typed revocation events with idempotent per-consumer handlers; the cascade is operative within seconds and audit-visible.
- **DPOA stored as free text.** Legacy systems store "Healthcare DPOA: Mary Smith, daughter" as a narrative field on the patient row. M39 ships `consent_record_dpoa_agent` rows enumerating the named agent + alternates, the activation condition, the per-agent scope, and the per-agent term, with self-referential validation preventing chicken-and-egg failures.
- **Bereavement consent treated as a clinical chart note.** Legacy systems lump post-death family communication preferences into the clinical narrative on the bereavement program record. M39 ships `bereavement_outreach_consent` as a first-class consent type captured post-death with the bereaved person as grantor; M16's `bereaved_contact.consent_record_id` FK is the regulatory artifact.
- **Consent-decision provenance (distinct from §164.528 disclosure accounting — M39-F03).** M39's `consent_eval_audit` table captures every `evaluate()` call with the consent-record-id and the version-at-eval, partitioned monthly — so a Compliance Officer can reconstruct *what the system knew about consent on date X when staff accessed record Y*. **This is a consent-DECISION audit, not the HIPAA §164.528 accounting-of-disclosures feeder.** §164.528 records *actual disclosures* (date, recipient, purpose, description) at each egress boundary and is owned by **Module 4**; the **disclosing** module (M28/M22/M05/M29/M32) writes that record at the point of disclosure (ADR-0013). Consent evaluation fires on internal access too, and not every disclosure traverses an M39 `evaluate()` — so `consent_eval_audit` can be neither the sole nor the authoritative §164.528 source.

Module 39 is intentionally **not** trying to be a general-purpose consent management platform (Datavant, OneTrust, Verily, etc. occupy that space for enterprise). M39 is the ChartWarden-shaped consent layer: tightly integrated with the platform's outbox, seam registry, ABAC predicate registry, audit, retention, and document-rendering infrastructure; designed for the ten consent types hospice operationally requires; bounded to leave room for the heavier patterns the cross-tenant federation layer (Phase 2) will add.

-----

## 2. Domain Model

### 2.1 Entity-Relationship Diagram

```
                       ┌──────────────────────────────┐
                       │  consent_type_catalog        │  platform-shared
                       │  (10 v1 types + custom slot) │  (dual-grant: PLATFORM
                       │  type_key (PK)               │   write, anyone read)
                       │  scope_discriminator         │
                       │  default_expiration_policy   │
                       │  capture_method_floor[]      │
                       │  reminder_cadence_floor[]    │
                       │  revocation_cascade_kind     │
                       │  is_per_recipient            │
                       │  is_per_named_agent          │
                       │  is_post_mortem_eligible     │
                       └──────────┬───────────────────┘
                                  │ FK type_key
                                  │
            ┌─────────────────────┼─────────────────────────────┐
            │                     │                             │
            ▼                     ▼                             ▼
  ┌────────────────────┐  ┌──────────────────────┐  ┌─────────────────────────┐
  │ tenant_consent_    │  │ consent_record       │  │ consent_renewal_cycle   │
  │ type_overlay       │  │ (the entity; one     │  │ (one per expiring or    │
  │ (per-org tighten)  │  │  per-execution row)  │◀─│  expired record)        │
  │ organization_id    │  │ id (UUIDv7)          │  │ source_consent_record_id│
  │ type_key           │  │ organization_id      │  │ status                  │
  │ tighter_expiration │  │ patient_id           │  │ cycle_started_at        │
  │ tighter_capture[]  │  │ type_key             │  │ next_action_due_at      │
  │ tighter_reminders[]│  │ scope_descriptor jsonb│  │ closed_at               │
  └────────────────────┘  │ grantor_kind         │  │ resolved_consent_       │
                          │ grantor_user_id?     │  │   record_id             │
                          │ grantor_caregiver_id?│  └─────────────────────────┘
                          │ acting_consent_id?   │
                          │ effective_at         │
                          │ expires_at?          │
                          │ status               │  one-to-many recipients
                          │ supersedes_consent_  │◀─────────────────────────┐
                          │   record_id?         │                          │
                          │ superseded_at?       │                ┌─────────┴──────────┐
                          │ revoked_at?          │                │ consent_record_    │
                          │ revoked_via_id?      │                │ recipient          │
                          │ renewed_from_consent_│                │ id                 │
                          │   record_id?         │                │ consent_record_id  │
                          │ capture_method       │                │ recipient_kind     │
                          │ capture_evidence_jsonb│               │ recipient_entity_  │
                          │ jurisdiction_code?   │                │   id (M40 FK)      │
                          │ survives_death       │                │ recipient_free_text│
                          │ language_code?       │                │ purpose_code (M38) │
                          │ created_at           │                │ purpose_free_text  │
                          │ created_by_id        │                │ expires_at?        │
                          │ updated_at           │                │ added_at           │
                          │ version              │                │ added_by_id        │
                          └───────┬──────────────┘                │ removed_at?        │
                                  │                               │ removed_by_id?     │
                                  │                               └────────────────────┘
                                  │ one-to-many DPOA agents
                                  ▼
                          ┌────────────────────────┐
                          │ consent_record_dpoa_   │
                          │ agent                  │
                          │ id                     │
                          │ consent_record_id      │
                          │ agent_kind (primary    │
                          │   | alternate_1        │
                          │   | alternate_2)       │
                          │ agent_name             │
                          │ agent_relationship     │
                          │ agent_contact_jsonb    │
                          │ agent_external_        │
                          │   physician_id? (M40)  │
                          │ activation_condition   │
                          │ scope_kind             │
                          │ term_kind              │
                          │ term_until?            │
                          │ state_specific_jsonb   │
                          │ added_at               │
                          │ removed_at?            │
                          └────────────────────────┘

  ┌────────────────────────────┐         ┌─────────────────────────────────┐
  │ consent_revocation         │         │ delegated_access                │
  │ (one row per explicit      │         │ (projection from                │
  │  revocation event)         │         │  family_caregiver_access)       │
  │ id                         │         │ id                              │
  │ consent_record_id          │         │ consent_record_id               │
  │ revoked_at                 │         │ recipient_id (consent_record_   │
  │ revoked_by_kind            │         │   recipient.id)                 │
  │ revoked_by_id              │         │ delegate_user_id?               │
  │ reason_text                │         │ delegate_caregiver_id           │
  │ evidence_document_id (M22)?│         │ scope_kind                      │
  │ cascade_status             │         │ effective_from                  │
  │ cascade_completed_at?      │         │ effective_until?                │
  └────────────────────────────┘         │ portal_session_class            │
                                         │ revoked_at?                     │
  ┌────────────────────────────┐         └─────────────────────────────────┘
  │ consent_expiration_        │
  │ reminder                   │         ┌─────────────────────────────────┐
  │ id                         │         │ consent_document_link           │
  │ consent_record_id          │         │ consent_record_id (PK)          │
  │ reminder_kind (90d/30d/    │         │ document_id (M22)               │
  │   14d/7d/1d)               │         │ document_version_id (M22)       │
  │ scheduled_for              │         │ rendered_at                     │
  │ fired_at?                  │         │ template_version                │
  │ delivery_channel           │         └─────────────────────────────────┘
  │ recipient_resolution       │
  │ idempotency_key            │         ┌─────────────────────────────────┐
  └────────────────────────────┘         │ consent_eval_audit              │
                                         │ (partitioned monthly; high vol) │
                                         │ id (UUIDv7)                     │
                                         │ organization_id                 │
                                         │ patient_id                      │
                                         │ consent_record_id?              │
                                         │ consent_version_at_eval         │
                                         │ type_key                        │
                                         │ recipient_resolved_id?          │
                                         │ allowed                         │
                                         │ deny_reason?                    │
                                         │ as_of                           │
                                         │ caller_module                   │
                                         │ caller_route                    │
                                         │ session_class                   │
                                         │ session_id?                     │
                                         │ membership_id?                  │
                                         │ redacted_categories[]           │
                                         │ evaluated_at                    │
                                         └─────────────────────────────────┘
```

The diagram captures the eleven owned tables. The platform-shared `consent_type_catalog` is the dual-grant pattern from M40 §3.6 — PLATFORM-scope writes only, anyone-read within the tenant. The append-only-with-supersession pattern (D1) is visible in `consent_record.supersedes_consent_record_id` (self-FK). The chain-of-authority pattern (D5) is visible in `consent_record.acting_consent_id` (self-FK pointing at the consent record that proves the grantor's authority). The renewal-vs-supersession distinction (D13) is preserved: supersession is mid-life scope edits; renewal is end-of-life re-capture.

### 2.2 Per-Entity Lifecycle

#### 2.2.1 `consent_record.status`

```
                 createDraft
                     │
                     ▼
                 ┌────────┐
                 │ draft  │ ──── discardDraft ──────────────────┐
                 └────┬───┘                                     │
                      │ sign (capture-method dependent)         ▼
                      ▼                                     [deleted]
                 ┌────────┐
                 │ active │ ────── editScope (supersede) ──┐
                 └───┬────┘                                 │
                     │                                      ▼
                     │                              ┌──────────────┐
                     │   ┌────── revoke (D7) ─────▶│  superseded  │
                     │   │                          └──────────────┘
                     │   │
                     ▼   ▼
                 ┌────────────┐         renew (D13)
                 │  revoked   │ ◀───── if applicable for type
                 └────────────┘
                     ▲
                     │ tick(expires_at < now)
                     │
                 ┌────────────┐
                 │  expired   │
                 └────────────┘
```

- **`draft`** — captured-but-unsigned; the route layer creates a draft when staff opens the consent-capture wizard or when a patient-portal session begins the flow. Drafts auto-expire after 30 days unless tenant tightens (the platform-floor is 30 days per D8). **M39-F13 / ARCH-250 / OPEN-020 — draft TTL is a UX/housekeeping TTL only:** drafts in the `draft` state carry no signed PHI consent (no signature has been collected; `signed_at` is NULL; `effective_at` has no regulatory force). The 30-day auto-expire is therefore a housekeeping boundary — abandoned wizard sessions are cleaned up, not regulatory consent records. It is **NOT** a §24 / `compliance`-class retention-class commitment; the `compliance` retention class (7-year floor per D20) attaches **only** to rows whose `status` has advanced to `active` (i.e., post-sign). Dropped drafts are deleted, not archived under a retention class; their deletion is not gated by M4 legal-hold or destruction-cert workflows. This distinction must be preserved in any tenant overlay that shortens the 30-day window — shortening is allowed; treating the window as a retention floor is not.
- **`active`** — signed; `effective_at` is in the past; `expires_at` (if set) is in the future; `superseded_at` is NULL; `revoked_at` is NULL. The vast majority of `evaluate()` queries match against rows in this state.
- **`expired`** — `expires_at` is in the past. Tick-driven; the `consent_expiration_cron` worker (hourly) walks rows whose `expires_at < now()` AND `status='active'` and transitions to `expired`. Emits `m39.consent.expired`.
- **`superseded`** — a newer consent record exists that points at this one via `supersedes_consent_record_id`. The newer record is `active`; the older row stays alive for survey reconstruction.
- **`revoked`** — explicit revocation occurred; `revoked_at` is non-NULL; `revoked_via_id` points at the `consent_revocation` row carrying the actor + reason + cascade-status. Cascade may be in-progress; the M39 `consent_revocation_cascade_cron` worker (every 30s) sweeps `cascade_status='in_progress'` rows and re-fires per-consumer handlers idempotently until all consumers ACK.

Invariants:
- Exactly one of `{superseded_at, revoked_at, expires_at-reached-and-ticked}` may transition an `active` row out of `active`.
- A `draft` row cannot have `supersedes_consent_record_id` set — supersession is a sign-time act, not a draft-time act.
- A `revoked` row cannot be un-revoked; the only forward path from `revoked` is via a brand-new consent record (which may have `renewed_from_consent_record_id` pointing at the revoked row if the patient re-grants the same scope; the renewal chain is distinct from the supersession chain).

#### 2.2.2 `consent_record_recipient` lifecycle (per-recipient consents only)

```
       addRecipient                     removeRecipient
           │                                  │
           ▼                                  ▼
       ┌───────┐                       ┌──────────┐
       │ added │ ───── still active ──▶│ removed  │
       └───────┘  expires_at < now()   └──────────┘
                            │
                            ▼
                       ┌────────┐
                       │expired │
                       └────────┘
```

Per-recipient additions emit `m39.consent.recipient_added`; removals emit `m39.consent.recipient_removed`. Adding a recipient to an `active` consent record does NOT supersede the consent record itself — the recipient list is mutable independently of the consent scope (D6). Removing the last active recipient on a per-recipient consent leaves the consent record `active` with zero recipients; the evaluate path returns `allowed=false reason='no_active_recipient_matches'` until a recipient is added (or until the consent record itself is revoked).

#### 2.2.3 `consent_revocation.cascade_status`

```
                  emitRevocationEvent
                         │
                         ▼
                  ┌──────────────┐  per-consumer handlers ACK
                  │ in_progress  │ ──────────────────────────────┐
                  └──────┬───────┘                                ▼
                         │                              ┌─────────────────┐
                         │ retry budget exhausted       │   completed     │
                         ▼                              └─────────────────┘
                  ┌──────────────┐
                  │ partial_     │ ── alert M36 ──▶ Compliance Officer
                  │ failed       │
                  └──────────────┘
```

The cascade handler set per consent type is enumerated in §4.4. Each consumer ACKs idempotently on `(consent_record_id, revocation_id, consumer_name)`. Retry budget is 5 attempts over 1 hour with exponential backoff (M1 outbox helper); on exhaustion the row transitions to `partial_failed` and an alert fires (`m39.consent.revoked_cascade_failed`, severity `critical`).

### 2.3 Validation Rules

| Rule | Where | Detail |
|---|---|---|
| `consent_record.type_key` must exist in `consent_type_catalog` | FK | platform-shared seed must include all ten v1 types |
| `consent_record.scope_descriptor` must conform to the TypeBox schema bound to `type_key` | service | per-type discriminated union; service validates on draft + on sign |
| `consent_record.grantor_kind='dpoa_healthcare_agent'` ⇒ `acting_consent_id` references an `active` consent record of type `dpoa_healthcare` whose DPOA-agent rows include the acting user; `acting_consent_id` cannot equal the row being signed | service + DB constraint | D5 chain-of-authority validation prevents chicken-and-egg |
| `consent_record.grantor_kind='court_guardian'` ⇒ `acting_consent_id` references a court-guardianship consent record OR a `dpoa_court_appointed` consent record OR the route requires step-up + uploaded court-order evidence document | service | per-state-statute variability accepted via state_specific_jsonb |
| `consent_record.grantor_kind='parent_for_minor'` ⇒ patient's age at `effective_at` < age-of-majority in `jurisdiction_code` (per M38 lookup); transitions to invalid (returns `allowed=false reason='grantor_authority_expired_on_majority'` from `evaluate()`) when patient ages out | service + evaluate-time check | M5 carries DOB; M38 carries per-jurisdiction age-of-majority |
| `consent_record.grantor_kind='bereaved_person_self'` only valid for `type_key='bereavement_outreach_consent'`; patient must be deceased at `effective_at`; grantor_caregiver_id must match an M16 `bereaved_contact` row | service | D14 post-mortem semantics |
| `consent_record.survives_death=true` only valid for `type_key IN ('family_caregiver_access', 'media_release', 'research_participation')`; for all other types the evaluate path returns `allowed=false reason='consent_terminated_on_death'` post-death | service + evaluate-time | D13 HHS post-death-no-transfer guidance |
| `consent_record_recipient.recipient_entity_id` FK must match `recipient_kind` (e.g., `recipient_kind='external_physician'` ⇒ M40 `external_physician.id`; `recipient_kind='facility'` ⇒ M40 `facility.id`; `recipient_kind='pharmacy'` ⇒ M40 `pharmacy.id`); `recipient_kind='free_text'` allows null FK with required `recipient_free_text ≥ 5 chars` | service + discriminated FK check | M40 MdmEntityProvider seam |
| `consent_record.capture_method ∈ consent_type_catalog.capture_method_floor[]` AND ∈ tenant_overlay tighter set if present | service | D4 + D8 tenant-tighten-only |
| `consent_record.capture_method='notarized'` ⇒ `capture_evidence_jsonb.notary_certificate_document_id` references an M22 uploaded document | service | high-stakes types may require notarization |
| `consent_record.capture_method='witnessed_verbal_documented'` ⇒ `capture_evidence_jsonb.witness_name` (≥2 chars) + `capture_evidence_jsonb.witness_attestation_text` (≥20 chars) + `capture_evidence_jsonb.witness_signature_evidence_document_id` (M22 doc ref) | service | last-resort capture method; permitted only for code-status/AD acknowledgment with documented patient incapacity |
| `consent_record.supersedes_consent_record_id` ⇒ superseded row.type_key matches; superseded row.patient_id matches; superseded row.organization_id matches; superseded row.status='active' at supersession time | service + DB CHECK | D1 supersession invariant |
| `consent_record.renewed_from_consent_record_id` ⇒ renewed-from row.type_key matches; renewed-from row.patient_id matches; renewed-from row.status ∈ {'expired', 'revoked'} | service + DB CHECK | D13 renewal-vs-supersession distinction |
| `consent_revocation.reason_text ≥ 40 chars` when `revoked_by_kind='staff'`; ≥ 0 chars when `revoked_by_kind='patient_self_via_portal'` (patient is not required to justify) | service + DB CHECK | balances accountability and patient rights |
| `consent_record.effective_at ≤ now()` at sign time (no future-dated signatures) | service | clinical-safety + audit clarity |
| `consent_record.expires_at` (if set) > `effective_at`; (expires_at − effective_at) ≤ platform-floor max from `consent_type_catalog.max_term_seconds` | service | per-type term ceiling |
| `consent_record_dpoa_agent.agent_kind='primary'` exactly one per consent record; `alternate_1` at most one; `alternate_2` at most one | partial unique indexes | exhaustive coverage of D5 |
| optimistic locking via `consent_record.version int notnull default 0`; PATCH must send `If-Match: <version>`; mismatch → 412 | route preHandler + service | matches M7/M16 pattern |
| `consent_eval_audit` is INSERT-only; trigger refuses UPDATE/DELETE except via M4 retention sweep partition drop | DB trigger | D12 audit immutability |

### 2.4 Side-Effects (Events Emitted)

Every state transition above emits the indicated outbox event. The full outbox catalog is in §4.4. Per-event idempotency is the M1 outbox helper's; per-route idempotency is the `Idempotency-Key` header.

**Cross-module consent-derived side-effects (D7 revocation cascade — typed per consent type):**

| Revoked type | Cascade handlers | Effect |
|---|---|---|
| `portal_access` | M2 (session terminate), M31 (forward-stub today) | active portal sessions for this patient/caregiver terminated; push notifications stopped; magic-link tokens invalidated |
| `family_caregiver_access` | M2 (session terminate filtered to delegate_caregiver_id), M31 (portal scope removal), M16 (per-bereaved-contact opt-out cascade if survives_death=true), M17 (portal-upcoming scope check), M18 (coordinate disclosure block), M19 (caregiver-initiated triage block), M36 (channel-membership removal for bereavement channel if relevant) | named family member's portal scope removed; bereavement channel membership revoked; subsequent portal hits return scope-denied |
| `42_cfr_part_2_release` | M5 (privacy_flag_snapshot recompute), M22 (signed-URL revocation for affected disclosed documents), M28 (FHIR client re-bind for next query), M11/M12/M13 (downstream consumer caches invalidated) | SUD-content disclosures blocked from this point forward; past disclosures audited under §164.528 |
| `dpoa_healthcare` | M7 (acting-consent revalidation across all care-plan signatures), M11 (acting-consent revalidation on active orders), M14 (IDG cosign-attribution recompute), M22 (chart-writeback DPOA-attribution recompute) | decision-making authority returns to patient or alternate agent; the alternate-1 agent (if active and uncontested) becomes the new primary by `consent_record_dpoa_agent.agent_kind='primary'` swap on next renewal; until renewal, evaluate returns `allowed=false reason='primary_dpoa_revoked'` for any path requiring `dpoa_active` predicate |
| `media_release` | M22 (locate and tag prior-rendered media artifacts as `disclosure_restricted=true`), M33 (reporting view filter), M28 (FHIR DocumentReference filter) | future media uses blocked; past media-release audits surface in §164.528 |
| `research_participation` | M30 (quality measure denominator-exclusion if patient was in a study cohort), M28 (FHIR research subject status update for ResearchSubject resource Phase 2) | study participation ends; downstream study data retention follows IRB-approved protocol independently |
| `telehealth_consent` | M8 (block future telehealth-encounter signing for this patient until re-captured), M36 (telehealth channel close) | not retroactive for past telehealth encounter records |
| `advance_directive_acknowledgment` | M5 (privacy_flag_snapshot recompute for AD-on-file flag), M7 (care-plan AD-banner clear) | rare; typically only happens when patient changes mind and provides new directive |
| `hipaa_release` | M22 (per-recipient signed-URL revocation), M28 (per-recipient FHIR client rebind), M5 (right-of-access export workflow blocks named recipient) | per-recipient cascade is the same shape as `42_cfr_part_2_release` minus the SUD-specific re-disclosure-notice path |
| `bereavement_outreach_consent` | M16 (per-bereaved-contact opt-out cascade) | per M16 §2.6 D6 |

**Other side effects:**
- **Privacy flag snapshot recompute (D-M5 interaction).** Any `m39.consent.signed` or `m39.consent.revoked` on a consent type whose presence affects M5's `patient.privacy_flag_snapshot` (i.e., `42_cfr_part_2_release`) emits a snapshot-recompute event consumed by M5.
- **Reminder cron fires.** The `consent_expiration_reminder_cron` (hourly) walks `consent_record.expires_at` against the platform-floor 90/30/14/7/1 day window; inserts `consent_expiration_reminder` rows; emits `m39.consent.expiring_soon` per-reminder with platform-floor M36 alert routing.
- **Renewal cycle opens.** When the first 30-day reminder fires AND no `consent_renewal_cycle` exists for this consent record, M39 inserts the cycle row; emits `m39.consent.renewal_cycle_opened`; the cycle stays open until either (a) a new consent record signed with `renewed_from_consent_record_id=<this row>`; or (b) the consent record expires without renewal (cycle closes with `closed_reason='expired_without_renewal'`).
- **DelegatedAccess projection refresh.** Sign or supersede on a `family_caregiver_access` consent record refreshes `delegated_access` rows transactionally.

-----

## 3. Drizzle Schema

### 3.1 Package Layout

```
apps/backend/src/modules/39-consent/
├── routes/
│   ├── consents.ts                    # POST/PATCH/GET on consent_record + lifecycle commands
│   ├── recipients.ts                  # POST/DELETE on consent_record_recipient
│   ├── dpoa-agents.ts                 # POST/PATCH on consent_record_dpoa_agent
│   ├── revocations.ts                 # POST revoke; GET revocation cascade status
│   ├── renewals.ts                    # GET expiring; POST renew (creates new consent referencing prior)
│   ├── delegated-access.ts            # GET projection; consumed by M31 forward seam
│   ├── catalog.ts                     # GET consent_type_catalog + tenant overlay
│   ├── overlays.ts                    # POST/PATCH tenant_consent_type_overlay (org-admin only)
│   ├── eval-audit.ts                  # GET consent_eval_audit (Compliance Officer surface)
│   └── readers.ts                     # GET surfaces for M5/M22/M28/M30/M33 (via seams in services)
├── services/
│   ├── consent-record-service.ts      # sign / supersede / revoke
│   ├── consent-evaluator.ts           # the seam implementation (4 query methods)
│   ├── consent-type-resolver.ts       # platform-floor + tenant-tighten merge
│   ├── recipient-service.ts           # add/remove recipient
│   ├── dpoa-agent-service.ts          # primary/alternate management
│   ├── revocation-service.ts          # cascade emit + handler tracking
│   ├── renewal-service.ts             # cycle open/close + renew action
│   ├── delegated-access-projector.ts  # rebuild projection on consent change
│   ├── eval-auditor.ts                # synchronous audit-insert on every evaluate()
│   ├── m22-render-emitter.ts          # emit m39.consent.signed → M22 render
│   ├── m22-document-backref.ts        # consume m22.document.rendered → stamp consent_document_link
│   ├── chain-of-authority-validator.ts # D5 self-FK chicken-and-egg refusal
│   ├── post-mortem-gate.ts            # D13 patient.deceased semantics
│   ├── abac-predicates.ts             # 11 named predicates registered with M3
│   ├── ai-block-validator.ts          # D17 boot-time check vs M32 prompt registry
│   └── eraser.ts                      # M4 destruction-cert eraseFn
├── workers/
│   ├── expiration-reminder.cron.ts    # hourly: walk expires_at within 90/30/14/7/1d window
│   ├── consent-expiration.cron.ts     # hourly: walk expires_at < now() → expired transition
│   ├── revocation-cascade-retry.cron.ts # every 30s: re-fire stuck cascades
│   ├── renewal-cycle-close.cron.ts    # nightly: close cycles whose source expired without renewal
│   ├── draft-auto-expire.cron.ts      # daily: discard drafts older than 30 days
│   └── eval-audit-partition.cron.ts   # nightly: rotate next-month partition
├── consumers/
│   ├── m22-document-rendered.ts       # m22.document.rendered (consent_record template only)
│   ├── m5-patient-deceased.ts         # m5.patient.deceased → invalidate non-survives-death consents
│   ├── m5-patient-merged.ts           # m5.patient.merged → re-point consent_record.patient_id
│   ├── m5-amendment-denied.ts         # no-op today; reserved for future per-amendment consent
│   ├── m4-legal-hold-applied.ts       # extend retention via M4 hold mechanism
│   ├── m4-legal-hold-released.ts      # release retention extension
│   └── m4-destruction-cert-signed.ts  # M4-driven eraser invocation
└── boot.ts                            # seam registration + predicate registration + AI block validator
```

### 3.2 Enums

```sql
CREATE TYPE consent_type_key AS ENUM (
  'portal_access',
  'dpoa_healthcare',
  'dpoa_financial',
  'family_caregiver_access',
  '42_cfr_part_2_release',
  'media_release',
  'research_participation',
  'telehealth_consent',
  'advance_directive_acknowledgment',
  'hipaa_release',
  'bereavement_outreach_consent',
  'custom'                            -- tenant-extensible slot per D2
);

CREATE TYPE consent_scope_discriminator AS ENUM (
  'categorical',
  'per_recipient',
  'per_named_agent',
  'per_encounter'
);

CREATE TYPE consent_status AS ENUM (
  'draft',
  'active',
  'superseded',
  'revoked',
  'expired'
);

CREATE TYPE consent_grantor_kind AS ENUM (
  'patient_self',
  'dpoa_healthcare_agent',
  'dpoa_financial_agent',
  'court_guardian',
  'parent_for_minor',
  'healthcare_surrogate',
  'bereaved_person_self'
);

CREATE TYPE consent_capture_method AS ENUM (
  'electronic_portal_signature',
  'typed_signature_in_app',
  'uploaded_signed_pdf',
  'witnessed_verbal_documented',
  'notarized'
);

CREATE TYPE consent_recipient_kind AS ENUM (
  'external_physician',
  'facility',
  'pharmacy',
  'irb',
  'family_member',
  'attorney',
  'employer',
  'researcher',
  'free_text'
);

CREATE TYPE consent_revocation_actor_kind AS ENUM (
  'patient_self_via_portal',
  'staff',
  'dpoa_agent',
  'court_order',
  'platform_admin_break_glass'
);

CREATE TYPE consent_revocation_cascade_status AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'partial_failed'
);

CREATE TYPE consent_reminder_kind AS ENUM (
  '90_days',
  '30_days',
  '14_days',
  '7_days',
  '1_day'
);

CREATE TYPE consent_renewal_cycle_status AS ENUM (
  'open',
  'renewed',
  'closed_expired',
  'closed_revoked',
  'closed_no_longer_applicable'
);

CREATE TYPE consent_dpoa_agent_kind AS ENUM (
  'primary',
  'alternate_1',
  'alternate_2'
);

CREATE TYPE consent_dpoa_activation_condition AS ENUM (
  'immediate',
  'upon_incapacity_attested',
  'upon_physician_determination',
  'upon_incompetence_court_order'
);

CREATE TYPE consent_dpoa_scope_kind AS ENUM (
  'healthcare_full',
  'healthcare_end_of_life_only',
  'financial_narrow',
  'financial_broad'
);

CREATE TYPE consent_dpoa_term_kind AS ENUM (
  'indefinite',
  'until_date',
  'event_driven'
);

CREATE TYPE consent_delegated_access_scope AS ENUM (
  'view_only_minimal',          -- name + DOB + active flag only
  'view_only_full',             -- full clinical record read
  'view_and_message',           -- read + M36 channel participation
  'view_message_and_decisions'  -- read + message + DPOA-tier decisions if DPOA active
);
```

### 3.3 Tables

```typescript
// packages/domain/consent/schema.ts
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, primaryKey, uniqueIndex, index, foreignKey, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// 1) consent_type_catalog — platform-shared dual-grant pattern (M40 §3.6)
export const consent_type_catalog = pgTable('consent_type_catalog', {
  type_key:                       consentTypeKey('type_key').primaryKey(),
  display_name_en:                text('display_name_en').notNull(),
  scope_discriminator:            consentScopeDiscriminator('scope_discriminator').notNull(),
  default_expiration_seconds:     integer('default_expiration_seconds'),   // null = indefinite
  max_term_seconds:               integer('max_term_seconds'),             // platform-floor ceiling
  capture_method_floor:           text('capture_method_floor').array().notNull(),  // consent_capture_method[]
  reminder_cadence_floor:         text('reminder_cadence_floor').array().notNull(),// consent_reminder_kind[]
  revocation_cascade_kind:        text('revocation_cascade_kind').notNull(),
  is_per_recipient:               boolean('is_per_recipient').notNull(),
  is_per_named_agent:             boolean('is_per_named_agent').notNull(),
  is_post_mortem_eligible:        boolean('is_post_mortem_eligible').notNull(),
  requires_jurisdiction_code:     boolean('requires_jurisdiction_code').notNull(),
  cfr_42_part_2_compliant:        boolean('cfr_42_part_2_compliant').notNull(),
  hipaa_164_508_compliant:        boolean('hipaa_164_508_compliant').notNull(),
  body_text_template_key:         text('body_text_template_key').notNull(),  // M22 form-template key
  m22_template_version:           text('m22_template_version').notNull(),
  created_at:                     timestamp('created_at').notNull().defaultNow(),
  updated_at:                     timestamp('updated_at').notNull().defaultNow(),
})

// 2) tenant_consent_type_overlay — per-org tighten-only
export const tenant_consent_type_overlay = pgTable('tenant_consent_type_overlay', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  type_key:                       consentTypeKey('type_key').notNull().references(() => consent_type_catalog.type_key),
  tighter_expiration_seconds:     integer('tighter_expiration_seconds'),    // ≤ catalog default
  tighter_capture_methods:        text('tighter_capture_methods').array(),  // subset of floor
  tighter_reminder_cadence:       text('tighter_reminder_cadence').array(), // superset of floor (more reminders, not fewer)
  state_addendum_text:            text('state_addendum_text'),              // non-loosening
  jurisdiction_code_required:     boolean('jurisdiction_code_required'),    // tenant may tighten true; can't relax false
  published_at:                   timestamp('published_at'),
  published_by_id:                uuid('published_by_id'),
  created_at:                     timestamp('created_at').notNull().defaultNow(),
  updated_at:                     timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  uniqOrgType: uniqueIndex('uq_tcto_org_type').on(t.organization_id, t.type_key),
}))

// 3) consent_record — the entity; append-only with supersession
export const consent_record = pgTable('consent_record', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  patient_id:                     uuid('patient_id').notNull(),
  type_key:                       consentTypeKey('type_key').notNull().references(() => consent_type_catalog.type_key),
  scope_descriptor:               jsonb('scope_descriptor').notNull(),
  grantor_kind:                   consentGrantorKind('grantor_kind').notNull(),
  grantor_user_id:                uuid('grantor_user_id'),
  grantor_caregiver_id:           uuid('grantor_caregiver_id'),
  grantor_relationship_text:      text('grantor_relationship_text'),
  acting_consent_id:              uuid('acting_consent_id'),    // self-FK; D5 chain-of-authority
  effective_at:                   timestamp('effective_at').notNull(),
  expires_at:                     timestamp('expires_at'),
  status:                         consentStatus('status').notNull().default('draft'),
  supersedes_consent_record_id:   uuid('supersedes_consent_record_id'),
  superseded_at:                  timestamp('superseded_at'),
  superseded_by_consent_record_id: uuid('superseded_by_consent_record_id'),
  revoked_at:                     timestamp('revoked_at'),
  revoked_via_id:                 uuid('revoked_via_id'),
  renewed_from_consent_record_id: uuid('renewed_from_consent_record_id'),
  capture_method:                 consentCaptureMethod('capture_method').notNull(),
  capture_evidence_jsonb:         jsonb('capture_evidence_jsonb').notNull(),
  jurisdiction_code:              text('jurisdiction_code'),
  language_code:                  text('language_code'),
  survives_death:                 boolean('survives_death').notNull().default(false),
  internal_notes_cipher:          text('internal_notes_cipher'),   // PHI; encrypted via per-tenant DEK
  created_at:                     timestamp('created_at').notNull().defaultNow(),
  created_by_id:                  uuid('created_by_id').notNull(),
  signed_at:                      timestamp('signed_at'),
  signed_by_id:                   uuid('signed_by_id'),
  updated_at:                     timestamp('updated_at').notNull().defaultNow(),
  version:                        integer('version').notNull().default(0),
}, (t) => ({
  selfSupersedeFk: foreignKey({ columns: [t.supersedes_consent_record_id], foreignColumns: [t.id] }),
  selfRenewalFk:  foreignKey({ columns: [t.renewed_from_consent_record_id], foreignColumns: [t.id] }),
  selfActingFk:   foreignKey({ columns: [t.acting_consent_id], foreignColumns: [t.id] }),
  selfSupersededByFk: foreignKey({ columns: [t.superseded_by_consent_record_id], foreignColumns: [t.id] }),
  patientTypeStatusIdx: index('ix_cr_patient_type_status').on(t.organization_id, t.patient_id, t.type_key, t.status),
  expiringSoonIdx: index('ix_cr_expiring_soon').on(t.expires_at).where(sql`status = 'active' AND expires_at IS NOT NULL`),
  activeByPatientIdx: index('ix_cr_active_by_patient').on(t.organization_id, t.patient_id).where(sql`status = 'active'`),
  selfNoCycleCheck: check('cr_no_self_supersede', sql`supersedes_consent_record_id <> id`),
  selfNoCycleActingCheck: check('cr_no_self_acting', sql`acting_consent_id <> id`),
  selfNoCycleRenewalCheck: check('cr_no_self_renewal', sql`renewed_from_consent_record_id <> id`),
  expiresAfterEffective: check('cr_expires_after_effective', sql`expires_at IS NULL OR expires_at > effective_at`),
  superseded_status_consistent: check('cr_superseded_consistent',
    sql`(status <> 'superseded') OR (superseded_at IS NOT NULL AND superseded_by_consent_record_id IS NOT NULL)`),
  revoked_status_consistent: check('cr_revoked_consistent',
    sql`(status <> 'revoked') OR (revoked_at IS NOT NULL AND revoked_via_id IS NOT NULL)`),
  signed_status_consistent: check('cr_signed_consistent',
    sql`(status = 'draft') OR (signed_at IS NOT NULL AND signed_by_id IS NOT NULL)`),
}))

// 4) consent_record_recipient — M:N for per-recipient consents
export const consent_record_recipient = pgTable('consent_record_recipient', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  consent_record_id:              uuid('consent_record_id').notNull().references(() => consent_record.id),
  recipient_kind:                 consentRecipientKind('recipient_kind').notNull(),
  recipient_entity_id:            uuid('recipient_entity_id'),    // M40 FK by kind; service validates
  recipient_free_text:            text('recipient_free_text'),
  recipient_resolved_display_name: text('recipient_resolved_display_name').notNull(),
  purpose_code:                   text('purpose_code'),           // M38 value set ref
  purpose_free_text:              text('purpose_free_text'),
  expires_at:                     timestamp('expires_at'),
  added_at:                       timestamp('added_at').notNull().defaultNow(),
  added_by_id:                    uuid('added_by_id').notNull(),
  removed_at:                     timestamp('removed_at'),
  removed_by_id:                  uuid('removed_by_id'),
  removed_reason_text:            text('removed_reason_text'),
}, (t) => ({
  consentIdx: index('ix_crr_consent').on(t.consent_record_id),
  activeByConsentIdx: index('ix_crr_active_by_consent').on(t.consent_record_id).where(sql`removed_at IS NULL`),
  resolvedEntityIdx: index('ix_crr_resolved_entity').on(t.recipient_kind, t.recipient_entity_id).where(sql`removed_at IS NULL`),
  freeTextOrEntity: check('crr_freetext_or_entity',
    sql`(recipient_kind = 'free_text' AND recipient_entity_id IS NULL AND recipient_free_text IS NOT NULL)
     OR (recipient_kind <> 'free_text' AND recipient_entity_id IS NOT NULL)`),
}))

// 5) consent_record_dpoa_agent — named agents for DPOA records
export const consent_record_dpoa_agent = pgTable('consent_record_dpoa_agent', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  consent_record_id:              uuid('consent_record_id').notNull().references(() => consent_record.id),
  agent_kind:                     consentDpoaAgentKind('agent_kind').notNull(),
  agent_name:                     text('agent_name').notNull(),
  agent_relationship:             text('agent_relationship').notNull(),
  agent_contact_jsonb:            jsonb('agent_contact_jsonb').notNull(),
  agent_external_physician_id:    uuid('agent_external_physician_id'),  // M40 FK if agent is a physician
  agent_user_id:                  uuid('agent_user_id'),                // if agent is a system user
  agent_caregiver_id:             uuid('agent_caregiver_id'),           // if agent is in M5 caregiver table
  activation_condition:           consentDpoaActivationCondition('activation_condition').notNull(),
  activation_evidence_jsonb:      jsonb('activation_evidence_jsonb'),   // physician determination doc; court order; etc.
  scope_kind:                     consentDpoaScopeKind('scope_kind').notNull(),
  term_kind:                      consentDpoaTermKind('term_kind').notNull(),
  term_until:                     timestamp('term_until'),
  state_specific_jsonb:           jsonb('state_specific_jsonb'),        // per-state DPOA statute fields
  added_at:                       timestamp('added_at').notNull().defaultNow(),
  added_by_id:                    uuid('added_by_id').notNull(),
  removed_at:                     timestamp('removed_at'),
  removed_by_id:                  uuid('removed_by_id'),
}, (t) => ({
  consentIdx: index('ix_crda_consent').on(t.consent_record_id),
  primaryUniq: uniqueIndex('uq_crda_primary').on(t.consent_record_id).where(sql`agent_kind = 'primary' AND removed_at IS NULL`),
  alt1Uniq:    uniqueIndex('uq_crda_alt1').on(t.consent_record_id).where(sql`agent_kind = 'alternate_1' AND removed_at IS NULL`),
  alt2Uniq:    uniqueIndex('uq_crda_alt2').on(t.consent_record_id).where(sql`agent_kind = 'alternate_2' AND removed_at IS NULL`),
  termConsistent: check('crda_term_consistent',
    sql`(term_kind <> 'until_date') OR (term_until IS NOT NULL)`),
}))

// 6) consent_revocation — explicit revocation event
export const consent_revocation = pgTable('consent_revocation', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  consent_record_id:              uuid('consent_record_id').notNull().references(() => consent_record.id),
  revoked_at:                     timestamp('revoked_at').notNull().defaultNow(),
  revoked_by_kind:                consentRevocationActorKind('revoked_by_kind').notNull(),
  revoked_by_user_id:             uuid('revoked_by_user_id'),
  revoked_by_caregiver_id:        uuid('revoked_by_caregiver_id'),
  reason_text:                    text('reason_text').notNull(),
  evidence_document_id:           uuid('evidence_document_id'),  // M22 doc ref; required for staff revocation
  cascade_status:                 consentRevocationCascadeStatus('cascade_status').notNull().default('pending'),
  cascade_started_at:             timestamp('cascade_started_at'),
  cascade_completed_at:           timestamp('cascade_completed_at'),
  cascade_consumer_status_jsonb:  jsonb('cascade_consumer_status_jsonb').notNull().default(sql`'{}'::jsonb`),
  step_up_evidence_id:            uuid('step_up_evidence_id'),
  audit_event_id:                 uuid('audit_event_id'),
}, (t) => ({
  consentIdx: index('ix_cr_revocation_consent').on(t.consent_record_id),
  cascadeStuckIdx: index('ix_cr_revocation_cascade_stuck').on(t.cascade_status, t.cascade_started_at)
    .where(sql`cascade_status IN ('pending', 'in_progress')`),
  staffReasonFloor: check('cr_revocation_staff_reason_floor',
    sql`revoked_by_kind <> 'staff' OR length(reason_text) >= 40`),
  staffEvidenceRequired: check('cr_revocation_staff_evidence',
    sql`revoked_by_kind <> 'staff' OR evidence_document_id IS NOT NULL`),
}))

-- continued next chunk...
```

```typescript
// 7) consent_expiration_reminder — fired-reminder log
export const consent_expiration_reminder = pgTable('consent_expiration_reminder', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  consent_record_id:              uuid('consent_record_id').notNull().references(() => consent_record.id),
  reminder_kind:                  consentReminderKind('reminder_kind').notNull(),
  scheduled_for:                  timestamp('scheduled_for').notNull(),
  fired_at:                       timestamp('fired_at'),
  delivery_channel:               text('delivery_channel').notNull(),       // 'm36_alert' | 'm36_email' | 'm36_inapp'
  recipient_resolution_jsonb:     jsonb('recipient_resolution_jsonb').notNull(),
  idempotency_key:                text('idempotency_key').notNull(),
  m36_alert_id:                   uuid('m36_alert_id'),
}, (t) => ({
  uniqIdem: uniqueIndex('uq_cer_idem').on(t.idempotency_key),
  pendingIdx: index('ix_cer_pending').on(t.scheduled_for).where(sql`fired_at IS NULL`),
  consentIdx: index('ix_cer_consent').on(t.consent_record_id),
}))

// 8) delegated_access — projection from family_caregiver_access consent
export const delegated_access = pgTable('delegated_access', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  patient_id:                     uuid('patient_id').notNull(),
  consent_record_id:              uuid('consent_record_id').notNull().references(() => consent_record.id),
  consent_record_recipient_id:    uuid('consent_record_recipient_id').notNull().references(() => consent_record_recipient.id),
  delegate_user_id:               uuid('delegate_user_id'),
  delegate_caregiver_id:          uuid('delegate_caregiver_id').notNull(),
  scope_kind:                     consentDelegatedAccessScope('scope_kind').notNull(),
  effective_from:                 timestamp('effective_from').notNull(),
  effective_until:                timestamp('effective_until'),
  portal_session_class:           text('portal_session_class').notNull(),     // 'caregiver_portal' | 'bereaved_portal'
  revoked_at:                     timestamp('revoked_at'),
  refreshed_at:                   timestamp('refreshed_at').notNull().defaultNow(),
}, (t) => ({
  patientCaregiverIdx: index('ix_da_patient_caregiver').on(t.patient_id, t.delegate_caregiver_id)
    .where(sql`revoked_at IS NULL`),
  activeByPatientIdx: index('ix_da_active_by_patient').on(t.organization_id, t.patient_id)
    .where(sql`revoked_at IS NULL AND (effective_until IS NULL OR effective_until > now())`),
}))

// 9) consent_document_link — back-ref to M22 PDF
export const consent_document_link = pgTable('consent_document_link', {
  consent_record_id:              uuid('consent_record_id').primaryKey().references(() => consent_record.id),
  organization_id:                uuid('organization_id').notNull(),
  document_id:                    uuid('document_id').notNull(),       // M22 FK; app-side only
  document_version_id:            uuid('document_version_id').notNull(),
  template_version:               text('template_version').notNull(),
  rendered_at:                    timestamp('rendered_at').notNull().defaultNow(),
}, (t) => ({
  docIdx: index('ix_cdl_document').on(t.document_id),
}))

// 10) consent_eval_audit — INSERT-only; partitioned monthly
// schema is created without partitioning declared via Drizzle; the migration script
// (§3.4) does CREATE TABLE ... PARTITION BY RANGE (evaluated_at) and creates monthly partitions
export const consent_eval_audit = pgTable('consent_eval_audit', {
  id:                             uuid('id').notNull(),       // composite PK with evaluated_at
  organization_id:                uuid('organization_id').notNull(),
  patient_id:                     uuid('patient_id').notNull(),
  consent_record_id:              uuid('consent_record_id'),
  consent_version_at_eval:        integer('consent_version_at_eval'),
  type_key:                       consentTypeKey('type_key').notNull(),
  recipient_resolved_kind:        text('recipient_resolved_kind'),
  recipient_resolved_id:          uuid('recipient_resolved_id'),
  allowed:                        boolean('allowed').notNull(),
  deny_reason:                    text('deny_reason'),
  as_of:                          timestamp('as_of').notNull(),
  caller_module:                  text('caller_module').notNull(),
  caller_route:                   text('caller_route'),
  session_class:                  text('session_class'),
  session_id:                     uuid('session_id'),
  membership_id:                  uuid('membership_id'),
  redacted_categories:            text('redacted_categories').array(),
  evaluated_at:                   timestamp('evaluated_at').notNull().defaultNow(),
}, (t) => ({
  // composite PK including partition key
  pk: primaryKey({ columns: [t.id, t.evaluated_at] }),
  patientTypeIdx: index('ix_cea_patient_type').on(t.organization_id, t.patient_id, t.type_key, t.evaluated_at),
  callerIdx: index('ix_cea_caller').on(t.caller_module, t.caller_route, t.evaluated_at),
  recordIdx: index('ix_cea_record').on(t.consent_record_id, t.evaluated_at),
}))

// 11) consent_renewal_cycle — cycle from expiration approach to re-capture
export const consent_renewal_cycle = pgTable('consent_renewal_cycle', {
  id:                             uuid('id').primaryKey().defaultRandom(),
  organization_id:                uuid('organization_id').notNull(),
  source_consent_record_id:       uuid('source_consent_record_id').notNull().references(() => consent_record.id),
  patient_id:                     uuid('patient_id').notNull(),
  status:                         consentRenewalCycleStatus('status').notNull().default('open'),
  cycle_started_at:               timestamp('cycle_started_at').notNull().defaultNow(),
  next_action_due_at:             timestamp('next_action_due_at'),
  closed_at:                      timestamp('closed_at'),
  closed_reason:                  text('closed_reason'),
  resolved_consent_record_id:     uuid('resolved_consent_record_id').references(() => consent_record.id),
  assigned_to_membership_id:      uuid('assigned_to_membership_id'),
}, (t) => ({
  sourceUniq: uniqueIndex('uq_crc_source_open').on(t.source_consent_record_id)
    .where(sql`status = 'open'`),
  openByPatientIdx: index('ix_crc_open_by_patient').on(t.organization_id, t.patient_id)
    .where(sql`status = 'open'`),
}))
```

### 3.4 Migration `0039_consent.sql` (Outline)

```sql
BEGIN;

-- 1. Enums (per §3.2)
CREATE TYPE consent_type_key AS ENUM (...);
-- ... all 14 enums

-- 2. Tables (per §3.3); RLS enabled inline via the M1 generator
SELECT install_table('consent_type_catalog', 'platform_shared');  -- dual-grant
SELECT install_table('tenant_consent_type_overlay', 'org_scoped');
SELECT install_table('consent_record', 'org_scoped');
SELECT install_table('consent_record_recipient', 'org_scoped');
SELECT install_table('consent_record_dpoa_agent', 'org_scoped');
SELECT install_table('consent_revocation', 'org_scoped');
SELECT install_table('consent_expiration_reminder', 'org_scoped');
SELECT install_table('delegated_access', 'org_scoped');
SELECT install_table('consent_document_link', 'org_scoped');
SELECT install_table('consent_renewal_cycle', 'org_scoped');

-- 3. consent_eval_audit — partitioned by month
CREATE TABLE consent_eval_audit (
  -- columns per §3.3 #10
)
PARTITION BY RANGE (evaluated_at);

-- Create rolling 3-month + current + next 3-month partitions (6 total)
SELECT create_monthly_partitions('consent_eval_audit', interval '3 months', interval '3 months');

-- Daily partition rotation cron registered with M1's partition-maintenance job

-- 4. Write-audit triggers via M4 generator
SELECT install_write_audit('consent_record', '{internal_notes_cipher,scope_descriptor,capture_evidence_jsonb}');
SELECT install_write_audit('consent_record_recipient', '{purpose_free_text,recipient_free_text}');
SELECT install_write_audit('consent_record_dpoa_agent', '{agent_contact_jsonb,activation_evidence_jsonb,state_specific_jsonb}');
SELECT install_write_audit('consent_revocation', '{reason_text}');
SELECT install_write_audit('delegated_access', '{}');     -- no PHI free-text columns
-- consent_eval_audit is INSERT-only — NO write-audit trigger (the audit table itself);
-- M4's audit-of-audit covers cross-tenant reads of this table per M4 §11.D11

-- 5. INSERT-only trigger on consent_eval_audit
CREATE OR REPLACE FUNCTION consent_eval_audit_immutability() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_eval_audit is INSERT-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cea_immutable
  BEFORE UPDATE OR DELETE ON consent_eval_audit
  FOR EACH ROW EXECUTE FUNCTION consent_eval_audit_immutability();

-- 6. Platform-shared seed of the 11 v1 consent types into consent_type_catalog
-- (handled by packages/consent/seeds/v1-types.sql; idempotent INSERT...ON CONFLICT)

-- 7. Eraser registration via M4
-- M39-F04 / ADR-0251 (ARCH-234): the eraser registers under the DATA-CLASS key the M4 boot
-- validator expects (`consent`), NOT `consent_record_subtree`. The function name keeps its
-- descriptive identifier; only the registration key is the data class.
SELECT m4_register_eraser('consent', 'consent', 'apps/backend/src/modules/39-consent/services/eraser.ts:eraseConsentSubtree');

-- 8. Retention class registration
SELECT m4_register_retention_class('consent', 7 * 365 * 24 * 3600, true);  -- 7y, state-overridable

-- 9. Partial unique indexes per §3.3
-- (already in Drizzle schema; created here for compactness)

-- 10. Forward-seam deny-stub for M31 portal-session-terminator
-- (no DB change; deny-stub is in seam-stubs/m31-portal-session-terminator.ts)

COMMIT;
```

### 3.5 RLS

Every M39 tenant table has `organization_id NOT NULL` and RLS via M1's `install_rls_org_scoped()` generator. The `consent_type_catalog` table uses M40's dual-grant pattern (M40 §3.6): PLATFORM-scope writes only; anyone-read within the tenant via `current_setting('app.tenant_scope') IN ('PLATFORM','PLATFORM_RO','TENANT')`.

Extra ABAC overlay (applied at route layer, not as RLS):
- `consent_record.internal_notes_cipher` decryption requires `consent.read_phi_content` permission + `consent_owner_or_compliance` ABAC pass.
- Per-recipient consents' downstream evaluations consult the named-predicate registry (M39's eleven resolvers per §4.7).
- Reads of `consent_eval_audit` require `consent.read_eval_audit` permission (typically Compliance Officer or Privacy Officer); cross-tenant reads via auditor session class require break-glass per M4 D-cross-tenant-audit-read.

### 3.6 Partition Strategy

`consent_eval_audit` is partitioned monthly. Rolling window: 3 months retained on hot storage; older months migrated to cold (Phase-2 — Phase-1 keeps everything hot since volume is bounded by `evaluate()` call count). Partition creation is driven by the M1 partition-maintenance cron registered at boot via `m1.register_partition_strategy('consent_eval_audit', 'monthly', 6)`.

### 3.7 Trigger Catalog

| Table | Trigger | Purpose |
|---|---|---|
| `consent_record` | `trg_cr_set_signed_audit_event` | On UPDATE that transitions `status` from `draft → active`, write the `audit_event_id` linkage to the matching audit row created in the same transaction |
| `consent_record` | `trg_cr_supersede_consistency` | On INSERT with `supersedes_consent_record_id IS NOT NULL`, UPDATE the superseded row's `superseded_at = now()`, `superseded_by_consent_record_id = NEW.id`, `status = 'superseded'` — in the same transaction (D1 invariant) |
| `consent_record` | `trg_cr_chain_of_authority_validate` | On INSERT/UPDATE that sets `acting_consent_id`, validate the chain (§2.3 rule); reject with check-constraint-style error if invalid |
| `consent_record_recipient` | `trg_crr_touch_subsetter_dirty` | On INSERT/UPDATE that flips `removed_at`, maintain the derived `subsetter_dirty_at` column so the service layer knows the disclosure-subsetter cache for prior signed-URLs is stale. **Derived-column maintenance only — this trigger must NOT write `outbox_event`** (ARCH-144/264 / M39-F08). The `m39.consent.recipient_added`/`recipient_removed` outbox events are emitted by the service layer (routes 12/13 → `addRecipient`/`removeRecipient`) via the M1 outbox helper in the same transaction as the recipient write — see §4.5. |
| `consent_revocation` | `trg_revocation_set_cascade_status` | On INSERT, initialize the derived `cascade_status='pending'` + stamp `cascade_payload_kind` (the per-consent-type cascade descriptor) for the service layer to read. **Derived-column maintenance only — this trigger must NOT write `outbox_event`** (ARCH-144/264 / M39-F08). The canonical `m39.consent.revoked` event is emitted by the service layer (route 10/27 → `revokeConsent`) via the M1 outbox helper in the same transaction as the `consent_revocation` INSERT — see §4.5. |
| `consent_eval_audit` | `trg_cea_immutable` | DENY UPDATE/DELETE; enforces D12 invariant |
| `delegated_access` | `trg_da_refresh_on_consent_change` (deferred constraint trigger) | When the source consent_record_recipient changes, the projector service updates this row; this trigger only verifies the consent_record_recipient is still active or the row is marked revoked (defense-in-depth) |

### 3.8 Eraser Registration

Per M4 destruction-cert workflow + D20:

```typescript
// apps/backend/src/modules/39-consent/services/eraser.ts
import { registerEraser } from '@chartwarden/audit/eraser-registry'
import { db } from '@chartwarden/foundation/db'
import { consent_record, consent_record_recipient, consent_record_dpoa_agent,
         consent_revocation, consent_expiration_reminder, delegated_access,
         consent_document_link, consent_eval_audit, consent_renewal_cycle } from '@chartwarden/domain/consent/schema'

export async function eraseConsentSubtree(args: {
  patientId: string,
  organizationId: string,
  legalHoldOverride: boolean
}): Promise<{ rowsDeleted: number, retainedClasses: readonly string[] }> {
  // 1. Refuse if any consent record on this patient has an active legal hold
  if (!args.legalHoldOverride) {
    const heldRows = await db.select().from(consent_record)
      .innerJoin(legal_hold_assignment, /* M4 join */)
      .where(/* patient + hold-active */)
    if (heldRows.length > 0) {
      return { rowsDeleted: 0, retainedClasses: ['consent_held_by_legal_hold'] }
    }
  }
  // 2. M39-F04 / ADR-0251 (ARCH-234): consent_eval_audit is IMMUTABLE audit (INSERT-only,
  //    enforced by trg_cea_immutable). The eraser MUST NOT DELETE FROM it. Its destruction is
  //    routed through M4's audit-partition retention/destruction-cert workflow (the partitioned
  //    audit table is owned by the M4 retention sweep + destruction certificate, NOT by this
  //    domain eraser). We hand M4 the patient scope so the audit partitions are destroyed under
  //    the certified audit-retention path, and assert no DELETE crosses the immutable boundary here.
  await m4.auditPartitionRetention.scheduleEvalAuditDestruction({
    table: 'consent_eval_audit',
    patientId: args.patientId,
    organizationId: args.organizationId,
  })
  // 3. Delete the projection table (delegated_access)
  await db.delete(delegated_access).where(/* patient + org */)
  // 4. Delete the satellite tables in FK order
  await db.delete(consent_renewal_cycle).where(/* patient + org */)
  await db.delete(consent_expiration_reminder).where(/* via consent_record join */)
  await db.delete(consent_revocation).where(/* via consent_record join */)
  await db.delete(consent_record_dpoa_agent).where(/* via consent_record join */)
  await db.delete(consent_record_recipient).where(/* via consent_record join */)
  await db.delete(consent_document_link).where(/* via consent_record join */)
  // 5. Finally delete the consent records (in supersession-chain order: leaves first)
  // The chain-walker walks from leaf to root via the self-FK
  const deletedConsent = await deleteConsentChainLeavesFirst(args.patientId, args.organizationId)
  // 6. Total + return
  return { rowsDeleted: /* sum */ , retainedClasses: [] }
}

registerEraser('consent', eraseConsentSubtree)  // M39-F04: data-class key the M4 boot validator expects (was 'consent_record_subtree')
```

The eraser is called by M4's destruction-cert workflow when the patient's overall retention class transitions to `eligible_for_destruction`. Erasure is atomic per patient; partial failure rolls the entire patient back (M4 destruction-cert pattern).

-----

## 4. API Routes, Services, Seams & Events

### 4.1 Route Inventory

All routes mount at `/api/v1/consents/*` unless otherwise noted; portal-side routes mount at `/api/v1/portal/consents/*` and resolve under the portal session class.

| # | Method | Path | Permission | ABAC | Step-up | Returns |
|---|---|---|---|---|---|---|
| 1 | GET | `/api/v1/consent-types` | `consent.read_catalog` | — | no | catalog + applicable tenant overlay |
| 2 | POST | `/api/v1/consent-types/overlay` | `consent.manage_overlay` | `org_admin_or_compliance` | yes | overlay row |
| 3 | GET | `/api/v1/patients/:patientId/consents` | `consent.read` | `caseload_or_scope` | no | active consents + recipients + DPOA agents |
| 4 | GET | `/api/v1/consents/:consentId` | `consent.read` | `consent_owner_or_compliance` | no | full record + version chain |
| 5 | GET | `/api/v1/consents/:consentId/version-chain` | `consent.read_history` | `consent_owner_or_compliance` | no | superseded ancestors + renewed-from ancestors |
| 6 | POST | `/api/v1/patients/:patientId/consents` | `consent.author` | `caseload_or_scope` | no (draft) | draft consent_record |
| 7 | PATCH | `/api/v1/consents/:consentId` | `consent.author` | `is_consent_drafter` | no | updated draft (only `status='draft'` editable) |
| 8 | POST | `/api/v1/consents/:consentId/sign` | `consent.sign` | `is_consent_drafter` or `caseload_or_scope` | **yes** (consent_management profile) | signed consent_record; emits `m39.consent.signed` |
| 9 | POST | `/api/v1/consents/:consentId/supersede` | `consent.sign` | `caseload_or_scope` | **yes** | new consent_record pointing at this via supersedes_consent_record_id |
| 10 | POST | `/api/v1/consents/:consentId/revoke` | `consent.revoke` | `caseload_or_scope` or `compliance_officer` | **yes** (staff) / portal session (patient self) | consent_revocation row; emits `m39.consent.revoked` |
| 11 | GET | `/api/v1/consents/:consentId/recipients` | `consent.read` | `consent_owner_or_compliance` | no | active + historical recipients |
| 12 | POST | `/api/v1/consents/:consentId/recipients` | `consent.author` | `caseload_or_scope` | **yes** | new consent_record_recipient row |
| 13 | DELETE | `/api/v1/consents/:consentId/recipients/:recipientId` | `consent.author` | `caseload_or_scope` | **yes** | flips removed_at |
| 14 | GET | `/api/v1/consents/:consentId/dpoa-agents` | `consent.read` | `consent_owner_or_compliance` | no | active + historical DPOA agents |
| 15 | POST | `/api/v1/consents/:consentId/dpoa-agents` | `consent.author` | `caseload_or_scope` | **yes** | new consent_record_dpoa_agent row |
| 16 | PATCH | `/api/v1/consents/:consentId/dpoa-agents/:agentId` | `consent.author` | `caseload_or_scope` | **yes** | mutate scope_kind, term, activation_condition |
| 17 | GET | `/api/v1/patients/:patientId/dpoa/active-primary` | `consent.read` | `caseload_or_scope` | no | the active DPOA primary agent (consumed by M7/M11/M14) |
| 18 | GET | `/api/v1/patients/:patientId/expiring-consents` | `consent.read` | `caseload_or_scope` or `compliance_officer` | no | consents within 90-day window; cursor-paginated (M39-F14) |
| 19 | GET | `/api/v1/consents/:consentId/renewal-cycle` | `consent.read` | `consent_owner_or_compliance` | no | open + closed cycles |
| 20 | POST | `/api/v1/consents/:consentId/renew` | `consent.sign` | `caseload_or_scope` | **yes** | new consent_record with `renewed_from_consent_record_id=<this>` |
| 21 | GET | `/api/v1/patients/:patientId/delegated-access` | `consent.read` | `caseload_or_scope` | no | projection rows |
| 22 | GET | `/api/v1/consents/:consentId/eval-audit` | `consent.read_eval_audit` | `compliance_officer` or `privacy_officer` | no | partitioned audit query; cursor-paginated (M39-F14) |
| 23 | GET | `/api/v1/consents/eval-audit/by-patient` | `consent.read_eval_audit` | `compliance_officer` or `privacy_officer` | no | patient-scoped **consent-decision** audit (NOT §164.528 — that is M4's disclosure sink, ADR-0013); cursor-paginated (M39-F14) |
| 24 | POST | `/api/v1/consents/:consentId/document/re-render` | `consent.admin_re_render` | `compliance_officer` | **yes** | re-emit `m39.consent.signed` to force M22 re-render |
| 25 | GET | `/api/v1/portal/consents/active` | (portal session) | `portal_self_service` | no | patient or delegate's active consents |
| 26 | POST | `/api/v1/portal/consents/:consentId/sign` | (portal session) | `portal_self_service` | no (session class is its own auth posture) | signed consent_record |
| 27 | POST | `/api/v1/portal/consents/:consentId/revoke` | (portal session) | `portal_self_service` | no | consent_revocation row with `revoked_by_kind='patient_self_via_portal'` |
| 28 | GET | `/api/v1/consents/post-mortem-eligible/:patientId` | `consent.read` | `bereavement_window` or `caseload_or_scope` | no | M16-consumer view: which consents on this patient survive death |
| 29 | POST | `/api/v1/consents/bereavement-outreach` | `consent.bereavement_outreach_author` | `bereavement_window` | **yes** | dedicated route for post-mortem `bereavement_outreach_consent` creation |
| 30 | POST | `/api/v1/consents/:consentId/cascade/retry` | `consent.cascade_admin` | `compliance_officer` | **yes** | re-fire stuck revocation cascade handlers |

### 4.2 Representative TypeBox Schemas

```typescript
// apps/backend/src/modules/39-consent/routes/schemas.ts
import { Type } from '@sinclair/typebox'

// ----- Scope-descriptor discriminated unions (one per type_key) -----

export const ScopeDescriptor_PortalAccess = Type.Object({
  type: Type.Literal('portal_access'),
  channels_allowed: Type.Array(Type.Union([
    Type.Literal('in_app'), Type.Literal('email_summary'),
    Type.Literal('sms_reminders'), Type.Literal('push_notifications'),
  ]), { minItems: 1 }),
  patient_can_message_care_team: Type.Boolean(),
  patient_can_view_clinical_record: Type.Boolean(),
  patient_can_view_medication_administration_log: Type.Boolean(),
})

export const ScopeDescriptor_DpoaHealthcare = Type.Object({
  type: Type.Literal('dpoa_healthcare'),
  scope_kind: Type.Union([
    Type.Literal('healthcare_full'),
    Type.Literal('healthcare_end_of_life_only'),
  ]),
  hipaa_release_to_dpoa_included: Type.Boolean(),
  emergency_room_authority_included: Type.Boolean(),
})

export const ScopeDescriptor_FamilyCaregiverAccess = Type.Object({
  type: Type.Literal('family_caregiver_access'),
  caregiver_caregiver_id: Type.String({ format: 'uuid' }),
  caregiver_relationship: Type.String({ minLength: 2, maxLength: 50 }),
  scope_kind: Type.Union([
    Type.Literal('view_only_minimal'), Type.Literal('view_only_full'),
    Type.Literal('view_and_message'), Type.Literal('view_message_and_decisions'),
  ]),
  bereavement_window_extension: Type.Boolean(),
})

export const ScopeDescriptor_42CfrPart2Release = Type.Object({
  type: Type.Literal('42_cfr_part_2_release'),
  patient_acknowledged_redisclosure_prohibition: Type.Literal(true),
  patient_acknowledged_right_to_revoke: Type.Literal(true),
  scope_of_records: Type.String({ minLength: 20, maxLength: 4000 }),
  purpose_of_disclosure: Type.String({ minLength: 20, maxLength: 2000 }),
  applies_to_diagnosis_categories: Type.Array(Type.String(), { minItems: 1 }),
})

export const ScopeDescriptor_HipaaRelease = Type.Object({
  type: Type.Literal('hipaa_release'),
  description_of_information: Type.String({ minLength: 20, maxLength: 4000 }),
  purpose_of_disclosure: Type.String({ minLength: 20, maxLength: 2000 }),
  patient_acknowledged_right_to_revoke: Type.Literal(true),
  patient_acknowledged_right_to_inspect_copy: Type.Literal(true),
  patient_acknowledged_redisclosure_warning: Type.Literal(true),
})

export const ScopeDescriptor_MediaRelease = Type.Object({
  type: Type.Literal('media_release'),
  permitted_uses: Type.Array(Type.Union([
    Type.Literal('case_study_clinical'), Type.Literal('case_study_marketing'),
    Type.Literal('staff_training'), Type.Literal('agency_website'),
    Type.Literal('social_media'), Type.Literal('printed_materials'),
  ]), { minItems: 1 }),
  patient_image_included: Type.Boolean(),
  patient_voice_included: Type.Boolean(),
  patient_name_included: Type.Boolean(),
})

export const ScopeDescriptor_ResearchParticipation = Type.Object({
  type: Type.Literal('research_participation'),
  irb_study_identifier: Type.String({ minLength: 3, maxLength: 200 }),
  irb_consent_form_document_id: Type.String({ format: 'uuid' }),
  retention_after_study_end_years: Type.Integer({ minimum: 1, maximum: 25 }),
  data_categories_shared: Type.Array(Type.String(), { minItems: 1 }),
  withdrawal_rights_acknowledged: Type.Literal(true),
})

export const ScopeDescriptor_TelehealthConsent = Type.Object({
  type: Type.Literal('telehealth_consent'),
  patient_acknowledged_telehealth_risks: Type.Literal(true),
  patient_acknowledged_emergency_protocol: Type.Literal(true),
  per_encounter: Type.Boolean(),
  per_encounter_max_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

export const ScopeDescriptor_AdvanceDirectiveAcknowledgment = Type.Object({
  type: Type.Literal('advance_directive_acknowledgment'),
  ad_artifact_document_id: Type.String({ format: 'uuid' }),
  patient_has_provided_ad: Type.Boolean(),
  patient_decline_to_provide_ad: Type.Boolean(),
  reviewed_with_clinician_membership_id: Type.String({ format: 'uuid' }),
  jurisdiction_form_kind: Type.Union([
    Type.Literal('polst'), Type.Literal('molst'), Type.Literal('living_will'),
    Type.Literal('durable_power_of_attorney_health_combined'),
    Type.Literal('verbal_only_documented'),
  ]),
})

export const ScopeDescriptor_BereavementOutreachConsent = Type.Object({
  type: Type.Literal('bereavement_outreach_consent'),
  contact_channels_allowed: Type.Array(Type.Union([
    Type.Literal('phone_call'), Type.Literal('email'), Type.Literal('sympathy_card'),
    Type.Literal('anniversary_letter'), Type.Literal('sympathy_letter'),
    Type.Literal('portal_message'), Type.Literal('in_person_visit'),
  ]), { minItems: 1 }),
  preferred_address_kind: Type.Union([
    Type.Literal('decedent_home_address'),
    Type.Literal('bereaved_contact_own_address'),
    Type.Literal('alternate_address_provided'),
  ]),
  language_for_outreach: Type.String({ pattern: '^[a-z]{2}(-[A-Z]{2})?$' }),
})

export const ScopeDescriptor = Type.Union([
  ScopeDescriptor_PortalAccess, ScopeDescriptor_DpoaHealthcare,
  ScopeDescriptor_FamilyCaregiverAccess, ScopeDescriptor_42CfrPart2Release,
  ScopeDescriptor_HipaaRelease, ScopeDescriptor_MediaRelease,
  ScopeDescriptor_ResearchParticipation, ScopeDescriptor_TelehealthConsent,
  ScopeDescriptor_AdvanceDirectiveAcknowledgment, ScopeDescriptor_BereavementOutreachConsent,
])

// ----- Route schemas (selected) -----

export const CreateConsentDraftRequest = Type.Object({
  type_key: Type.Union([
    Type.Literal('portal_access'), Type.Literal('dpoa_healthcare'),
    Type.Literal('dpoa_financial'), Type.Literal('family_caregiver_access'),
    Type.Literal('42_cfr_part_2_release'), Type.Literal('media_release'),
    Type.Literal('research_participation'), Type.Literal('telehealth_consent'),
    Type.Literal('advance_directive_acknowledgment'), Type.Literal('hipaa_release'),
    Type.Literal('bereavement_outreach_consent'),
  ]),
  scope_descriptor: ScopeDescriptor,
  grantor_kind: Type.Union([
    Type.Literal('patient_self'), Type.Literal('dpoa_healthcare_agent'),
    Type.Literal('dpoa_financial_agent'), Type.Literal('court_guardian'),
    Type.Literal('parent_for_minor'), Type.Literal('healthcare_surrogate'),
    Type.Literal('bereaved_person_self'),
  ]),
  grantor_user_id: Type.Optional(Type.String({ format: 'uuid' })),
  grantor_caregiver_id: Type.Optional(Type.String({ format: 'uuid' })),
  grantor_relationship_text: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
  acting_consent_id: Type.Optional(Type.String({ format: 'uuid' })),
  effective_at: Type.String({ format: 'date-time' }),
  expires_at: Type.Optional(Type.String({ format: 'date-time' })),
  capture_method: Type.Union([
    Type.Literal('electronic_portal_signature'),
    Type.Literal('typed_signature_in_app'),
    Type.Literal('uploaded_signed_pdf'),
    Type.Literal('witnessed_verbal_documented'),
    Type.Literal('notarized'),
  ]),
  jurisdiction_code: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
  language_code: Type.Optional(Type.String({ pattern: '^[a-z]{2}(-[A-Z]{2})?$' })),
  survives_death: Type.Optional(Type.Boolean()),
  internal_notes_plaintext: Type.Optional(Type.String({ maxLength: 4000 })),
})

export const SignConsentRequest = Type.Object({
  capture_evidence: Type.Object({
    signed_at_iso: Type.String({ format: 'date-time' }),
    typed_signature_name: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    typed_signature_role: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
    portal_session_id: Type.Optional(Type.String({ format: 'uuid' })),
    uploaded_pdf_document_id: Type.Optional(Type.String({ format: 'uuid' })),
    witness_name: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    witness_attestation_text: Type.Optional(Type.String({ minLength: 20, maxLength: 4000 })),
    witness_signature_evidence_document_id: Type.Optional(Type.String({ format: 'uuid' })),
    notary_certificate_document_id: Type.Optional(Type.String({ format: 'uuid' })),
    step_up_evidence_id: Type.Optional(Type.String({ format: 'uuid' })),
  }),
})

export const RevokeConsentRequest = Type.Object({
  reason_text: Type.String({ minLength: 0, maxLength: 4000 }),
  evidence_document_id: Type.Optional(Type.String({ format: 'uuid' })),
})

export const AddRecipientRequest = Type.Object({
  recipient_kind: Type.Union([
    Type.Literal('external_physician'), Type.Literal('facility'),
    Type.Literal('pharmacy'), Type.Literal('irb'), Type.Literal('family_member'),
    Type.Literal('attorney'), Type.Literal('employer'),
    Type.Literal('researcher'), Type.Literal('free_text'),
  ]),
  recipient_entity_id: Type.Optional(Type.String({ format: 'uuid' })),
  recipient_free_text: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })),
  purpose_code: Type.Optional(Type.String()),
  purpose_free_text: Type.Optional(Type.String({ minLength: 5, maxLength: 2000 })),
  expires_at: Type.Optional(Type.String({ format: 'date-time' })),
})

export const AddDpoaAgentRequest = Type.Object({
  agent_kind: Type.Union([
    Type.Literal('primary'), Type.Literal('alternate_1'), Type.Literal('alternate_2'),
  ]),
  agent_name: Type.String({ minLength: 2, maxLength: 200 }),
  agent_relationship: Type.String({ minLength: 2, maxLength: 100 }),
  agent_contact: Type.Object({
    phone: Type.Optional(Type.String()),
    email: Type.Optional(Type.String({ format: 'email' })),
    address: Type.Optional(Type.Object({
      street: Type.String(), city: Type.String(), state: Type.String(), zip: Type.String(),
    })),
  }),
  agent_external_physician_id: Type.Optional(Type.String({ format: 'uuid' })),
  agent_user_id: Type.Optional(Type.String({ format: 'uuid' })),
  agent_caregiver_id: Type.Optional(Type.String({ format: 'uuid' })),
  activation_condition: Type.Union([
    Type.Literal('immediate'), Type.Literal('upon_incapacity_attested'),
    Type.Literal('upon_physician_determination'),
    Type.Literal('upon_incompetence_court_order'),
  ]),
  activation_evidence: Type.Optional(Type.Object({
    physician_attestation_document_id: Type.Optional(Type.String({ format: 'uuid' })),
    court_order_document_id: Type.Optional(Type.String({ format: 'uuid' })),
  })),
  scope_kind: Type.Union([
    Type.Literal('healthcare_full'), Type.Literal('healthcare_end_of_life_only'),
    Type.Literal('financial_narrow'), Type.Literal('financial_broad'),
  ]),
  term_kind: Type.Union([
    Type.Literal('indefinite'), Type.Literal('until_date'), Type.Literal('event_driven'),
  ]),
  term_until: Type.Optional(Type.String({ format: 'date-time' })),
  state_specific: Type.Optional(Type.Object({})),
})
```

### 4.3 The `ConsentEvaluator` Seam (Published)

This is the contract every downstream consumer imports. It lives at `packages/consent/src/seams/consent-evaluator.ts`:

```typescript
export interface ConsentEvaluator {
  /** General-purpose query used by every named ABAC predicate that gates on consent. */
  evaluate(args: {
    organizationId: string
    patientId: string
    consentType: ConsentTypeKey
    asOf?: string
    sessionContext: {
      sessionClass: SessionClass
      sessionId?: string
      membershipId?: string
      portalDelegateCaregiverId?: string
      recipientClientId?: string
    }
    callerModule: ModuleId
    callerRoute?: string
  }): Promise<{
    allowed: boolean
    consentRecordId?: string
    consentVersionAtEval?: number
    expiresAt?: string
    scopeDescriptor?: unknown
    denyReason?: ConsentDenyReason
  }>

  /** Specialized for disclosure paths (M28 FHIR, M22 disclosure subsetter, M27 cost report, M29 outbound HL7). */
  evaluateForDisclosure(args: {
    organizationId: string
    patientId: string
    recipientClientId?: string
    recipientResolvedKind?: RecipientResolvedKind
    recipientResolvedId?: string
    asOf?: string
    callerModule: ModuleId
    callerRoute?: string
  }): Promise<{
    allowed: boolean
    redactSudContent: boolean
    redactHivContent: boolean
    redactMentalHealthContent: boolean
    redactGeneticContent: boolean
    redactFamilyViolenceContent: boolean
    expiresAt?: string
    recipientScopeDescriptor?: unknown
    denyReason?: ConsentDenyReason
  }>

  /** Specialized for ingress paths (M29 inbound HL7 redaction per M29 D15). */
  evaluateForIngressRedaction(args: {
    organizationId: string
    patientId: string
    asOf?: string
    callerModule: ModuleId
    callerRoute?: string
  }): Promise<{
    redactSubstanceUseDisorderFields: boolean
    redactHivFields: boolean
    redactMentalHealthFields: boolean
    redactGeneticFields: boolean
    redactFamilyViolenceFields: boolean
  }>

  /** Bulk read for caseload-list paths (M5, M33, M30, M28 bulk export).
   *
   * M39-F15 / ARCH-110 — bulk FHIR egress eval-audit batching:
   * When `callerModule` is `'m28'` (FHIR Gateway bulk export) or any caller passing
   * `batchContext.recipientClientId`, `evaluateBulk` writes a SINGLE `consent_eval_audit`
   * row per (recipient × batch-request), not one row per resource or per patientId in the
   * batch. The single audit row carries:
   *   - `batch_patient_count` — how many patientIds were evaluated
   *   - `batch_allowed_count` / `batch_denied_count` — summary tallies
   *   - `recipient_resolved_kind` / `recipient_resolved_id` — the egress recipient
   *   - `caller_route` — identifies the bulk-export request (e.g., `$export` operation ID)
   *
   * This prevents the O(patients × resources) eval-audit fan-out that would arise if M28
   * called `evaluate()` or `evaluateForDisclosure()` once per FHIR resource in a bulk export.
   * Per-resource evaluation correctness is preserved (the method still evaluates each patientId
   * individually against the active consent record set); only the audit write is batched.
   *
   * Non-bulk callers (M5, M33, M30 caseload-list paths without a recipient context) write one
   * `consent_eval_audit` row per patientId in the batch as before (no change for those paths).
   */
  evaluateBulk(args: {
    organizationId: string
    patientIds: readonly string[]
    consentType: ConsentTypeKey
    asOf?: string
    callerModule: ModuleId
    callerRoute?: string
    /** Present on FHIR bulk-export paths; triggers batched eval-audit write (M39-F15). */
    batchContext?: {
      recipientClientId: string
      recipientResolvedKind?: RecipientResolvedKind
      recipientResolvedId?: string
      exportRequestId: string   // M28 $export operation ID; becomes the audit row's batch key
    }
  }): Promise<Map<string, {
    allowed: boolean
    consentRecordId?: string
    expiresAt?: string
    denyReason?: ConsentDenyReason
  }>>
}

export type ConsentDenyReason =
  | 'no_active_consent_on_file'
  | 'consent_expired'
  | 'consent_revoked'
  | 'consent_superseded_with_narrower_scope'
  | 'no_active_recipient_matches'
  | 'patient_deceased_consent_terminated'
  | 'patient_aged_out_parental_consent'
  | 'grantor_authority_expired'
  | 'primary_dpoa_revoked'
  | 'jurisdiction_mismatch'
  | 'scope_does_not_cover_request'
```

#### 4.3.1 Sensitive-category redaction flags — backing & computation (M39-F05 / ADR-0014 / ARCH-190/154)

Each `redact*Content`/`redact*Fields` flag returned by `evaluateForDisclosure` and
`evaluateForIngressRedaction` is **fail-closed by default (= `true`, redact)** and is set to
`false` (disclose) **only** when M39 can point to an authoritative backing fact. A flag M39
cannot authoritatively decide is **delegated to M5** (the `PrivacyFlag` snapshot owner) and M39
never invents a disclose decision for it. The backing per category:

| Flag | Sensitive category | Authoritative backing that can flip it to `false` (disclose) | Owner / source of truth | Default when no backing |
|---|---|---|---|---|
| `redactSudContent` / `redactSubstanceUseDisorderFields` | 42 CFR Part 2 SUD | An **active `42_cfr_part_2_release` consent record** whose `consent_record_recipient` set **names the resolved recipient** (`recipientResolvedKind`/`recipientResolvedId`, or `recipientClientId` for FHIR) with an unexpired per-recipient window, AND whose scope/purpose covers the request. This is the same fact the `sud_disclosure_allowed` predicate resolves. | **M39** (it owns `42_cfr_part_2_release`) | `true` — redact (no §2.31 consent names the recipient) |
| `redactHivContent` / `redactHivFields` | HIV/AIDS status | M39 owns **no** HIV-specific consent type, so it **delegates to M5**: disclose only when `patient.privacy_flag_snapshot.hiv_disclosure_permitted` is set for the resolved recipient context (M5 D10), itself derived from a `hipaa_release` consent record naming the recipient with HIV in scope where the tenant/state requires specific HIV authorization. M39 reads the M5 snapshot via `PatientReader`; if M5 has no affirmative flag, M39 redacts. | **M5 PrivacyFlag** (M39 delegates) | `true` — redact |
| `redactMentalHealthContent` / `redactMentalHealthFields` | Mental-health / psychotherapy-note-adjacent | Delegated to **M5**: disclose only when `patient.privacy_flag_snapshot.mental_health_disclosure_permitted` is affirmatively set for the recipient context (derived from a `hipaa_release` naming the recipient with mental-health content in scope per state law). | **M5 PrivacyFlag** (M39 delegates) | `true` — redact |
| `redactGeneticContent` / `redactGeneticFields` | Genetic information (GINA) | Delegated to **M5**: disclose only when `patient.privacy_flag_snapshot.genetic_disclosure_permitted` is affirmatively set for the recipient context (derived from a `hipaa_release` naming the recipient with genetic content in scope). | **M5 PrivacyFlag** (M39 delegates) | `true` — redact |
| `redactFamilyViolenceContent` / `redactFamilyViolenceFields` | Domestic/family-violence safety content | The `family_violence_disclosure_allowed` predicate (registered by M15, resolved by M39 per M15 §4.5); disclose only when that resolver returns `true` for the recipient context. | **M39** (resolver) via **M15** registration | `true` — redact |

**Rationale for delegating HIV/MH/Genetic to M5 (ADR-0014):** M39 ships ten typed consent
types; none is an HIV-, mental-health-, or genetics-specific release. Authoritatively deciding
those categories requires the per-state sensitivity rules and the per-recipient disclosure
posture that M5 already computes into `patient.privacy_flag_snapshot`. M39 therefore does not
fabricate a backing it does not own: for those three categories it reads the M5 flag and
**fails closed to redact** whenever M5 has no affirmative disclose flag. Only the SUD and
family-violence flags are decided in M39 (it owns the `42_cfr_part_2_release` consent type and
the `family_violence_disclosure_allowed` resolver respectively).

**PHI-Sensitive extra controls enumerated (OPEN-021):** beyond the per-category flag, every
disclosure under a sensitive-category release additionally enforces:
1. **Per-recipient segmentation** — the redaction decision is computed **per resolved recipient**,
   never patient-global; a release naming recipient A never discloses to recipient B.
2. **§2.31 per-recipient grant** — SUD disclosure requires a `consent_record_recipient` row
   naming that exact recipient with an unexpired window; absence ⇒ redact (`no_active_recipient_matches`).
3. **Enforced re-disclosure gate (§2.32)** — any SUD-category disclosure carries the §2.32
   prohibition-on-re-disclosure notice (M22 renders it on the PDF; M28 includes it in
   `Bundle.text.div`); the disclosure path must attach it or the egress is blocked.
4. **Fail-closed default** — every flag defaults to redact; a missing/erroring backing fact
   (including an unavailable M5 snapshot) resolves to redact, never disclose.
5. **Eval-audit `redacted_categories[]`** — each `evaluate*` call records which categories were
   redacted in the `consent_eval_audit` row so the redaction decision is reconstructable per §3.x.

**Companion seams M39 also publishes:**

```typescript
/** Used by M16 to bind bereaved_contact.consent_record_id with policy enforcement. */
export interface BereavementOutreachConsentProvider {
  consentForBereavedContact(args: {
    organizationId: string
    decedentPatientId: string
    bereavedContactId: string
    asOf?: string
  }): Promise<{ consentRecordId: string; status: ConsentStatus; channelsAllowed: readonly string[] } | null>
  postMortemEligibilityForDecedent(decedentPatientId: string, organizationId: string): Promise<{
    decedentSurvivesDeathConsents: readonly { consentRecordId: string; typeKey: ConsentTypeKey }[]
  }>
}

/** Used by M31 (forward) — caregiver portal-session scope resolution. */
export interface DelegatedAccessReader {
  delegatedAccessForCaregiver(args: {
    organizationId: string
    delegateCaregiverId: string
    asOf?: string
  }): Promise<ReadonlyArray<{
    delegatedAccessId: string
    patientId: string
    scopeKind: DelegatedAccessScope
    effectiveUntil?: string
    consentRecordId: string
  }>>
}

/** Used by M22 (disclosure subsetter) + M28 (FHIR) — fast recipient lookup. */
export interface RecipientDirectoryReader {
  recipientsForPatient(args: {
    organizationId: string
    patientId: string
    consentType: ConsentTypeKey
    asOf?: string
  }): Promise<ReadonlyArray<{
    consentRecordId: string
    recipientId: string
    recipientKind: ConsentRecipientKind
    recipientEntityId?: string
    recipientFreeText?: string
    purposeCode?: string
    expiresAt?: string
  }>>
}

/** Used by M32 on read-only paths — surfaces consent-state-aware advisories (Phase 2). */
export interface ConsentStateAdvisoryProvider {
  advisoryForReadContext(args: {
    organizationId: string
    patientId: string
    callerModule: ModuleId
    callerRoute: string
  }): Promise<{ advisoryText: string | null; severity: 'info' | 'warn' | 'block_hint' }>
}
```

`validateSeams()` (called in `bootSeams()` per the M1 boot pattern) refuses to start the server if any required seam is missing.

### 4.4 The Seams M39 Consumes

```typescript
// apps/backend/src/modules/39-consent/boot.ts (consumed seams)
import type { MembershipReader, CredentialReader } from '@chartwarden/identity/seams'   // M2
import type { PatientReader, CaseloadProvider } from '@chartwarden/patient/seams'        // M5
import type { DocumentRenderer } from '@chartwarden/documents/seams'                     // M22
import type { MessagingProvider, AlertEmitter } from '@chartwarden/messaging/seams'      // M36
import type { TerminologyProvider } from '@chartwarden/terminology/seams'                // M38
import type { ExternalPhysicianReader, FacilityReader, PharmacyReader }
                                       from '@chartwarden/mdm/seams'                     // M40
import type { PortalSessionTerminator } from '@chartwarden/portal/seams'                 // M31 (forward)
import type { FhirClientCacheInvalidator } from '@chartwarden/fhir-gateway/seams'        // M28 (forward)
```

At M39 init (full surface):

```typescript
export function initM39(reg: SeamRegistry): void {
  // Required upstream
  reg.require<MembershipReader>('m2.membership-reader')
  reg.require<CredentialReader>('m2.credential-reader')
  reg.require<PatientReader>('m5.patient-reader')
  reg.require<CaseloadProvider>('m5.caseload-provider')
  reg.require<DocumentRenderer>('m22.document-renderer')
  reg.require<MessagingProvider>('m36.messaging-provider')
  reg.require<AlertEmitter>('m36.alert-emitter')
  reg.require<TerminologyProvider>('m38.terminology')
  reg.require<ExternalPhysicianReader>('m40.external-physician-reader')
  reg.require<FacilityReader>('m40.facility-reader')
  reg.require<PharmacyReader>('m40.pharmacy-reader')

  // Forward-seam consumers — deny-stubs until owner lands
  reg.optional<PortalSessionTerminator>('m31.portal-session-terminator', denyStubPortalSessionTerminator)
  reg.optional<FhirClientCacheInvalidator>('m28.fhir-client-cache-invalidator', denyStubFhirClientCache)

  // Publish M39's seams
  reg.publish<ConsentEvaluator>('m39.consent-evaluator', realConsentEvaluator)
  reg.publish<ConsentStateAdvisoryProvider>('m39.consent-state-advisory-provider', realConsentStateAdvisoryProvider)
  reg.publish<DelegatedAccessReader>('m39.delegated-access-reader', realDelegatedAccessReader)
  reg.publish<BereavementOutreachConsentProvider>('m39.bereavement-outreach-consent-provider', realBereavementOutreachConsentProvider)
  reg.publish<RecipientDirectoryReader>('m39.recipient-directory-reader', realRecipientDirectoryReader)

  // Register the 11 ABAC predicate resolvers with M3's named-predicate registry
  m3.predicateRegistry.register('sud_consent_present', sudConsentPresentResolver)
  m3.predicateRegistry.register('sud_disclosure_allowed', sudDisclosureAllowedResolver)
  m3.predicateRegistry.register('dpoa_active', dpoaActiveResolver)
  m3.predicateRegistry.register('family_caregiver_access_active', familyCaregiverAccessActiveResolver)
  m3.predicateRegistry.register('portal_access_active', portalAccessActiveResolver)
  m3.predicateRegistry.register('telehealth_consent_active', telehealthConsentActiveResolver)
  m3.predicateRegistry.register('media_release_active', mediaReleaseActiveResolver)
  m3.predicateRegistry.register('research_participation_active', researchParticipationActiveResolver)
  m3.predicateRegistry.register('advance_directive_acknowledged', advanceDirectiveAcknowledgedResolver)
  m3.predicateRegistry.register('hipaa_release_active', hipaaReleaseActiveResolver)
  m3.predicateRegistry.register('family_violence_disclosure_allowed', familyViolenceDisclosureAllowedResolver)

  // Register the eraser + retention class
  m4.eraserRegistry.register('consent', eraseConsentSubtree)  // M39-F04: data-class key the M4 boot validator expects
  m4.retentionClassRegistry.register('consent', { defaultYears: 7, stateOverridable: true })

  // Register the SESSION_POLICY consent_management step-up profile with M2
  m2.sessionPolicyRegistry.register('consent_management', {
    maxAgeMinutes: 5, requiresPasskey: true, fallbackTotp: true,
    auditTier: 'critical',
  })

  // Register M36 alert rules + recipient resolver
  m36.alertRuleRegistry.register(...M39_ALERT_RULES)
  m36.recipientResolverRegistry.register('consent_management_steward', resolveConsentSteward)

  // AI-prohibited boundary validator (D17)
  validateM39AIBlock(m32.promptRegistry)
}
```

### 4.5 Outbox Event Catalog

| Event | Trigger | Consumers | Payload (beyond M1 envelope) |
|---|---|---|---|
| `m39.consent.created` | route 6 → `createConsentDraft` | (none — drafts are internal) | `{ consentRecordId, patientId, typeKey }` |
| `m39.consent.signed` | route 8 → `signConsent` | **M22** (render PDF), **M5** (privacy_flag_snapshot recompute if SUD), **M16** (post-mortem grant if bereavement_outreach_consent), M33, M30 | `{ consentRecordId, patientId, typeKey, signedAt, signedBy, captureMethod, expiresAt? }` |
| `m39.consent.supersedes` | route 9 → `supersedeConsent` | M22 (re-render), M5 (snapshot), M3 (cache invalidation), M28 (FHIR client rebind) | `{ newConsentRecordId, supersededConsentRecordId, patientId, typeKey, supersededAt }` |
| `m39.consent.revoked` | route 10/27 → `revokeConsent` | per-type cascade — §2.4 | `{ consentRecordId, revocationId, patientId, typeKey, revokedAt, revokedByKind, cascadeKind }` |
| `m39.consent.expired` | cron `consent-expiration` | M5 (snapshot), M22 (signed-URL revoke), M36 | `{ consentRecordId, patientId, typeKey, expiredAt }` |
| `m39.consent.expiring_soon` | cron `expiration-reminder` | **M36** (alert), M14 (compliance tile) | `{ consentRecordId, patientId, typeKey, expiresAt, reminderKind }` |
| `m39.consent.renewal_cycle_opened` | service `renewalCycleOpener` | M36, M33 | `{ cycleId, sourceConsentRecordId, patientId, typeKey, nextActionDueAt }` |
| `m39.consent.renewed` | route 20 → `renewConsent` | M22 (re-render), M5 (snapshot), M16 (if bereavement), M36 | `{ newConsentRecordId, renewedFromConsentRecordId, patientId, typeKey, signedAt }` |
| `m39.consent.recipient_added` | route 12 → `addRecipient` | M22 (subsetter cache invalidation), M28 (FHIR cache invalidation) | `{ consentRecordId, recipientId, recipientKind, recipientEntityId?, patientId }` |
| `m39.consent.recipient_removed` | route 13 → `removeRecipient` | M22, M28, M5 | `{ consentRecordId, recipientId, removedAt, patientId }` |
| `m39.consent.dpoa.agent_appointed` | route 15 → `addDpoaAgent` | M7 (banner), M11 (attribution refresh), M14 (IDG attribution) | `{ consentRecordId, dpoaAgentId, agentKind, agentName, patientId }` |
| `m39.consent.dpoa.agent_removed` | route 16 → `removeDpoaAgent` | M7, M11, M14 | `{ consentRecordId, dpoaAgentId, agentKind, patientId }` |
| `m39.consent.delegated_access.granted` | service `delegatedAccessProjector` | **M31 (forward)**, M17, M18, M19 | `{ delegatedAccessId, consentRecordId, patientId, delegateCaregiverId, scopeKind, effectiveFrom, effectiveUntil? }` |
| `m39.consent.delegated_access.revoked` | service `delegatedAccessProjector` | M31, M17, M18, M19, M36 | `{ delegatedAccessId, consentRecordId, patientId, delegateCaregiverId, revokedAt }` |

### 4.6 Outbox Subscriptions (Consumers in M39)

| Source event | Source module | Handler | Purpose |
|---|---|---|---|
| `m22.document.rendered` (template_key='consent_record') | M22 | `m22-document-rendered.ts` | Stamp `consent_document_link` with `document_id`/`document_version_id` |
| `m5.patient.deceased` | M5 | `m5-patient-deceased.ts` | Transition active non-survives-death consents to `expired` per D13 |
| `m5.patient.merged` | M5 | `m5-patient-merged.ts` | UPDATE consent_record SET patient_id = mergedIntoId; emit `m39.consent.repointed` |
| `m4.legal_hold.applied` (retention_class='consent') | M4 | `m4-legal-hold-applied.ts` | Extend retention on matching consent_records |
| `m4.legal_hold.released` | M4 | `m4-legal-hold-released.ts` | Release retention extension |
| `m16.bereavement.eligible` | M16 | `m16-bereavement-eligible.ts` | No-op signal that bereavement scope exists; consent capture is staff-initiated (W-CON-11) |

Consumer idempotency keyed on `(eventId, m39ConsumerName)` in M1's outbox-dedup registry.

### 4.7 Permission Keys Registered into Module 3

M39 contributes these fifteen keys to M3's permission catalog (`packages/auth/src/permissions/consent.ts`). **Binding handshake: boot validation fails if any key is missing from M3's catalog at startup.**

| Key | Default roles | Description |
|---|---|---|
| `consent.read_catalog` | every role | read consent type catalog + applicable overlay |
| `consent.read` | clinical_* (within caseload), compliance_officer, privacy_officer, medical_director, org_admin | read consent records for a patient |
| `consent.read_history` | compliance_officer, privacy_officer, medical_director, org_admin, surveyor (engagement-scoped) | read version + renewal chain |
| `consent.read_phi_content` | clinical_* (within caseload), compliance_officer, privacy_officer | decrypt internal_notes_cipher |
| `consent.read_eval_audit` | compliance_officer, privacy_officer, surveyor (engagement-scoped) | read consent_eval_audit |
| `consent.author` | rn_case_manager, msw, clinical_supervisor, intake_nurse, compliance_officer, privacy_officer | create/edit draft / add recipient or DPOA agent |
| `consent.sign` | rn_case_manager, msw, clinical_supervisor, intake_nurse, compliance_officer, privacy_officer (with step-up) | sign / supersede / renew |
| `consent.revoke` | rn_case_manager, clinical_supervisor, compliance_officer, privacy_officer (with step-up); patient_portal_user (portal) | record revocation |
| `consent.manage_overlay` | org_admin, compliance_officer (with step-up) | publish tenant_consent_type_overlay |
| `consent.admin_re_render` | platform_admin, compliance_officer (with step-up) | force M22 re-render |
| `consent.delegate_assignment` | rn_case_manager, msw, clinical_supervisor | create/edit delegated_access bindings |
| `consent.portal_self_service` | patient_portal_user (portal session) | sign/revoke own consents through portal |
| `consent.read_bereavement_outreach` | bereavement_counselor, msw, clinical_supervisor, compliance_officer | read post-mortem bereavement_outreach_consent |
| `consent.bereavement_outreach_author` | bereavement_counselor, msw, clinical_supervisor (with step-up) | author bereavement_outreach_consent post-death |
| `consent.cascade_admin` | platform_admin, compliance_officer (with step-up) | re-fire stuck revocation cascade handlers |

### 4.8 ABAC Predicates Registered (Resolver Ownership)

M39 owns the resolvers for these eleven predicates. Each resolver is a pure typed function exported from `apps/backend/src/modules/39-consent/services/abac-predicates.ts` and registered at boot with M3's predicate registry.

| Predicate | Resolves via | Consumed by |
|---|---|---|
| `sud_consent_present` | `evaluate(patient, '42_cfr_part_2_release')` returns `allowed=true` for ≥1 active recipient | M22 portal document filter, M5 SUD-content gating |
| `sud_disclosure_allowed` | `evaluate(patient, '42_cfr_part_2_release', sessionContext)` returns `allowed=true` AND recipient matches the requesting party | **M7, M8, M9, M11, M12, M13, M14, M15, M22, M28** |
| `dpoa_active` | `evaluate(patient, 'dpoa_healthcare')` AND primary agent activation condition met | **M7, M11, M14, M22** |
| `family_caregiver_access_active` | `evaluate(patient, 'family_caregiver_access', sessionContext)` for the session's portal delegate caregiver | **M17, M18, M19, M22, M31 (forward)** |
| `portal_access_active` | `evaluate(patient, 'portal_access', sessionContext)` | **M31 (forward)** |
| `telehealth_consent_active` | `evaluate(patient, 'telehealth_consent')` with optional per-encounter scope check | **M8, M36** |
| `media_release_active` | `evaluate(patient, 'media_release')` | **M22, M33** |
| `research_participation_active` | `evaluate(patient, 'research_participation')` with optional study-identifier scope | future research module + **M30** denominator filter |
| `advance_directive_acknowledged` | `evaluate(patient, 'advance_directive_acknowledgment')` categorical | **M6, M7, M14** |
| `hipaa_release_active` | `evaluate(patient, 'hipaa_release')` with recipient match | **M5, M22** |
| `family_violence_disclosure_allowed` | M15-registered predicate; M39 owns the resolver — `evaluate(patient, 'family_violence_disclosure_acknowledgment', sessionContext)` (custom-type slot per D2 + M15) | **M15** |

### 4.9 BullMQ Queue Catalog

| Queue | Schedule | Worker | Purpose |
|---|---|---|---|
| `m39-expiration-reminder` | cron `0 * * * *` (hourly) | `expiration-reminder.cron.ts` | Walk consents whose `expires_at` falls in next 90/30/14/7/1d window; insert reminder rows idempotently; emit `m39.consent.expiring_soon` |
| `m39-consent-expiration` | cron `0 * * * *` (hourly) | `consent-expiration.cron.ts` | Transition `expires_at<now()` + `status='active'` rows to `expired`; emit |
| `m39-revocation-cascade-retry` | every 30s | `revocation-cascade-retry.cron.ts` | Re-fire stuck `cascade_status IN ('pending','in_progress')` AND `cascade_started_at < now() - interval '5 minutes'` |
| `m39-renewal-cycle-close` | cron `0 3 * * *` (nightly 3 AM) | `renewal-cycle-close.cron.ts` | Close cycles whose source expired without renewal |
| `m39-draft-auto-expire` | cron `0 4 * * *` (daily 4 AM) | `draft-auto-expire.cron.ts` | Discard (`DELETE`) drafts older than 30 days. **M39-F13 / ARCH-250 / OPEN-020 — housekeeping TTL only:** deletes rows whose `status='draft'` AND `created_at < now() - INTERVAL '30 days'`. These rows have never been signed (`signed_at IS NULL`) and carry no §24/`compliance`-class retention obligation. Deletion is not gated by M4 legal-hold or destruction-cert workflows. The 30-day window is a UX/housekeeping boundary; it is NOT a §24 retention-class commitment. See §2.2.1 for the full clarification. |
| `m39-eval-audit-partition` | cron `30 23 * * *` (nightly 11:30 PM) | `eval-audit-partition.cron.ts` | Pre-create next-month `consent_eval_audit_yyyy_mm` partition |
| `m39-m22-document-rendered` | event | `m22-document-rendered.worker.ts` | Subscribe M22 |
| `m39-m5-patient-deceased` | event | `m5-patient-deceased.worker.ts` | D13 cascade |
| `m39-m5-patient-merged` | event | `m5-patient-merged.worker.ts` | Re-point consent_record.patient_id |

All queue jobs are idempotent on a deterministic job ID; the M1 idempotency middleware enforces.

### 4.10 M36 Typed Alert Payloads

M39 registers five alert types with M36's alert-rule registry:

| Alert key | Severity | Floor cadence | Recipients | Notes |
|---|---|---|---|---|
| `m39.consent.expiration_imminent` | NORMAL (90d) → NORMAL (30d) → HIGH (14d/7d) → CRITICAL (1d) | platform-floor 90/30/14/7/1 day | compliance_officer + privacy_officer + assigned RN case manager | tenant may tighten cadence (more reminders) not loosen |
| `m39.consent.revoked_cascade_failed` | CRITICAL | immediate on `partial_failed` transition | compliance_officer + platform-ops-on-call | rare; indicates a downstream consumer is misbehaving |
| `consent.dpoa.agent_appointed` | NORMAL | immediate | medical_director + assigned RN case manager + clinical_supervisor | informational; banner on M7 care plan UI |
| `m39.consent.recipient_disclosure_attempted_without_consent` | HIGH | immediate | compliance_officer + privacy_officer | M22/M28 emit this; M39 routes through M36 |
| `m39.consent.renewal_overdue` | HIGH (7d past expiry without renewal) → CRITICAL (30d) | platform-floor 7d/30d | compliance_officer + assigned RN case manager | only for compliance-critical types (`42_cfr_part_2_release`, `hipaa_release`, `dpoa_healthcare`) |

The five alert payloads are typed in `packages/messaging/src/alerts/consent.ts` and consumed by M36's typed-alert-payload registry.

### 4.11 ABAC Attribute Sets on Patient-Scoped PHI Read Routes (M39-F11 / ARCH-053 / ARCH-066/067)

For every patient-scoped read route that returns PHI, the ABAC gate must evaluate the **full attribute set** — not just a bare `caseload_or_scope` flag. The table below makes the required attributes explicit per route. The route layer must resolve all four dimensions **before** handing the result set to the caller; missing any attribute is a deny.

| Route # | Path | ABAC attributes required (all must pass) |
|---|---|---|
| **3** | `GET /api/v1/patients/:patientId/consents` | **caseload** (`CaseloadProvider.isOnCaseload(membershipId, patientId)`); **discipline scope** (member's licensed discipline must include consent-management; Compliance Officer and Privacy Officer bypass discipline scope); **on-call window** (applies only if session class is `on_call` — membership must be in the on-call rotation for this organization at the current wall-clock time per M17's schedule seam); **bereavement window** (if patient is deceased, read is gated by `bereavement_window` status — M16's eligibility flag must be active AND the requesting membership must be assigned to the bereavement program for this patient) |
| **4** | `GET /api/v1/consents/:consentId` | Same four attributes as route 3; additionally, the `consent_record.patient_id` must equal the resolved patient scope for the session — prevents IDOR across patients within the same caseload |
| **11** | `GET /api/v1/consents/:consentId/recipients` | Same four attributes as route 4 |
| **14** | `GET /api/v1/consents/:consentId/dpoa-agents` | Same four attributes as route 4 |
| **17** | `GET /api/v1/patients/:patientId/dpoa/active-primary` | **caseload** (mandatory; this route is consumed by M7/M11/M14 via the seam — the consuming module's service principal must itself be within caseload scope for the patient; the seam call carries the originating `callerModule` and the patient's `organizationId`); **discipline scope** (clinical roles only — `rn_case_manager`, `msw`, `medical_director`, `clinical_supervisor`, `intake_nurse`, `idg_coord`; Compliance Officer and Privacy Officer bypass); **on-call window** (if session class is `on_call`, membership must hold on-call assignment at current time); **bereavement window** (same post-mortem gate as route 3 — even the active DPOA primary query is restricted to bereavement-eligible sessions post-death, because the DPOA may drive care decisions that affect post-mortem estate handling) |
| **21** | `GET /api/v1/patients/:patientId/delegated-access` | **caseload** (mandatory; the projection is consumed by M31 portal-session-minter via the `DelegatedAccessReader` seam — the session principal must be caseload-scoped or the Compliance Officer role); **discipline scope** (clinical roles + bereavement_counselor; the delegate-projection read is not restricted to the assigning clinician's discipline, but it is restricted to clinical and bereavement roles); **on-call window** (on-call sessions may read this projection to determine caregiver contact scope during a triage call per M19 §4.4); **bereavement window** (post-death reads of `delegated_access` that survived death via `survives_death=true` are only accessible to bereavement-eligible sessions; expired delegated-access rows with `revoked_at IS NOT NULL` are still readable by Compliance Officer for audit purposes) |
| **28** | `GET /api/v1/consents/post-mortem-eligible/:patientId` | **bereavement window** (mandatory — this route exists for post-mortem use; patient must be deceased AND membership must be in the active bereavement program for this patient per M16); **caseload** (OR compliance_officer — Compliance Officer bypass applies); **discipline scope** (bereavement_counselor, msw, clinical_supervisor, compliance_officer; no on-call override) |

**Implementation note (route layer):** The four attributes are resolved as a short-circuiting predicate chain in this order: (1) session class validity, (2) `consent.read` permission key present in M3's decision for this membership, (3) caseload membership, (4) discipline scope, (5) on-call window if applicable, (6) bereavement window if applicable. The chain short-circuits at the first deny; the deny reason is logged to `consent_eval_audit` as a `deny_reason='abac_attribute_deny:<attribute_name>'` entry (structural, no PHI in the deny reason). Compliance Officer and Privacy Officer bypass (4) discipline scope only — they do not bypass (3) caseload (both roles are org-wide) or (5)/(6) temporal windows.

**Seam consumers (routes 17, 21 via seam):** When M7, M11, M14 call route 17 via the `ConsentEvaluator` seam's `evaluate(type='dpoa_healthcare', …)` method, the `sessionContext.membershipId` passed in is the **originating clinical membership** on whose behalf the call is made, not a platform-admin bypass. The seam enforcer applies the same four-attribute check against the originating membership. Callers that pass `callerModule` without a valid `membershipId` (e.g., a background job) receive `allowed=false reason='abac_attribute_deny:no_session_membership'` — background jobs must use the M1 break-glass service principal pattern to access these routes, which routes through the `compliance_officer` bypass tier and emits a break-glass audit event.

### 4.12 Cursor Pagination on PHI List and Audit Query Routes (M39-F14 / SD-052)

All PHI list routes and audit query routes use **cursor-based pagination** (opaque cursor, not offset/limit). Offset-based pagination is prohibited on M39 routes because `consent_eval_audit` is partitioned monthly and can have O(10M) rows; offset scans degrade quadratically and expose patients to time-of-check/time-of-use skew in compliance audits.

**Routes with mandatory cursor pagination:**

| Route # | Path | Cursor key | Default page size | Max page size |
|---|---|---|---|---|
| **18** | `GET /api/v1/patients/:patientId/expiring-consents` | `(expires_at, id)` composite — ascending by `expires_at`, then `id` for tie-breaking; cursor is base64-encoded JSON `{"ea":"<ISO8601>","id":"<uuid>"}` | 50 | 200 |
| **22** | `GET /api/v1/consents/:consentId/eval-audit` | `(evaluated_at, id)` composite — descending by `evaluated_at` (most-recent-first audit view); cursor encodes `{"eat":"<ISO8601>","id":"<uuid>"}` | 100 | 500 |
| **23** | `GET /api/v1/consents/eval-audit/by-patient` | `(evaluated_at, id)` composite — same as route 22; already marked cursor-paginated in §4.1 | 100 | 500 |

**Request/response shape (uniform across routes 18, 22, 23):**

```typescript
// Query parameters (example for route 22)
export const EvalAuditCursorQuery = Type.Object({
  cursor: Type.Optional(Type.String()),       // opaque base64 cursor from prior response
  limit:  Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  // route-specific filters (e.g., type_key, allowed, caller_module, date_from, date_to)
  type_key:       Type.Optional(Type.String()),
  allowed:        Type.Optional(Type.Boolean()),
  caller_module:  Type.Optional(Type.String()),
  date_from:      Type.Optional(Type.String({ format: 'date-time' })),
  date_to:        Type.Optional(Type.String({ format: 'date-time' })),
})

// Response envelope (uniform)
export const CursorPagedResponse = <T extends TSchema>(itemSchema: T) => Type.Object({
  items:       Type.Array(itemSchema),
  nextCursor:  Type.Union([Type.String(), Type.Null()]),  // null when no more pages
  hasMore:     Type.Boolean(),
  totalHint:   Type.Optional(Type.Integer()),  // approximate count from partition stats; absent when too expensive
})
```

**Cursor semantics:**
- The cursor is opaque to the caller and must not be constructed or decoded client-side — treat it as a token.
- Cursors are stateless (no server-side cursor objects); they encode the last-seen keyset values.
- A cursor is valid for 1 hour; after expiry the route returns `422 cursor_expired` and the caller must restart from the beginning. This prevents stale cursors spanning partition boundaries across monthly rotations.
- Filters passed with a cursor must be identical to the original request filters; a mismatch returns `422 cursor_filter_mismatch`.
- Audit query routes (22, 23) write a `consent_eval_audit` row for the *query itself* only when the caller is a portal user or an external collaborator; internal compliance officer / privacy officer queries do not self-audit (to avoid audit-of-audit fan-out).

**Implementation note:** Route 18 uses `consent_record.expires_at` as the primary sort key, which is indexed by `ix_cr_expiring_soon` (partial index on active rows with `expires_at IS NOT NULL`). Routes 22 and 23 use `consent_eval_audit.evaluated_at` as the primary sort key, which is the partition key — the query planner partition-prunes by `date_from`/`date_to` before applying the cursor predicate. Never apply `OFFSET` as a fallback; the route must error rather than degrade to offset pagination.

-----

## 5. Frontend Screens

### 5.1 Web Inventory

All screens live under `apps/web/src/modules/39-consent/` and share TanStack Query keys + TanStack Router routes.

| # | Path | Screen | Notes |
|---|---|---|---|
| 1 | `/patients/:patientId/consents` | Patient consent dashboard | active consents grouped by type; expiring-soon banner; "+ New consent" CTA per missing type |
| 2 | `/patients/:patientId/consents/:consentId` | Consent detail | full record + recipients + DPOA agents + version chain + renewal cycle + signed-PDF preview |
| 3 | `/patients/:patientId/consents/:consentId/version-chain` | Version-chain viewer | tree visualization (supersession + renewal chains) |
| 4 | `/patients/:patientId/consents/new` | Consent capture wizard | type-selection → typed scope form → grantor identity → capture-method → preview → sign |
| 5 | `/patients/:patientId/consents/:consentId/recipients` | Recipient management | active recipients table + "+ Add recipient" modal (M40 entity picker) |
| 6 | `/patients/:patientId/consents/:consentId/dpoa-agents` | DPOA agent management | primary + alternates; activation-condition selector; per-state addendum fields |
| 7 | `/patients/:patientId/consents/:consentId/revoke` | Revocation drawer | reason + evidence upload + cascade preview |
| 8 | `/patients/:patientId/consents/:consentId/renew` | Renewal wizard | pre-filled from prior consent; review-and-sign |
| 9 | `/compliance/consents/expiring` | Expiring-consents queue | org-wide list sortable by `expires_at`; assignee column |
| 10 | `/compliance/consents/eval-audit` | Consent eval audit explorer | filter by patient/type/caller_module/date-range; per-row deep-link to the consent_record |
| 11 | `/compliance/consents/renewal-cycles` | Open renewal cycles | dashboard tile + drill-down |
| 12 | `/admin/consent-types/overlay` | Tenant overlay editor | side-by-side platform-floor vs tenant-overlay diff; rejected-overlay error surface |
| 13 | `/compliance/consents/cascade-failures` | Stuck revocation cascade list | with manual retry button (route 30) |

### 5.2 Mobile (Capacitor) Variants

- **Bedside consent capture** — wizard adapted for tablet bedside (large touch targets); typed-signature pad + biometric step-up for M2 SESSION_POLICY `consent_management` profile.
- **Counselor post-mortem `bereavement_outreach_consent` capture** — used in MSW/bereavement-counselor home-visit context; offline-first with sync on reconnect.
- **DPOA agent designation** in admission flow — drawer overlay on M6 admission wizard.

### 5.3 Portal Variants (M31-consumed, Phase 2)

- **Active consents view** — patient or delegated caregiver sees their active consents grouped by type, with explicit revocation buttons.
- **Portal-issued consent flow** — types `portal_access`, `family_caregiver_access`, `telehealth_consent`, `media_release` may be signed from the portal; the portal-signed consent_record uses `capture_method='electronic_portal_signature'` with `capture_evidence_jsonb.portal_session_id` populated.
- **Revocation surface** — patient may revoke any of their own consents; `revoked_by_kind='patient_self_via_portal'`; no reason floor (D7).

### 5.4 Accessibility (WCAG 2.1 AA)

- All forms use semantic labels and `aria-describedby` for inline errors.
- Scope-descriptor discriminated-union forms expose a fieldset legend per type; `aria-live="polite"` announces type-switching state changes.
- Signature pads have keyboard-typed-signature fallback for users who can't operate a touch surface.
- Color is never the sole indicator: consent status pills use shape + icon + text (e.g., expired = strike-through outline + clock icon + "Expired").
- The version-chain tree viewer (screen 3) is keyboard-navigable; each node has `aria-label` with the consent date + status.
- Per-state addendum text (DPOA agent screen) renders via the M22 template-overlay-aware viewer; the rendered text is selectable + screen-reader-readable.
- Step-up auth modal (M2-owned) is announced as a separate dialog; focus moves into the modal and returns to the triggering control on dismissal.

-----

## 6. Permissions Matrix

Authoritative matrix; entries marked **(✓ ABAC)** require an attribute predicate in addition to the role grant. Every PHI route requires `caseload_or_scope` unless tagged `(broad)`.

| Action | RN | LPN | MSW | Chap | Vol Coord | Clin Supv | DON | Comp Off | Priv Off | IDG Coord | Surveyor | Patient (Portal) | Caregiver (Portal) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| read catalog | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| read consent | ✓ ABAC | ✓ ABAC | ✓ ABAC | ✓ ABAC | — | ✓ ABAC | ✓ ABAC | ✓ | ✓ | ✓ ABAC | ✓ (engagement) | self only | delegated only |
| read history | — | — | — | — | — | ✓ ABAC | ✓ | ✓ | ✓ | — | ✓ (engagement) | — | — |
| read phi content | ✓ ABAC | — | ✓ ABAC | ✓ ABAC | — | ✓ ABAC | ✓ ABAC | ✓ | ✓ | — | — | — | — |
| read eval audit | — | — | — | — | — | — | — | ✓ | ✓ | — | ✓ (engagement) | — | — |
| author draft (any type) | ✓ ABAC | — | ✓ ABAC | — | — | ✓ ABAC | — | ✓ | ✓ | — | — | — | — |
| sign | ✓ ABAC + step-up | — | ✓ ABAC + step-up | — | — | ✓ ABAC + step-up | — | ✓ + step-up | ✓ + step-up | — | — | self only | delegated only (via portal session) |
| revoke (staff) | ✓ ABAC + step-up | — | — | — | — | ✓ + step-up | — | ✓ + step-up | ✓ + step-up | — | — | — | — |
| revoke (patient self) | — | — | — | — | — | — | — | — | — | — | — | ✓ (portal session) | — |
| add recipient | ✓ ABAC + step-up | — | ✓ ABAC + step-up | — | — | ✓ + step-up | — | ✓ + step-up | ✓ + step-up | — | — | — | — |
| remove recipient | ✓ ABAC + step-up | — | — | — | — | ✓ + step-up | — | ✓ + step-up | ✓ + step-up | — | — | — | — |
| add DPOA agent | ✓ ABAC + step-up | — | ✓ ABAC + step-up | — | — | ✓ + step-up | — | ✓ + step-up | — | — | — | — | — |
| modify DPOA agent | — | — | — | — | — | ✓ + step-up | — | ✓ + step-up | ✓ + step-up | — | — | — | — |
| renew | ✓ ABAC + step-up | — | ✓ ABAC + step-up | — | — | ✓ + step-up | — | ✓ + step-up | ✓ + step-up | — | — | self only | — |
| author bereavement outreach (post-mortem) | — | — | ✓ ABAC + step-up | ✓ ABAC + step-up | — | ✓ + step-up | — | — | — | — | — | — | — |
| manage overlay (org-wide) | — | — | — | — | — | — | ✓ + step-up | ✓ + step-up | — | — | — | — | — |
| admin re-render | — | — | — | — | — | — | — | ✓ + step-up | — | — | — | — | — |
| cascade admin retry | — | — | — | — | — | — | — | ✓ + step-up | — | — | — | — | — |

Notes:
- The Volunteer Coordinator role has **no** consent-author or consent-sign authority by design — consent is a clinical/compliance act, not a volunteer-management one.
- Privacy Officer overlaps Compliance Officer for many actions but has unique read authority for `eval_audit` queries; M3 SoD constraint (`mutually_exclusive_role`) prevents the same membership from holding both Privacy Officer and Compliance Officer simultaneously per platform policy.
- Surveyor access is `(engagement)` — gated by M3 engagement-scope ABAC; magic-link minted by M3 via M2's `mintAuditorSession` seam.

-----

## 7. Workflow Acceptance Criteria

### 7.1 W-CON-01 — Initial admission consent capture (HIPAA Release + Portal Access)

**Setup:** Patient `pt_amelia` newly admitted; M6 admission activation is in progress; intake nurse opens the consent capture wizard.

**Steps:**
1. Intake nurse navigates to `/patients/:patientId/consents/new`; selects `hipaa_release` type.
2. Wizard renders the typed scope form (per §4.2 `ScopeDescriptor_HipaaRelease`); nurse fills in description + purpose + checks the three required acknowledgments.
3. Recipient picker opens; nurse adds a recipient `{kind: 'facility', recipient_entity_id: <Engrace primary location>}` for ongoing treatment purposes.
4. Capture-method = `typed_signature_in_app`; nurse hands the tablet to the patient who types their name + role (e.g., "Self").
5. Patient taps "Sign"; step-up auth modal fires (nurse's biometric per M2 SESSION_POLICY `consent_management`); on success, route 8 fires.
6. M39 inserts consent_record with `status='active'`, `signed_at=now`, `effective_at=admissionDate`, no expiration (HIPAA Release defaults to 6-month expiration per D8 — wizard prefills `expires_at = now + 6 months`).
7. M39 emits `m39.consent.signed`; M22's `m39-consent-document-render-requested.ts` consumer renders the `consent_record` template; emits `m22.document.rendered`.
8. M39's `m22-document-rendered.ts` stamps `consent_document_link`.
9. Repeat steps 1-7 for `portal_access` consent with scope `{patient_can_view_clinical_record: true, patient_can_message_care_team: true}`.
10. Patient dashboard at `/patients/:patientId/consents` now shows both consents `active` with expiry indicators.

**Done means:** within p95=20s of step 5 the signed PDFs are queryable via `RenderedDocumentProvider.getRenderedDocumentForAggregate(M39:consent_record, <id>)`; the consent dashboard shows both consents `active`; the `consent_eval_audit` log shows zero deny rows for any subsequent route hit consulting `hipaa_release_active` or `portal_access_active` on this patient with the right recipient resolution.

### 7.2 W-CON-02 — 42 CFR Part 2 release with per-recipient addition over time

**Setup:** Patient `pt_brian` has an admission with an SUD diagnosis flagged on M5 (`patient.privacy_flag_snapshot.sud='confirmed'`). The clinical team has captured the §2.31 consent naming one initial recipient: a specialty pharmacy.

**Steps:**
1. RN case manager creates draft consent of type `42_cfr_part_2_release`; scope includes the patient acknowledgments and the affected ICD-10 categories (F11.20 specifically — opioid dependence).
2. RN adds initial recipient `{kind: 'pharmacy', recipient_entity_id: <CVS Specialty M40 row>, purpose_code: 'TREATMENT', expires_at: now + 1 year}`.
3. RN signs the consent (step-up).
4. M39 emits `m39.consent.signed`; M22 renders the `consent_record` template; M5 recomputes `patient.privacy_flag_snapshot.sud_consent_present=true` (for the named recipient only).
5. Two weeks later, the patient is being transferred temporarily to a SNF for respite. RN navigates to `/patients/:patientId/consents/:consentId/recipients`; opens "Add recipient" modal; adds `{kind: 'facility', recipient_entity_id: <Sunset SNF M40 row>, purpose_code: 'TREATMENT', expires_at: now + 6 months}`.
6. M39 emits `m39.consent.recipient_added`; M22 disclosure-subsetter cache invalidates; M28 FHIR client cache invalidates.
7. The next FHIR query from the SNF's HL7 v2 system (via M29) arrives; M29's `evaluateForIngressRedaction` returns `redactSubstanceUseDisorderFields: false` (consent allows it for this recipient).

**Done means:** the consent_record stays at version 0 throughout (no supersession — recipient addition is not a scope change per D6); the per-recipient effective windows are independent (CVS Specialty consent expires 1 year from initial sign, Sunset SNF expires 6 months from its `added_at`); a `consent_eval_audit` query for `recipient_resolved_id=<CVS>` over the year shows `allowed=true` for every SUD-related egress; the same query for an un-listed recipient (e.g., a transcription vendor) shows `allowed=false reason='no_active_recipient_matches'`.

### 7.3 W-CON-03 — Revocation cascade (portal_access)

**Setup:** Patient `pt_chen` has an active `portal_access` consent + an active `family_caregiver_access` consent naming her daughter; both with active portal sessions live in M2. Patient changes her mind and wants to revoke portal_access entirely.

**Steps:**
1. Compliance officer (called by the patient on the phone) records the revocation at `/patients/:patientId/consents/:consentId/revoke` with `reason_text="Patient called and stated she no longer wants portal access for either herself or her daughter; revocation captured verbally with patient identity verified per voice-callback procedure" + evidence_document_id` referencing a witnessed-verbal-revocation note staff documented in M22.
2. M39 inserts `consent_revocation` row with `cascade_status='pending'`, `step_up_evidence_id` from compliance officer's biometric.
3. M39 transitions the consent_record to `status='revoked'`; emits `m39.consent.revoked` with `cascadeKind='portal_access_revocation'`.
4. M2 consumer subscribes; iterates active sessions whose `session_class='portal'` AND `scope.patientId=pt_chen`; terminates each session immediately.
5. M31 forward-stub today logs deferral: "would terminate portal session for `pt_chen` but M31 not yet present; M2 termination is operative."
6. M22 consumer subscribes; revokes any pending signed-URL that targets `pt_chen` patient-facing documents; emits `document.signed_url_revoked` audit per signed URL.
7. The daughter's separate `family_caregiver_access` consent is NOT auto-revoked — but the M39 service offers a "Revoke linked caregiver access too?" prompt on the revocation drawer (UX hint); the compliance officer in this scenario also revokes that consent.
8. `cascade_status` transitions to `completed` once all subscribers ACK.

**Done means:** within 5 seconds of revocation, all portal sessions for the patient are terminated server-side (verified by a portal-session probe returning `401 session_revoked`); the M5 `patient.privacy_flag_snapshot.portal_access_active` flips to `false`; the M22 signed-URL revocation list contains every URL minted in the last 5 minutes for the patient; the M16 outreach paths (if any) update on next worker tick.

### 7.4 W-CON-04 — SUD detection from M22 DocLens → interim PrivacyFlag → consent capture

**Setup:** A 15-page fax bundle arrives at M22 intake for `pt_dorothy`; DocLens classifies pages 3-5 as a discharge summary containing methadone references → flags `sud_detected=true`.

**Steps:**
1. M22 emits `m22.intake.sud_detected` with `{patientId: pt_dorothy, batchId, jobId, detectionEvidence}`.
2. M5 consumes and creates interim `patient.privacy_flag(scope='sud', source='m22-intake', status='unconfirmed')` per M5 D10.
3. The reviewer in M22's W1 review UI sees a banner: "This document contains potential SUD content. A privacy flag has been created. Confirm SUD status with the patient at the next visit; a §2.31 consent will be required before any disclosure."
4. RN visits the patient three days later, confirms the SUD context (patient is on methadone for opioid use disorder, not for pain), captures the patient's verbal confirmation, and at the same visit captures a `42_cfr_part_2_release` consent naming the relevant recipients (primary attending physician + the specialty pharmacy).
5. RN signs the consent via the wizard with capture_method=`typed_signature_in_app` (patient signature) + step-up.
6. M39 emits `m39.consent.signed`; M5 promotes the privacy flag from `unconfirmed` to `confirmed`; M22 renders the `consent_record` PDF; M22's chart-extraction-discrepancy resolver (if any extracted candidate had been blocked) re-evaluates with `sud_consent_present=true` for the named recipients.

**Done means:** the M22 extraction review queue's banner clears for this patient; subsequent disclosure attempts from M28/M29 to the named recipients pass with `redactSudContent=false`; disclosure attempts to un-listed recipients still get `redactSudContent=true`; the entire flow from `m22.intake.sud_detected` to `m39.consent.signed` is queryable as a continuous narrative via the consent_eval_audit and M22 audit cross-reference.

### 7.5 W-CON-05 — Expiring consent reminder cadence

**Setup:** A `42_cfr_part_2_release` consent on `pt_evangeline` has `expires_at = 90 days from now`; no tenant overlay; default reminder cadence.

**Steps:**
1. T-90d: hourly cron walks; finds the consent; inserts `consent_expiration_reminder` with `reminder_kind='90_days'`; emits `m39.consent.expiring_soon` with NORMAL severity; M36 routes to compliance_officer + privacy_officer + assigned RN.
2. T-30d: same flow; severity NORMAL.
3. T-14d: same; severity HIGH; M36 escalation policy fires (Slack-equivalent in-app channel + email).
4. T-7d: same; severity HIGH; M36 also adds the consent to the M14 compliance dashboard tile.
5. T-1d: same; severity CRITICAL; M36 may invoke the M20 SOS-voice-escalation if recipients haven't acknowledged; renewal-cycle row inserted on first 30-day reminder; assigned RN gets a banner on patient chart "Consent renewal required by <date>".
6. RN captures renewal via route 20; new consent_record with `renewed_from_consent_record_id=<old>`; old consent transitions to `expired` after its expires_at passes.

**Done means:** all five reminders fire on the documented cadence (verified via `consent_expiration_reminder.fired_at` timestamps); the idempotency_key guard prevents duplicate firings if the cron retries; the M36 alert recipients change when the assigned RN changes mid-cycle (verified by an integration test that swaps the M5 caseload assignment mid-cycle).

### 7.6 W-CON-06 — Tenant overlay tightening (cannot loosen)

**Setup:** Tenant `engrace_hospice_or` wants to tighten the `42_cfr_part_2_release` capture-method floor to require `notarized` for any recipient kind `irb`.

**Steps:**
1. Org admin navigates to `/admin/consent-types/overlay`; selects `42_cfr_part_2_release`; adds tighter rule "capture_method must be `notarized` when any recipient.recipient_kind='irb'".
2. Submit fires route 2; M39 validates: `notarized ∈ platform_floor.capture_method_floor` (it is); the rule is a tighten (it adds a constraint, doesn't remove one).
3. Overlay row inserted with `published_at`, `published_by_id`.
4. Compliance officer at a different tenant attempts to publish an overlay that would remove `notarized` from the floor for `dpoa_healthcare` (loosen attempt).
5. Submit fires route 2; M39 validates: the proposed overlay removes a platform-floor capture method → reject with `422 overlay_loosens_platform_floor` and field-level diff against the floor.

**Done means:** the engrace tenant's `42_cfr_part_2_release` consent capture wizard now refuses non-notarized capture methods for IRB-kind recipients (verified by attempting to sign with `electronic_portal_signature` for an IRB recipient and getting `422 capture_method_below_tenant_overlay`); the loosening attempt is recorded in M4 audit with `severity='warn'`.

### 7.7 W-CON-07 — Post-death consent termination (D13)

**Setup:** Patient `pt_frances` is on hospice; has active consents of types `hipaa_release` (to her attorney), `family_caregiver_access` (her son, `survives_death=true`), `42_cfr_part_2_release` (a substance-use treatment recipient, `survives_death=false`), and `portal_access`.

**Steps:**
1. M6 emits `m6.discharge.death` with `patientId=pt_frances`.
2. M5 sets `patient.deceased=true`; emits `m5.patient.deceased`.
3. M39's `m5-patient-deceased.ts` consumer walks active consents for `pt_frances`; for each row with `survives_death=false`, transitions `status='expired'` with `deny_reason='patient_deceased_consent_terminated'`; emits `m39.consent.expired` per row.
4. The `hipaa_release` to the attorney terminates (attorney's M22 access blocks); the `42_cfr_part_2_release` terminates; the `portal_access` terminates.
5. The `family_caregiver_access` with `survives_death=true` is preserved; the son's portal session remains valid (subject to the standard 13-month bereavement window M16 governs).
6. M16's `bereavement.eligible` event fires; M39 receives `m16.bereavement.eligible` (no-op signal); bereavement counselor at next visit captures `bereavement_outreach_consent` separately (W-CON-11).

**Done means:** post-step-3, the `consent_eval_audit` shows `allowed=false reason='patient_deceased_consent_terminated'` for any subsequent evaluate call on the terminated consents; `family_caregiver_access` continues to return `allowed=true` for the son until the 13-month bereavement window closes; the post-mortem-eligible view (route 28) returns exactly the one survives-death consent.

### 7.8 W-CON-08 — DPOA chain-of-authority validation (D5 chicken-and-egg refusal)

**Setup:** Patient `pt_grace` is alert and capable; she signs her own `dpoa_healthcare` consent designating her daughter Mary as primary agent.

**Steps:**
1. RN creates the draft consent with `grantor_kind='patient_self'`, `acting_consent_id=null` (patient signs as herself); adds DPOA agent rows for Mary (primary) and Mary's husband (alternate_1).
2. Patient signs; consent active.
3. Six months later patient becomes incapacitated; Mary tries to sign a new `hipaa_release` consent as the DPOA agent on the patient's behalf — wizard asks for the `acting_consent_id`; Mary selects the active `dpoa_healthcare` consent.
4. M39 validates: `grantor_kind='dpoa_healthcare_agent'` AND `acting_consent_id` references an active `dpoa_healthcare` consent record that lists the acting user in its DPOA agent rows AND the activation condition is met (`upon_incapacity_attested` requires a separate physician attestation document).
5. Mary uploads the physician attestation; sign proceeds; new `hipaa_release` consent active with Mary as grantor + `acting_consent_id=<the DPOA record>`.
6. Refuse case: an unrelated person tries to sign a future consent with `grantor_kind='dpoa_healthcare_agent'` but `acting_consent_id=<the consent record they're signing>` — self-FK cycle. M39 returns `422 consent_chain_of_authority_self_reference`; the trigger `trg_cr_chain_of_authority_validate` enforces independently.

**Done means:** the chain-of-authority graph for `pt_grace` is queryable (route 5 version-chain plus the acting_consent_id edge) and shows a 2-node graph (patient-signed DPOA → DPOA-signed HIPAA release); the chicken-and-egg refusal is exercised by a unit test that attempts the self-reference and verifies the DB trigger + service-layer guard both reject independently.

### 7.9 W-CON-09 — Right-of-access export gate (HIPAA §164.524)

**Setup:** Patient `pt_henry` requests a copy of his record to be sent to his employer's HR for FMLA documentation. M5's right-of-access workflow is the front door.

**Steps:**
1. M5 records the request; assembles the export package; before shipping, calls `evaluate(patient=pt_henry, type='hipaa_release', sessionContext=<m5 service principal>)` AND `evaluateForDisclosure(patient=pt_henry, recipientClientId=<employer>, ...)`.
2. M39 finds no active `hipaa_release` consent naming the employer; returns `allowed=false, denyReason='no_active_recipient_matches'`.
3. M5 surfaces the deny on the right-of-access workflow UI: "Cannot ship — no active HIPAA release names this recipient. Capture a §164.508 authorization first."
4. RN captures a new `hipaa_release` consent naming the employer; signs.
5. M5 retries the evaluate; receives `allowed=true`; ships the package.

**Done means:** the `consent_eval_audit` table contains both the deny and the subsequent allow rows for the same `patient_id` + `recipientResolvedId`; the M5 workflow's "Send to recipient" button is disabled when the evaluate returns deny and the deny reason is surfaced inline; the M5/M39 boundary is preserved — M5 owns the export workflow, M39 owns the consent decision.

### 7.10 W-CON-10 — FHIR Gateway egress with SUD redaction (consumer interaction with M28 D3)

**Setup:** External HIE client is registered with M28; has a SMART Backend-Services token; queries `MedicationRequest` for `pt_imelda`. Patient has a `42_cfr_part_2_release` consent naming a different HIE (St Anthony's) and not this one.

**Steps:**
1. M28 receives the FHIR query; on every `MedicationRequest` resource projection, calls `evaluateForDisclosure(patient=pt_imelda, recipientClientId=<this HIE's M28 client id>, asOf=now)`.
2. M39 returns `{allowed: true, redactSudContent: true, ...}` — disclosure allowed for non-SUD content; SUD content must be filtered.
3. M28 filters buprenorphine `MedicationRequest` from the result set; returns Bundle with non-SUD items + `OperationOutcome` with `issue.severity='warning'` and `issue.details.text='filtered for 42 CFR Part 2; consent absent'`.
4. Later, compliance officer adds the HIE to the consent record (route 12 `add recipient`); M39 emits `m39.consent.recipient_added`; M28 client cache invalidates.
5. On the HIE's next query, `evaluateForDisclosure` returns `redactSudContent: false`; the buprenorphine resource projects.

**Done means:** the M28 §7.3 workflow (W-FHIR-03) passes against the M39 ConsentEvaluator implementation; the OperationOutcome's narrative is consistent across both query cycles (consumer is informed of the filtering reason); the M39 audit table records both evaluate calls with the version-at-eval before and after the recipient was added.

### 7.11 W-CON-11 — Post-mortem bereavement outreach consent capture

**Setup:** Patient `pt_jeanne` died last week; her son, primary caregiver, was on the M5 `is_primary=true` flag at death; her daughter was a `family_caregiver_access` grantee with `survives_death=false` (so that consent terminated at death); a sister surfaced post-death and was added to M16's `bereaved_contact` roster.

**Steps:**
1. M16's roster-seeder proposes 3 bereaved contacts: son (primary, implicit consent per M16 D6 CoP 418.64(d) interpretation), daughter (was a caregiver pre-death — needs new consent), sister (post-death surfaced — needs new consent).
2. Bereavement counselor at the first contact captures `bereavement_outreach_consent` for the son (route 29) — even though M16 D6 says the primary caregiver has implicit consent, the documented consent is preferred per platform-floor practice; `grantor_kind='bereaved_person_self'`, scope channels = phone + sympathy_card + anniversary_letter.
3. Counselor at the same visit attempts a `bereavement_outreach_consent` for the daughter — the daughter says yes; counselor captures with the daughter as grantor (`grantor_caregiver_id=<daughter M5 row>`); the patient (decedent) is the `patient_id` on the consent record.
4. The sister, contacted by phone, gives verbal consent; counselor captures with `capture_method='witnessed_verbal_documented'` + witness attestation note.
5. M39 emits `m39.consent.signed` for each; M22 renders `consent_record` PDFs; M16's listener confirms the `bereaved_contact.consent_record_id` linkage.

**Done means:** all three contacts in M16 have `consent_record_id` FK populated to a `bereavement_outreach_consent` consent record with `patient_id=pt_jeanne` (the decedent), `grantor_kind='bereaved_person_self'`, `grantor_caregiver_id=<respective bereaved contact>`; the consent records survive in `compliance` retention class for the 13-month bereavement window plus retention floor; revocation by any one bereaved person cascades only to that one M16 outreach schedule (per M16 §2.6 D6).

### 7.12 W-CON-12 — Revocation by patient-self via portal (no step-up; reason floor relaxed)

**Setup:** Patient `pt_kira` has an active `media_release` consent; opens her portal session; revokes it from her portal-side consent list.

**Steps:**
1. Patient navigates to `/api/v1/portal/consents/active`; sees her active consents.
2. Selects the `media_release` row; taps "Revoke"; portal renders a confirmation modal with the M22-rendered consent PDF preview alongside the revocation form.
3. Patient submits with `reason_text="changed my mind"` (5 chars — well below the 40-char staff floor, but the portal route allows it because `revoked_by_kind='patient_self_via_portal'` per D7).
4. M39 inserts the revocation row; emits `m39.consent.revoked` with `cascadeKind='media_release'`.
5. M22 consumer locates prior-rendered media artifacts for `pt_kira` (case-study photos in an internal training deck); tags them `disclosure_restricted=true`; emits `m22.media.disclosure_restricted`.
6. The patient sees an immediate confirmation: "Your consent has been revoked. Past uses of your image or voice in our materials are being flagged for restriction. We will notify you within 30 days of the disposition of those materials per HIPAA §164.508(b)(5)."

**Done means:** no step-up was required (portal session class is its own auth posture per D16); reason floor of 40 chars is relaxed for patient-self revocations per D7; the M22 cascade is operative and audit-visible; the M39 audit row captures `revoked_by_kind='patient_self_via_portal'` distinct from a staff-side revocation.

-----

## 8. Audit & Observability

### 8.1 Audit Events Catalog

M4 PHI write-audit triggers fire automatically on every owned table mutation per the M4 generator pattern; M39 also emits the following logical audit events via the `auditEvent()` helper (M4 §3.2) for events that don't correspond to a single-table write:

| Event key | Severity | Body |
|---|---|---|
| `m39.consent.signed` | info | `{ consentRecordId, patientId, typeKey, signedBy, captureMethod, stepUpEvidenceId }` |
| `consent.supersession_chain_extended` | info | `{ newConsentRecordId, supersededConsentRecordId, patientId, typeKey }` |
| `m39.consent.revoked` | warn (patient-self) / critical (staff or court-order) | `{ consentRecordId, revocationId, revokedByKind, reasonTextHash }` |
| `consent.eval_denied` | info | `{ consentRecordId?, patientId, typeKey, callerModule, callerRoute, denyReason }` |
| `m39.consent.recipient_added` | info | `{ consentRecordId, recipientId, recipientKind, recipientEntityId? }` |
| `m39.consent.recipient_removed` | warn | `{ consentRecordId, recipientId, removedBy, reason }` |
| `consent.dpoa.agent_appointed` | warn | `{ consentRecordId, dpoaAgentId, agentKind, agentName, activationCondition }` |
| `consent.dpoa.agent_removed` | warn | `{ consentRecordId, dpoaAgentId, agentKind, reason }` |
| `m39.consent.renewal_cycle_opened` | info | `{ cycleId, sourceConsentRecordId, patientId, typeKey, nextActionDueAt }` |
| `consent.renewal_completed` | info | `{ newConsentRecordId, renewedFromConsentRecordId, patientId, typeKey }` |
| `consent.cascade_handler_failed` | critical | `{ consentRecordId, revocationId, consumerName, attemptCount, lastError }` |
| `consent.tenant_overlay_published` | warn | `{ overlayId, typeKey, publishedBy, changes }` |
| `consent.tenant_overlay_rejected_loosens_floor` | critical | `{ attemptedById, typeKey, fieldsLoosened }` |
| `consent.post_mortem_termination` | info | `{ consentRecordId, patientId, typeKey, deceasedAt }` |
| `consent.ai_block_validator_failed` | critical | `{ blockedPromptKey, m32PromptRegistryRow }` |

Severity tiers map to M4 retention + alert routing per M4 §6.

### 8.2 Metrics (Prometheus)

```
m39_consent_records_active_total{type_key,organization_id}                     # gauge
m39_consent_records_signed_total{type_key,organization_id}                     # counter
m39_consent_records_revoked_total{type_key,revoked_by_kind,organization_id}    # counter
m39_consent_records_expired_total{type_key,organization_id}                    # counter
m39_consent_evaluate_calls_total{type_key,caller_module,allowed,organization_id} # counter
m39_consent_evaluate_latency_ms{type_key,caller_module}                        # histogram
m39_consent_evaluator_db_query_count{method}                                    # counter — D11 perf telemetry
m39_consent_revocation_cascade_duration_ms{type_key}                           # histogram
m39_consent_revocation_cascade_status_total{type_key,cascade_status}           # counter
m39_consent_revocation_cascade_consumer_failure_total{consumer_name}           # counter
m39_consent_renewal_cycles_open_total{type_key,organization_id}                # gauge
m39_consent_renewal_cycles_closed_total{closed_reason,organization_id}         # counter
m39_consent_expiration_reminders_fired_total{reminder_kind,type_key}           # counter
m39_consent_eval_audit_partition_size_rows{partition_month}                    # gauge
m39_consent_delegated_access_active_total{scope_kind,organization_id}          # gauge
m39_consent_dpoa_active_agents_total{agent_kind,organization_id}               # gauge
m39_consent_tenant_overlay_publish_attempts_total{outcome,organization_id}     # counter
m39_consent_chain_of_authority_validation_failures_total{failure_kind}         # counter
```

### 8.3 OpenTelemetry Spans

| Span | Attributes |
|---|---|
| `m39.consent.sign` | `consent.type_key`, `consent.capture_method`, `consent.patient_id`, `step_up.evidence_id` |
| `m39.consent.evaluate` | `consent.type_key`, `consent.caller_module`, `consent.caller_route`, `consent.allowed`, `consent.deny_reason?` |
| `m39.consent.evaluate_for_disclosure` | `consent.recipient_resolved_kind`, `consent.recipient_resolved_id?` |
| `m39.consent.evaluate_for_ingress_redaction` | `consent.patient_id` |
| `m39.consent.evaluate_bulk` | `consent.batch_size`, `consent.allowed_count`, `consent.denied_count` |
| `m39.consent.revoke` | `consent.type_key`, `consent.revoked_by_kind`, `consent.cascade_consumer_count` |
| `m39.consent.revocation_cascade` | `consent.revocation_id`, `consent.cascade_status`, child spans per consumer |
| `m39.consent.renew` | `consent.type_key`, `consent.renewed_from_consent_record_id` |
| `m39.consent.tenant_overlay_publish` | `consent.type_key`, `consent.organization_id`, `consent.validation_result` |
| `m39.consent.chain_of_authority_validate` | `consent.acting_consent_id`, `consent.validation_path[]` |

All spans correlate via the request `traceId` propagated through the M1 outbox envelope.

### 8.4 Log Events of Note

- `m39.consent.evaluate_slow` — when `evaluate_latency_ms > p99 threshold (target 30ms per D11)` log a structured warn entry with the type_key + caller_module + DB query plan summary.
- `m39.consent.cascade_consumer_retry_exhausted` — when a consumer ACK fails 5 times; log structured error with consumer_name + last_error + outbox event id.
- `m39.consent.ai_block_validator_pass` — log at boot when `validateM39AIBlock` passes; useful for ops to confirm the boundary is operative.
- `m39.consent.draft_auto_expired` — log info per discarded draft (rare; mostly stale "started but abandoned" flows).

### 8.5 STRIDE Map

| Threat | Mitigation |
|---|---|
| **Spoofing** an RN session to sign a consent | M2 SESSION_POLICY `consent_management` profile requires step-up (biometric/passkey) for every sign action; the step-up token's freshness is re-validated at sign time; the audit row carries the step-up evidence ID |
| **Tampering** with consent_record after sign | DB CHECK constraints + service-layer guards refuse any mutation to a `signed` row except via the supersede or revoke paths (each of which appends a NEW row, never mutates); the M4 write-audit trigger captures every attempt |
| **Tampering** with consent_eval_audit to hide an unauthorized access | `consent_eval_audit` is INSERT-only at the DB trigger level; UPDATE/DELETE refused; partition drops are M4 retention-managed and audit-logged separately |
| **Tampering** with a revocation row to fake compliance | `consent_revocation` is INSERT-only; the M4 audit-event linkage stamps the actor + IP + timestamp in the same transaction; the reason text floor (≥40 chars) is a DB CHECK; staff-revocations require evidence_document_id (DB CHECK) |
| **Tampering** with a tenant overlay to loosen the floor | The `consent_type_resolver` service enforces tighten-only at publish time; the `validateOverlayDoesNotLoosen` golden-diff check rejects loosening attempts at publish; M3's `org_admin_or_compliance` ABAC gates the route; a successful loosen would still be visible in the M4 audit trail |
| **Repudiation** of who signed a consent | The `consent_record.signed_by_id` + `m4_audit_event_id` + the M2 step-up token's audit row record the biometric/passkey signature; the trail is end-to-end signed at every step |
| **Repudiation** of who revoked a consent | Same pattern as sign: `consent_revocation.revoked_by_user_id` + `m4_audit_event_id` + step-up evidence; the staff revocation requires `evidence_document_id` (an M22 doc upload) so the revocation has a non-system artifact |
| **Information disclosure** via consent_eval_audit row containing PHI | The audit row carries the patient_id (PHI) but no free-text fields; `redacted_categories[]` is structural; the table-level RLS + the `consent.read_eval_audit` permission scope the read to compliance/privacy/auditor roles only |
| **Information disclosure** via the consent record's `internal_notes_cipher` field | Encrypted via per-tenant DEK envelope (M1 helper); decryption requires `consent.read_phi_content` permission + ABAC pass; the M4 audit denylist substitutes `<scrubbed:N chars>` in audit payloads |
| **Information disclosure** of recipient identity (a known recipient may itself be PHI; e.g., naming an addiction-treatment center as a recipient indirectly discloses SUD context) | `consent_record_recipient.recipient_free_text` is denylisted in M4 audit payload; the per-route ABAC requires `consent.read` or higher to expose recipient identity |
| **Denial of service** via consent_eval_audit volume | The table is partitioned monthly + the M1 partition-maintenance cron pre-creates next-month partitions; the M4 retention sweep drops old partitions on schedule (Phase 2 cold-storage migration handles longer retention) |
| **Denial of service** via stuck revocation cascade flooding M36 alerts | The cascade-retry cron has an exponential-backoff budget per consumer; on exhaustion the row transitions to `partial_failed` and a single CRITICAL alert fires (not one per retry); the M36 alert dedup helper coalesces |
| **Elevation of privilege** via a forged `acting_consent_id` (signing as DPOA when not actually a DPOA agent) | The `trg_cr_chain_of_authority_validate` trigger validates the chain server-side: the acting consent must be active + the acting user must be in the DPOA agent rows of the acting consent + the activation condition must be met (with evidence document if required); the service layer enforces independently |
| **Elevation of privilege** via tenant overlay attempting to loosen floor | Already in tampering row; also: the M4 audit `severity='critical'` on the rejected attempt ensures the attempt is visible to the platform Security Officer via the routine audit review |

### 8.6 Eraser + Retention

- **Retention class:** `consent` (registered with M4 retention class registry at boot per §4.4).
- **Default retention:** 7 years from `expires_at` (or from `revoked_at` if revoked, or from `superseded_at` if superseded — the latest applicable date) per HIPAA §164.530(j)(2) hospice extension; state-overridable via M4.
- **Legal hold:** the M4 legal-hold mechanism extends retention indefinitely while the hold is active; the eraser refuses to delete consent records under hold.
- **Destruction-cert eraser** (registered under the data-class key `consent` — M39-F04 / ADR-0251 / ARCH-234; the M4 boot validator keys erasers by data class, not by the descriptive `consent_record_subtree` label):
  - Refuses if any consent record on the patient has an active legal hold (unless `legalHoldOverride=true`).
  - Does **NOT** delete `consent_eval_audit` — that table is immutable audit (INSERT-only, `trg_cea_immutable`); its destruction is routed through M4's audit-partition retention / destruction-cert workflow (M39-F04 / ADR-0251, ARCH-234). The eraser schedules eval-audit destruction with M4 but never issues a `DELETE` against the immutable audit table.
  - Cascade-deletes the projection (`delegated_access`).
  - Cascade-deletes the satellite tables (`consent_renewal_cycle`, `consent_expiration_reminder`, `consent_revocation`, `consent_record_dpoa_agent`, `consent_record_recipient`, `consent_document_link`) in FK order.
  - Finally deletes the consent records in supersession-chain order (leaves first), walking the self-FK.
  - Atomic per patient; partial failure rolls the entire patient back.
  - Emits `m39.consent.subtree_erased` for downstream cleanup (M22 has its own eraser for the rendered PDFs).

### 8.7 AI Boundary Enforcement (D17)

`validateM39AIBlock(m32.promptRegistry)` runs at boot and refuses to start if M32's prompt registry contains any template that:

- writes to any M39-owned table (matched by `target_table_writes` metadata on M32 prompt rows), OR
- emits any `m39.consent.*` outbox event, OR
- invokes the `ConsentEvaluator` seam from a non-read-only path, OR
- generates content rendered into any M22 `consent_record`-template-key payload field except via the `ConsentStateAdvisoryProvider` seam (which is read-only by contract).

The validator is also re-run nightly by `ai-block-validator.cron.ts`; failure raises a CRITICAL alert.

-----

## 9. Test Plan

### 9.1 Unit Tests (target ≥ 90% coverage; ≥ 95% on named services)

Coverage targets named services:
- `consent-evaluator.ts` (the seam implementation) — ≥ 95% lines + branches; property-based tests on the version-walking + asOf semantics.
- `chain-of-authority-validator.ts` — ≥ 95%; exhaustive case coverage of grantor_kind × acting_consent presence/absence × activation condition × self-reference.
- `consent-type-resolver.ts` (platform-floor + tenant overlay merge) — ≥ 95%; property-based tests on tighten-only invariant.
- `post-mortem-gate.ts` — ≥ 95%; all 10 consent types × survives_death true/false × pre-/post-death.
- `delegated-access-projector.ts` — ≥ 95%; projection-rebuild correctness across consent versioning.
- `abac-predicates.ts` (11 resolvers) — ≥ 90% each; each predicate tested with active / expired / revoked / superseded / pre-/post-death fixtures.
- `revocation-service.ts` — ≥ 95%; cascade-status transitions; consumer dedup; partial-failed alerting.

Representative cases:
- evaluate() with `asOf` strictly before consent.signed_at returns `allowed=false reason='no_active_consent_on_file'`
- evaluate() with `asOf` in the version chain returns the consent state at that point (verified by reconstructing from supersession edges)
- evaluate() with patient.deceased=true returns `allowed=false reason='patient_deceased_consent_terminated'` for non-survives-death types
- evaluate() with `family_caregiver_access` and survives_death=true returns `allowed=true` post-death within the bereavement window
- evaluate() with parent_for_minor grantor when patient ages out returns `allowed=false reason='patient_aged_out_parental_consent'`
- evaluate() for per-recipient consent with no matching active recipient returns `allowed=false reason='no_active_recipient_matches'`
- chain-of-authority refuses self-reference (consent.id == consent.acting_consent_id) at service + DB trigger
- chain-of-authority refuses missing activation evidence when condition='upon_physician_determination'
- tenant overlay tighter-only rejects when proposed capture-method floor is a strict subset of platform floor (loosen attempt)
- revocation cascade idempotency: 3 deliveries of the same `m39.consent.revoked` event to a consumer result in exactly 1 effect

### 9.2 Integration Tests (Testcontainers — Postgres + Valkey)

- Full sign → render → backref cycle: patch boot to register an M22 fake renderer; signing a consent triggers the M22 render path; the `consent_document_link` row populates within p95 = 15s; the consent_record's `signed_at` is server-stamped.
- Revocation cascade with 5 simulated consumers (M2 session-terminate fake, M22 signed-URL revoke fake, M5 snapshot fake, M28 cache invalidator fake, M16 cascade fake): all 5 ACK within 30s; `cascade_status` transitions to `completed`; tenant alert is suppressed.
- Revocation cascade with 1 consumer permanently failing: after 5 retries the row transitions to `partial_failed`; one CRITICAL alert fires; remaining consumers complete normally.
- Expiration reminder cron walks the table at hourly cadence; reminder rows insert idempotently (duplicate cron run inserts zero new rows).
- consent_eval_audit partition pre-creation: the nightly cron pre-creates next-month partition; eval calls land in the right partition.
- Eraser end-to-end: a destruction-cert workflow for `pt_X` deletes all consent_record + recipients + DPOA agents + revocations + reminders + delegated_access + consent_eval_audit rows + consent_document_link rows; no row left behind; M22 receives `m39.consent.subtree_erased`.
- Tenant overlay publish + render: publishing a tighter overlay for `42_cfr_part_2_release` immediately blocks subsequent capture attempts that don't meet the tightened floor.

### 9.3 RLS Isolation Tests

3-org × 100-consent × 50-recipient × 20-DPOA × 10K-eval-audit-row fixture:
- Org A's `chartwarden_app` role cannot SELECT/INSERT/UPDATE/DELETE any of Org B or Org C's rows in any of the 11 tables.
- `consent_type_catalog` is readable by all three orgs (platform-shared).
- `consent_type_catalog` is NOT writable by any of the three orgs' `chartwarden_app` role; only `wardenx_platform_admin` can INSERT/UPDATE; verified with explicit denial test.
- `consent_eval_audit` partition table inherits RLS from parent (verified by a SELECT from Org A returning zero Org B rows even when the underlying partition contains both).

### 9.4 IDOR / Layer-Independence Tests

- IDOR — actor in Org A attempts to fetch a consent_record by ID belonging to Org B → 404 (not 403 — to avoid information disclosure).
- IDOR — actor's session is scope=`external_collaborator` for patient X attempting to fetch consents for patient Y → 404.
- Layer independence — RBAC stubbed open, RLS still scopes — verified by removing all M3 permission grants and confirming Org A's session still cannot see Org B's rows (per Security Hardening §6.1).
- Layer independence — RLS stubbed open (test-only), ABAC still scopes — verified by allowing cross-tenant reads and confirming the `consent.read` permission still requires `caseload_or_scope`.

### 9.5 Security Tests

- **Step-up freshness** — a sign attempt with a `step_up_evidence_id` older than 5 minutes returns `403 step_up_stale`; the route does not write.
- **Notarization evidence required** — a sign attempt with `capture_method='notarized'` but `capture_evidence_jsonb.notary_certificate_document_id=null` returns `422 notary_evidence_required`.
- **Witness signature evidence required** — `capture_method='witnessed_verbal_documented'` requires `witness_signature_evidence_document_id` (an M22 doc ref); validation refuses the sign otherwise.
- **AI-prohibited path attempt** — registering an M32 prompt template with `target_table_writes=['consent_record']` causes the boot validator to refuse to start; the structured error message identifies the offending template key.
- **Chain-of-authority cycle attempt** — POST to route 6 with `acting_consent_id=self` returns `422 chain_of_authority_self_reference`; the trigger blocks even when the service-layer guard is bypassed (test by direct INSERT via `chartwarden_app` role).
- **Forged DPOA agent attempt** — POST to route 15 with `agent_kind='primary'` when a primary agent already exists on the consent returns `422 primary_dpoa_already_assigned`; the partial unique index enforces.
- **Revocation reason floor bypass attempt** — staff revoke with `reason_text="short"` (5 chars) returns `422 reason_text_below_staff_floor`; the DB CHECK enforces.
- **Survey-record-relevant** — the `consent_eval_audit.id` is UUIDv7 per M1 and not guessable; ID-enumeration attacks blocked at the routing layer.

### 9.6 E2E (Playwright + Capacitor where mobile-applicable)

- **Web — full HIPAA release admission capture** — intake nurse logs in; navigates to patient consents; runs the wizard; signs with biometric step-up; sees the rendered PDF in the dashboard; confirms `consent_eval_audit` entries on subsequent right-of-access export attempts.
- **Web — 42 CFR Part 2 release with recipient addition over time** — exercises W-CON-02 scenario end-to-end including the FHIR gateway test fixture.
- **Web — revocation cascade with portal session termination** — exercises W-CON-03; verifies M2 session termination is observable via portal-session probe.
- **Web — SUD detection → interim flag → consent capture** — exercises W-CON-04 with M22 DocLens test fixture and M5 flag promotion.
- **Web — expiring consent reminder cadence** — accelerated time (using the M1 test-time-helper); cron fires at each milestone; M36 alerts visible.
- **Web — tenant overlay publish + reject loosen** — exercises W-CON-06 from the org admin's console.
- **Web — post-death consent termination** — exercises W-CON-07 including the bereavement consent capture follow-up.
- **Web — DPOA chain-of-authority validation** — exercises W-CON-08; verifies the chicken-and-egg refusal at both service and DB-trigger layers.
- **Mobile — bedside consent capture via Capacitor** — touch signature pad; biometric step-up; offline-buffered draft syncs on reconnect.
- **Mobile — counselor post-mortem bereavement outreach consent capture** — exercises W-CON-11 from the MSW/counselor home-visit context.
- **Portal — patient self-revocation** — exercises W-CON-12; verifies the relaxed reason floor and the immediate confirmation copy.
- **Portal — caregiver delegated-access scope check** — daughter logs into portal with `family_caregiver_access` scope = `view_only_full`; attempts to message care team; sees `403 scope_insufficient` (the consent didn't include messaging); patient amends consent to `view_and_message`; daughter retries → succeeds.

### 9.7 Performance Targets (per System Design §9)

- `ConsentEvaluator.evaluate()` p95 = 30ms / p99 = 60ms at 1000 RPS across 1M consent records.
- `evaluateBulk()` p95 for 100 patient batch = 200ms; p99 = 500ms.
- `evaluateForDisclosure()` (per-FHIR-resource cost) p95 = 25ms / p99 = 50ms (the M28 hot path; budget is tight).
- **M39-F15 / ARCH-110 — bulk FHIR egress eval-audit write:** `evaluateBulk()` with `batchContext` (M28 `$export` paths) writes exactly **1 `consent_eval_audit` row per (recipient × export request)**, regardless of the number of patientIds or FHIR resources in the export. The single batched audit write must complete within the same DB transaction as the bulk evaluation; target p95 = 10ms for the batched write (same as a single-row eval-audit insert — the row is wider but the count is fixed at 1). The k6 bulk-export fixture (10K patients × 1 export request) must produce exactly 1 `consent_eval_audit` row, not 10K rows; the integration test asserts `SELECT COUNT(*) FROM consent_eval_audit WHERE caller_route = '<exportRequestId>'` = 1.
- Revocation cascade end-to-end (M2 + M22 + M5 + M28 fake consumers) p95 = 5s / p99 = 15s.
- Consent capture (POST draft → POST sign → M22 render arrival) p95 = 15s / p99 = 30s.
- Expiration reminder cron full sweep across 100K consents p95 = 2 minutes.
- consent_eval_audit insert p95 = 8ms / p99 = 20ms.
- k6 perf test fixture: 1M consents × 10K eval/sec × 30-minute sustained load; observed p95/p99 under target.

### 9.8 Fixtures

- **Ten v1 consent type seeds** — covering all platform consent types per the catalog seed.
- **DPOA chain-of-authority fixture** — patient with active DPOA → DPOA-signed HIPAA release → DPOA agent revoked → alternate becomes primary path.
- **Revocation cascade fixture** — 5 consumer modules each with a fake idempotent ACK.
- **Multi-recipient `42_cfr_part_2_release` fixture** — patient with 3 active recipients of different kinds, with one recipient expiring mid-test.
- **Post-death cascade fixture** — patient with all 10 consent types, exactly half `survives_death=true`.
- **Tenant overlay fixture** — Engrace overlay tightening `42_cfr_part_2_release` notary requirement for IRB recipients.
- **AI block-violation fixture** — a fake M32 prompt registry entry that should trip `validateM39AIBlock`.

-----

## 10. Implementation Tasks

Phase A — Foundation (week 1, schema + boot + seam shapes):
1. **A1** Drizzle schema for all 11 tables; migration `0039_consent.sql`; RLS via M1 generator; partition setup for `consent_eval_audit`.
2. **A2** Seed `consent_type_catalog` with the 10 v1 types (+ `bereavement_outreach_consent` + custom slot reservation); platform-floor expiration policies; capture-method floors; reminder cadence floors.
3. **A3** Boot module `boot.ts` registering all consumed seams (require), all published seams (publish), the 11 ABAC predicate resolvers (declared but stubbed initially), the eraser, the retention class, the SESSION_POLICY profile, the M36 alert rules + recipient resolver, the AI-block validator.
4. **A4** Forward-seam deny-stubs: `m31.portal-session-terminator`, `m28.fhir-client-cache-invalidator` (logged-deferral pattern).

Phase B — Consent capture + sign + revoke (week 2):
5. **B1** Routes 1, 3, 4, 6, 7, 8 (catalog read, patient consents read, consent detail, create draft, edit draft, sign).
6. **B2** Service `consent-record-service.ts` — sign + supersede + revoke; chain-of-authority validator wired; service-layer self-FK guard.
7. **B3** Routes 10, 11, 12, 13 (revoke, recipient list, add/remove recipient).
8. **B4** Route 9 (supersede) + the `m39.consent.supersedes` event emission.
9. **B5** Triggers `trg_cr_supersede_consistency` + `trg_cr_chain_of_authority_validate` + `trg_revocation_set_cascade_status` (derived-column maintenance only; **no `outbox_event` writes** — the `m39.consent.revoked` event is emitted by `revokeConsent` in the service layer via the M1 outbox helper in-transaction per §4.5, M39-F08 / ARCH-144/264).

Phase C — DPOA + delegated_access projection (week 3):
10. **C1** Routes 14, 15, 16, 17 (DPOA agent list, add, modify, active-primary lookup).
11. **C2** Service `dpoa-agent-service.ts` + primary-uniqueness constraint exercise.
12. **C3** Service `delegated-access-projector.ts` — rebuild projection on `family_caregiver_access` consent changes.
13. **C4** Routes 21, 28 (delegated_access read, post-mortem-eligible).
14. **C5** Event `m39.consent.dpoa.agent_appointed` → M7/M11/M14 backref consumers stubbed.

Phase D — ConsentEvaluator seam + the 11 ABAC predicates (week 4):
15. **D1** Service `consent-evaluator.ts` — all 4 methods (`evaluate`, `evaluateForDisclosure`, `evaluateForIngressRedaction`, `evaluateBulk`) with the version-walking + asOf semantics.
16. **D2** Service `eval-auditor.ts` — synchronous audit-insert wrapping every evaluate call.
17. **D3** All 11 ABAC predicate resolvers wired to M3's named-predicate registry; each predicate has its own unit test suite.
18. **D4** Performance pass — DB indexes confirmed via EXPLAIN ANALYZE on canonical evaluate queries; p95 = 30ms verified on 1M-row fixture.

Phase E — Expiration + renewal + reminders (week 5):
19. **E1** Worker `expiration-reminder.cron.ts` — hourly walk + idempotent insert + M36 emit.
20. **E2** Worker `consent-expiration.cron.ts` — hourly transition to `expired`.
21. **E3** Service `renewal-service.ts` + route 20 (renew) + worker `renewal-cycle-close.cron.ts`.
22. **E4** Routes 18, 19 (expiring consents view, renewal cycle view).

Phase F — Revocation cascade + tenant overlay (week 6):
23. **F1** Service `revocation-service.ts` — per-consumer ACK tracking + cascade-status transitions + outbox emission with typed per-type cascade descriptor.
24. **F2** Worker `revocation-cascade-retry.cron.ts` — every 30s sweep of stuck cascades.
25. **F3** Routes 2, 12 (overlay publish), 30 (cascade retry).
26. **F4** Service `consent-type-resolver.ts` + golden-diff validator for overlay loosen-attempt rejection.
27. **F5** AI-block validator wired at boot and to nightly cron `ai-block-validator.cron.ts`.

Phase G — Frontend (web) + portal forward-stub (week 7):
28. **G1** Screens 1, 2, 4 (patient dashboard, consent detail, capture wizard) — TanStack Router + Query + the M22 PDF preview component.
29. **G2** Screen 3 (version-chain viewer) — D3 visualization library `@nivo/network` for the chain.
30. **G3** Screens 5, 6, 7, 8 (recipients, DPOA agents, revocation drawer, renewal wizard).
31. **G4** Screens 9, 10, 11, 12, 13 (compliance surfaces).
32. **G5** Portal-side routes 25, 26, 27 — forward-stubbed UI behind a Phase-2 flag.

Phase H — M22 integration + post-mortem flow + bereavement outreach (week 8):
33. **H1** M22 outbox-consumer `m22-document-rendered.ts` — backref stamping.
34. **H2** M5 outbox-consumer `m5-patient-deceased.ts` — D13 cascade across all active consents.
35. **H3** Route 29 (bereavement_outreach consent author) + the M16 backref consumer.
36. **H4** Route 24 (admin re-render) for ops use.

Phase I — Testing + ops + sign-off (weeks 9–10):
37. **I1** Unit tests passing per §9.1 coverage targets.
38. **I2** Integration tests passing per §9.2.
39. **I3** RLS isolation + IDOR + Security tests passing per §9.3–9.5.
40. **I4** E2E + Mobile + Portal Playwright tests passing per §9.6.
41. **I5** k6 perf tests within targets per §9.7.
42. **I6** axe-core a11y scan passes on all M39 web surfaces.
43. **I7** Operations runbook update — recovery procedures for stuck cascades, partition maintenance, AI-block validator failure response.
44. **I8** Architecture doc patch (v0.12 next minor) — update M39 entry to reference this spec.
45. **I9** Module `README.md` complete with seam-consumer documentation for downstream module authors.
46. **I10** Manifest patch (§13) merged; dependency-cruiser CI passes; table-ownership lint passes.

Critical path: A → B → D (the seam is the linchpin) → E + F (in parallel) → G + H (in parallel) → I.

-----

## 11. Resolved Decisions

Decisions are wired to single constants / interfaces, not scattered.

| # | Decision | Rationale | Status |
|---|---|---|---|
| **D1** | **Append-only versioned `consent_record` with explicit supersession chains.** Every "edit" is a new row; self-FK `supersedes_consent_record_id` + `superseded_at` + `superseded_by_consent_record_id`; cycle-prevention via DB CHECK on self-FK; service walks the chain on point-in-time queries. | Survey reconstruction requires a write-once narrative; mid-life scope edits cannot lose prior consent state; the chain is the audit. | **Decided** |
| **D2** | **Platform-shared `consent_type_catalog` of 10 v1 types + `bereavement_outreach_consent` + tenant-extensible `custom` slot; tenant overlay is tighten-only with golden-diff validator.** Dual-grant pattern per M40 §3.6 — PLATFORM scope writes, anyone-read within tenant. | Compliance criticality demands platform-floored types; tenant customization is real (per-state addendum) but must not weaken regulatory floors. | **Decided** |
| **D3** | **`bereavement_outreach_consent` is a first-class M39 type, not a special case carved out elsewhere.** Lives in `consent_type_catalog` alongside the other 10; M16 holds the FK on `bereaved_contact.consent_record_id`. | M16's regulatory artifact (CoP 418.64(d) coverage proof) is the consent record; unifying the model simplifies the entire revocation cascade + audit surface. | **Decided** |
| **D4** | **Five capture methods**: `electronic_portal_signature` (M31 with biometric/passkey per M2 portal session class), `typed_signature_in_app` (staff captures patient name + role with witness attestation when patient is in-room), `uploaded_signed_pdf` (paper consent scanned via M22 intake), `witnessed_verbal_documented` (last-resort; requires witness attestation + signature evidence doc; permitted only for code-status/AD acknowledgment with documented patient incapacity), `notarized` (extra evidence layer for high-stakes types like DPOA when tenant overlay or jurisdiction requires). Per-type floor enumerated in `consent_type_catalog.capture_method_floor[]`. | Hospice consent capture happens across in-person bedside, home visit, telephonic, paper-by-fax, and portal-self-service surfaces; a single enum capturing the evidence shape per channel keeps the audit narrative crisp. | **Decided** |
| **D5** | **Chain-of-authority grantor model with self-referential validation.** `grantor_kind` enum + `acting_consent_id` self-FK pointing at the consent record that *proves* the grantor's authority; self-FK refused at trigger + service; the chicken-and-egg DPOA-signs-its-own-DPOA case is unambiguously blocked. | Without explicit chain-of-authority capture, the audit narrative for a DPOA-signed consent is "Mary signed it because she said she was the DPOA" — that is not survey-reconstructable; the chain *is* the proof. | **Decided** |
| **D6** | **Per-recipient grants for the four explicitly per-recipient types** (`42_cfr_part_2_release`, `hipaa_release`, `family_caregiver_access`, `research_participation`); separate `consent_record_recipient` rows; recipients can be added/removed incrementally without re-signing if scope hasn't changed; material scope change forces new consent. | 42 CFR §2.31 explicitly requires per-recipient specificity; HIPAA §164.508 names a specific recipient; treating these as per-record categorical loses the regulatory shape; the per-row model also lets the agency track per-recipient expiration cleanly. | **Decided** |
| **D7** | **Typed revocation cascade with per-consumer idempotent ACK + cascade-status transitions + automatic retry + partial-failed alerting.** Cascade kind enumerated per consent type in `consent_type_catalog.revocation_cascade_kind`; M39 emits the canonical event; consumers ACK idempotently keyed on `(consent_record_id, revocation_id, consumer_name)`; M39 does NOT mutate downstream module rows. | The legacy "flip the boolean and hope" pattern leaves active sessions running and in-flight queries serving stale data; the typed cascade with explicit consumer-ACK tracking is the only audit-defensible posture. | **Decided** |
| **D8** | **Platform-floor expiration policies per consent type; tenant-tighten-only.** Catalog seeds defaults: `42_cfr_part_2_release`=1y, `hipaa_release`=6mo, `dpoa_healthcare`=indefinite, `telehealth_consent`=per-session, `media_release`=3y, `research_participation`=study+3y, `advance_directive_acknowledgment`=indefinite, `portal_access`=indefinite, `family_caregiver_access`=indefinite (revoke-driven), `bereavement_outreach_consent`=13mo aligned with M16 window. `max_term_seconds` ceiling per type. | Each regulatory regime has its own term reasonableness; the term shouldn't be a single platform-wide default; tenant tightening is operationally sensible (a more cautious agency wants shorter terms) but loosening creates audit risk. | **Decided** |
| **D9** | **Platform-floor reminder cadence: 90/30/14/7/1 days before expiry.** Tenant may tighten (add more reminders, or move existing earlier) but not loosen (remove or move later). Routed via M36 typed alerts; severity escalates (NORMAL → HIGH → CRITICAL). | The 90-day window is the operational signal to start the renewal conversation; the 1-day window is the alarm bell; without the multi-stage cadence, expirations slip silently. | **Decided** |
| **D10** | **DelegatedAccess as projection from `family_caregiver_access` consents.** Query-optimized for M31 portal session-minter; one row per named family member + scope; consent record remains source of truth; projector rebuilds on consent change. | The portal session-minter cannot afford to walk consent_record + consent_record_recipient + chain-of-authority on every login; the projection cuts the hot path; the source-of-truth invariant is preserved by rebuilding deterministically. | **Decided** |
| **D11** | **`ConsentEvaluator` seam with four typed query methods.** `evaluate` (general purpose, used by all 11 ABAC predicates), `evaluateForDisclosure` (M28/M22/M27/M29 disclosure paths with category-level redaction flags), `evaluateForIngressRedaction` (M29 inbound HL7 redaction), `evaluateBulk` (M5/M30/M33 list paths). | Four typed surfaces cover every downstream consumer pattern without the seam becoming a kitchen sink; the methods are bounded so M39 can index appropriately and meet the p95 = 30ms perf target. | **Decided** |
| **D12** | **Consent-version-aware `consent_eval_audit` partitioned monthly.** Every evaluate() call writes a row with the consent_record_id + version_at_eval + caller_module + caller_route + redacted_categories[]; INSERT-only at trigger level. | The HIPAA §164.528 accounting question "what did the system know about consent on date X when staff accessed record Y" must have a definitive answer; tying the audit to the *version* at eval time (not the current version) is the only way to reconstruct that. | **Decided** |
| **D13** | **Pre-death/post-death scope semantics.** Patient's own consents (other than types flagged `survives_death=true` at capture) terminate on death-discharge per 42 CFR §2.31 and HHS guidance; M5's `m5.patient.deceased` event triggers the M39 cascade transitioning non-survives-death active consents to `expired` with `deny_reason='patient_deceased_consent_terminated'`. | HHS guidance is explicit that patient consent doesn't transfer to surviving family; the cascade makes the regulatory posture deterministic without requiring per-row workflow review. | **Decided** |
| **D14** | **`bereavement_outreach_consent` is captured post-death with the bereaved person themselves as grantor** (`grantor_kind='bereaved_person_self'`), distinct from any pre-death consent; M39 owns the type; M16 holds the per-bereaved-contact FK. | The bereaved person is a different rights-holder than the deceased patient; their consent must be separately captured per HHS guidance; the consent record's patient_id remains the decedent (subject of the records) but the grantor is the bereaved person. | **Decided** |
| **D15** | **Signed PDF rendering via M22 with the `consent_record` template** (already in M22 D14 catalog). M39 emits `m39.consent.signed`; M22 renders; M22 emits `m22.document.rendered`; M39's backref consumer stamps `consent_document_link`. | M22 owns rendering; M39 owns state; the typed handshake decouples the two modules; the M22 template overlay applies tenant branding without M39 knowing. | **Decided** |
| **D16** | **Step-up auth on staff-side consent management (`consent_management` SESSION_POLICY profile)** — biometric/passkey + ≤5min freshness. Required for sign / supersede / revoke / add-recipient / add-DPOA-agent / overlay-publish. Read paths do NOT require step-up. Patient self-service through M31 portal uses the portal session class's own auth posture; M39 trusts M31's session. | These mutations are high-consequence (consent state drives downstream disclosure decisions); step-up is the proportionate control; read paths are gated by routine ABAC. | **Decided** |
| **D17** | **AI-prohibited boundary with boot validator + nightly re-validation.** AI may not create, modify, revoke, or evaluate consent. AI may, on read-only paths, surface advisories via the `ConsentStateAdvisoryProvider` seam (Phase 2 with M32). `validateM39AIBlock` rejects any M32 prompt template that would cross the line. | Consent is a regulatory commitment; an LLM hallucination on consent state is a §164.508 violation; AI advisory on read-only paths is permitted because it does not bind the system to a consent decision. | **Decided** |
| **D18** | **Forward-seam deny-stub for M31 portal-session-terminator** (logged-deferral pattern; M2 termination operative today). When M31 lands, the stub is replaced; M39 already emits the typed events M31 will subscribe to (`m39.consent.portal_access.granted/.revoked`, `m39.consent.family_caregiver_access.granted/.revoked`). | M31 is Phase 2; M39 lands in Phase 1 because the consent layer is consumed by ~17 already-locked modules; the deny-stub keeps the cascade auditable today and seamless on lock. | **Decided** |
| **D19** | **No M27 cost-report-specific consent path.** M27 reads consent state via the standard `evaluateBulk` + `evaluateForDisclosure` methods; no dedicated seam method needed. | M27's PHI-bearing surface is bounded; the existing seam shape is sufficient; avoid a one-off seam method that exists for a single consumer. | **Decided** |
| **D20** | **`compliance` retention class with 7-year HIPAA §164.530(j)(2) floor and state-overridable.** Eraser registered with M4 destruction-cert workflow; deletes consent-record subtree atomically with the M5-triggered patient eraser; legal holds supersede. | The §164.508 6-year floor is widened to 7 years by the hospice CoP 418.104(a) operational retention — taking the longer of the two as the platform-floor; state overrides via M4's existing hook. | **Decided** |
| **D21** | **Fourteen outbox event types** covering the full state lifecycle (created, signed, supersedes, revoked, expired, expiring_soon, renewal_cycle_opened, renewed, recipient_added, recipient_removed, dpoa.agent_appointed, dpoa.agent_removed, delegated_access.granted, delegated_access.revoked); per-consumer dedup keyed on `(eventId, consumerName)`. | Each downstream module needs a different subset of events; the typed catalog lets each module declare what it subscribes to without M39 over-broadcasting; idempotency is the resilience floor. | **Decided** |
| **D22** | **Manifest patch: `M39.dependsOn = [1, 2, 3, 4, 5]` (M39-F02/ADR-0006: 22 dropped to break the 22↔39 cycle — M39 is consumed *by* M22 via forward seam; 36/38/40 are outbox/seam/terminology consumers, no edge per ADR-0005 D1); `M39.ownedTables` = 11 tables; forward-seam consumers M27, M28, M29, M31, M33.** Removes the prior placeholder `dependsOn`. The M22 circular dep that M22's spec D18 documented (M22→M39 was wrong; M39→M22 is correct) is now resolved with M39 as the consumer of `DocumentRenderer`. | Manifest must reflect actual import direction; M39 consumes M22's renderer (M39 → M22 edge); the M22 D18 patch removed the wrong M22 → M39 edge. | **Decided** |

-----

## 12. Acceptance Sign-Off Checklist

Every box must be checked before M39 is promoted from `v0.2 Locked (spec)` to `v1.0 Shipped (code)`. Each box is binary — partial credit is not acceptance.

### 12.1 Architectural Conformance

- [ ] Manifest patch from §13 applied to `module-manifest.ts`; `npm run check:manifest` passes.
- [ ] Dependency-cruiser CI passes — M39 imports only from `dependsOn` set; no direct cross-schema imports into other modules; the prior M22→M39 spurious edge stays removed.
- [ ] Table-ownership lint passes — every M39 table appears in `module-manifest.ts:M39.ownedTables`; no other module claims any of these 11 tables.
- [ ] Seam registry (`SeamRegistry`) registers all 5 published seams (§4.3 `ConsentEvaluator`, `ConsentStateAdvisoryProvider`, `DelegatedAccessReader`, `BereavementOutreachConsentProvider`, `RecipientDirectoryReader`); boot validation passes.
- [ ] Forward-seam deny-stubs (`PortalSessionTerminator` for M31; `FhirClientCacheInvalidator` for M28) ship; logged-deferral path exercised by an integration test.
- [ ] `validateM39AIBlock` wired at boot AND nightly cron; failure raises CRITICAL alert; test fixture exercises the violation path.
- [ ] No direct `@anthropic-ai/sdk` or other AI SDK import anywhere under `apps/backend/src/modules/39-consent/**`; dependency-cruiser adapter-mandate rule enforces.

### 12.2 Data Model Conformance

- [ ] All 11 owned tables created with RLS enabled and the M1 `tenant_isolation_pgrole` policy attached (or platform-shared dual-grant policy on `consent_type_catalog`).
- [ ] All 14 enums per §3.2 created; no orphan enum values; migration is reversible.
- [ ] `consent_eval_audit` partitioned monthly; rolling-window cron registered with M1 partition-maintenance.
- [ ] Partial unique indexes on `consent_record_dpoa_agent` (`primary`, `alternate_1`, `alternate_2` slots; one each per consent record when `removed_at IS NULL`).
- [ ] Self-FK CHECK constraints on `consent_record` prevent cycles (`supersedes != id`, `acting != id`, `renewed_from != id`).
- [ ] CHECK constraints enforce: `expires_at > effective_at`; `superseded_consistent`; `revoked_consistent`; `signed_consistent`; staff-revocation `reason_text ≥ 40 chars`; staff-revocation `evidence_document_id IS NOT NULL`.
- [ ] M4 audit denylist registered for free-text PHI columns (`internal_notes_cipher`, `scope_descriptor`, `capture_evidence_jsonb`, `purpose_free_text`, `recipient_free_text`, `agent_contact_jsonb`, `activation_evidence_jsonb`, `state_specific_jsonb`, `reason_text`).
- [ ] `consent_eval_audit` is INSERT-only — `trg_cea_immutable` refuses UPDATE/DELETE; M4 audit-of-audit covers cross-tenant reads.

### 12.3 Routes & Seams

- [ ] All 30 routes (§4.1) implemented with permission-key middleware wired to M3; ABAC predicate gates wired per route.
- [ ] All TypeBox schemas from §4.2 implemented; routes return field-anchored validation errors.
- [ ] All 5 published seams registered in `SeamRegistry`; type-checked against the package interface declarations.
- [ ] All 11 ABAC predicate resolvers registered with M3's named-predicate registry at boot.
- [ ] All 15 permission keys (§4.7) present in M3's catalog with the default role templates seeded.
- [ ] `consent_management` SESSION_POLICY profile registered with M2 (5min freshness, passkey-preferred, TOTP fallback, audit_tier=critical).
- [ ] M36 alert-rule registry contains all 5 alert types (§4.10) with platform-floor cadences; `consent_management_steward` recipient resolver registered.
- [ ] All 9 BullMQ workers + crons registered (§4.9); cron schedules in tenant TZ; idempotency keys deterministic.

### 12.4 Workflow Acceptance

- [ ] W-CON-01 through W-CON-12 integration tests pass against a Testcontainers stack (Postgres + Valkey).
- [ ] E2E Playwright suites pass for web + mobile + portal-forward-stub surfaces.
- [ ] Manual operator-acceptance walk-through of the revocation cascade (mock 5-consumer scenario including the partial-failed alerting) signed off by the operator-on-call rotation lead.
- [ ] Manual compliance-officer walk-through of the consent_eval_audit explorer + a §164.528 accounting-of-disclosures simulated reconstruction signed off by the Privacy Officer.

### 12.5 Security

- [ ] All 14 STRIDE-mapped mitigations (§8.5) exercised by tests; each maps to a passing integration or security test.
- [ ] Step-up freshness enforced on all sign/revoke/recipient/DPOA/overlay routes; replay test confirms a 6-minute-old step-up token returns `403 step_up_stale`.
- [ ] Chain-of-authority self-reference refused at trigger AND service layers independently.
- [ ] Notarization + witness evidence requirements enforced server-side.
- [ ] AI-prohibited path attempt (a fake M32 prompt template with `target_table_writes=['consent_record']`) refuses to start the server; structured error identifies the violating template key.
- [ ] Tenant overlay loosen-attempt rejected with field-level diff; M4 audit `severity='critical'` on the rejected attempt.
- [ ] No `consent_eval_audit` row contains any free-text PHI; structural-only payload verified.
- [ ] Cross-tenant `consent_eval_audit` read attempt blocked by RLS even with `consent.read_eval_audit` permission granted.

### 12.6 Performance

- [ ] `evaluate()` p95 ≤ 30ms / p99 ≤ 60ms at 1000 RPS across 1M consent records (k6 fixture).
- [ ] `evaluateBulk()` p95 ≤ 200ms / p99 ≤ 500ms for 100-patient batch.
- [ ] `evaluateForDisclosure()` p95 ≤ 25ms / p99 ≤ 50ms (M28 hot path budget).
- [ ] Revocation cascade end-to-end p95 ≤ 5s / p99 ≤ 15s (5-consumer fixture).
- [ ] Consent capture POST draft → POST sign → M22 render arrival p95 ≤ 15s / p99 ≤ 30s.
- [ ] Expiration reminder cron full sweep across 100K consents p95 ≤ 2 minutes.
- [ ] `consent_eval_audit` INSERT p95 ≤ 8ms / p99 ≤ 20ms.

### 12.7 Test Coverage

- [ ] Unit test coverage thresholds met (≥ 90% lines / ≥ 85% branches on critical files; ≥ 95% on named services per §9.1).
- [ ] All integration tests passing (Testcontainers per §9.2).
- [ ] All RLS isolation tests passing (3-org × 100-consent fixture per §9.3).
- [ ] All IDOR / layer-independence tests passing per §9.4.
- [ ] All security tests passing per §9.5.
- [ ] All E2E tests passing on nightly per §9.6.
- [ ] k6 perf tests within targets per §9.7 + §12.6.
- [ ] axe-core a11y scan passes on all M39 web surfaces (WCAG 2.1 AA).

### 12.8 Cross-Module Sign-Off

- [ ] **M3 (Authorization)** confirms the 11 ABAC predicate resolvers are accepted into the named-predicate registry; predicate signatures match consumer expectations across M5/M7/M8/M9/M11/M12/M13/M14/M15/M16/M17/M18/M19/M22/M27/M28/M29/M30/M33.
- [ ] **M4 (Audit)** confirms the `consent` retention class registration, the eraser registration under the data-class key `consent` (M39-F04), that the eraser does NOT delete the immutable `consent_eval_audit` (its destruction routes through M4's audit-partition retention / destruction-cert workflow), the audit denylist registration, and the INSERT-only `consent_eval_audit` immutability trigger.
- [ ] **M5 (Patient)** confirms its `m39.consent.signed` and `m39.consent.revoked` subscribers are operative and recompute `patient.privacy_flag_snapshot` correctly per M5 D3 + D10.
- [ ] **M16 (Bereavement)** confirms `bereaved_contact.consent_record_id` FK contracts and the `m39.consent.revoked` cascade satisfy M16 §2.6 D6.
- [ ] **M22 (Documents)** confirms the `consent_record` template rendering path is operative; the `m39.consent.signed` consumer renders within target latency; the per-tenant overlay applies correctly without loosening platform-floor fields.
- [ ] **M28 (FHIR)** confirms `evaluateForDisclosure` returns the correct category-redaction flags for §164.508 + §2.31 + ONC §170.315(b)(10) certification scope.
- [ ] **M29 (External Interfaces)** confirms `evaluateForIngressRedaction` is called before persisting any HL7 inbound frame and returns the correct field-redaction posture per M29 W-XI-14.
- [ ] **M36 (Messaging)** confirms the 5 alert types registered with platform-floor cadences; the `consent_management_steward` recipient resolver returns the correct membership set.
- [ ] **M2 (Identity)** confirms the `consent_management` SESSION_POLICY profile is registered with the documented step-up policy; biometric/passkey assertions are correctly verified at sign time.
- [ ] **M40 (MDM)** confirms `external_physician`, `facility`, `pharmacy` recipient resolution via the reader seams is operative; recipient identity resolution does not leak cross-tenant.

### 12.9 Compliance Sign-Off (Privacy Officer + Compliance Officer)

- [ ] All 10 platform-floor consent types' TypeBox payloads cover every §164.508(c)(1) (HIPAA Authorization), §2.31 (SUD Release), and ONC §170.315(b)(10) content element required for survey defensibility.
- [ ] §164.508(c)(2) writing requirement satisfied — every signed consent has an M22-rendered PDF queryable via `consent_document_link`.
- [ ] §2.32 re-disclosure prohibition notice rendered on every `42_cfr_part_2_release` PDF (via the M22 template); M22 disclosure subsetter attaches the notice to any downstream disclosure under that consent.
- [ ] §164.508(b)(5) revocation procedure described in the M22 platform-floor template body text; tenant overlay may extend but not remove.
- [ ] §164.526 right-to-amend statement-of-disagreement attachment workflow operative (M5/M22 integration is unchanged; M39 audit captures the consent-evaluation context at disclosure time).
- [ ] Route 23 consent-**decision** audit (`consent_eval_audit`) returns survey-acceptable narrative when queried by date range. (NOT the §164.528 accounting-of-disclosures feeder — that record is written by the disclosing module to M4's sink at egress per ADR-0013 / M39-F03.)
- [ ] HHS post-death-no-transfer guidance honored — D13 cascade verified by Privacy Officer's manual walkthrough on a deceased-patient fixture.
- [ ] Per-state advance-directive variants (POLST, MOLST, living-will, combined DPOA-AD, verbal-only) accepted by `ScopeDescriptor_AdvanceDirectiveAcknowledgment.jurisdiction_form_kind`; per-state addendum template-overlay extension point verified.
- [ ] Notary requirement enforcement on DPOA records (when tenant overlay or jurisdiction requires) verified server-side; refused attempts audit-logged.

### 12.10 Documentation Sign-Off

- [ ] Module `README.md` complete with seam-consumer documentation for downstream module authors (showing how to consume `ConsentEvaluator` from another module's boot).
- [ ] `packages/consent/SEAMS.md` written documenting all 5 published seams + the typed payloads of all 14 outbox events; reviewed by Architecture (Fabrice).
- [ ] Operations runbook updated with: cascade-failure recovery procedure, partition maintenance for `consent_eval_audit`, AI-block validator failure response, tenant overlay publish workflow, expiring-consent triage cadence.
- [ ] DR/BCP runbook updated with M39 RPO/RTO targets (RPO: 1 hour, RTO: 4 hours per platform baseline) + the eval-audit partition recovery procedure.
- [ ] AI Governance doc updated to list M39 in the AI-prohibited surface registry alongside M30/M28/M11/M12/M13 etc.
- [ ] Security Hardening doc updated with the `consent_management` SESSION_POLICY profile entry.
- [ ] Architecture doc v0.12 (next minor) updated to reference this spec and reflect the manifest patch.

**Lock status:** All twenty-two decisions (D1–D22) resolved. Module 39 is **buildable now**. Forward seams to M27/M28/M29/M31/M33 are documented as published seams or deny-stub-consumed forward seams in §4.3 + §4.4; their consumer modules can rely on the seam contracts without waiting for M39 implementation completion (`ConsentEvaluator` is the keystone — every locked clinical module already wires the deny-stub today and gets the real implementation transparently on M39 boot per the M1 SeamRegistry pattern).

-----

## 13. Proposed Manifest Patch

This section is the **binding deliverable** for integrating M39 into the platform manifest, dependency-cruiser boundary rules, seam registry, and ABAC predicate registry. The patches below are presented in **diff-ready** form against the current `apps/backend/src/module-manifest.ts` (manifest v0.11) and the supporting infrastructure files identified in M1 Foundation + ARCHITECTURE_25_15_FITNESS.md.

### 13.1 `module-manifest.ts` — M39 entry replacement

**Current entry (manifest v0.11 — placeholder):**

```ts
{
  id: 39,
  name: "Consent & Authorization Management",
  codePaths: ["apps/backend/src/modules/39-consent"],
  dependsOn: [],
  ownedTables: [],
},
```

**Replacement entry (manifest v0.12 — lock-grade):**

```ts
{
  id: 39,
  name: "Consent & Authorization Management",
  codePaths: [
    "packages/consent",                        // M39-F01: Drizzle schema lives here, NOT packages/domain (leaf = pure types only)
    "apps/backend/src/modules/39-consent",
  ],
  dependsOn: [1, 2, 3, 4, 5], // M39-F02 / ADR-0006: 22 dropped (M39 is consumed BY M22 via forward seam — no edge, breaks the 22↔39 cycle); 36/38/40 are outbox/seam/terminology consumers (ADR-0005 D1 — no edge); 1–4 are foundation helpers (ADR-0005 D4). The broader relationship inventory is in the §13.1 prose / "Depends on" header, not the edge set.
  ownedTables: [
    "consent_type_catalog",                  // platform-shared dual-grant pattern
    "tenant_consent_type_overlay",
    "consent_record",
    "consent_record_recipient",
    "consent_record_dpoa_agent",
    "consent_revocation",
    "consent_expiration_reminder",
    "delegated_access",
    "consent_document_link",
    "consent_eval_audit",                    // partitioned monthly
    "consent_renewal_cycle",
  ],
  // M39-F07 / ARCH-146 / ADR-0005: ModuleDef carries ONLY {id, name, codePaths, dependsOn,
  // ownedTables}. The previously-listed publishedSeams / consumedSeams / forwardSeamConsumerStubs /
  // registersAbacPredicates / registersPermissionKeys / registersRetentionClasses / registersErasers /
  // registersSessionPolicyProfiles / registersAlertRules / aiProhibitedSurface are NOT manifest fields —
  // they are registered at boot against the M1 SeamRegistry and the M3 predicate/permission registries.
  // See §4.3 (seams), §4.6 (permission keys), §4.7 (ABAC predicates), §3.8 (eraser), §1619 (alert rules),
  // and D17 (AI-prohibited boundary, boot-validated).
},
```

### 13.2 `.dependency-cruiser.cjs` — boundary rules generated from the manifest

The existing M22→M39 boundary rule (introduced as part of M22 D18) becomes a clean M39→M22 edge. No new bespoke rules are needed beyond what the manifest-driven check already generates per `ARCHITECTURE_25_15_FITNESS.md` §"The checks":

```
- Check 1 (module import boundaries): M39 may import from {1,2,3,4,5,22,36,38,40} ∪ leaves; importing M6 or M7 or M28 fails.
- Check 2 (adapter mandate): no `@anthropic-ai/sdk`, `stripe`, `twilio`, `dosespot-sdk` etc. anywhere under `apps/backend/src/modules/39-consent/**` or `packages/consent/**`.
- Check 3 (domain purity): `packages/domain/consent/**` imports no I/O, no app packages, no FHIR; locked per §9 dependency direction.
- Check 4 (leaves stay leaves): `shared/types/ui` do not import from `packages/consent/**`.
- Check 5 (helper-only tables): no direct schema import of `audit_event` / `outbox_event` / `idempotency_key` outside their helper (M4/M1 helpers); confirmed.
- Check 6 (table ownership): `scripts/check-table-ownership.ts` confirms the 11 owned tables appear only under M39's modules.
- Check 7 (no cycles): the prior M22 ↔ M39 cycle is gone; the residual graph is a DAG.
```

### 13.3 Dependency direction impact (impacted neighbors)

| Module | Before | After | Reason |
|---|---|---|---|
| 1 (Foundation) | not in M39.dependsOn | ✓ | M1 provides outbox + audit helper + SeamRegistry + DEK; not previously enumerated |
| 2 (Identity) | not in M39.dependsOn | ✓ | M2 provides MembershipReader, CredentialReader, SESSION_POLICY consent_management profile |
| 3 (Authorization) | not in M39.dependsOn | ✓ | M3 hosts the named-predicate registry M39 contributes to; the 11 predicate resolvers live in M39 |
| 4 (Audit) | not in M39.dependsOn | ✓ | M4 owns the eraser registry, retention class registry, legal-hold, write-audit triggers M39 consumes |
| 5 (Patient) | not in M39.dependsOn | ✓ | M5 owns PatientReader, CaseloadProvider, patient.deceased event source M39 subscribes to |
| 22 (Documents) | M22.dependsOn previously listed `[1, 5, 39]` (wrong direction); M22 D18 removed the M39 entry | M39 → M22 (M39 consumes DocumentRenderer for consent_record template renders) | The cycle that M22 D18 identified ("M22 → M39 → M22") is resolved with M39 as consumer; M22's `m39-consent-document-render-requested.ts` consumer is now backed by the real M39 emission |
| 36 (Messaging) | not in M39.dependsOn | ✓ | M36 hosts the alert-rule registry + recipient-resolver registry M39 contributes to |
| 38 (Terminology) | not in M39.dependsOn | ✓ | M38 provides the recipient-class value set, jurisdiction-code value set, purpose-of-disclosure code list |
| 40 (MDM) | not in M39.dependsOn | ✓ | M40 provides ExternalPhysicianReader, FacilityReader, PharmacyReader M39 consumes for recipient identity |
| 16 (Bereavement) | M16.dependsOn includes 39 | (unchanged — M16 → M39 consumer edge stands) | M16 holds the `bereaved_contact.consent_record_id` FK; M16 consumes `BereavementOutreachConsentProvider` |
| 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 22, 23, 27, 28, 29, 30, 33 | each already lists 39 in `dependsOn` as the ConsentEvaluator consumer | (unchanged) | Every locked clinical/billing/integration module that consults the consent platform was already wired to consume `m39.consent-evaluator` as a forward seam; M39 lock makes those edges operative |
| 31 (Portal) | future | will be added on M31 lock | M31 will publish `PortalSessionTerminator` consumed by M39 (forward-stub today) and consume `ConsentEvaluator` |

### 13.4 Side-effects of the patch

- **CI:** Dependency-cruiser re-checks M39 imports against the new manifest. Pre-patch, any cross-import to M2/M3/M4/M5/M22/M36/M38/M40 (which previously didn't exist anyway) would have been flagged as violations; post-patch they are sanctioned. Any future cross-import from M39 to a module outside the `dependsOn` set will be flagged.
- **Boot validation:** `module-manifest.ts:M39.ownedTables` will be cross-referenced by the table-ownership lint script. The 11 listed tables must exist with matching schema after migration `0039_consent.sql` applies; absence raises a boot error.
- **Forward-seam deny-stubs:** M39 ships `forward-seam-stubs/m31-portal-session-terminator.ts` and `forward-seam-stubs/m28-fhir-client-cache-invalidator.ts` until those owners deliver real implementations. Each stub: (i) registers itself with `reg.optional(...)`; (ii) on invocation, logs a structured deferral entry with the consent_record_id + revocation_id + intended_action; (iii) returns successfully (the cascade does not fail because a forward consumer is absent). When M31 lands, the stub is replaced by the real handler; the M2 session-terminator path remains operative throughout.
- **Cross-module consumer wiring becomes operative:** every locked module that had `m39.consent-evaluator` as a deny-stubbed consumed seam (per M7/M8/M9/M11/M12/M13/M14/M15/M16/M17/M18/M19/M22 boot files) gets the real implementation transparently on M39 boot. No consumer-module code change is required.
- **AI Governance registry:** M39 is added to the AI-prohibited surface registry in `CHARTWARDEN_AI_GOVERNANCE_v0_2.md` (next minor); the `validateM39AIBlock` runs at boot and refuses to start if any M32 prompt template would cross the boundary.

### 13.5 Migration concerns

- The `0039_consent.sql` migration is non-destructive — only CREATE statements for new tables, types, indexes, RLS policies, triggers, partitions, seed data for `consent_type_catalog`. No existing data is touched.
- `consent_type_catalog` seed inserts the 11 platform consent types (`portal_access`, `dpoa_healthcare`, `dpoa_financial`, `family_caregiver_access`, `42_cfr_part_2_release`, `media_release`, `research_participation`, `telehealth_consent`, `advance_directive_acknowledgment`, `hipaa_release`, `bereavement_outreach_consent`); idempotent `INSERT...ON CONFLICT (type_key) DO NOTHING`. The `custom` slot is documented as a sentinel value the tenant overlay path uses; no row inserted.
- For tenants that exist pre-M39, the `family_caregiver_access` consents previously implicit via M5 `caregiver` rows are NOT auto-migrated — M5's snapshot stays as-is until staff re-captures a formal consent at next admission review (per the platform-floor "no implicit consents on existing patients" rule documented in Operations Runbook).
- Existing SUD privacy flags on M5 (`patient.privacy_flag_snapshot.sud`) continue to gate access via the M3 `sud_consent_present` predicate that now resolves through M39; for SUD-flagged patients with no on-file `42_cfr_part_2_release` consent, the predicate returns `false` and access is denied to SUD-categorized records — preserving the existing safe state. Compliance officers may run a one-time bulk-import of pre-existing paper §2.31 consents via M22 intake → manual consent_record creation; no automated path is provided (consent capture must be deliberate).

### 13.6 Reverse-cycle check

After applying the patch, the dependency graph remains a DAG:

- M39 → M1, M2, M3, M4, M5, M22, M36, M38, M40 (no cycles among these).
- M22 → M39 edge that M22 D18 removed stays removed; M22's `m39-consent-document-render-requested.ts` consumer subscribes to M39's outbox event, not M39's schema.
- M5 ↔ M39 is acyclic because M5 → M39 is via outbox subscriber (`m39.consent.signed`/`m39.consent.revoked` consumed by M5) and M39 → M5 is via the seam registry (`PatientReader`, `CaseloadProvider` consumed by M39). Outbox subscribers are runtime-only edges, not import-graph edges; dependency-cruiser does not consider them cycles per architecture §25.
- M16 → M39 (consumes `BereavementOutreachConsentProvider`) + M39 → M16 (subscribes to `m16.bereavement.eligible`) — same outbox-vs-import distinction; not a cycle.
- The 17+ clinical/billing/integration modules that consume `m39.consent-evaluator` are all unidirectional consumers; no cycles introduced.

### 13.7 Sign-off

This patch must be applied as the first M39 PR. Subsequent M39 PRs (Phase A through I in §10) MUST pass the boundary check against this patched manifest. Reviewers should pay particular attention to:

1. The 11 ABAC predicate resolver registrations land in `apps/backend/src/modules/39-consent/services/abac-predicates.ts` and are wired into M3's named-predicate registry at boot — not embedded in route handlers.
2. The 5 published seams' interface declarations live in `packages/consent/src/seams/` and are imported by consumer modules via the package, not via deep imports into `apps/backend/src/modules/39-consent/**`.
3. The forward-seam deny-stubs implement the typed seam interface; they do not throw — they log + return success — so the cascade does not surface a false failure pending M31 lock.
4. The AI-block validator is wired at boot AND to the nightly cron; the test fixture exercises a fake violating prompt and confirms refusal.

-----

## Document Footer

**Spec version:** v0.2 (Locked)
**Spec author:** Architecture (Fabrice V. Adjam, FabWebDev)
**Date:** 2026-06-10
**Source documents referenced (versions):** Architecture v0.11; Security Hardening v0.2; AI Governance v0.2; System Design v0.3; DR/BCP v0.1; Ops Runbook v0.1; Integrations v0.1; M01 v0.2; M02 v0.2; M03 v0.2; M04 v0.2; M05 v0.2; M06 v0.2; M07 v0.2; M08 v0.2; M09 v0.2; M10 v0.2; M11 v0.2; M12 v0.2; M13 v0.2; M14 v0.2; M15 v0.2; M16 v0.2; M17 v0.2; M18 v0.2; M19 v0.2; M20 v0.2; M22 v0.2; M27 v0.2; M28 v0.2; M29 v0.3; M30 v0.2; M33 v0.2; M36 v0.2; M38 v0.2; M40 v0.2.

**Locked decisions:** D1 through D22 (twenty-two).
**Owned tables:** Eleven (10 tenant-owned, 1 platform-shared `consent_type_catalog` with dual-grant pattern per M40 §3.6).
**Published seams:** Five (`ConsentEvaluator`, `ConsentStateAdvisoryProvider`, `DelegatedAccessReader`, `BereavementOutreachConsentProvider`, `RecipientDirectoryReader`).
**ABAC predicates contributed:** Eleven (per §4.8).
**Permission keys contributed:** Fifteen (per §4.7).
**Outbox event types emitted:** Fourteen (per §4.5).
**M36 alert types registered:** Five (per §4.10).
**SESSION_POLICY profile registered:** One (`consent_management`, per D16).
**Retention class registered:** One (`consent`, per D20).
**Eraser registered:** One, under the data-class key `consent` (per §8.6; M39-F04). It does NOT delete the immutable `consent_eval_audit` — that destruction routes through M4's audit-partition retention / destruction-cert workflow.
**Forward-seam consumer deny-stubs:** Two (`m31.portal-session-terminator`, `m28.fhir-client-cache-invalidator`).
**AI surface:** Prohibited (boot validator + nightly cron per D17).

