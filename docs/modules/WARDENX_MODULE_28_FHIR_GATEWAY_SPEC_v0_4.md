# WardenX — Module 28: FHIR Gateway — Spec v0.4 (Consolidated)

**Spec status:** Locked v0.4 (Consolidated)
**Owns:** `packages/fhir`, `apps/backend/src/modules/28-fhir`, FHIR R4 gateway, SMART Backend Services, bulk export, inbound proposal pipeline.
**Depends on:** 1 (Foundation — `organization`, `withOrgContext`, `audit()` helper, `auditRead()` helper, outbox dispatcher, idempotency middleware, RLS generator, partitioned-table conventions, per-tenant DEK envelope-encryption helper for `fhir_client_credential.secret_cipher` and the cursor-HMAC key on `tenant_fhir_config.cursor_signing_key_cipher`, BullMQ on Valkey, circuit-breaker and `DegradedError` envelope, system status event, the typed `SeamRegistry` with boot validation, the MinIO client with per-tenant bucket scope; the M11 outbox events `m11.order.results_received`, `m11.order.results_received_critical`, `m11.order.transmission_status_changed`, `m11.order.transmission_terminal_failed`, `m11.order.results_overdue` consumed for FHIR response-cache invalidation), 2 (Identity — `user`, `membership`, `location`, `organization` source-of-truth tables consumed for the `Practitioner` / `PractitionerRole` / `Organization` / `Location` FHIR projections; the per-membership credential resolution for `PractitionerRole.specialty` and `PractitionerRole.code`; session classes for the operator surfaces that initiate bulk exports and review inbound proposals; the per-tenant device-attestation join *not* consulted because FHIR consumers are external clients authenticated via SMART Backend Services / API key, never via the field-clinician device pathway), 3 (Authorization — `fhir.client.*`, `fhir.inbound.*`, `fhir.export.bulk.*`, `fhir.config.*`, `fhir.capability.read` permission keys M28 contributes; ABAC predicates `fhir_client_organization_scope`, `fhir_inbound_owner_module_match`, `fhir_export_scope_satisfied`, `bulk_export_initiator_or_admin`, `fhir_client_active`, `fhir_export_recipient_authorized` registered into M3's named-predicate registry; the standard `caseload_or_scope` predicate is *not* applied to FHIR consumer reads because the consumer is an external client with a pre-registered tenant-and-resource-scope; the `caseload_or_scope` predicate *is* applied to the WardenX operator surfaces that manage FHIR clients, review inbound proposals, and initiate bulk exports), 4 (Audit — PHI write-audit trigger generator on the M28-owned tables; **`auditRead()` declaration on every FHIR resource read, search, `$everything`, and `$export` operation** because every read by an external consumer is a HIPAA §164.528 *disclosure* that requires reproducible accounting per architecture §11.A retention class `compliance`; retention class `compliance` for `fhir_client`, `fhir_client_credential`, `fhir_client_session`, `fhir_bulk_export_job`, `fhir_bulk_export_artifact`, `fhir_inbound_resource` rows (these are *part of* the disclosure-accounting record and a future §164.528 request must reproduce the wire-shape served years later); retention class `operational` for `fhir_capability_snapshot` (rebuildable from boot at any time); `eraseFn` registered into M4's destruction-cert callback registry per §3.7; the encrypted-at-rest secret columns are denylisted from audit value-capture per §3.6; the FHIR payload bytes in inbound staging are denylisted to their hash digest until proposal-decision time, then either flowed to the owner module or destruction-erased on rejection; the retention class `compliance_42cfr_part2` applied to SUD-redacted DiagnosticReport reads), 5 (Patient & Demographics — `PatientReader`, `CaregiverReader`, `PatientAddressReader`, `PatientPayerReader` consumed via `packages/patient/seams` — never direct schema import — for the `Patient`, `RelatedPerson`, and `Coverage` FHIR projections; the M5 `patient.privacy_flag_snapshot` consumer is *transitive* through M39's `consent.evaluate` for the SUD-redaction gate per D3; `m5.patient.deceased` consumed via outbox to set `Patient.deceasedBoolean` / `Patient.deceasedDateTime` on the wire and to freeze the export inclusion of clinical resources for the decedent at the death timestamp; `m5.patient.merged` consumed to redirect any `id` reference to the surviving record per the merged-into pointer; the MBI / SSN encrypted columns are never projected to FHIR — `Patient.identifier[]` carries the MRN and the tenant-public identifier system URIs per D9, never the protected identifiers, and the §3.6 denylist enforces this), 6 (Admission, Election & Certification — `ElectionPeriodReader`, `CertificationReader`, `FaceToFaceReader`, `LevelOfCareReader`, `AdmissionStatusReader` consumed for the hospice-election-period contextualization of every clinical read; the `Coverage.period` on the hospice-payer Coverage projection is anchored to the active `election_period.start_date` / `end_date`; M28 reads `m6.election.period_started` / `m6.election.period_ended` / `m6.revocation.created` / `m6.transfer.created` / `m6.discharge.created` / `m6.discharge.death` via outbox to maintain the export-time eligibility envelope for each patient; M28 does **not** import M6 schema — only the reader seams), 7 (Care Plan — `CarePlanReader`, `ProblemReader`, `GoalReader`, `InterventionReader` consumed for the `CarePlan` / `Condition` / `Goal` FHIR projections; M28 reads only signed-and-current versions of the IPOC; draft versions are excluded from FHIR egress; M28 does not import M7 schema), 8 (Encounters & Visit Notes — `SignedEncountersReader` and `BillableEncounterReader` consumed for the `Encounter` and `Observation` (vitals) projections; per M8 D2 only `signed` / `cosigned` encounters are projected — draft / finalized / cosign_pending encounters are excluded from FHIR egress; per M8 D9 the EVV-bracket source of truth populates `Encounter.period.start` / `.end` when EVV-derived, and M8's documented-missing fallback values populate the same fields when EVV is unavailable with a wire-level extension flagging the fallback; vitals authored under an encounter project to `Observation` with `Observation.encounter` referencing the encounter `id`; `m8.encounter.signed` and `m8.encounter.cosigned` consumed via outbox to invalidate the per-patient export eligibility cache), 9 (Clinical Assessments Suite — `LatestAssessmentProvider` and `ScaleSeriesProvider` consumed for the `Observation` projection of structured assessment scales (PPS, FAST, PAINAD, ESAS, etc.); LOINC codes per M38 binding; one `Observation` per scale-instance with `Observation.derivedFrom` referencing the source `assessment_id` so a consumer can audit the source row; M28 does not import M9 schema), 10 (HOPE Engine — `HopeTimepointProvider` and the `hope.j2051_trigger_fired` outbox subscription consumed for the J-code-tagged `Observation` projection that maps each HOPE item to LOINC + the symptom-impact-pair to a typed `Observation.hasMember[]` cluster; per architecture §F HOPE codes are LOINC-only on the wire, never the internal HOPE-item-ID; M28 does not import M10 schema), 11 (Orders — `OrderProvider.getOrdersSince`, `OrderProvider.activeOrdersForPatient`, `OrderProvider.findOrder`, `OrderProvider.searchOrdersByPatient` consumed for the Phase-2 `ServiceRequest` projection of non-medication orders and for the `DiagnosticReport` projection of lab results; **Phase 1 M28 does not project `ServiceRequest`** — only `MedicationRequest` via M12 is in Phase 1 per architecture §I; M11 remains in `dependsOn` because the medication-order signature trail M12 surfaces transitively chains through M11's `OrderSignatureProvider`, and the M28 `Provenance` composition reads the signature trail; the `m11.order.results_received` family of outbox events is consumed for FHIR response-cache invalidation; M28 does not import M11 schema), 12 (DoseSpot Integration — `MedicationOrderProvider.getActiveMedications`, `.getMedicationsSince`, `.getControlledSubstanceFlag`, `.getMedicationHistoryForReconciliation` consumed for the `MedicationRequest` and `MedicationStatement` projections; per M12 D14 the free-text PHI-denylisted fields are never projected to the FHIR `notes` field; per M12 §SUD the SUD-flagged medication orders are redacted at egress under D3; M28 does not import M12 schema), 13 (eMAR & Med Administration — `MedicationAdministrationProvider`, `ReconciliationProvider` consumed for the `MedicationAdministration` and `List` (medication reconciliation) projections; per M13 D11 the IV-continuous administration mode catalog projects to a `MedicationAdministration.partOf` chain so the start / rate-change / pause / resume / stop sequence is recoverable on the wire; per M13 D7 the controlled-substance witness signature is captured in `MedicationAdministration.performer[]` with `function='witness'`; M28 does not import M13 schema), 15 (Discipline Care Plans — `DisciplinePlanReader` consumed for the discipline-plan-flavored `CarePlan` projection with `CarePlan.category` discriminating Aide / MSW / Spiritual / Volunteer per M15's published seam contract; `QuestionnaireResponse` projection of discipline assessments deferred to Phase 2; M28 does not import M15 schema), 22 (Document Management — `DocumentReader.documentsForPatient`, `DocumentReader.documentMetadata`, `RenderedDocumentProvider.getRenderedDocumentForAggregate`, `ExtractionProvenanceReader.provenanceForTargetAggregate` consumed for the `DocumentReference`, `Binary`, and `Provenance` projections; per M22 the FHIR `DocumentReference.content[].attachment.url` points at a per-disclosure short-lived presigned MinIO URL minted by M28 against the M22 storage scope per architecture §7.6 — never a long-lived public URL; per M22's Statement-of-Disagreement pipeline a denied amendment's statement is attached to every subsequent FHIR disclosure of the underlying record per the M22 `attach_to_disclosures=true` flag; the SUD whole-document redaction pattern (M22 D20) is mirrored by M28's whole-report DiagnosticReport redaction per D20; M28 does not import M22 schema), 23 (Billing — Medicare — `ClaimReader.fhirProjection` consumed for the Phase-2 `Claim` / `ClaimResponse` / `ExplanationOfBenefit` projections per US Core 6.0 hospice profile; per M23's forward-seam declaration the typed contract ships at M23 lock and M28 wires the projection at M28 lock; Phase 1 M28 does not expose Claim / ClaimResponse / EOB — the contract is registered against the seam but the routes return `404 Not Found` with `OperationOutcome` until D1 unlocks; M28 does not import M23 schema), 29 (External Interfaces — `LabObservationReader` consumed via `packages/external-interfaces/seams` for the `DiagnosticReport` and child `Observation` projections of lab results; the reader provides the per-value lab observation rows, the abnormal/critical flags, and the `sud_redaction_status` that drives the D20 whole-report redaction; M28 does not import M29 schema), 36 (Secure Messaging & Alerts — M28 emits typed alerts (`fhir.client.pending_approval`, `fhir.client.activated`, `fhir.client.revoked`, `fhir.bulk_export.completed`, `fhir.bulk_export.failed`, `fhir.inbound.proposal_pending`, `fhir.inbound.proposal_overdue`, `fhir.search.anomaly_detected`, `fhir.capability.regenerated`) and consumes `m36.delivery_failed` to surface stuck operator notifications; M28 owns no out-of-band delivery code — every SMS/email/push path is M36's; M28 owns no Socket.IO room — the operator dashboards subscribe through M36's standard `org:<orgId>` and `provider_entity:<id>` rooms), 38 (Clinical Terminology — `TerminologyProvider.asFhirCodeSystem`, `.asFhirValueSet`, `.expand`, `.validate`, `.lookup`, `.lookupBatch` consumed for the `CodeSystem`, `ValueSet`, `$expand`, `$validate-code` FHIR endpoints — M28 owns the FHIR wire shape; M38 owns the projection per M38 D-FHIR; `asOfDate` lookups pinned to each consumed resource's authoring date so a 2024 encounter validates against the 2024 ICD-10-CM revision and an October cutover does not retroactively shift the wire content; `TerminologyProvider.searchByText` is not exposed to external consumers — `$expand` with a textFilter is the FHIR-spec-conforming alternative), 39 (Consent & Authorization Management — `ConsentEvaluator.evaluateForDisclosure(patientId, recipientClientId, asOf)` consumed as the per-resource egress gate; per D3 the default-on 42 CFR Part 2 redaction is consulted via `ConsentEvaluator` not via the M5 PrivacyFlag snapshot directly; per architecture §J the `42_cfr_part_2_release` consent kind must reference the receiving FHIR client by `fhir_client_id` or be marked `recipient_class='any_subject_to_baa'`; M39 owns the consent state machine — M28 only asks; `Consent` resource FHIR projection consumed from M39 for the `Consent`-type query; M28 does not import M39 schema), 40 (Master Data Management — `ExternalPhysicianReader`, `PharmacyReader`, `FacilityReader`, `ReferralSourceReader` consumed for the `Practitioner`, `PractitionerRole`, `Organization`, and `Location` projections that reference external entities; per architecture §11.F the canonical NPI is sourced from M40 and the per-tenant overlay (preferred-pharmacy, attending-physician overrides) is consulted; per the M40 merge-request workflow a recently-merged external physician is redirected to the surviving canonical record at wire time; the NPPES provenance (`nppes_provenance.lastSyncedAt`, `deactivated_at`, `status`) is consumed for the Practitioner FHIR extensions per D21; the `mdm.physician_deactivated` outbox event is consumed for `Practitioner` / `PractitionerRole` cache invalidation per D22; M28 does not import M40 schema)

**Consumed by:** 30 (HQRP & Quality — M28's `fhir_search_audit` digest stream is one of the upstream signals M30 reads for the HIPAA §164.528 disclosure-accounting compliance scorecard; M30 consumes M28's `FhirGatewayMetricsProvider.disclosureMetricsForOrg(orgId, period)` published seam for the per-quarter disclosure volume and per-recipient cardinality summary; M30 does not import M28 schema), 33 (Reporting & Dashboards — `FhirGatewayMetricsProvider` consumed for the per-tenant FHIR utilization dashboard: requests-per-hour, top resource types, top clients, bulk-export job counts, inbound-proposal review SLA, error-rate; M33 does not import M28 schema), 34 (SaaS Tenant Platform — `FhirClientReader.clientsForOrg(orgId)` consumed by the tenant-admin SaaS console for surfacing the configured external FHIR clients to the platform-ops "tenant overview" view; per M34 the BAA reference identifier on each `fhir_client` row is the join key into the M34 contract catalog), 35 (Subscription Billing — Phase-2 FHIR egress quotas may be metered against the M35 subscription tier; M28 publishes the metering counters via `FhirGatewayMetricsProvider`; M35 deny-stub today, real wiring at M35 lock).

## Changelog

- **v0.4 (Consolidated)** — Rolls the v0.2 base and v0.3 delta into a single self-contained specification. No scope change; no decision reversals.
- **v0.3 (Locked)** — Closed the M11 v0.3 + M40 v0.3 downstream forward-stubs on the FHIR gateway side:
  - **New FHIR resource: `DiagnosticReport`.** The v0.2 v1 resource set covered `Observation` (M9 assessments + M10 HOPE) but not lab results — M11 v0.2 lab orders were never authoritatively projectable until M29 v0.3 added the lab observation read path. The FHIR `DiagnosticReport` projection is composed from M11's order metadata + M29's `LabObservationReader` seam. Each `DiagnosticReport.result[]` element references a per-value FHIR `Observation` projected from the same M29 source row. Both projections are deterministic at read time, no new persistence on M28's side.
  - **SUD redaction extended to DiagnosticReport.** Per D3 the SUD redaction layer applies to every FHIR egress path. A `DiagnosticReport` whose ANY child observation has `sud_redaction_status != 'not_applicable'` is redacted as a whole — `DiagnosticReport.result[]` is replaced with a single placeholder `Observation` carrying a `dataAbsentReason` of `temp-unknown` and the SUD banner text in `note[]`. The redaction is conservative (whole-report redaction even if only one of N child observations is SUD-class) per the M22 v0.3 D20 pattern — a single SUD result in a panel should not be inferable from the un-redacted siblings.
  - **`Practitioner` NPPES enrichment.** M28 already projected M40 `ExternalPhysician` to FHIR `Practitioner` but exposed only the canonical fields. Two FHIR extensions on the Practitioner projection were added: `http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-last-synced-at` (the `external_physician.nppes_provenance.lastSyncedAt` value from M40 v0.3 D10) and `http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-deactivated-at` (when `external_physician.status='deactivated'`). The taxonomies (already projected to `Practitioner.qualification[]`) are unchanged. These extensions let downstream FHIR consumers reason about staleness of practitioner data — particularly relevant for partner-lab CDS hooks that need to know if the ordering physician's NPPES record was deactivated.
  - **Cache invalidation signals.** M28's FHIR response cache (Valkey, 5-min TTL per `(resourceType, id, asOf)` tuple) invalidates on outbox events from upstream owner modules. The invalidation set includes: `m11.order.results_received` invalidates the cached `DiagnosticReport/{orderId}` and the affected `Patient/$everything` cache; `m11.order.results_received_critical` does the same; `mdm.physician_deactivated` (from M40) invalidates the cached `Practitioner/{mdmId}`.
  - **Four decisions** — D19 (DiagnosticReport composition from M11 + M29), D20 (SUD redaction at DiagnosticReport granularity = whole-report redact), D21 (Practitioner NPPES enrichment extensions), D22 (M11 events trigger FHIR cache invalidation).
  - **Four workflow acceptance criteria** — W-FHIR-13 (DiagnosticReport read for non-SUD lab returns full payload), W-FHIR-14 (`?patient=:id` search returns recent lab reports), W-FHIR-15 (SUD-class lab returns redacted DiagnosticReport with banner), W-FHIR-16 (Practitioner read includes NPPES extensions and deactivated-at when applicable).
  - **Four implementation tasks** — T-M28-22 through T-M28-25.
  - **No D1–D18 reversals; no v0.2 scope changes.** The R5/R6 mapper compile-shells remain inactive; the M23 `Claim`/`ClaimResponse`/`EOB` Phase-2 forward-stubs remain 404 until M23 v0.3+ enables them.
- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all eighteen open questions into binding decisions (§11). Defines the **version-pluggable mapper architecture** with R4 mappers live, R5 / R6 mappers as compile-shells with golden-test scaffolding but no live routes (D1), the **SMART-on-FHIR Backend Services authentication model** with asymmetric JWT (RS384) against a per-client-registered JWKS URI plus the per-tenant API-key alternative for trusted infrastructure integrations (D2), the **default-on 42 CFR Part 2 SUD redaction** at every FHIR egress path through M39's `ConsentEvaluator.evaluateForDisclosure` consult with the per-client `42_cfr_part_2_release` consent reference (D3), the **asynchronous bulk-export job model** with NDJSON output to MinIO under `tenants/<org>/fhir-exports/<job_id>/`, BullMQ `fhir.bulk-export` queue, resumable via job ID, per-resource-type partitioned NDJSON files, presigned download URLs at 24-hour TTL, and the FHIR-spec-conforming `Content-Location` + `X-Progress` polling envelope (D4), the **`$everything` operation scope** returning Patient + linked clinical resources within the requesting client's authorization horizon minus 42 CFR Part 2 redacted content with a 5,000-resource per-call cap above which bulk export is recommended (D5), the **US Core 6.0 mandatory search parameter coverage** with the `FhirSearchTranslator` typed contract translating FHIR search syntax into upstream reader-seam calls — no SQL is built inside M28 (D6), the **FHIR version negotiation via the Accept header** with default R4 at `application/fhir+json; fhirVersion=4.0.1` and R5 / R6 returning `415 Unsupported Media Type` with `OperationOutcome` until those mappers land (D7), the **inbound-FHIR import propose-then-review pipeline** with staging in `fhir_inbound_resource` tagged `pending` and the typed `m28.fhir.inbound.proposed` outbox event consumed by the owner module (M5 for `Patient` demographic, M12 for `MedicationStatement` medication-history); no FHIR PUT/POST writes M5 / M6 / M7 / M12 / M13 / M22 tables directly (D8), the **identifier system URI scheme** with platform-owned URIs at `https://fhir.wardenx.com/sid/{system}` and per-tenant URIs at `https://fhir.<tenant-fhir-host>/sid/{system}` resolved via the new `tenant_fhir_config` row (D9), the **`Provenance` resource as a read-time composition** from M22's `ExtractionProvenanceReader`, M8's encounter-signature trail, M11/M12/M13's order/medication-signature trails — not a persistently stored row — emitted only when explicitly requested via `_include=Resource:provenance` or `_revinclude=Provenance:target` (D10), the **`CapabilityStatement` as a deterministic boot-time generation** from the route registration + the seam catalog with the platform-singleton `fhir_capability_snapshot` row holding a signed checksum and the `GET /fhir/r4/metadata` endpoint returning the conformance JSON (D11), the **per-recipient `fhir_client` registry** with `client_id` UUID + JWKS URI + `allowed_scopes[]` + `tier` (`tier-1` partner / `tier-2` referral / `tier-3` research) + per-client rate limit + per-client IP allowlist + per-client BAA contract reference; client onboarding requires Org Admin + Compliance Officer dual approval; client revocation is one-click and audited (D12), the **cursor-based pagination** via `Bundle.link.relation=next` with a signed (HMAC-SHA256) opaque cursor containing the last `id` + `meta.lastUpdated` of the previous page; default page size 50, max 500; no offset-based pagination because offset breaks under concurrent writes (D13), the **AI-prohibited zone for FHIR**: Module 32's LLM may not synthesize, modify, or redact FHIR resources — projections are deterministic mappings from authoritative module data only; enforced at boot via `validateFhirAIBlock()` against M32's prompt registry mirroring M12 D12 / M13 D15 / M22 D-pattern (D14), the **`auditRead()` on every FHIR read** producing reproducible HIPAA §164.528 right-to-an-accounting-of-disclosures evidence with per-query parameter envelope, returning result count, and consuming `fhir_client_id` recorded per disclosure (D15), the **per-tier rate limits** with Valkey-backed sliding windows (tier-1 100 RPS / tier-2 10 RPS / tier-3 1 RPS), per-client bulk-export concurrency cap at 1 concurrent (D16), the **published M28 seams** `FhirGatewayMetricsProvider` (read paths for M30 / M33 / M35) and `FhirClientReader` (read paths for M34) and `FhirInboundProposalReader` (read paths for M5 / M12) registered at boot via M1 seam registry with `validateSeams()` refusing startup if unregistered (D17), and the **proposed manifest patch** updating `M28.dependsOn` from `[5, 6, 7, 8, 11, 12, 13, 38, 40]` to `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 22, 23, 36, 38, 39, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)* — the prior encoding was structurally identical to the pre-lock state of every prior consumer-heavy module: it omitted the foundation deps that are transitively required but not surfaced in the architecture §20 short-list, omitted M9 / M10 / M15 / M22 / M23 / M36 / M39 deps that are real consumer-of-seam relationships, and conflated "Phase 1 v1 resources" with "consumed seams in Phase 1." M28 reads M9 (assessments → Observation), M10 (HOPE → Observation), M15 (discipline plans → CarePlan), M22 (DocumentReference / Binary / Provenance), M36 (alert delivery), M39 (consent gate) in Phase 1; the M23 forward-seam wires at M28 lock with the Phase-2 Claim / ClaimResponse / EOB projection routes returning `404` with `OperationOutcome` until D1 unlocks. The M11 / M12 / M13 / M22 lock established the precedent that every module surfaces *all* its declared imports in `dependsOn`, including foundation and cross-cutting; M28 follows. Also confirms `packages/fhir` and `apps/backend/src/modules/28-fhir` in `M28.codePaths` per the manifest already-encoded entry (D18).
- **v0.1** — Initial draft.

> **Phase boundary (binding):** Phase 1 delivers the R4 v1 resource set per architecture §I — `Patient`, `Encounter`, `Observation`, `MedicationRequest`, `MedicationAdministration`, `Condition`, `CarePlan`, `Goal`, `DocumentReference`, `Practitioner`, `PractitionerRole`, `Organization`, plus the supporting `Coverage`, `RelatedPerson`, `Binary`, `Consent`, `CodeSystem`, `ValueSet`, `CapabilityStatement`, `OperationOutcome`, `Bundle`, `List` (medication reconciliation), and `DiagnosticReport` (lab results, with child `Observation` projections) — and the `$everything`, `$expand`, `$validate-code`, `$export` operations. **R5 and R6 mappers are compile-shells with golden-test scaffolding only**; their routes return `415 Unsupported Media Type` with `OperationOutcome` until those mappers complete (D1). **`ServiceRequest` (M11 non-medication orders), `QuestionnaireResponse` (M9 discipline assessments), `Claim` / `ClaimResponse` / `ExplanationOfBenefit` (M23 billing) are Phase 2** — the seam contracts are wired but the routes return `404 Not Found` with `OperationOutcome` until each is enabled. **Bereavement `CarePlan` is Phase 2** — M16's bereavement plans project to `CarePlan` with `category='bereavement'`, the seam contract is wired but the projection is not enabled in Phase 1. **`Location` resource is Phase 2** — addresses are inlined on `Patient.address[]` and `Organization.address[]` and `Encounter.location[]` references `Location` via the platform identifier URI but no `GET /fhir/r4/Location/{id}` is exposed in Phase 1 — the route returns `404`. **SMART-on-FHIR EHR-launch (user-facing app launch with the `aud` parameter) is Phase 2** — Phase 1 supports Backend Services only (system-to-system) per D2; the EHR-launch surface lands when M31 Portal lands and the patient-facing SMART app catalog is defined. **SMART-on-FHIR user-launch with refresh tokens is Phase 2.** The "done" gate for M28 is: SMART Backend Services authentication operational with per-client JWKS + scope validation + token mint + bearer-token verification + tier-based rate limiting; the FHIR R4 mapper package `packages/fhir/r4/` with mappers for the Phase-1 v1 resource set + Coverage + RelatedPerson + Binary + Consent + CodeSystem + ValueSet + CapabilityStatement + OperationOutcome + Bundle + List + DiagnosticReport wired against the consumed seams; the `FhirSearchTranslator` typed contract with US Core 6.0 mandatory search parameters per resource type wired against the consumed seams; the `$everything` operation with the D5 scope and cap; the `$export` operation with the D4 NDJSON-to-MinIO BullMQ job model; the `$expand` and `$validate-code` operations delegating to M38; the `$export` polling and `$export-poll-status` endpoints; the inbound-FHIR POST endpoint with the D8 propose-then-review pipeline; the per-tenant identifier URI scheme per D9; the read-time `Provenance` composition per D10; the boot-time `CapabilityStatement` generation per D11; the `fhir_client` registry with the D12 onboarding/revocation workflow; the cursor-based pagination per D13; the AI-prohibited-zone validator wired against M32's prompt registry per D14; `auditRead()` on every FHIR read per D15; the tier-based rate limits per D16; the published `FhirGatewayMetricsProvider`, `FhirClientReader`, `FhirInboundProposalReader` seams per D17; and the test plan green. Not gated on M30 / M33 / M34 / M35 existing — those consume M28's metrics seam as forward seams. **The M23 forward-seam projection for `Claim` / `ClaimResponse` / `ExplanationOfBenefit` wires the consumer side now via the seam registry but the routes return `404` until Phase 2 enables them.**


## 1. Purpose & Scope

### 1.1 What This Module Does

- **Exposes the WardenX clinical record as FHIR R4 resources at standardized REST endpoints.** `GET /fhir/r4/{ResourceType}/{id}`, `GET /fhir/r4/{ResourceType}?{search}`, `GET /fhir/r4/Patient/{id}/$everything`, `POST /fhir/r4/$export`, `POST /fhir/r4/Patient/{id}` (inbound staging), `GET /fhir/r4/metadata`, `GET /fhir/r4/CodeSystem/{system}`, `GET /fhir/r4/ValueSet/{vs}/$expand`, `POST /fhir/r4/CodeSystem/$validate-code`. The wire shape conforms to US Core 6.0 (R4-based) for the resources US Core defines; non-US-Core resources follow base FHIR R4 with the hospice-domain extensions specified in §2.4 (level-of-care, election-period, CTI / F2F attestation).
- **Translates FHIR search syntax into upstream reader-seam calls.** The `FhirSearchTranslator` (§4.5) is a typed contract that maps FHIR search parameters (e.g., `Patient?_id=...&birthdate=...&identifier=...`) into the parameter set the consumed reader seams accept (e.g., `PatientReader.findById`, `PatientReader.searchByIdentifier`). No SQL is constructed inside M28 — every clinical read goes through a published reader seam, which means M28 cannot read PHI tables M28 has not been granted access to via a registered seam. The seam registry's boot validation enforces this at startup.
- **Mints and validates SMART-on-FHIR Backend Services bearer tokens.** Per D2 the authentication model is asymmetric JWT against a per-client-registered JWKS URI for system-to-system clients. The `POST /fhir/oauth2/token` endpoint accepts the SMART Backend Services `grant_type=client_credentials` with a signed `client_assertion` JWT, verifies the assertion against the client's published JWKS, validates the requested scopes against the client's `allowed_scopes[]`, and mints a short-lived bearer token (15 minutes) stored in `fhir_client_session`. Every subsequent FHIR call presents the bearer token; M28's authentication middleware verifies it against the session row and rejects expired / revoked / unknown tokens with `401 Unauthorized` + `OperationOutcome`.
- **Runs the asynchronous bulk-export job pipeline.** Per D4 the `$export` operation accepts the FHIR-spec request envelope (resource types, since, patient list), validates the consuming client's scope, enqueues a `fhir.bulk-export` BullMQ job, returns `202 Accepted` with `Content-Location: /fhir/r4/$export-poll-status/{job_id}`, and the worker streams NDJSON per resource type to MinIO under `tenants/<org>/fhir-exports/<job_id>/{resource_type}.ndjson`. The status endpoint returns `202 In-Progress` with `X-Progress` until completion, then `200 OK` with the FHIR-spec `output[]` array of per-resource-type signed download URLs at 24-hour TTL.
- **Stages inbound FHIR resources for review by the owning WardenX module.** Per D8 the inbound POST endpoint accepts a FHIR resource, validates the wire shape against the M28-shipped JSON-Schema profiles per resource type, persists the payload in `fhir_inbound_resource` tagged `pending`, and publishes `m28.fhir.inbound.proposed` to the outbox. The owning module's consumer (M5 for `Patient`, M12 for `MedicationStatement`) reads the proposal and decides accept / reject through a WardenX-side review screen. M28 does not write to M5 / M12 / M22 / etc. tables under any circumstance.
- **Composes `Provenance` resources at read time from upstream signature trails.** Per D10 `Provenance` is not a stored row in M28 — it is a deterministic composition from M22's `ExtractionProvenanceReader` (DocLens-derived chart fields), M8's encounter-signature trail (the M8 author + cosigner ABAC-derived `Provenance.agent[]`), and M11/M12/M13's order/medication/administration-signature trails. The composer is invoked only when `_include=Resource:provenance` or `_revinclude=Provenance:target` is present in the search request, or `provenance.include=true` is passed to `$everything`.
- **Exposes Module 38 terminology as FHIR `CodeSystem` and `ValueSet` resources.** Per architecture §F + the M38 D-FHIR pattern, `GET /fhir/r4/CodeSystem/{system}` returns the projection of an M38-managed code system as a FHIR `CodeSystem`, `GET /fhir/r4/ValueSet/{vs}/$expand` invokes M38's expansion path and shapes the result as a FHIR `ValueSet`, and `POST /fhir/r4/CodeSystem/$validate-code` delegates to M38's `validate` path. M28 owns the FHIR wire shape; M38 owns the projection. The `asOfDate` parameter is honored per M38.
- **Generates and publishes the `CapabilityStatement` at boot.** Per D11 the `GET /fhir/r4/metadata` endpoint returns a deterministic JSON conformance statement built at boot from the route registry + the seam catalog. The statement covers: resource types supported (with `interaction=read|search-type` per resource), search params per resource (the US Core 6.0 mandatory set + the hospice-domain extensions), `_include` / `_revinclude` (where supported), supported operations (`$everything`, `$expand`, `$validate-code`, `$export`), security (SMART-on-FHIR Backend Services with the `system/*.read` and `system/*.write` scope grammar). The statement is persisted as the platform-singleton `fhir_capability_snapshot` row with a signed (HMAC-SHA256) checksum so consumers can verify what the gateway advertised at the time of a disclosure. The published statement includes the `DiagnosticReport` resource and the two Practitioner NPPES extension URIs.
- **Manages the per-recipient FHIR client registry.** Per D12 each external consumer is represented as a `fhir_client` row with `client_id` UUID, `name`, `type` (`smart_backend_services` or `api_key`), `jwks_uri` (for SMART) or `credential_id` (for API-key), `allowed_scopes[]` (subset of `system/Patient.read system/Encounter.read ...`), `tier` (`tier-1` / `tier-2` / `tier-3`), `rate_limit_rps`, `ip_allowlist[]`, `baa_contract_reference`, `status` (`active` / `suspended` / `revoked`), `organization_id`. The onboarding workflow requires Org Admin + Compliance Officer dual approval; revocation is one-click and audited.
- **Enforces tier-based rate limits and per-client concurrency caps.** Per D16 a Valkey-backed sliding window enforces tier-1 100 RPS, tier-2 10 RPS, tier-3 1 RPS per client; bulk-export is capped at 1 concurrent job per client; rate-limit-violation responses are `429 Too Many Requests` with `Retry-After` and `OperationOutcome`.
- **Emits an `auditRead()` row for every FHIR read.** Per D15 every FHIR GET / search / `$everything` / `$export` operation emits a `phi.read` audit row through M4's `auditRead()` helper with the typed query envelope (resource type, query parameters, `_include` / `_revinclude`, `_count`), the result count, the consuming `fhir_client_id`, the requesting IP, and the user-agent — producing the HIPAA §164.528 right-to-an-accounting-of-disclosures evidence trail.
- **Projects lab results as FHIR DiagnosticReport + child Observation resources.** M11's `m11.order.results_received` arrives when M29 attaches a lab observation to an order. M28 reads the order via M11's `OrderProvider`, the observation values via M29's `LabObservationReader`, the ordering provider via M40's `ExternalPhysicianReader`, and the patient via M5's `PatientReader`; composes a deterministic FHIR `DiagnosticReport` with `result[]` referencing per-value `Observation` projections. SUD redaction (D3) extends to whole-report redaction when any contained value is SUD-class (D20).
- **Surfaces NPPES freshness on Practitioner.** Two FHIR extensions on `Practitioner` carry the NPPES `lastSyncedAt` and `deactivatedAt` metadata from M40, letting downstream consumers reason about practitioner data currency (D21). The extension URIs are published as part of M28's CapabilityStatement.

### 1.2 What This Module Does Not Do

- **Compute clinical data.** Every clinical value on the wire originates from a consumed reader seam — `PatientReader`, `SignedEncountersReader`, `MedicationOrderProvider`, `MedicationAdministrationProvider`, `CarePlanReader`, etc. M28 does not derive, compute, or synthesize clinical content. The FHIR projections are deterministic mappings — given the same source data and the same `asOf` parameter, two M28 instances produce byte-identical output.
- **Persist clinical resources.** No M28-owned table carries clinical PHI. The `fhir_inbound_resource` table stages inbound resources for owner-module review and is destruction-erased on rejection or owner-module-acceptance; the bulk-export NDJSON files live in MinIO at `tenants/<org>/fhir-exports/<job_id>/` for 24 hours and are auto-purged. M28 stores no resource that the owning module hasn't already authored. The `DiagnosticReport` and its child `Observation` projections are likewise composed at read time from M11 + M29 source data and never persisted.
- **Run AI rewrites at egress.** Per D14 Module 32's LLM may not synthesize, modify, or redact FHIR resources. The 42 CFR Part 2 redaction (D3) is a deterministic gate consulted against M39's `ConsentEvaluator`, not an AI summarization. The boot validator `validateFhirAIBlock()` blocks M32 from holding any prompt that mentions M28 routes or FHIR resources for content generation.
- **Compute compliance signals or quality measures from FHIR data.** Module 30 (HQRP & Quality) owns the quality measure computations. M28 publishes the `FhirGatewayMetricsProvider` seam M30 consumes for the per-quarter disclosure-volume metric; M30 reads and computes; M28 does not compute.
- **Mint long-lived presigned URLs for `DocumentReference.content[].attachment.url`.** Per M22 the URL is a short-lived presigned MinIO URL minted by M28 *at the time the FHIR resource is served*, not stored on the M22 `document_record` row. The URL is valid for 15 minutes per the magic-link pattern in architecture §7.6.
- **Hold any consent state.** Module 39 owns the `consent` table and the state machine. M28 calls `ConsentEvaluator.evaluateForDisclosure(patientId, recipientClientId, asOf)` synchronously on every egress and honors the response. A consent revocation that arrives between M28's evaluate-call and the resource serialization is honored on the *next* call — there is no race-window mitigation inside M28; the gate is the synchronous evaluate.
- **Run SMART-on-FHIR EHR-launch (user-facing app launch).** Phase 1 is Backend Services only. The EHR-launch surface — the `iss`, `launch`, `aud` parameters, the `openid fhirUser launch/patient` scope grammar, the patient-facing app catalog — lands in Phase 2 alongside M31 Portal and the patient-facing SMART app catalog.
- **Project `ServiceRequest`, `QuestionnaireResponse`, `Claim`, `ClaimResponse`, `ExplanationOfBenefit` in Phase 1.** The seam contracts are wired; the routes return `404 Not Found` with `OperationOutcome` until each is enabled (per D1 phase boundary).
- **Project `Location` in Phase 1.** Addresses are inlined on `Patient.address[]` / `Organization.address[]` / `Encounter.location[]` references via the platform identifier URI; the `GET /fhir/r4/Location/{id}` route returns `404` (per D1 phase boundary).
- **Generate clinical narrative for FHIR resources via AI.** `Resource.text.div` (FHIR narrative) is composed deterministically from the structured fields per the FHIR-spec generated-narrative algorithm — never AI-generated.
- **Stream EHR-style HL7 v2 ADT, ORU, ORM.** Those are Module 29 (External Interfaces). M28 is FHIR-only.
- **Manage Xero / Gusto / Stripe integrations.** Those are M29, M27, M35. M28 only knows FHIR clients.
- **Replace internal cross-module communication.** Cross-module communication within WardenX uses the seam registry + outbox per architecture §25; M28 is for *external* consumers. Internal modules consume the same source-of-truth via the reader seams M28 also consumes; they do not call M28's FHIR routes.

### 1.3 Regulatory & Operational Drivers

- **HIPAA §164.528 — Right to an Accounting of Disclosures.** Every FHIR read of PHI by an external consumer is a disclosure that the covered entity must be able to enumerate on request from the patient. Per D15 every FHIR read emits an `auditRead()` row with the consuming `fhir_client_id`, the resource type, the query parameters, the result count, and the timestamp. The retention class is `compliance` per M4. The §164.528 accounting workflow is M4-owned but reads M28's audit trail as the disclosure source.
- **HIPAA §164.502(b) — Minimum Necessary.** Per D12 each `fhir_client` is registered with an `allowed_scopes[]` array enumerating the precise resource types and read patterns the client is authorized to access. The SMART scope check rejects `system/Patient.read` requests from a client whose `allowed_scopes[]` does not include the resource type — a tier-2 referral client with `system/Encounter.read system/Observation.read` cannot request `system/Patient.read` and will receive `403 Forbidden` with `OperationOutcome.issue.code='forbidden'`.
- **HIPAA §164.514 — De-identification & Limited Data Sets.** The Phase-2 research export pattern per security-hardening §8.5 produces a de-identified bulk export; M28's Phase-1 bulk export is identifiable PHI under a BAA (`baa_contract_reference` per D12) and the de-identification step is M30 + M22-owned, not M28-owned.
- **42 CFR Part 2 §2.32 — Prohibition on Re-disclosure.** Per architecture §J + M39 the system redacts SUD data in FHIR exports by default; explicit consent referencing the recipient is required. Per D3 the `ConsentEvaluator.evaluateForDisclosure` consult is the per-resource gate; the redaction is enforced *at egress*, not at storage; a SUD-flagged medication is present in the source `medication_order` table but absent from the `MedicationRequest` FHIR projection unless the consent gate opens. A lab `DiagnosticReport` whose any child observation is SUD-class is whole-report-redacted per D20.
- **ONC 21st Century Cures Act §4001 — Information Blocking.** A covered actor that engages in a practice that interferes with or discourages access to, exchange of, or use of EHI commits information blocking. M28 is the *primary* interoperability surface for WardenX clinical data; the §4001 conformance posture is "expose what is requested under a valid scope; redact only what regulation requires." The `OperationOutcome` returned on a redaction-induced empty Bundle must include `issue.severity=warning` with `issue.details.text` describing the regulatory basis (e.g., "filtered for 42 CFR Part 2; consent absent") so the consumer can request consent rather than misinterpreting the empty Bundle as "no data."
- **ONC HTI-1 / HTI-2 — Decision Support Intervention transparency.** Where M28 projects an AI-augmented clinical resource (e.g., a HearthNote Layer 2 narrative on `DocumentReference.description`), the `Provenance.activity` per D10 includes the M22 extraction-provenance with the AI-model identity and the per-field provenance flag so the consumer can distinguish AI-augmented content from human-authored content. This is part of M22 / M32 architecture §10 governance; M28 is the wire surface.
- **ONC USCDI v3+ — Standard Data Classes.** Phase 1's resource set covers the bulk of USCDI v3 with explicit gaps: USCDI v3 Care Team Member overlaps `PractitionerRole` (Phase 1); USCDI v3 Procedures overlaps `ServiceRequest` (deferred to Phase 2); USCDI v3 Goals overlaps `Goal` (Phase 1); USCDI v3 Health Concerns overlaps `Condition` (Phase 1). Per architecture §23.9 the explicit USCDI mapping is Phase-2 scope (forward-seam pattern); Phase 1 conforms to US Core 6.0 which subsumes most of USCDI v3.
- **US Core 6.0 Implementation Guide.** The Phase-1 v1 resource set conforms to US Core 6.0 (R4-based) for the resources US Core defines: `Patient`, `Encounter`, `Observation`, `MedicationRequest`, `MedicationAdministration`, `Condition`, `CarePlan`, `Goal`, `DocumentReference`, `DiagnosticReport`, `Practitioner`, `PractitionerRole`, `Organization`, `Coverage`, `RelatedPerson`. The `CapabilityStatement` declares the US Core 6.0 IG dependency and the supported profiles.
- **FHIR Bulk Data Access (Flat FHIR) v2.0.0.** The `$export` operation conforms to the FHIR Bulk Data spec: the request envelope, the polling envelope (`Content-Location`, `X-Progress`), the completion manifest (`output[]` with `type`, `url`, `count`), the abort semantics (`DELETE` to the polling URL), the file format (NDJSON, one resource per line).
- **SMART App Launch v2.0.0 — Backend Services.** The Phase-1 authentication conforms to the SMART Backend Services flow: client registration with JWKS URI, asymmetric JWT `client_assertion`, scope grammar `system/*.read` and `system/*.write`, token endpoint `/fhir/oauth2/token`, well-known config endpoint `/fhir/.well-known/smart-configuration`.
- **CMS Interoperability and Patient Access Final Rule (CMS-9115-F).** Hospice agencies are not yet in scope for CMS-9115-F (which targets Medicare Advantage / Medicaid Managed Care / CHIP / QHP issuers as of the rule date), but the architectural posture matches: standardized FHIR API, SMART-on-FHIR auth, US Core conformance, public CapabilityStatement. When the rule extends to hospice (anticipated), M28 is conformant out of the box.
- **State-level health information exchange (HIE) onboarding requirements.** Some states require hospice agencies to subscribe to a state HIE (e.g., Oregon's OHA HIE program, Indiana's IHIE). The `fhir_client` registry per D12 is the operational surface for HIE onboarding — each HIE is one client, with the HIE-defined scopes and the HIE-required IP allowlist; the per-tenant `tenant_fhir_config.tenant_fhir_host` per D9 is the URL the HIE registers.

### 1.4 Competitive Context

The hospice EHR competitive landscape (HCHB, Axxess, MatrixCare, Suncoast, Hospice Tools) ships varying degrees of FHIR-readable data. Most ship a basic Patient/Encounter/Observation read surface, none ship a complete SMART-on-FHIR Backend Services auth model with per-client scope enforcement and disclosure-accounting integration. WardenX's posture matches the broader EHR market's "FHIR-first interoperability" stance (Epic, Cerner, athenahealth, eClinicalWorks all support SMART Backend Services with US Core conformance); M28 brings hospice-domain FHIR conformance — election-period, level-of-care, CTI / F2F attestation extensions — into the same architecture.

The module-architectural decision that distinguishes M28 from peer offerings is **the reader-seam-only data path** (§4.4): M28 cannot read PHI tables it has not been granted access to via a registered seam, which means a future "I want to expose an FHIR resource for {new domain}" requires the owning module to publish a typed reader seam first, not a new schema import. This is the architectural fitness rule (architecture §25.15 check 5) applied to the interop layer, and it inverts the typical "interop layer touches all PHI tables" anti-pattern.


## 2. Domain Model

### 2.1 Entity-Relationship Diagram

```
                    ┌───────────────────────┐
                    │  organization (M1)    │
                    │  (tenant)             │
                    └───────────┬───────────┘
                                │
            ┌───────────────────┼───────────────────────────────────────┐
            ▼                   ▼                                       ▼
┌───────────────────────┐  ┌───────────────────────┐    ┌─────────────────────────────┐
│  tenant_fhir_config   │  │  fhir_client          │    │  fhir_bulk_export_job       │
│  ─────────────────    │  │  ─────────────────    │    │  ─────────────────          │
│  organization_id (PK) │  │  id (UUID)            │    │  id (UUID)                  │
│  tenant_fhir_host     │  │  organization_id  ────┼────►  organization_id            │
│  identifier_uri_base  │  │  name                 │    │  client_id ─────► fhir_client│
│  cursor_signing_key   │  │  type                 │    │  status                     │
│   _cipher (per-tenant │  │  jwks_uri (nullable)  │    │  request_envelope           │
│   DEK-encrypted)      │  │  credential_id        │    │  resource_types[]           │
│  capability_overrides │  │   (FK → fhir_client_  │    │  since_iso                  │
│   (jsonb)             │  │    credential)        │    │  group_id (nullable)        │
│  inbound_review_sla   │  │  allowed_scopes[]     │    │  total_resources            │
│   _hours              │  │  tier                 │    │  artifact_count             │
└───────────────────────┘  │  rate_limit_rps       │    │  started_at                 │
                           │  ip_allowlist[]       │    │  completed_at               │
                           │  baa_contract_ref     │    │  expires_at (24h TTL)       │
                           │  status               │    │  initiated_by_membership_id │
                           │  approved_by_admin_id │    └──────────────┬──────────────┘
                           │  approved_by_compl_id │                   │
                           └──────────┬────────────┘                   │
                                      │                                ▼
                                      │             ┌──────────────────────────────────┐
                                      │             │  fhir_bulk_export_artifact       │
                                      │             │  ─────────────────               │
                                      │             │  id (UUID)                       │
                                      │             │  job_id ──► fhir_bulk_export_job │
                                      │             │  resource_type                   │
                                      │             │  minio_object_key                │
                                      │             │  byte_size                       │
                                      │             │  row_count                       │
                                      │             │  checksum_sha256                 │
                                      │             └──────────────────────────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌────────────────────────────┐                  ┌────────────────────────────────────┐
│  fhir_client_credential    │                  │  fhir_client_session               │
│  ─────────────────         │                  │  ─────────────────                 │
│  id (UUID)                 │                  │  jti (UUID — JWT ID)               │
│  client_id ──► fhir_client │                  │  client_id ──► fhir_client         │
│  kind                      │                  │  organization_id                   │
│   ('api_key' | 'jwks_pin') │                  │  scopes_granted[]                  │
│  secret_cipher (per-tenant │                  │  issued_at                         │
│   DEK-encrypted; only the  │                  │  expires_at (15-min TTL)           │
│   sha256 digest is matched)│                  │  last_used_at                      │
│  fingerprint (for ops      │                  │  revoked_at (nullable)             │
│   display only)            │                  │  ip_at_issue                       │
│  rotated_at                │                  └────────────────────────────────────┘
│  status                    │
└────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │  fhir_inbound_resource                       │
                    │  ─────────────────                           │
                    │  id (UUID)                                   │
                    │  organization_id                             │
                    │  source_client_id ──► fhir_client            │
                    │  resource_type                               │
                    │  source_fhir_id (the consumer's claimed id)  │
                    │  payload (jsonb — raw FHIR resource)         │
                    │  payload_sha256 (digest for audit)           │
                    │  proposed_at                                 │
                    │  owner_module ('m5' | 'm12' | ...)           │
                    │  proposal_status                             │
                    │   ('pending'|'accepted'|'rejected'|'expired')│
                    │  decided_by_membership_id                    │
                    │  decided_at                                  │
                    │  decision_rationale (≥40 chars for reject)   │
                    │  accepted_aggregate_id (the WardenX-side id  │
                    │   created/updated by the owner module)       │
                    │  validation_errors (jsonb)                   │
                    └──────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │  fhir_capability_snapshot  (platform-shared) │
                    │  ─────────────────                           │
                    │  id (UUID) — platform singleton per release  │
                    │  fhir_version ('4.0.1' | '5.0.0' | '6.0.0')  │
                    │  release_tag (the WardenX platform release)  │
                    │  generated_at                                │
                    │  capability_statement (jsonb)                │
                    │  checksum_sha256                             │
                    │  signature (HMAC-SHA256 over checksum, the   │
                    │   platform signing key in the boot          │
                    │   environment)                               │
                    │  organization_id (NULL — platform row)       │
                    └──────────────────────────────────────────────┘
```

**Tables M28 owns (eight):** `tenant_fhir_config`, `fhir_client`, `fhir_client_credential`, `fhir_client_session`, `fhir_bulk_export_job`, `fhir_bulk_export_artifact`, `fhir_inbound_resource`, `fhir_capability_snapshot`.

**Tables M28 reads via reader seams (never schema imports):** every PHI-bearing table in M5, M6, M7, M8, M9, M10, M11, M12, M13, M15, M22, M23 (forward), M29, M38, M39, M40. The dependency-cruiser boundary check (architecture §25.15) blocks any `import` from a non-listed code path.

### 2.2 Per-Entity Lifecycle

#### `tenant_fhir_config`

One row per `organization_id`. Seeded at tenant onboarding with the platform-default identifier URI base, a freshly generated per-tenant cursor signing key (envelope-encrypted via the M1 per-tenant DEK), and the default inbound-review SLA of 72 hours. The platform admin can override the `tenant_fhir_host` (e.g., `engrace-fhir.wardenx.com` vs. the default `<org-slug>.fhir.wardenx.com`); the cursor signing key is rotated annually via the M34 rotation workflow. Never deleted while the tenant is active; tombstoned with the tenant per M4 destruction-cert workflow.

#### `fhir_client` — onboarding state machine

```
                  ┌─── proposed ────┐
                  │     (Org Admin   │
                  │      requests)   │
                  ▼                  │
            ┌───────────┐            │
            │  pending  │  (rejected)│
            │ _approval │─────────►  rejected
            └─────┬─────┘            │
                  │ (Compl Officer   │
                  │  co-approves)    │
                  ▼                  │
            ┌──────────┐             │
            │  active  │             │
            └────┬─────┘             │
                 │ (manual or        │
                 │  rate-violation)  │
                 ▼                   │
            ┌─────────────┐          │
            │  suspended  │──────────┤
            └─────┬───────┘   (manual unsuspend)
                  │              ▼
                  │           active
                  │
                  │ (Org Admin or platform-ops)
                  ▼
            ┌──────────┐
            │ revoked  │   ◄── terminal; tombstoned in audit
            └──────────┘
```

Transitions emit `audit_event.action` per the table. Per D12 the `pending_approval → active` transition requires two distinct memberships (`approved_by_admin_id` and `approved_by_compliance_id`) and the row's `status` cannot flip without both being non-null. The compliance-officer signature is the survey-defense artifact for a HIPAA §164.504 business-associate-agreement-in-place posture; the `baa_contract_reference` must be a valid M34 contract id by row insert.

#### `fhir_client_credential`

For `kind='api_key'`, the row holds a per-tenant DEK-encrypted `secret_cipher` and a `fingerprint` (first 8 chars of the sha256 of the secret) for ops display only. The secret is never returned to a UI surface after creation — the onboarding flow returns the plaintext once at creation and the Org Admin must capture it. `kind='jwks_pin'` is a future option for clients that wish to pin a specific JWK by `kid` rather than rely on the `jwks_uri` rotation; Phase 1 ships only `api_key`. Rotation creates a new row with `status='active'`, retires the prior with `status='retired'` and a 30-day overlap window during which both verify, then the prior is destruction-erased per M4.

#### `fhir_client_session`

Created on token mint at `POST /fhir/oauth2/token`; 15-minute TTL; deleted (or marked `revoked_at`) on explicit revoke. The `jti` (JWT ID) is the bearer-token identity; the bearer token itself is not stored — only the `jti` plus the sha256 of the token-signing key fingerprint plus the `scopes_granted[]`. The token verification middleware checks `jti` against the row, validates `expires_at`, validates `revoked_at IS NULL`, and updates `last_used_at`. Sessions are partitioned monthly by `issued_at` per the M4 partition convention.

#### `fhir_bulk_export_job` — lifecycle

```
              ┌───────────┐
              │ accepted  │  (POST /$export returns 202)
              └─────┬─────┘
                    │ (worker picks up)
                    ▼
              ┌───────────────┐
              │ in_progress   │
              └────┬──────────┘
                   │ (worker completes per resource type)
                   ▼
              ┌───────────┐
              │ completed │  ◄── output[] URLs minted
              └─────┬─────┘
                    │ (24h elapse)
                    ▼
              ┌──────────┐
              │ expired  │  ◄── NDJSON files purged from MinIO
              └──────────┘

              ┌───────────────┐
              │ in_progress   │
              └────┬──────────┘
                   │ (worker error or DELETE /$export-poll-status/{id})
                   ▼
              ┌──────────┐
              │ failed   │   or   ┌──────────┐
              └──────────┘        │ cancelled │
                                   └──────────┘
```

Concurrency: one job per client at a time; a second submission while one is `accepted` or `in_progress` returns `429 Too Many Requests`. Per D4 the worker writes one NDJSON file per resource type to MinIO (`tenants/<org>/fhir-exports/<job_id>/{resource_type}.ndjson`), one `fhir_bulk_export_artifact` row per file with `checksum_sha256`, and updates `total_resources` + `artifact_count` on completion. The 24-hour `expires_at` is set on completion; a sweeper job moves `completed → expired` and purges the MinIO objects.

#### `fhir_inbound_resource` — lifecycle

```
              ┌──────────┐
              │ pending  │
              └────┬─────┘
                   │ (owner-module reviewer accepts → owner-module write succeeds)
                   ▼
              ┌──────────┐
              │ accepted │ ◄── accepted_aggregate_id pinned
              └──────────┘

              ┌──────────┐
              │ pending  │
              └────┬─────┘
                   │ (owner-module reviewer rejects with rationale ≥ 40 chars)
                   ▼
              ┌──────────┐
              │ rejected │
              └──────────┘

              ┌──────────┐
              │ pending  │
              └────┬─────┘
                   │ (SLA breach: pending > inbound_review_sla_hours)
                   ▼
              ┌──────────┐
              │ expired  │ ◄── M36 alert fires per D12
              └──────────┘
```

Per D8 the owner module's reviewer is the only actor authorized to transition the row — enforced by the `fhir_inbound_owner_module_match` ABAC predicate registered with M3. On acceptance, the owner module writes its native row (an `m5.patient` update, an `m12.medication_history_record` insert) and emits its native outbox event; the `fhir_inbound_resource.accepted_aggregate_id` is pinned by the owner's accept callback. On rejection, the payload is destruction-erased to its sha256 digest after a 30-day retention for dispute resolution; the audit trail keeps the rejection rationale.

#### `fhir_capability_snapshot`

Generated at boot. Per D11 the platform-singleton row is keyed by `release_tag`; on startup the bootstrap checks whether the current `release_tag` has a row, generates the statement from the route registry + the seam catalog if not, computes the checksum, signs with the platform signing key, and persists. The `GET /fhir/r4/metadata` endpoint reads this row (cached in memory per process) and returns the `capability_statement` JSON; the signed checksum is the survey-defense artifact for what the gateway advertised at the time of a disclosure. The regenerated snapshot includes the `DiagnosticReport` resource and the two Practitioner NPPES extension URIs.

### 2.3 Validation Rules (Domain-Level, Not the Wire-Shape Schemas)

- **`fhir_client.tier ∈ {'tier-1','tier-2','tier-3'}`**; the `rate_limit_rps` must match the platform-floor for the tier (tier-1 100, tier-2 10, tier-3 1) — tenants may *tighten* (lower) the rate limit but never *loosen* it per the platform-floor / tenant-tighten-only semantics (per the architecture §-fitness rule).
- **`fhir_client.allowed_scopes[]` must be a subset of `SUPPORTED_SCOPES`**; an attempt to register a scope outside the supported set is rejected at admin-route validation time with `INVALID_SCOPE`. The `SUPPORTED_SCOPES` constant in `packages/fhir/src/auth/scopes.ts` is the single source of truth; new scopes require a code-level addition, not a runtime configuration.
- **`fhir_client.jwks_uri` must be HTTPS and have a verifiable JWKS at registration time**; M28's onboarding worker fetches `<jwks_uri>` once and parses the response; any non-200, non-JSON, or JWKS-without-RSA-keys response rejects the registration. Subsequent JWKS rotations are picked up on next token mint (cached for 5 minutes per architecture §25.4 cache TTL convention).
- **`fhir_client.ip_allowlist[]` entries must be valid CIDR**; empty array = no IP restriction (default for tier-1 partners); non-empty = enforce on every request including token mint.
- **`fhir_client.baa_contract_reference` must resolve to an active M34 contract** at the moment of approval; if M34 returns "expired" or "missing," the approval is rejected.
- **`fhir_client_session.scopes_granted[]` must be a subset of `fhir_client.allowed_scopes[]`** at the time of token mint; if the client requests a broader scope at `/oauth2/token`, the response is `400 Bad Request` with `error='invalid_scope'`.
- **`fhir_bulk_export_job.resource_types[]` must be a subset of the active `CapabilityStatement.rest[].resource[].type` set** at request time; otherwise reject `400` with `unsupported_resource_type` and the OperationOutcome lists the deviating types.
- **`fhir_bulk_export_job.expires_at` is server-generated** to `completed_at + 24 hours`, never client-influenced.
- **`fhir_inbound_resource.payload` must validate against the M28-shipped JSON-Schema profile for the `resource_type`** before persistence; otherwise reject at the POST with `400 Bad Request` + `OperationOutcome` enumerating the issues; no `fhir_inbound_resource` row is created on schema failure.
- **`fhir_inbound_resource.owner_module` must be in `KNOWN_OWNER_MODULES`** = `{'m5','m12'}` in Phase 1 (Patient demographic → M5; MedicationStatement → M12); inbound for unrecognized resource types returns `501 Not Implemented`.
- **`fhir_capability_snapshot.signature` must verify against the platform signing key** at every read; a verification failure aborts boot.
- **The `cursor_signing_key_cipher` on `tenant_fhir_config` must decrypt successfully** at every cursor verification; a decryption failure on a presented cursor returns `400 Bad Request` with `invalid_cursor`.

### 2.4 Side Effects

| Action | Side effects |
|--------|--------------|
| `fhir_client` created with `status='pending_approval'` | outbox `m28.fhir.client.pending_approval` + audit; M36 alert routed to Compliance Officer + Org Admin |
| `fhir_client` transitions to `active` | outbox `m28.fhir.client.activated` + audit; M36 alert to Org Admin (informational); per-client rate-limit counters initialized in Valkey |
| `fhir_client` transitions to `suspended` or `revoked` | outbox `m28.fhir.client.revoked` + audit; all active `fhir_client_session` rows for the client marked `revoked_at=now()`; bulk-export jobs in `in_progress` are cancelled by the worker on next checkpoint; M36 alert to the operating partner contact via the BAA contact email (M34) |
| `fhir_client_session` token minted | row inserted; `auditRead()` of `phi.token_minted` per D15 with the typed envelope; rate-limit token-mint counter incremented |
| `fhir_bulk_export_job` created | row inserted with `status='accepted'`; BullMQ `fhir.bulk-export` job enqueued; M36 alert `fhir.bulk_export.accepted` (informational, suppressed if tier-1) |
| `fhir_bulk_export_job` transitions to `completed` | NDJSON artifacts persisted in MinIO; row updated with `completed_at`, `total_resources`, `artifact_count`; M36 alert `fhir.bulk_export.completed` to initiator with the polling URL; presigned URLs minted on demand at `GET /$export-poll-status/{id}` |
| `fhir_bulk_export_job` transitions to `expired` | NDJSON objects purged from MinIO; row updated with `status='expired'`; audit `phi.export_artifact_purged` |
| `fhir_inbound_resource` created (POST inbound) | row inserted with `proposal_status='pending'`; outbox `m28.fhir.inbound.proposed` with the typed envelope; M36 alert `fhir.inbound.proposal_pending` to the owner-module reviewer role |
| `fhir_inbound_resource` transitions to `accepted` | owner module writes its native row + emits its native outbox; M28 row updated with `accepted_aggregate_id`; audit `phi.inbound_accepted` |
| `fhir_inbound_resource` transitions to `rejected` | row updated with `decision_rationale`; payload destruction-scheduled at +30 days per M4 §3.7; audit `phi.inbound_rejected`; M36 alert to the source `fhir_client` BAA contact (informational) |
| `fhir_inbound_resource` transitions to `expired` | row updated with `proposal_status='expired'`; payload destruction-scheduled; M36 alert `fhir.inbound.proposal_overdue` to Compliance Officer |
| Any FHIR read served | `auditRead()` per D15 with the typed query envelope + result count + `fhir_client_id`; rate-limit counter incremented in Valkey; metrics counter incremented for `FhirGatewayMetricsProvider` consumption |
| `fhir_capability_snapshot` regenerated at boot | row inserted (or no-op if `release_tag` matches existing); audit `system.fhir_capability_regenerated`; M36 alert `fhir.capability.regenerated` to platform-ops |
| `m11.order.results_received` / `.results_received_critical` / `.transmission_status_changed` / `.transmission_terminal_failed` / `.results_overdue` consumed | the `m28.fhir-cache-invalidation` consumer invalidates the Valkey cache keys `DiagnosticReport/{orderId}`, `Patient/{patientId}/$everything` (and `ServiceRequest/{orderId}` for forward-compat); audit `m28.fhir.cache_invalidated` |
| `mdm.physician_deactivated` consumed | the cache-invalidation consumer invalidates `Practitioner/{mdmId}` and `PractitionerRole/{mdmId}`; audit `m28.fhir.cache_invalidated` |

### 2.5 Concurrency

- **Token mint:** `POST /fhir/oauth2/token` is idempotent per `(client_id, jti)`; the JTI is taken from the `client_assertion` JWT and rejects replays within the `expires_at` window via the M1 idempotency middleware.
- **Bulk-export submission:** one job per client at a time, enforced by a Valkey lock on `fhir:bulk-export:lock:<client_id>`; a second submission while one is `accepted` or `in_progress` returns `429 Too Many Requests` with `Retry-After: 60`.
- **Inbound proposal acceptance:** the owner module's accept callback is single-writer per `fhir_inbound_resource.id` via the M1 idempotency middleware with key `fhir.inbound.accept:<id>`. A second acceptance attempt is a no-op returning the prior result.
- **Capability snapshot regeneration:** at boot, an advisory lock on `fhir_capability_snapshot.<release_tag>` ensures only one process generates per platform release; followers read the persisted row.
- **Per-resource FHIR reads:** stateless and concurrent-safe — every read goes through reader seams that own their own concurrency guarantees; M28 holds no per-resource locks.
- **Rate-limit counter:** Valkey `INCR` with `EXPIRE` for the sliding window; the per-client counter is sharded per-second for low contention.
- **Cache invalidation:** the `m28.fhir-cache-invalidation` consumer's effect is naturally idempotent — Valkey `DEL` on an absent key is a no-op, so concurrent or replayed invalidations are safe.

### 2.6 Idempotency

- **`POST /fhir/oauth2/token`** — idempotent per `(client_id, jti)` from the `client_assertion` JWT; the M1 idempotency middleware persists the response for 15 minutes (the token TTL).
- **`POST /fhir/r4/$export`** — idempotent per `(client_id, sha256(request_envelope))`; a re-submission within 10 minutes returns the prior job's `Content-Location` rather than starting a new one. The 10-minute window is a tenant-config (`tenant_fhir_config.export_dedup_window_minutes`) defaulting to 10.
- **`POST /fhir/r4/{ResourceType}` inbound** — idempotent per `(source_client_id, resource_type, source_fhir_id)`; a re-submission updates the staged payload (with the prior payload archived to the audit trail) and resets the proposal SLA clock; the M28 row id is preserved.
- **Owner-module accept callbacks** — idempotent per `fhir_inbound_resource.id` per the M1 middleware.
- **Capability snapshot generation** — idempotent per `release_tag` per the advisory lock.
- **Cache invalidation consumers** — idempotent because Valkey `DEL` on an absent key is a no-op.


## 3. Drizzle Schema

M28 owns eight tables and introduces no new tables, columns, indexes, or migrations for the `DiagnosticReport` resource, the Practitioner NPPES extensions, or the cache invalidation — those are all code-only read-time projections and outbox consumers. The `fhir_capability_snapshot` row is regenerated at boot per D11; the `DiagnosticReport` resource and the new Practitioner extensions land in the regenerated snapshot.

### 3.1 Package Layout

```
packages/fhir/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                              # public exports
│   ├── seams.ts                              # FhirGatewayMetricsProvider + FhirClientReader + FhirInboundProposalReader
│   ├── boot.ts                               # registers seams, eraseFn, ABAC predicates, runs validateFhirAIBlock()
│   │
│   ├── r4/
│   │   ├── index.ts
│   │   ├── mappers/
│   │   │   ├── patient.ts                    # M5 → R4 Patient + US Core
│   │   │   ├── encounter.ts                  # M8 → R4 Encounter + US Core
│   │   │   ├── observation.ts                # M8 / M9 / M10 → R4 Observation + US Core
│   │   │   ├── medication-request.ts         # M12 → R4 MedicationRequest + US Core
│   │   │   ├── medication-administration.ts  # M13 → R4 MedicationAdministration
│   │   │   ├── medication-statement.ts       # M12 medhx → R4 MedicationStatement
│   │   │   ├── condition.ts                  # M7 → R4 Condition + US Core
│   │   │   ├── care-plan.ts                  # M7 IPOC + M15 discipline → R4 CarePlan + US Core
│   │   │   ├── goal.ts                       # M7 → R4 Goal + US Core
│   │   │   ├── document-reference.ts         # M22 → R4 DocumentReference + US Core
│   │   │   ├── binary.ts                     # M22 → R4 Binary
│   │   │   ├── practitioner.ts               # M2 + M40 → R4 Practitioner + US Core
│   │   │   ├── practitioner-role.ts          # M2 + M3 → R4 PractitionerRole + US Core
│   │   │   ├── organization.ts               # M2 + M40 → R4 Organization + US Core
│   │   │   ├── related-person.ts             # M5 caregivers → R4 RelatedPerson + US Core
│   │   │   ├── coverage.ts                   # M5 patient_payer → R4 Coverage + US Core
│   │   │   ├── consent.ts                    # M39 → R4 Consent
│   │   │   ├── list-medication-rec.ts        # M13 reconciliation → R4 List
│   │   │   ├── diagnostic-report/            # M11 + M29 → R4 DiagnosticReport + child Observation (D19, D20)
│   │   │   ├── code-system.ts                # M38 projection → R4 CodeSystem
│   │   │   ├── value-set.ts                  # M38 projection → R4 ValueSet
│   │   │   ├── capability-statement.ts       # boot-generated → R4 CapabilityStatement
│   │   │   ├── operation-outcome.ts          # error envelope builder
│   │   │   └── bundle.ts                     # paginated Bundle assembly
│   │   ├── search/
│   │   │   ├── translator.ts                 # FhirSearchTranslator typed contract
│   │   │   ├── parameters.ts                 # SUPPORTED_SEARCH_PARAMETERS per resource type
│   │   │   ├── cursor.ts                     # HMAC-signed cursor encode/decode
│   │   │   └── include.ts                    # _include / _revinclude resolver
│   │   ├── operations/
│   │   │   ├── everything.ts                 # Patient/$everything
│   │   │   ├── export.ts                     # system / Group / Patient $export
│   │   │   ├── expand.ts                     # ValueSet $expand → M38
│   │   │   └── validate-code.ts              # CodeSystem $validate-code → M38
│   │   ├── provenance/
│   │   │   └── composer.ts                   # read-time Provenance from upstream signature trails
│   │   └── narrative/
│   │       └── deterministic.ts              # text.div from structured fields (no AI)
│   │
│   ├── r5/
│   │   ├── mappers/                          # compile-shells (the R5 type defs imported, mappers return 415)
│   │   └── README.md                         # "ships at R5 lock"
│   │
│   ├── r6/
│   │   ├── mappers/                          # compile-shells
│   │   └── README.md                         # "ships at R6 lock; awaiting HL7 publication"
│   │
│   ├── auth/
│   │   ├── smart-backend-services.ts         # client_credentials flow + asymmetric JWT verify
│   │   ├── api-key.ts                        # API-key kind credential validation
│   │   ├── scopes.ts                         # SUPPORTED_SCOPES constant + scope-set matcher
│   │   ├── jwks-cache.ts                     # 5-minute JWKS cache + rotation pickup
│   │   └── well-known-config.ts              # /.well-known/smart-configuration generator
│   │
│   ├── consent/
│   │   └── egress-gate.ts                    # calls M39 ConsentEvaluator per resource at egress
│   │
│   ├── rate-limit/
│   │   └── valkey-sliding-window.ts          # tier-1/2/3 RPS + bulk-export concurrency
│   │
│   ├── seams/
│   │   └── consumed.ts                       # requireConsumedSeams() + requireV03Seams() (LabObservationReader)
│   │
│   └── interfaces/
│       ├── search-translator.ts              # FhirSearchTranslator + ResolvedSearchQuery types
│       ├── mapper.ts                         # FhirMapper<TDomain, TFhir> + version-pluggable contract
│       └── projection.ts                     # FhirCodeSystemProjection + FhirValueSetProjection (consumed from M38)

apps/backend/src/modules/28-fhir/
├── routes.ts
├── routes/
│   ├── metadata.ts                           # GET /fhir/r4/metadata
│   ├── well-known.ts                         # GET /fhir/.well-known/smart-configuration
│   ├── token.ts                              # POST /fhir/oauth2/token
│   ├── resource-read.ts                      # GET /fhir/r4/{type}/{id}
│   ├── resource-search.ts                    # GET /fhir/r4/{type}?{search}
│   ├── everything.ts                         # GET /fhir/r4/Patient/{id}/$everything
│   ├── export.ts                             # POST /fhir/r4/$export, /fhir/r4/Group/{id}/$export, /fhir/r4/Patient/$export
│   ├── export-status.ts                      # GET /fhir/r4/$export-poll-status/{id}, DELETE same
│   ├── code-system.ts                        # GET /fhir/r4/CodeSystem/{system}, $validate-code
│   ├── value-set.ts                          # GET /fhir/r4/ValueSet/{vs}, $expand
│   ├── inbound.ts                            # POST /fhir/r4/{type} (staged proposal)
│   └── admin/
│       ├── clients.ts                        # /api/v1/fhir/clients (admin)
│       ├── client-sessions.ts                # /api/v1/fhir/clients/{id}/sessions
│       ├── bulk-export-jobs.ts               # /api/v1/fhir/bulk-export-jobs (admin)
│       ├── inbound-proposals.ts              # /api/v1/fhir/inbound-proposals (admin)
│       └── config.ts                         # /api/v1/fhir/config (admin)
├── consumers/
│   └── cache-invalidation.ts                 # m28.fhir-cache-invalidation (M11 + M40 events)
├── services/
│   ├── client-onboarding.ts                  # the dual-approval workflow
│   ├── client-revocation.ts                  # cascade-revoke sessions + cancel jobs
│   ├── bulk-export-worker.ts                 # BullMQ fhir.bulk-export consumer
│   ├── bulk-export-sweeper.ts                # BullMQ fhir.bulk-export-sweeper (24h expiry)
│   ├── inbound-staging.ts                    # validate + persist + emit
│   ├── inbound-sla-watch.ts                  # BullMQ fhir.inbound-sla-watch (expiry detection)
│   ├── search-execution.ts                   # FhirSearchTranslator + reader-seam calls + Bundle assembly
│   ├── everything-execution.ts               # $everything scope + 5k cap + Bundle assembly
│   ├── audit-disclosure.ts                   # the auditRead() wrapper per D15
│   ├── rate-limit-gate.ts                    # the per-request gate
│   ├── consent-gate.ts                       # the per-resource egress gate
│   ├── tenant-config.ts                      # tenant_fhir_config CRUD
│   ├── capability-statement-builder.ts       # boot-time CapabilityStatement generator
│   └── fhir-client-reader.ts                 # implements FhirClientReader seam
├── workers/
│   ├── bulk-export.worker.ts                 # BullMQ worker
│   ├── bulk-export-sweeper.worker.ts
│   ├── inbound-sla-watch.worker.ts
│   └── capability-snapshot-validator.worker.ts  # hourly checksum verify
└── boot.ts                                   # registers M28's contributions
```

### 3.2 Migration Script Phases (`0028_fhir_gateway.sql`)

**Phase A — enums, then helper types.**

```sql
CREATE TYPE fhir_client_type AS ENUM ('smart_backend_services', 'api_key');
CREATE TYPE fhir_client_tier AS ENUM ('tier-1', 'tier-2', 'tier-3');
CREATE TYPE fhir_client_status AS ENUM ('pending_approval', 'active', 'suspended', 'revoked', 'rejected');
CREATE TYPE fhir_client_credential_kind AS ENUM ('api_key', 'jwks_pin');
CREATE TYPE fhir_client_credential_status AS ENUM ('active', 'retired');
CREATE TYPE fhir_bulk_export_status AS ENUM ('accepted', 'in_progress', 'completed', 'failed', 'cancelled', 'expired');
CREATE TYPE fhir_bulk_export_request_kind AS ENUM ('system', 'group', 'patient');
CREATE TYPE fhir_inbound_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');
CREATE TYPE fhir_inbound_owner_module AS ENUM ('m5', 'm12');
CREATE TYPE fhir_version_enum AS ENUM ('4.0.1', '5.0.0', '6.0.0');
```

**Phase B — `tenant_fhir_config`, `fhir_client`, `fhir_client_credential`, `fhir_client_session`.** Then `fhir_bulk_export_job` and `fhir_bulk_export_artifact`. Then `fhir_inbound_resource` (monthly-partitioned by `proposed_at` per M4 §3.6 PHI conventions). Then `fhir_capability_snapshot`.

**Phase C — RLS policies per the standard pattern (§3.5).**

**Phase D — write-audit triggers per the M4 §3.6 denylist (§3.6).**

**Phase E — indexes per §3.4.**

**Phase F — seed rows: the platform `fhir_capability_snapshot` for the current release tag; the `tenant_fhir_config` row for `Engrace Hospice LLC` with the default URI base.**

### 3.3 Schema Files (Drizzle)

```typescript
// packages/db/src/schema/fhir/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core'

export const fhirClientType = pgEnum('fhir_client_type', ['smart_backend_services', 'api_key'])
export const fhirClientTier = pgEnum('fhir_client_tier', ['tier-1', 'tier-2', 'tier-3'])
export const fhirClientStatus = pgEnum('fhir_client_status',
  ['pending_approval', 'active', 'suspended', 'revoked', 'rejected'])
export const fhirClientCredentialKind = pgEnum('fhir_client_credential_kind', ['api_key', 'jwks_pin'])
export const fhirClientCredentialStatus = pgEnum('fhir_client_credential_status', ['active', 'retired'])
export const fhirBulkExportStatus = pgEnum('fhir_bulk_export_status',
  ['accepted', 'in_progress', 'completed', 'failed', 'cancelled', 'expired'])
export const fhirBulkExportRequestKind = pgEnum('fhir_bulk_export_request_kind', ['system', 'group', 'patient'])
export const fhirInboundStatus = pgEnum('fhir_inbound_status', ['pending', 'accepted', 'rejected', 'expired'])
export const fhirInboundOwnerModule = pgEnum('fhir_inbound_owner_module', ['m5', 'm12'])
export const fhirVersionEnum = pgEnum('fhir_version_enum', ['4.0.1', '5.0.0', '6.0.0'])
```

```typescript
// packages/db/src/schema/fhir/tenant-config.ts
import { pgTable, uuid, text, jsonb, timestamp, integer, index, primaryKey, customType } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const tenantFhirConfig = pgTable('tenant_fhir_config', {
  organizationId: uuid('organization_id').primaryKey()
    .references(() => /* organization */, { onDelete: 'restrict' }),
  tenantFhirHost: text('tenant_fhir_host').notNull(),
  identifierUriBase: text('identifier_uri_base').notNull(),  // e.g., 'https://engrace.fhir.wardenx.com/sid'
  cursorSigningKeyCipher: bytea('cursor_signing_key_cipher').notNull(),  // per-tenant DEK-encrypted
  capabilityOverrides: jsonb('capability_overrides').notNull().default('{}'),
  inboundReviewSlaHours: integer('inbound_review_sla_hours').notNull().default(72),
  exportDedupWindowMinutes: integer('export_dedup_window_minutes').notNull().default(10),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

```typescript
// packages/db/src/schema/fhir/client.ts
import { pgTable, uuid, text, jsonb, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { fhirClientType, fhirClientTier, fhirClientStatus } from './enums'

export const fhirClient = pgTable('fhir_client', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  type: fhirClientType('type').notNull(),
  jwksUri: text('jwks_uri'),                                  // present for smart_backend_services
  credentialId: uuid('credential_id'),                        // FK → fhir_client_credential.id; present for api_key
  allowedScopes: jsonb('allowed_scopes').notNull(),           // string[] like ['system/Patient.read', 'system/Encounter.read']
  tier: fhirClientTier('tier').notNull(),
  rateLimitRps: integer('rate_limit_rps').notNull(),
  ipAllowlist: jsonb('ip_allowlist').notNull().default('[]'),  // string[] CIDR
  baaContractReference: text('baa_contract_reference').notNull(),  // M34 contract id
  status: fhirClientStatus('status').notNull().default('pending_approval'),
  approvedByAdminMembershipId: uuid('approved_by_admin_membership_id'),
  approvedByComplianceMembershipId: uuid('approved_by_compliance_membership_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdx: index('fhir_client_org_idx').on(t.organizationId, t.status),
  nameUq: uniqueIndex('fhir_client_org_name_uq').on(t.organizationId, t.name),
}))
```

```typescript
// packages/db/src/schema/fhir/client-credential.ts
import { pgTable, uuid, text, timestamp, customType } from 'drizzle-orm/pg-core'
import { fhirClientCredentialKind, fhirClientCredentialStatus } from './enums'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const fhirClientCredential = pgTable('fhir_client_credential', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  clientId: uuid('client_id').notNull().references(() => /* fhirClient */, { onDelete: 'cascade' }),
  kind: fhirClientCredentialKind('kind').notNull(),
  secretCipher: bytea('secret_cipher'),               // per-tenant DEK-encrypted; only sha256 digest matched at validate time
  secretDigestSha256: text('secret_digest_sha256'),   // the sha256(plaintext) digest matched at validate time
  fingerprint: text('fingerprint').notNull(),          // first 8 chars for ops display
  status: fhirClientCredentialStatus('status').notNull().default('active'),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

```typescript
// packages/db/src/schema/fhir/client-session.ts (MONTHLY-PARTITIONED by issued_at)
import { pgTable, uuid, text, timestamp, jsonb, index, inet } from 'drizzle-orm/pg-core'

export const fhirClientSession = pgTable('fhir_client_session', {
  jti: uuid('jti').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  clientId: uuid('client_id').notNull(),
  scopesGranted: jsonb('scopes_granted').notNull(),    // string[]
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ipAtIssue: inet('ip_at_issue'),
  tokenKeyFingerprint: text('token_key_fingerprint').notNull(),  // sha256 of the signing key fingerprint
}, (t) => ({
  clientIdx: index('fhir_client_session_client_idx').on(t.clientId, t.expiresAt),
  expiryIdx: index('fhir_client_session_expiry_idx').on(t.expiresAt),
}))
// Partition by RANGE (issued_at) monthly per M4 §3.6
```

```typescript
// packages/db/src/schema/fhir/bulk-export-job.ts
import { pgTable, uuid, text, jsonb, timestamp, integer, index } from 'drizzle-orm/pg-core'
import { fhirBulkExportStatus, fhirBulkExportRequestKind } from './enums'

export const fhirBulkExportJob = pgTable('fhir_bulk_export_job', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  clientId: uuid('client_id').notNull(),
  requestKind: fhirBulkExportRequestKind('request_kind').notNull(),
  groupId: uuid('group_id'),                                // when request_kind='group'
  patientIds: jsonb('patient_ids'),                         // when request_kind='patient'; string[]
  resourceTypes: jsonb('resource_types').notNull(),         // string[]
  sinceIso: timestamp('since_iso', { withTimezone: true }),
  requestEnvelopeSha256: text('request_envelope_sha256').notNull(),  // for the §2.6 dedup
  status: fhirBulkExportStatus('status').notNull().default('accepted'),
  totalResources: integer('total_resources'),
  artifactCount: integer('artifact_count'),
  failureReason: text('failure_reason'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  initiatedByMembershipId: uuid('initiated_by_membership_id'),  // null when initiated by the FHIR client itself
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  clientIdx: index('fhir_bulk_export_client_idx').on(t.clientId, t.status),
  orgIdx: index('fhir_bulk_export_org_idx').on(t.organizationId, t.createdAt),
  expiryIdx: index('fhir_bulk_export_expiry_idx').on(t.expiresAt),
  dedupIdx: index('fhir_bulk_export_dedup_idx').on(t.clientId, t.requestEnvelopeSha256, t.createdAt),
}))
```

```typescript
// packages/db/src/schema/fhir/bulk-export-artifact.ts
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core'

export const fhirBulkExportArtifact = pgTable('fhir_bulk_export_artifact', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  jobId: uuid('job_id').notNull().references(() => /* fhirBulkExportJob */, { onDelete: 'cascade' }),
  resourceType: text('resource_type').notNull(),
  minioObjectKey: text('minio_object_key').notNull(),       // 'tenants/<org>/fhir-exports/<job>/{type}.ndjson'
  byteSize: integer('byte_size').notNull(),
  rowCount: integer('row_count').notNull(),
  checksumSha256: text('checksum_sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  jobIdx: index('fhir_bulk_export_artifact_job_idx').on(t.jobId),
}))
```

```typescript
// packages/db/src/schema/fhir/inbound-resource.ts (MONTHLY-PARTITIONED by proposed_at)
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { fhirInboundStatus, fhirInboundOwnerModule } from './enums'

export const fhirInboundResource = pgTable('fhir_inbound_resource', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  sourceClientId: uuid('source_client_id').notNull(),
  resourceType: text('resource_type').notNull(),
  sourceFhirId: text('source_fhir_id'),                     // consumer's claimed id
  payload: jsonb('payload').notNull(),                       // raw FHIR resource
  payloadSha256: text('payload_sha256').notNull(),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  ownerModule: fhirInboundOwnerModule('owner_module').notNull(),
  proposalStatus: fhirInboundStatus('proposal_status').notNull().default('pending'),
  decidedByMembershipId: uuid('decided_by_membership_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionRationale: text('decision_rationale'),             // ≥40 chars on reject
  acceptedAggregateId: uuid('accepted_aggregate_id'),
  validationErrors: jsonb('validation_errors'),
  payloadEraseScheduledAt: timestamp('payload_erase_scheduled_at', { withTimezone: true }),
}, (t) => ({
  orgIdx: index('fhir_inbound_org_idx').on(t.organizationId, t.proposalStatus, t.proposedAt),
  ownerIdx: index('fhir_inbound_owner_idx').on(t.ownerModule, t.proposalStatus),
  dedupIdx: index('fhir_inbound_dedup_idx').on(t.sourceClientId, t.resourceType, t.sourceFhirId),
}))
// Partition by RANGE (proposed_at) monthly per M4 §3.6
```

```typescript
// packages/db/src/schema/fhir/capability-snapshot.ts (platform-shared)
import { pgTable, uuid, text, jsonb, timestamp, index, customType } from 'drizzle-orm/pg-core'
import { fhirVersionEnum } from './enums'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const fhirCapabilitySnapshot = pgTable('fhir_capability_snapshot', {
  id: uuid('id').primaryKey().defaultRandom(),
  fhirVersion: fhirVersionEnum('fhir_version').notNull(),
  releaseTag: text('release_tag').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  capabilityStatement: jsonb('capability_statement').notNull(),
  checksumSha256: text('checksum_sha256').notNull(),
  signature: bytea('signature').notNull(),                  // HMAC-SHA256(checksumSha256, platform_signing_key)
}, (t) => ({
  releaseIdx: index('fhir_capability_release_idx').on(t.fhirVersion, t.releaseTag),
}))
```

### 3.4 Critical Indexes (Beyond Above)

- `fhir_client.organization_id, status` — admin list queries
- `fhir_client.name` per-org uniqueness — operator clarity
- `fhir_client_credential.client_id, status` — credential lookup at API-key validate
- `fhir_client_credential.secret_digest_sha256, status WHERE status='active'` — partial index for the validate path (constant-time digest match)
- `fhir_client_session.client_id, expires_at` — active-session enumeration for revocation cascade
- `fhir_client_session.expires_at` — sweeper enumeration of expired sessions
- `fhir_bulk_export_job.client_id, status WHERE status IN ('accepted','in_progress')` — concurrency lock backstop
- `fhir_bulk_export_job.expires_at WHERE status='completed'` — sweeper enumeration
- `fhir_bulk_export_job.client_id, request_envelope_sha256, created_at` — §2.6 dedup lookup
- `fhir_inbound_resource.organization_id, proposal_status, proposed_at` — operator review queue
- `fhir_inbound_resource.owner_module, proposal_status WHERE proposal_status='pending'` — partial index for SLA-watch worker
- `fhir_inbound_resource.payload_erase_scheduled_at WHERE proposal_status IN ('rejected','expired')` — destruction sweeper
- `fhir_capability_snapshot.fhir_version, release_tag` — boot lookup

### 3.5 RLS Policy Pattern

Every table is RLS-enforced. Per the architecture §3 tenancy model (three-layer defense), the per-tenant gate is the standard `withOrgContext()`-driven policy:

```sql
-- Standard per-tenant table (fhir_client, fhir_client_credential, fhir_client_session,
-- fhir_bulk_export_job, fhir_bulk_export_artifact, fhir_inbound_resource, tenant_fhir_config)
ALTER TABLE fhir_client ENABLE ROW LEVEL SECURITY;
CREATE POLICY fhir_client_org_isolation ON fhir_client
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);

-- Platform-shared capability snapshot — readable platform-wide; writable only with the platform_ops role
ALTER TABLE fhir_capability_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY fhir_capability_read_all ON fhir_capability_snapshot
  FOR SELECT USING (true);
CREATE POLICY fhir_capability_write_platform_ops ON fhir_capability_snapshot
  FOR INSERT WITH CHECK (current_setting('app.role', true) = 'platform_ops');
CREATE POLICY fhir_capability_update_platform_ops ON fhir_capability_snapshot
  FOR UPDATE USING (current_setting('app.role', true) = 'platform_ops')
  WITH CHECK (current_setting('app.role', true) = 'platform_ops');
```

The `withOrgContext()` middleware (M1 §3.13) sets `app.org_id` for every request; the bypass-only paths (the bulk-export worker, the inbound-SLA worker, the capability-snapshot validator) use the M1-provided `withSystemPrincipalOrgContext()` that explicitly sets `app.org_id` from the job payload, never from a session.

### 3.6 Audit Trigger Denylist (M11 D11 / M17 §3.6 Pattern)

Per the M4 §3.6 PHI-table convention M28 uses the M4 write-audit trigger generator on every owned table; the per-table denylist is:

| Table | Denylisted columns (never enter the audit `value_capture` jsonb) | Rationale |
|-------|------------------------------------------------------------------|-----------|
| `tenant_fhir_config` | `cursor_signing_key_cipher` | Encrypted-at-rest secret per §8 |
| `fhir_client_credential` | `secret_cipher`, `secret_digest_sha256` | Encrypted-at-rest secret per §8 |
| `fhir_client_session` | (none — no PHI; the JTI and scopes are operational, not PHI) | n/a |
| `fhir_inbound_resource` | `payload` (full FHIR resource bytes — until proposal-decision; only the `payload_sha256` is captured in audit value_capture) | The payload may carry PHI fragments before owner-module acceptance; the digest is sufficient for audit reconstruction without re-storing PHI |
| `fhir_bulk_export_job` | (none — the request envelope is metadata) | n/a |
| `fhir_bulk_export_artifact` | (none — checksums and counts only) | n/a |
| `fhir_client` | (none — operational metadata only) | n/a |
| `fhir_capability_snapshot` | (none — public conformance) | n/a |

The `auditRead()` events (per D15) carry a typed envelope with the resource type, query parameters, result count, and consuming `fhir_client_id`; the resource bytes themselves are not captured (the disclosure-accounting requirement is "what was disclosed to whom, when," not "every byte that left the building").

### 3.7 Eraser Registration (M4 Destruction Workflow)

M28 registers a single `eraseFn` into the M4 destruction-cert callback registry per the M5 / M22 / M27 precedent. The eraser handles:

- `tenant_fhir_config` — soft delete with `cursor_signing_key_cipher` zeroed; the row persists for survey reconstruction of "what URI base did this tenant use at the time of disclosure X" but the signing key is wiped (subsequent cursor verification fails for any old cursor; this is the correct semantics — a destruction-certified tenant has no outstanding active cursors).
- `fhir_client` — soft delete with `status='revoked'`; the row persists in audit-only mode; the `baa_contract_reference` and the operator approvals are retained for the §164.528 disclosure-accounting record; the `name` is left in place.
- `fhir_client_credential` — destruction of `secret_cipher` and `secret_digest_sha256`; the row's `fingerprint` is retained for ops display.
- `fhir_client_session` — full destruction (no PHI value; rows older than 90 days are routine-purged anyway).
- `fhir_bulk_export_job` — soft delete with `status='expired'`; the artifact rows are also expired; the MinIO objects are explicitly purged (the standard 24-hour TTL would otherwise leave them up to 23 hours after destruction); the job metadata persists for audit reconstruction.
- `fhir_bulk_export_artifact` — `minio_object_key` purged from MinIO; the row metadata persists.
- `fhir_inbound_resource` — `payload` set to `'{"_destroyed":true}'`; the `payload_sha256` is retained; the decision rationale is retained; the audit trail is fully preserved.
- `fhir_capability_snapshot` — never erased (platform-shared, no PHI).

```typescript
// apps/backend/src/modules/28-fhir/boot.ts
import { registerEraser } from '@wardenx/audit/erasers'
import { fhirEraseFn } from './services/eraser'

export function bootstrapModule28(): void {
  registerEraser('fhir_gateway', fhirEraseFn)
  // ... register seams, ABAC predicates, validateFhirAIBlock, etc.
}
```


## 4. API Routes & Seams

### 4.1 Route Inventory

| # | Method | Path | Permission gate / Auth | Notes | Idempotency | Returns |
|---|--------|------|------------------------|-------|-------------|---------|
| 1 | GET | `/fhir/r4/metadata` | `fhir.capability.read` (anonymous-allowed per FHIR-spec convention; rate-limited per-IP) | CapabilityStatement | n/a | 200 application/fhir+json |
| 2 | GET | `/fhir/.well-known/smart-configuration` | anonymous; rate-limited per-IP | SMART well-known config | n/a | 200 application/json |
| 3 | POST | `/fhir/oauth2/token` | `client_assertion` JWT verified against `fhir_client.jwks_uri`; rate-limited per client_id | SMART Backend Services token mint | `(client_id, jti)` 15-min window | 200 application/json |
| 4 | GET | `/fhir/r4/{ResourceType}/{id}` | bearer-token; scope `system/{ResourceType}.read`; tier rate limit | resource read | n/a | 200 application/fhir+json |
| 5 | GET | `/fhir/r4/{ResourceType}` | bearer-token; scope `system/{ResourceType}.read`; tier rate limit | resource search | n/a | 200 application/fhir+json (Bundle) |
| 6 | GET | `/fhir/r4/Patient/{id}/$everything` | bearer-token; scopes for every linked resource type; tier rate limit | $everything operation (D5) | n/a | 200 application/fhir+json (Bundle) |
| 7 | POST | `/fhir/r4/$export` | bearer-token; scopes per resource type; concurrency cap | system-level bulk export (D4) | `(client_id, sha256(env))` 10-min window | 202 + `Content-Location` |
| 8 | POST | `/fhir/r4/Group/{id}/$export` | same as 7 | group-scoped bulk export | same as 7 | 202 + `Content-Location` |
| 9 | POST | `/fhir/r4/Patient/$export` | same as 7 | all-patient bulk export | same as 7 | 202 + `Content-Location` |
| 10 | GET | `/fhir/r4/$export-poll-status/{job_id}` | bearer-token; job initiator scope match | bulk export status | n/a | 202 In-Progress \| 200 Completed \| 410 Expired |
| 11 | DELETE | `/fhir/r4/$export-poll-status/{job_id}` | bearer-token; job initiator | cancel bulk export | n/a | 202 Accepted |
| 12 | GET | `/fhir/r4/CodeSystem/{system}` | bearer-token; scope `system/CodeSystem.read` | CodeSystem read | n/a | 200 application/fhir+json |
| 13 | POST | `/fhir/r4/CodeSystem/$validate-code` | bearer-token; scope `system/CodeSystem.read` | $validate-code | n/a | 200 application/fhir+json |
| 14 | GET | `/fhir/r4/ValueSet/{vs}` | bearer-token; scope `system/ValueSet.read` | ValueSet read | n/a | 200 application/fhir+json |
| 15 | GET | `/fhir/r4/ValueSet/{vs}/$expand` | bearer-token; scope `system/ValueSet.read` | $expand | n/a | 200 application/fhir+json |
| 16 | POST | `/fhir/r4/{ResourceType}` | bearer-token; scope `system/{ResourceType}.write` | inbound staging (D8) | `(client, type, source_fhir_id)` permanent | 202 Accepted + OperationOutcome |
| 17 | GET | `/fhir/r5/...` (any) | (n/a) | R5 routes (D1, D7) | n/a | 415 Unsupported Media Type + OperationOutcome |
| 18 | GET | `/fhir/r6/...` (any) | (n/a) | R6 routes (D1, D7) | n/a | 415 Unsupported Media Type + OperationOutcome |
| 19 | GET | `/fhir/r4/Claim/{id}` | (n/a Phase 1) | Phase-2 (D1) | n/a | 404 Not Found + OperationOutcome |
| 20 | GET | `/fhir/r4/ServiceRequest/{id}` | (n/a Phase 1) | Phase-2 (D1) | n/a | 404 Not Found + OperationOutcome |
| 21 | GET | `/fhir/r4/QuestionnaireResponse/{id}` | (n/a Phase 1) | Phase-2 (D1) | n/a | 404 Not Found + OperationOutcome |
| 22 | GET | `/fhir/r4/Location/{id}` | (n/a Phase 1) | Phase-2 (D1) | n/a | 404 Not Found + OperationOutcome |
| 23 | GET | `/api/v1/fhir/clients` | `fhir.client.read` | admin list | n/a | 200 |
| 24 | POST | `/api/v1/fhir/clients` | `fhir.client.admin` (Org Admin role) | propose new client (D12) | n/a | 201 |
| 25 | POST | `/api/v1/fhir/clients/{id}/approve` | `fhir.client.admin` (Compliance Officer role) | co-approve (D12) | n/a | 200 |
| 26 | POST | `/api/v1/fhir/clients/{id}/revoke` | `fhir.client.admin` | revoke (D12) | n/a | 200 |
| 27 | POST | `/api/v1/fhir/clients/{id}/suspend` | `fhir.client.admin` | suspend (D12) | n/a | 200 |
| 28 | POST | `/api/v1/fhir/clients/{id}/credentials/rotate` | `fhir.client.admin` | rotate credential | n/a | 200 + plaintext-once |
| 29 | GET | `/api/v1/fhir/clients/{id}/sessions` | `fhir.client.session.read` | active sessions | n/a | 200 |
| 30 | POST | `/api/v1/fhir/clients/{id}/sessions/{jti}/revoke` | `fhir.client.admin` | manually revoke a session | n/a | 200 |
| 31 | GET | `/api/v1/fhir/bulk-export-jobs` | `fhir.export.bulk.read` | admin list (operator) | n/a | 200 |
| 32 | POST | `/api/v1/fhir/bulk-export-jobs` | `fhir.export.bulk.initiate` | operator-initiated export | server-generated key | 202 |
| 33 | POST | `/api/v1/fhir/bulk-export-jobs/{id}/cancel` | `fhir.export.bulk.cancel` (initiator or admin) | cancel | n/a | 200 |
| 34 | GET | `/api/v1/fhir/inbound-proposals` | `fhir.inbound.review` | operator review queue | n/a | 200 |
| 35 | POST | `/api/v1/fhir/inbound-proposals/{id}/accept` | `fhir.inbound.accept` + ABAC `fhir_inbound_owner_module_match` | accept (D8) | `id` | 200 |
| 36 | POST | `/api/v1/fhir/inbound-proposals/{id}/reject` | `fhir.inbound.reject` + ABAC `fhir_inbound_owner_module_match` | reject (D8) | `id` | 200 |
| 37 | GET | `/api/v1/fhir/config` | `fhir.config.read` | tenant FHIR config | n/a | 200 |
| 38 | PUT | `/api/v1/fhir/config` | `fhir.config.write` | tenant FHIR config | server-generated key | 200 |
| 39 | POST | `/api/v1/fhir/config/rotate-cursor-key` | `fhir.config.write` + step-up | rotate cursor signing key | server-generated key | 200 |

**FHIR-spec error envelope.** Every error response on routes 1–22 is an `OperationOutcome` (FHIR-spec) with the right `issue.severity`, `issue.code` (FHIR `issue-type` ValueSet), `issue.diagnostics`, and the WardenX `issue.details.coding` carrying the internal error code for cross-referencing with the WardenX error envelope. Routes 17/18/19/20/21/22 return the FHIR-spec error code per D1. Routes 23-39 (admin) return the WardenX error envelope per architecture §25.


### 4.2 Representative TypeBox Schemas

```typescript
// apps/backend/src/modules/28-fhir/routes/admin/clients.ts
import { Type, Static } from '@sinclair/typebox'

export const CreateClientBody = Type.Object({
  name: Type.String({ minLength: 3, maxLength: 200 }),
  type: Type.Union([Type.Literal('smart_backend_services'), Type.Literal('api_key')]),
  jwksUri: Type.Optional(Type.String({ format: 'uri', pattern: '^https://' })),
  allowedScopes: Type.Array(
    Type.String({ pattern: '^system/[A-Z][A-Za-z]+\\.(read|write)$' }),
    { minItems: 1, maxItems: 50 },
  ),
  tier: Type.Union([Type.Literal('tier-1'), Type.Literal('tier-2'), Type.Literal('tier-3')]),
  rateLimitRpsOverride: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),  // tighten-only
  ipAllowlist: Type.Optional(Type.Array(Type.String(), { default: [] })),
  baaContractReference: Type.String({ minLength: 1, maxLength: 100 }),
})

export const ApproveClientBody = Type.Object({
  rationale: Type.String({ minLength: 20, maxLength: 1000 }),
})

export const RevokeClientBody = Type.Object({
  rationale: Type.String({ minLength: 40, maxLength: 1000 }),
})
```

```typescript
// apps/backend/src/modules/28-fhir/routes/token.ts
import { Type } from '@sinclair/typebox'

// SMART Backend Services token endpoint: application/x-www-form-urlencoded
export const TokenFormBody = Type.Object({
  grant_type: Type.Literal('client_credentials'),
  scope: Type.String({ minLength: 1, maxLength: 2000 }),
  client_assertion_type: Type.Literal('urn:ietf:params:oauth:client-assertion-type:jwt-bearer'),
  client_assertion: Type.String({ minLength: 1, maxLength: 8192 }),  // the signed JWT
})

export const TokenResponse = Type.Object({
  access_token: Type.String(),
  token_type: Type.Literal('Bearer'),
  expires_in: Type.Integer({ minimum: 60, maximum: 900 }),
  scope: Type.String(),
})

export const TokenErrorResponse = Type.Object({
  error: Type.Union([
    Type.Literal('invalid_client'), Type.Literal('invalid_grant'), Type.Literal('invalid_request'),
    Type.Literal('invalid_scope'), Type.Literal('unauthorized_client'), Type.Literal('unsupported_grant_type'),
  ]),
  error_description: Type.Optional(Type.String()),
})
```

```typescript
// apps/backend/src/modules/28-fhir/routes/export.ts
import { Type } from '@sinclair/typebox'

// POST /fhir/r4/$export (application/fhir+json or query parameters)
export const ExportRequestBody = Type.Object({
  resourceType: Type.Literal('Parameters'),
  parameter: Type.Array(Type.Object({
    name: Type.String(),
    valueString: Type.Optional(Type.String()),
    valueInstant: Type.Optional(Type.String({ format: 'date-time' })),
    valueReference: Type.Optional(Type.Object({ reference: Type.String() })),
  })),
})

// Plus FHIR-spec query parameters (alternative encoding):
//   _outputFormat=application/fhir+ndjson   (only supported value)
//   _type=Patient,Encounter,Observation,...
//   _since=2024-01-01T00:00:00Z
//   patient=Patient/{id1},Patient/{id2}
```

```typescript
// apps/backend/src/modules/28-fhir/routes/inbound.ts — Patient example
import { Type } from '@sinclair/typebox'

export const InboundPatientResource = Type.Object({
  resourceType: Type.Literal('Patient'),
  id: Type.Optional(Type.String()),
  identifier: Type.Optional(Type.Array(Type.Object({
    system: Type.String({ format: 'uri' }),
    value: Type.String(),
  }))),
  name: Type.Array(Type.Object({
    family: Type.Optional(Type.String()),
    given: Type.Optional(Type.Array(Type.String())),
  }), { minItems: 1 }),
  gender: Type.Optional(Type.Union([
    Type.Literal('male'), Type.Literal('female'), Type.Literal('other'), Type.Literal('unknown'),
  ])),
  birthDate: Type.Optional(Type.String({ format: 'date' })),
  address: Type.Optional(Type.Array(Type.Object({
    line: Type.Optional(Type.Array(Type.String())),
    city: Type.Optional(Type.String()),
    state: Type.Optional(Type.String()),
    postalCode: Type.Optional(Type.String()),
  }))),
})
```


### 4.3 Published Seams (`packages/fhir/src/seams.ts`)

```typescript
// Consumed by M33 reporting, M30 quality, M35 subscription billing
export interface FhirGatewayMetricsProvider {
  /** Per-tenant FHIR utilization. Returns aggregated counters; NO PHI. */
  metricsForOrg(args: {
    organizationId: string
    from: string
    to: string
  }): Promise<FhirGatewayMetrics>

  /** Per-quarter disclosure metric used by M30 HIPAA §164.528 scorecard. */
  disclosureMetricsForOrg(args: {
    organizationId: string
    quarter: string                                // 'YYYY-Q[1234]'
  }): Promise<FhirDisclosureMetrics>
}

export interface FhirGatewayMetrics {
  requestsByHour: Array<{ hour: string; count: number }>
  topResourceTypes: Array<{ resourceType: string; count: number }>
  topClients: Array<{ clientId: string; clientName: string; count: number }>
  bulkExportJobsAccepted: number
  bulkExportJobsCompleted: number
  bulkExportJobsFailed: number
  inboundProposalsPending: number
  inboundProposalsAccepted: number
  inboundProposalsRejected: number
  inboundProposalReviewSlaP50Hours: number
  inboundProposalReviewSlaP95Hours: number
  errorRateByCode: Array<{ code: string; count: number }>
}

export interface FhirDisclosureMetrics {
  quarter: string
  totalDisclosures: number
  distinctRecipientClients: number
  byResourceType: Array<{ resourceType: string; disclosures: number }>
  byClient: Array<{ clientId: string; clientName: string; baaReference: string; disclosures: number }>
}

// Consumed by M34 SaaS console
export interface FhirClientReader {
  clientsForOrg(args: { organizationId: string }): Promise<ReadonlyArray<FhirClientSummary>>
  clientDetail(args: { organizationId: string; clientId: string }): Promise<FhirClientDetail | null>
}

export interface FhirClientSummary {
  id: string
  name: string
  type: 'smart_backend_services' | 'api_key'
  tier: 'tier-1' | 'tier-2' | 'tier-3'
  status: 'pending_approval' | 'active' | 'suspended' | 'revoked' | 'rejected'
  baaContractReference: string
  approvedAt: string | null
  createdAt: string
}

export interface FhirClientDetail extends FhirClientSummary {
  allowedScopes: string[]
  rateLimitRps: number
  ipAllowlist: string[]
  jwksUri: string | null
  fingerprint: string | null                        // first 8 chars of secret digest for api_key clients
  lastSuccessfulRequestAt: string | null
  activeSessionCount: number
}

// Consumed by M5 (Patient demographic proposals) and M12 (MedicationStatement medhx proposals)
export interface FhirInboundProposalReader {
  pendingForOwnerModule(args: {
    organizationId: string
    ownerModule: 'm5' | 'm12'
  }): Promise<ReadonlyArray<FhirInboundProposalSummary>>

  proposalDetail(args: {
    organizationId: string
    proposalId: string
  }): Promise<FhirInboundProposalDetail | null>
}

export interface FhirInboundProposalSummary {
  id: string
  resourceType: string
  sourceClientId: string
  sourceClientName: string
  sourceFhirId: string | null
  proposedAt: string
  slaDueAt: string
}

export interface FhirInboundProposalDetail extends FhirInboundProposalSummary {
  payload: Record<string, unknown>                  // raw FHIR resource (after JSON-schema validation)
  validationErrors: Array<{ path: string; message: string }> | null
}
```

Registered at boot via the M1 seam registry:

```typescript
// apps/backend/src/modules/28-fhir/boot.ts
import { registerEraser } from '@wardenx/audit/erasers'
import { validateFhirAIBlock } from '@wardenx/fhir/ai-block'
import { registerPredicate } from '@wardenx/auth/predicates'

export function bootstrapModule28(reg: SeamRegistry): void {
  reg.publish<FhirGatewayMetricsProvider>('m28.fhir-gateway-metrics', fhirGatewayMetricsProvider)
  reg.publish<FhirClientReader>('m28.fhir-client-reader', fhirClientReader)
  reg.publish<FhirInboundProposalReader>('m28.fhir-inbound-proposal-reader', fhirInboundProposalReader)

  registerEraser('fhir_gateway', fhirEraseFn)

  registerPredicate('fhir_client_organization_scope', fhirClientOrganizationScope)
  registerPredicate('fhir_inbound_owner_module_match', fhirInboundOwnerModuleMatch)
  registerPredicate('fhir_export_scope_satisfied', fhirExportScopeSatisfied)
  registerPredicate('bulk_export_initiator_or_admin', bulkExportInitiatorOrAdmin)
  registerPredicate('fhir_client_active', fhirClientActive)
  registerPredicate('fhir_export_recipient_authorized', fhirExportRecipientAuthorized)

  validateFhirAIBlock()    // throws if M32 holds any prompt that synthesizes FHIR content
}
```

**Boot validation.** `apps/backend/src/bootstrap/seams.ts` (M1-owned) calls `validateSeams()` which refuses to start the server if any required seam is unregistered. M28's `bootstrapModule28` registers all three; absence is a hard failure.


### 4.4 Consumed Seams

```typescript
// Consumed at boot — registered by their owning modules; verified by validateSeams()
import type { PatientReader, CaregiverReader, PatientAddressReader, PatientPayerReader } from '@wardenx/patient/seams'   // M5
import type {
  ElectionPeriodReader, CertificationReader, FaceToFaceReader, LevelOfCareReader, AdmissionStatusReader,
} from '@wardenx/admission/seams'                                                                                          // M6
import type { CarePlanReader, ProblemReader, GoalReader, InterventionReader } from '@wardenx/care-plan/seams'             // M7
import type { SignedEncountersReader, BillableEncounterReader } from '@wardenx/encounters/seams'                          // M8
import type { LatestAssessmentProvider, ScaleSeriesProvider } from '@wardenx/assessments/seams'                            // M9
import type { HopeTimepointProvider } from '@wardenx/hope/seams'                                                            // M10
import type { OrderProvider } from '@wardenx/orders/seams'                                                                  // M11 (Phase-2 ServiceRequest + DiagnosticReport)
import type { MedicationOrderProvider } from '@wardenx/dosespot/seams'                                                       // M12
import type { MedicationAdministrationProvider, ReconciliationProvider } from '@wardenx/emar/seams'                       // M13
import type { DisciplinePlanReader } from '@wardenx/discipline-care-plans/seams'                                            // M15
import type { DocumentReader, RenderedDocumentProvider, ExtractionProvenanceReader } from '@wardenx/documents/seams'      // M22
import type { ClaimReader } from '@wardenx/billing/seams'                                                                    // M23 (Phase-2; deny-stub-OK)
import type { LabObservationReader } from '@wardenx/external-interfaces/seams'                                              // M29 (DiagnosticReport)
import type { AlertEmitter } from '@wardenx/messaging/seams'                                                                // M36
import type { TerminologyProvider } from '@wardenx/terminology'                                                              // M38
import type { ConsentEvaluator } from '@wardenx/consent/seams'                                                               // M39
import type { ExternalPhysicianReader, PharmacyReader, FacilityReader, ReferralSourceReader } from '@wardenx/mdm/seams'   // M40

function requireConsumedSeams(reg: SeamRegistry): void {
  reg.require<PatientReader>('m5.patient-reader')
  reg.require<CaregiverReader>('m5.caregiver-reader')
  reg.require<PatientAddressReader>('m5.patient-address-reader')
  reg.require<PatientPayerReader>('m5.patient-payer-reader')
  reg.require<ElectionPeriodReader>('m6.election-period-reader')
  reg.require<CertificationReader>('m6.certification-reader')
  reg.require<FaceToFaceReader>('m6.face-to-face-reader')
  reg.require<LevelOfCareReader>('m6.level-of-care-reader')
  reg.require<AdmissionStatusReader>('m6.admission-status-reader')
  reg.require<CarePlanReader>('m7.care-plan-reader')
  reg.require<ProblemReader>('m7.problem-reader')
  reg.require<GoalReader>('m7.goal-reader')
  reg.require<InterventionReader>('m7.intervention-reader')
  reg.require<SignedEncountersReader>('m8.signed-encounters-reader')
  reg.require<BillableEncounterReader>('m8.billable-encounter-reader')
  reg.require<LatestAssessmentProvider>('m9.latest-assessment-provider')
  reg.require<ScaleSeriesProvider>('m9.scale-series-provider')
  reg.require<HopeTimepointProvider>('m10.hope-timepoint-provider')
  reg.require<OrderProvider>('m11.order-provider')                       // Phase-2 ServiceRequest; DiagnosticReport read path
  reg.require<MedicationOrderProvider>('m12.medication-order-provider')
  reg.require<MedicationAdministrationProvider>('m13.medication-administration-provider')
  reg.require<ReconciliationProvider>('m13.reconciliation-provider')
  reg.require<DisciplinePlanReader>('m15.discipline-plan-reader')
  reg.require<DocumentReader>('m22.document-reader')
  reg.require<RenderedDocumentProvider>('m22.rendered-document-provider')
  reg.require<ExtractionProvenanceReader>('m22.extraction-provenance-reader')
  reg.require<ClaimReader>('m23.claim-reader')                            // Phase-2; route returns 404 until enabled
  reg.require<LabObservationReader>('m29.lab-observation-reader')         // DiagnosticReport read path
  reg.require<AlertEmitter>('m36.alert-emitter')
  reg.require<TerminologyProvider>('m38.terminology-provider')
  reg.require<ConsentEvaluator>('m39.consent-evaluator')
  reg.require<ExternalPhysicianReader>('m40.external-physician-reader')
  reg.require<PharmacyReader>('m40.pharmacy-reader')
  reg.require<FacilityReader>('m40.facility-reader')
  reg.require<ReferralSourceReader>('m40.referral-source-reader')
}
```

The `LabObservationReader` requirement ensures M28 boot fails if M29 doesn't register the seam — the boot-gate enforces that M29's lab observation read path and M28's `DiagnosticReport` projection ship together. The dependency-cruiser boundary check (architecture §25.15 check 5) verifies that `packages/fhir/src/r4/mappers/*` files import only from the seam interface barrels (`@wardenx/{module}/seams`) and never from `packages/db/src/schema/*` directly. A direct schema import from any mapper file is a CI-blocking violation.

### 4.5 The `FhirMapper` and `FhirSearchTranslator` Contracts (D6)

```typescript
// packages/fhir/src/interfaces/mapper.ts

/**
 * A FhirMapper translates a domain entity into a FHIR resource.
 * Each mapper is FHIR-version-specific. R5 / R6 mappers are compile-shells in Phase 1 (D1).
 *
 * Mappers are PURE: same domain input + same asOfDate ⇒ byte-identical FHIR output.
 * No AI rewrites; no narrative generation beyond the FHIR-spec deterministic text.div builder (D14).
 */
export interface FhirMapper<TDomain, TFhir> {
  readonly version: '4.0.1' | '5.0.0' | '6.0.0'
  readonly profile: string                          // e.g., 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'
  map(domain: TDomain, ctx: MapperContext): TFhir
}

export interface MapperContext {
  readonly organizationId: string
  readonly tenantFhirHost: string                  // resource.id reference URI assembly
  readonly identifierUriBase: string                // per D9
  readonly asOfDate: string                         // ISO; pinned per-resource at source-authoring time
  readonly recipientClientId: string                // for consent gate per D3
  readonly redactSudContent: boolean                // result of M39 ConsentEvaluator consult
  readonly includeProvenance: boolean
}
```

```typescript
// packages/fhir/src/interfaces/search-translator.ts

/**
 * Translates FHIR search syntax into typed reader-seam calls.
 * NO SQL is constructed inside M28; every read goes through a published reader seam.
 *
 * The translator is the SINGLE POINT in M28 that knows the FHIR search grammar.
 * Adding a new search parameter is a code change here; it cannot be configured at runtime.
 */
export interface FhirSearchTranslator {
  validate(req: FhirSearchRequest): FhirSearchValidation
  resolve(req: FhirSearchRequest, ctx: SearchContext): ResolvedSearch
}

export interface FhirSearchRequest {
  resourceType: string
  parameters: ReadonlyArray<{ name: string; modifier?: string; value: string }>
  includes: ReadonlyArray<string>                  // _include
  revincludes: ReadonlyArray<string>               // _revinclude
  count: number                                     // _count (1..500, default 50)
  cursor?: string                                   // opaque HMAC-signed cursor per D13
  summary?: 'true' | 'data' | 'text' | 'count'     // _summary
  elements?: ReadonlyArray<string>                  // _elements
}

export interface FhirSearchValidation {
  valid: boolean
  issues: ReadonlyArray<{
    severity: 'error' | 'warning' | 'fatal' | 'information'
    code: string                                    // FHIR issue-type ValueSet
    diagnostics: string
    expression?: string                             // FHIRPath
  }>
}

export interface SearchContext {
  readonly organizationId: string
  readonly recipientClientId: string
  readonly allowedScopes: ReadonlyArray<string>
  readonly tenantFhirHost: string
  readonly identifierUriBase: string
  readonly redactSudContent: boolean
}

export interface ResolvedSearch {
  execute(): Promise<{ rows: ReadonlyArray<unknown>; nextCursor: string | null; totalEstimate?: number }>
}
```

Per D6 the **US Core 6.0 mandatory search parameters** are encoded in `packages/fhir/src/r4/search/parameters.ts` as a per-resource catalog. A request for `Patient?identifier=...&birthdate=...&family=...` resolves to `PatientReader.searchByIdentifier(...)` and then a per-row filter for the additional parameters; a request for an unsupported parameter (e.g., `Patient?ethnicity=...` when ethnicity is not yet wired) returns a 400 with `OperationOutcome.issue.code='not-supported'`.


### 4.6 Permission Keys Registered into Module 3

```typescript
// packages/auth/src/permissions/keys.ts (additions for M28)
export const M28_PERMISSIONS = [
  // FHIR client registry (admin)
  'fhir.client.read',
  'fhir.client.admin',
  'fhir.client.session.read',

  // Inbound proposals (operator review)
  'fhir.inbound.review',
  'fhir.inbound.accept',
  'fhir.inbound.reject',

  // Bulk export (operator)
  'fhir.export.bulk.read',
  'fhir.export.bulk.initiate',
  'fhir.export.bulk.cancel',

  // Tenant FHIR config
  'fhir.config.read',
  'fhir.config.write',

  // Capability statement
  'fhir.capability.read',
] as const
```

Permission-to-role mapping (per the M3 role catalog):

| Permission | Tenant Admin | Compliance Officer | Billing Manager | Clinical Manager | RN | Platform Ops |
|------------|--------------|--------------------|----|---|---|---|
| `fhir.client.read` | ✓ | ✓ | | ✓ | | ✓ |
| `fhir.client.admin` | ✓ | ✓ (co-approval required per D12) | | | | ✓ |
| `fhir.client.session.read` | ✓ | ✓ | | | | ✓ |
| `fhir.inbound.review` | ✓ | ✓ | | ✓ | | ✓ |
| `fhir.inbound.accept` | ✓ (M5 only) | | | ✓ (M5 only) | ✓ (M5 only) | |
| `fhir.inbound.reject` | ✓ | ✓ | | ✓ | ✓ | |
| `fhir.export.bulk.read` | ✓ | ✓ | ✓ | | | ✓ |
| `fhir.export.bulk.initiate` | ✓ | ✓ | | | | ✓ |
| `fhir.export.bulk.cancel` | ✓ | ✓ | | | | ✓ |
| `fhir.config.read` | ✓ | ✓ | | | | ✓ |
| `fhir.config.write` | ✓ | | | | | ✓ |
| `fhir.capability.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The FHIR scope grammar (`system/Patient.read system/Encounter.read ...`) on the bearer-token path is **not** a WardenX permission — it is enforced via the `fhir_client.allowed_scopes[]` consult plus the `fhir_export_scope_satisfied` ABAC predicate at every FHIR route.

### 4.7 ABAC Predicates Registered with M3

| Predicate | Resolution |
|-----------|------------|
| `fhir_client_organization_scope` | A `fhir_client` row is only visible to memberships whose `organization_id` matches the row's `organization_id`. |
| `fhir_inbound_owner_module_match` | An inbound proposal can only be accepted/rejected by a member with permission on the `owner_module`'s native review path: for `owner_module='m5'`, the reviewer needs `m5.patient.write` plus `caseload_or_scope`; for `owner_module='m12'`, the reviewer needs `m12.medication.write` plus `caseload_or_scope`. |
| `fhir_export_scope_satisfied` | The requested `_type` set on a `$export` request is a subset of the client's `allowed_scopes[]` resource list. Returns the deviating resource type in the deny reason for the OperationOutcome. |
| `bulk_export_initiator_or_admin` | A `fhir_bulk_export_job` may be cancelled or its status read by the `initiated_by_membership_id` (when initiated via the admin route), the bearer-token-authenticated FHIR client itself (when initiated via `$export`), or any member with `fhir.export.bulk.cancel`. |
| `fhir_client_active` | The `fhir_client.status='active'` AND (the requesting IP is in the `ip_allowlist[]` if non-empty) AND (the client's BAA contract reference is currently in `active` state in M34). Any failure returns 401 with `OperationOutcome.issue.code='login'` (per FHIR-spec convention). |
| `fhir_export_recipient_authorized` | At bulk-export completion (and at every read serving), the resource's patient population intersects with M39's consent-state for the recipient client: any patient with `42_cfr_part_2_release` consent absent has SUD content redacted from the export per D3; the egress gate is the per-resource consult, not a per-job consult. |

Predicates are registered into M3's named-predicate registry (architecture §-fitness) and resolved via the standard M3 evaluator. The predicate identifiers are referenced from M28 routes via the M3 `requirePermissionPredicate('predicateName', ...)` helper.

### 4.8 BullMQ Queue Catalog

| Queue | Worker | Trigger | Concurrency | Idempotency | Notes |
|-------|--------|---------|-------------|-------------|-------|
| `fhir.bulk-export` | bulk-export worker | enqueue on `POST /$export` accepted | 4 per backend node; 1 per `client_id` (Valkey lock) | `(client_id, sha256(request_envelope))` | Streams NDJSON to MinIO; emits artifact rows; finalizes job status |
| `fhir.bulk-export-sweeper` | sweeper | cron every 15 minutes | 1 | n/a | Moves `completed → expired` for jobs past `expires_at`; purges MinIO objects |
| `fhir.inbound-sla-watch` | SLA watcher | cron every 5 minutes | 1 | n/a | Moves `pending → expired` for proposals past `inbound_review_sla_hours`; emits M36 alert; schedules payload destruction |
| `fhir.inbound-payload-destruction` | destruction worker | scheduled per row at `proposalStatus IN ('rejected','expired') + 30 days` | 1 | per-row idempotency-key on `fhir_inbound_resource.id` | Sets `payload='{"_destroyed":true}'`; preserves audit |
| `fhir.capability-snapshot-validator` | validator | cron hourly | 1 | n/a | Verifies the persisted `fhir_capability_snapshot.signature` against the current platform signing key; alerts on mismatch |
| `fhir.client-session-sweeper` | sweeper | cron every 5 minutes | 1 | n/a | Deletes `fhir_client_session` rows past `expires_at` (or moved them to monthly-archive per partition) |
| `fhir.jwks-refresh` | JWKS fetcher | on-demand (cache miss + cache expiry @ 5 min) | 8 | `(client_id, jwks_uri_etag)` 5-min window | Fetches and parses the client's JWKS; updates the in-memory cache |

### 4.9 M36 Typed Alert Payloads

```typescript
// packages/messaging/src/alerts/m28.ts
export type M28AlertEnvelope =
  | { kind: 'fhir.client.pending_approval'; clientId: string; clientName: string; tier: string; proposedByMembershipId: string }
  | { kind: 'fhir.client.activated'; clientId: string; clientName: string; tier: string; approvedAt: string }
  | { kind: 'fhir.client.revoked'; clientId: string; clientName: string; revokedBy: string; rationale: string }
  | { kind: 'fhir.client.suspended'; clientId: string; clientName: string; reason: string }
  | { kind: 'fhir.bulk_export.accepted'; jobId: string; clientId: string; resourceTypes: string[]; initiatedBy: string | null }
  | { kind: 'fhir.bulk_export.completed'; jobId: string; clientId: string; totalResources: number; artifactCount: number; pollUrl: string }
  | { kind: 'fhir.bulk_export.failed'; jobId: string; clientId: string; failureReason: string }
  | { kind: 'fhir.inbound.proposal_pending'; proposalId: string; resourceType: string; ownerModule: 'm5' | 'm12'; sourceClientName: string; slaDueAt: string }
  | { kind: 'fhir.inbound.proposal_overdue'; proposalId: string; resourceType: string; ownerModule: 'm5' | 'm12'; sourceClientName: string; hoursOverdue: number }
  | { kind: 'fhir.search.anomaly_detected'; clientId: string; clientName: string; anomalyKind: 'rate_spike' | 'off_hours' | 'unusual_resource_mix'; signal: Record<string, unknown> }
  | { kind: 'fhir.capability.regenerated'; releaseTag: string; fhirVersion: string; checksumSha256: string }
  | { kind: 'fhir.config.cursor_key_rotated'; rotatedByMembershipId: string }

// All M28 alert rules contribute to M36's alert-rule catalog; recipient resolvers per rule are
// registered in M28's boot.ts following the M36 §4.5 pattern.
```

Per the M36 typed-alert contract M28 owns no out-of-band delivery code — every SMS/email/push path is M36's. The alert-rule resolver for `fhir.inbound.proposal_pending` routes to the owner-module's reviewer pool (M5 patient-write membership for `owner_module='m5'`; M12 medication-write membership for `owner_module='m12'`). The resolver for `fhir.client.pending_approval` routes to Org Admin + Compliance Officer per D12.

### 4.10 Outbox Event Catalog

```typescript
// packages/fhir/src/outbox-events.ts
export type M28OutboxEvent =
  | { type: 'm28.fhir.client.pending_approval'; payload: { clientId: string; proposedByMembershipId: string; tier: string; allowedScopes: string[] } }
  | { type: 'm28.fhir.client.activated'; payload: { clientId: string; approvedByAdminMembershipId: string; approvedByComplianceMembershipId: string; approvedAt: string } }
  | { type: 'm28.fhir.client.revoked'; payload: { clientId: string; revokedAt: string; rationale: string } }
  | { type: 'm28.fhir.client.suspended'; payload: { clientId: string; reason: string } }
  | { type: 'm28.fhir.bulk_export.accepted'; payload: { jobId: string; clientId: string; resourceTypes: string[]; requestKind: 'system' | 'group' | 'patient' } }
  | { type: 'm28.fhir.bulk_export.completed'; payload: { jobId: string; clientId: string; completedAt: string; totalResources: number; artifactCount: number } }
  | { type: 'm28.fhir.bulk_export.failed'; payload: { jobId: string; clientId: string; failedAt: string; failureReason: string } }
  | { type: 'm28.fhir.bulk_export.cancelled'; payload: { jobId: string; clientId: string; cancelledByMembershipId: string | null; cancelledAt: string } }
  | { type: 'm28.fhir.inbound.proposed'; payload: { proposalId: string; ownerModule: 'm5' | 'm12'; resourceType: string; sourceClientId: string; proposedAt: string; payloadSha256: string } }
  | { type: 'm28.fhir.inbound.accepted'; payload: { proposalId: string; ownerModule: 'm5' | 'm12'; acceptedAggregateId: string; decidedByMembershipId: string; decidedAt: string } }
  | { type: 'm28.fhir.inbound.rejected'; payload: { proposalId: string; ownerModule: 'm5' | 'm12'; decidedByMembershipId: string; decidedAt: string; rationale: string } }
  | { type: 'm28.fhir.inbound.expired'; payload: { proposalId: string; ownerModule: 'm5' | 'm12'; expiredAt: string } }
  | { type: 'm28.fhir.capability.regenerated'; payload: { releaseTag: string; fhirVersion: '4.0.1' | '5.0.0' | '6.0.0'; checksumSha256: string } }
```

Outbox events ride the M1 outbox dispatcher per architecture §25. Owner-module consumers per the outbox subscription pattern:

| Event | Consumer | Action |
|-------|----------|--------|
| `m28.fhir.inbound.proposed` (`ownerModule='m5'`) | M5 | Surface in M5 reviewer queue; on accept call M28 `POST /api/v1/fhir/inbound-proposals/{id}/accept` with the new/updated `patient_id` |
| `m28.fhir.inbound.proposed` (`ownerModule='m12'`) | M12 | Surface in M12 medhx-review queue; on accept call M28 accept route with the new `medication_history_record.id` |
| `m28.fhir.inbound.accepted` | M5 / M12 | Already wired by the accept callback; this is the after-the-fact notification for cross-module observers (M33 reporting) |
| `m28.fhir.inbound.rejected` | M28 internal | Schedule the payload destruction at +30 days |
| `m28.fhir.client.activated` | M34 | Surface the new client on the tenant SaaS console; mark the BAA contract reference as bound |
| `m28.fhir.client.revoked` | M34 | Mark the BAA contract reference as un-bound (audit trail retained) |
| `m28.fhir.bulk_export.completed` | M33 reporting | Update the bulk-export dashboard counter |

### 4.11 The `DiagnosticReport` FHIR Mapper

#### 4.11.1 Mapper file location

```
packages/fhir/src/r4/mappers/diagnostic-report/
├── index.ts                          # exports the mapper
├── projector.ts                      # the actual composition logic
├── child-observation-projector.ts    # per-value Observation projection
├── sud-redaction-applier.ts          # D20 whole-report redaction
└── __tests__/
    ├── projector.test.ts
    ├── sud-redaction.test.ts
    └── golden/
        ├── lab-cbc-non-sud.json
        ├── lab-methadone-sud-redacted.json
        └── lab-critical-flag.json
```

#### 4.11.2 Projector signature

```ts
// packages/fhir/src/r4/mappers/diagnostic-report/projector.ts

import type { OrderProvider } from '@wardenx/orders/seams'
import type { LabObservationReader } from '@wardenx/external-interfaces/seams'   // M29
import type { PatientReader } from '@wardenx/patient/seams'
import type { ExternalPhysicianReader, FacilityReader } from '@wardenx/mdm/seams'
import type { TerminologyProvider } from '@wardenx/terminology'

export interface DiagnosticReportProjectorDeps {
  readonly orderProvider: OrderProvider
  readonly labObservationReader: LabObservationReader
  readonly patientReader: PatientReader
  readonly externalPhysicianReader: ExternalPhysicianReader
  readonly facilityReader: FacilityReader
  readonly terminology: TerminologyProvider
  readonly sudRedactionApplier: (report: DiagnosticReport) => DiagnosticReport  // D20
}

export interface ProjectDiagnosticReportInput {
  readonly organizationId: string
  readonly orderId: string
  readonly asOf?: Date
  readonly clientId: string         // the FHIR client requesting (for the audit row)
}

export async function projectDiagnosticReport(
  deps: DiagnosticReportProjectorDeps,
  input: ProjectDiagnosticReportInput,
): Promise<DiagnosticReport | null> {
  // 1. Load the order (M11)
  const order = await deps.orderProvider.findOrder(input.organizationId, input.orderId)
  if (!order || order.kind !== 'lab') return null

  // 2. Load the observation (M29)
  if (!order.lastLabObservationAttachedId) {
    // No observation attached yet — the FHIR DiagnosticReport doesn't exist
    return null
  }
  const observation = await deps.labObservationReader.loadById(
    input.organizationId, order.lastLabObservationAttachedId,
  )
  if (!observation) return null

  // 3. Load the patient
  const patient = await deps.patientReader.findById({
    organizationId: input.organizationId,
    patientId: order.patientId,
  })
  if (!patient) return null

  // 4. Resolve ordering provider (M40)
  const orderingProvider = order.orderingPhysicianMdmId
    ? await deps.externalPhysicianReader.findById(
        input.organizationId, order.orderingPhysicianMdmId,
      )
    : null

  // 5. Resolve performer organization (M40 — the lab facility)
  const performerFacility = order.labDestinationFacilityId
    ? await deps.facilityReader.findById(input.organizationId, order.labDestinationFacilityId)
    : null

  // 6. Build child Observations
  const childObservations: Observation[] = observation.values.map((v, idx) => ({
    resourceType: 'Observation',
    id: `${observation.id}--${idx}`,
    status: 'final',
    code: {
      coding: [{ system: 'http://loinc.org', code: v.loincCode, display: v.loincText }],
    },
    subject: { reference: `Patient/${patient.id}` },
    effectiveDateTime: observation.attachedAt,
    valueQuantity: v.numericValue !== null && v.unit !== null
      ? { value: v.numericValue, unit: v.unit, system: 'http://unitsofmeasure.org' }
      : undefined,
    valueString: v.numericValue === null && v.stringValue !== null
      ? v.stringValue
      : undefined,
    interpretation: v.criticalFlag || v.abnormalFlag
      ? [{
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
            code: v.criticalFlag || v.abnormalFlag!,
          }],
        }]
      : undefined,
    referenceRange: v.referenceRange
      ? [{ text: v.referenceRange }]
      : undefined,
  }))

  // 7. Assemble the DiagnosticReport
  const report: DiagnosticReport = {
    resourceType: 'DiagnosticReport',
    id: order.id,
    meta: {
      lastUpdated: observation.attachedAt,
      profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab'],
    },
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
    code: {
      coding: order.data?.observationIdentifier
        ? [{ system: 'http://loinc.org', code: order.data.observationIdentifier.code, display: order.data.observationIdentifier.text }]
        : [],
    },
    subject: { reference: `Patient/${patient.id}` },
    effectivePeriod: {
      start: order.signedAt!,
      end: observation.attachedAt,
    },
    issued: observation.attachedAt,
    performer: [
      ...(orderingProvider ? [{ reference: `Practitioner/${orderingProvider.id}` }] : []),
      ...(performerFacility ? [{ reference: `Organization/${performerFacility.id}` }] : []),
    ],
    result: childObservations.map((obs, idx) => ({
      reference: `Observation/${observation.id}--${idx}`,
    })),
    contained: childObservations,    // child observations inlined for FHIR Bundle simplicity
  }

  // 8. Apply SUD redaction per D20
  return deps.sudRedactionApplier(report)
}
```

Per D19 the `DiagnosticReport` is composed at read time from the M11 `order_record` (report metadata), the M29 `lab_observation` (result values), and the M40 facility (performer organization). The DiagnosticReport URL `id` is the M11 `order_record.id`; the child Observation URLs use a synthetic ID format `<observation-id>--<value-index>` so distinct values within one observation get distinct IDs without collision. The mapping is purely structural — no clinical inference, no value transformation.

#### 4.11.3 SUD redaction applier

```ts
// packages/fhir/src/r4/mappers/diagnostic-report/sud-redaction-applier.ts

export function applySudRedactionToDiagnosticReport(report: DiagnosticReport): DiagnosticReport {
  // Check if ANY contained observation is SUD-class (the source data carries this flag
  // via the lab_observation row's sud_redaction_status field; the projector passes it
  // through into the contained Observation's meta.security label OR a custom marker)
  const hasSudResult = (report.contained ?? []).some(
    (obs: Observation) => obs.meta?.security?.some(s => s.code === 'R-SUD'),
  )

  if (!hasSudResult) return report   // no redaction needed

  // D20: whole-report redaction
  return {
    ...report,
    result: [
      { reference: `Observation/${report.id}--sud-placeholder` },
    ],
    contained: [
      {
        resourceType: 'Observation',
        id: `${report.id}--sud-placeholder`,
        status: 'final',
        code: { text: 'SUD-protected results' },
        subject: report.subject,
        effectiveDateTime: report.effectivePeriod?.start,
        dataAbsentReason: {
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
            code: 'temp-unknown',
            display: 'Temporarily Unknown',
          }],
        },
        note: [{
          text: 'Results subject to 42 CFR Part 2 protections. To view values, request an unredact grant via the SUD Disclosure workflow at the source EHR.',
        }],
      },
    ],
    // Clear conclusion if present
    conclusion: undefined,
    // Add the security label at the report level
    meta: {
      ...report.meta,
      security: [
        ...(report.meta?.security ?? []),
        {
          system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
          code: 'R',
          display: 'restricted',
        },
      ],
    },
  }
}
```

#### 4.11.4 The `LabObservationReader` consumed seam

```ts
// Added to packages/fhir/src/seams/consumed.ts

import type { LabObservationReader } from '@wardenx/external-interfaces/seams'   // M29

function requireV03Seams(reg: SeamRegistry): void {
  reg.require<LabObservationReader>('m29.lab-observation-reader')
}
```

This addition to §4.4's `requireConsumedSeams()` ensures M28 boot fails if M29 doesn't register the seam — the boot-gate enforces M29's lab observation read path and M28's `DiagnosticReport` projection ship together.

### 4.12 Practitioner Mapper Extension

The Practitioner mapper file carries the two NPPES extensions:

```ts
// packages/fhir/src/r4/mappers/practitioner/projector.ts

export async function projectPractitioner(
  deps: PractitionerProjectorDeps,
  input: { organizationId: string; mdmId: string; asOf?: Date },
): Promise<Practitioner | null> {
  const physician = await deps.externalPhysicianReader.findById(input.organizationId, input.mdmId)
  if (!physician) return null

  // ... mapping for canonical fields ...

  const extensions: any[] = []

  // D21: nppes-last-synced-at
  if (physician.nppesProvenance?.lastSyncedAt) {
    extensions.push({
      url: 'http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-last-synced-at',
      valueDateTime: physician.nppesProvenance.lastSyncedAt,
    })
  }

  // D21: nppes-deactivated-at
  if (physician.status === 'deactivated' && physician.deactivatedAt) {
    extensions.push({
      url: 'http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-deactivated-at',
      valueDateTime: physician.deactivatedAt.toISOString(),
    })
  }

  return {
    resourceType: 'Practitioner',
    id: physician.id,
    active: physician.status === 'active',      // FHIR-standard mapping
    identifier: [
      { system: 'http://hl7.org/fhir/sid/us-npi', value: physician.npi },
    ],
    name: [{
      family: physician.lastName,
      given: [physician.firstName, ...(physician.middleName ? [physician.middleName] : [])],
    }],
    qualification: physician.taxonomies?.map(t => ({
      identifier: [{ system: 'http://nucc.org/provider-taxonomy', value: t.code }],
      code: { text: t.display },
    })) ?? [],
    extension: extensions.length > 0 ? extensions : undefined,
  }
}
```

Per D21 the `nppes-last-synced-at` extension is ALWAYS included when the source has it, and the `nppes-deactivated-at` extension is included WHEN `external_physician.status='deactivated'` AND `external_physician.deactivated_at IS NOT NULL`; when the practitioner is deactivated, `Practitioner.active = false` (FHIR-standard mapping). Both extension URIs are documented in M28's CapabilityStatement per D11.

### 4.13 Cache Invalidation Consumer

#### 4.13.1 Consumer registration

```ts
// apps/backend/src/modules/28-fhir/consumers/cache-invalidation.ts

import type { Outbox } from '@wardenx/foundation/outbox'
import type { Logger } from 'pino'
import type { ValkeyClient } from '@wardenx/foundation/valkey'

export function registerCacheInvalidationConsumers(
  outbox: Outbox,
  valkey: ValkeyClient,
  logger: Logger,
): void {
  // M11 events — invalidate DiagnosticReport + Patient/$everything
  const m11Events = [
    'm11.order.results_received',
    'm11.order.results_received_critical',
    'm11.order.transmission_status_changed',
    'm11.order.transmission_terminal_failed',
    'm11.order.results_overdue',
  ]

  for (const eventName of m11Events) {
    outbox.registerConsumer({
      eventName,
      consumerName: `m28.fhir-cache-invalidation-${eventName}`,
      handler: async ({ payload }) => {
        const orgId = (payload as any).organizationId
        const orderId = (payload as any).orderId
        if (!orgId || !orderId) {
          logger.warn({ eventName, payload }, 'm28.cache_invalidation.missing_ids')
          return
        }

        // Look up the patient_id via M11's OrderProvider (we don't trust the event
        // payload for the patient ID — orders can be re-pointed via M22 corrections)
        const order = await SeamRegistry.get('OrderProvider').findOrder(orgId, orderId)
        if (!order) {
          logger.warn({ orderId }, 'm28.cache_invalidation.order_not_found')
          return
        }

        // Invalidate cache keys
        await valkey.del(`fhir:${orgId}:DiagnosticReport:${orderId}`)
        await valkey.del(`fhir:${orgId}:ServiceRequest:${orderId}`)
        await valkey.del(`fhir:${orgId}:Patient:${order.patientId}:$everything`)

        logger.info({ orderId, patientId: order.patientId }, 'm28.cache_invalidation.completed')
      },
    })
  }

  // M40 — mdm.physician_deactivated invalidates Practitioner + PractitionerRole
  outbox.registerConsumer({
    eventName: 'mdm.physician_deactivated',
    consumerName: 'm28.fhir-cache-invalidation-physician',
    handler: async ({ payload }) => {
      const physicianId = (payload as any).id
      const affectedOrgs: string[] = (payload as any).affectedOrgs ?? []

      for (const orgId of affectedOrgs) {
        await valkey.del(`fhir:${orgId}:Practitioner:${physicianId}`)
        await valkey.del(`fhir:${orgId}:PractitionerRole:${physicianId}`)
      }

      logger.info({ physicianId, affectedOrgs: affectedOrgs.length }, 'm28.cache_invalidation.practitioner')
    },
  })
}
```

The consumer's idempotency is handled by Valkey's `DEL` being naturally idempotent (deleting an absent key is a no-op). Per D22 the `ServiceRequest/{orderId}` invalidation is wired today for forward-compat even though the Phase-2 ServiceRequest mapper currently returns 404. The invalidation is per-tenant — cross-tenant cache pollution is impossible because the cache key already includes `organization_id`. The consumer doesn't trigger any FHIR projection — it just invalidates; the next FHIR read recomputes from authoritative source.


## 5. UI Surfaces

### 5.1 Web Screens

| Screen | Path | Purpose |
|--------|------|---------|
| FHIR Client Registry | `/admin/fhir/clients` | List, propose, approve, suspend, revoke FHIR clients; per-client detail page with allowed scopes, BAA reference, recent disclosure volume |
| Client Onboarding Wizard | `/admin/fhir/clients/new` | 4-step wizard: client identity → auth method (Backend Services with JWKS URL or API key) → scopes & tier → BAA reference & compliance co-approval-required notice |
| Client Detail | `/admin/fhir/clients/{id}` | Operational dashboard: active sessions, last-24h request count, error rate, top resource types accessed; "Revoke" / "Suspend" / "Rotate credential" actions |
| Bulk Export Jobs | `/admin/fhir/bulk-export-jobs` | Cross-client list of `accepted`, `in_progress`, `completed`, `failed`, `cancelled`, `expired` jobs; per-job detail with resource-type breakdown, artifact links, retry button |
| Operator-Initiated Export | `/admin/fhir/bulk-export-jobs/new` | Pick destination client; pick resource types; pick `_since`; submit |
| Inbound Proposals — Patient | `/admin/fhir/inbound/patient` | M5 reviewer queue: pending Patient proposals from external clients; side-by-side compare with existing match candidates from M5; accept (creates / updates) or reject with rationale |
| Inbound Proposals — Medication History | `/admin/fhir/inbound/medication-statement` | M12 reviewer queue: pending MedicationStatement proposals; reconciliation against existing M12 medhx records |
| Tenant FHIR Config | `/admin/fhir/config` | View / edit the tenant's `tenant_fhir_host`, `identifier_uri_base`, `inbound_review_sla_hours`; rotate cursor signing key (with step-up) |
| Disclosure Accounting Export | `/admin/fhir/disclosures` | Per-patient §164.528 disclosure-accounting query: for a chosen patient + date range, list every FHIR disclosure with consuming client + resource type + count |
| Capability Statement Viewer | `/admin/fhir/capability` | Read-only view of the current `fhir_capability_snapshot`; checksum + release_tag display; the public URL at `/fhir/r4/metadata` for verification |
| FHIR Utilization Dashboard | `/admin/fhir/dashboard` | Charts: requests-by-hour, top resource types, top clients, error rate, bulk-export job volume, inbound-proposal SLA p50/p95 — consumes the `FhirGatewayMetricsProvider` seam |

### 5.2 Mobile (Capacitor) Variants

None. M28 is an administrative + interop surface. No clinician-facing mobile screens.

### 5.3 Portal Variants (M31-consumed)

None in Phase 1. Phase 2 may surface a patient-facing "who has accessed my data via FHIR" view derived from the M28 disclosure-accounting trail; that surface is M31-owned with M28 publishing the read-side data per the `FhirGatewayMetricsProvider.disclosureMetricsForOrg` seam plus a Phase-2 per-patient query.

### 5.4 Accessibility (WCAG 2.1 AA)

The administrative web surfaces conform to WCAG 2.1 AA per architecture §-A11y standard. Specific attention points for M28:

- The **Inbound Proposals review** UI must announce each pending proposal's resource type, source client name, and SLA-due timestamp on screen-reader navigation; the accept / reject buttons must include the resource type in their accessible name (e.g., "Accept Patient proposal from St. Francis Hospital").
- The **Capability Statement Viewer** renders the JSON as a syntax-highlighted block; the per-resource conformance table is keyboard-navigable with per-row aria-labels.
- The **Disclosure Accounting Export** form requires a date-range picker that is keyboard-navigable and screen-reader-accessible per the standard form-control patterns from `packages/ui`.
- Color is never the sole indicator of status: the `status` chip on every screen pairs color with text + icon (e.g., a revoked client has a red chip with the word "Revoked" and a slashed-circle icon).
- Error states return WCAG-conformant inline messages with `aria-live='polite'` for asynchronous validation results.

## 6. Permissions Matrix

| Action | Route | Permission | ABAC predicate(s) |
|--------|-------|------------|-------------------|
| Read CapabilityStatement | 1 | `fhir.capability.read` (or anonymous + per-IP rate limit) | none |
| Read SMART well-known config | 2 | (anonymous) | none |
| Mint bearer token | 3 | (bearer not required; client_assertion JWT verified) | `fhir_client_active` |
| Read FHIR resource | 4 | (bearer + FHIR scope) | `fhir_client_active`, `fhir_export_recipient_authorized` (per-resource consent gate) |
| Search FHIR resources | 5 | (bearer + FHIR scope) | same as 4 |
| Patient/$everything | 6 | (bearer + FHIR scopes for every linked type) | same as 4 |
| Initiate bulk export (FHIR-side) | 7,8,9 | (bearer + FHIR scope) | `fhir_client_active`, `fhir_export_scope_satisfied` |
| Poll bulk export | 10 | (bearer) | `bulk_export_initiator_or_admin` |
| Cancel bulk export (FHIR-side) | 11 | (bearer) | `bulk_export_initiator_or_admin` |
| Read CodeSystem | 12 | (bearer + `system/CodeSystem.read`) | `fhir_client_active` |
| $validate-code | 13 | (bearer + `system/CodeSystem.read`) | `fhir_client_active` |
| Read ValueSet / $expand | 14,15 | (bearer + `system/ValueSet.read`) | `fhir_client_active` |
| Inbound staging | 16 | (bearer + `system/{Type}.write`) | `fhir_client_active` |
| List FHIR clients | 23 | `fhir.client.read` | `fhir_client_organization_scope` |
| Propose new client | 24 | `fhir.client.admin` (Org Admin) | `fhir_client_organization_scope` |
| Approve client | 25 | `fhir.client.admin` (Compliance Officer; must differ from proposer) | `fhir_client_organization_scope` |
| Revoke client | 26 | `fhir.client.admin` | `fhir_client_organization_scope` |
| Suspend client | 27 | `fhir.client.admin` | `fhir_client_organization_scope` |
| Rotate credential | 28 | `fhir.client.admin` | `fhir_client_organization_scope` |
| Read client sessions | 29 | `fhir.client.session.read` | `fhir_client_organization_scope` |
| Revoke session | 30 | `fhir.client.admin` | `fhir_client_organization_scope` |
| List bulk export jobs (admin) | 31 | `fhir.export.bulk.read` | `fhir_client_organization_scope` |
| Initiate bulk export (operator) | 32 | `fhir.export.bulk.initiate` | `fhir_client_organization_scope`, `fhir_export_scope_satisfied` |
| Cancel bulk export (operator) | 33 | `fhir.export.bulk.cancel` | `bulk_export_initiator_or_admin` |
| Review inbound proposals | 34 | `fhir.inbound.review` | `fhir_client_organization_scope`, `fhir_inbound_owner_module_match` |
| Accept proposal | 35 | `fhir.inbound.accept` | `fhir_inbound_owner_module_match` |
| Reject proposal | 36 | `fhir.inbound.reject` | `fhir_inbound_owner_module_match` |
| Read tenant FHIR config | 37 | `fhir.config.read` | `fhir_client_organization_scope` |
| Write tenant FHIR config | 38 | `fhir.config.write` | `fhir_client_organization_scope` |
| Rotate cursor signing key | 39 | `fhir.config.write` + step-up | `fhir_client_organization_scope` |


## 7. Workflow Acceptance Criteria

### 7.1 W-FHIR-01 — Onboard a new FHIR client end-to-end

**Setup:** Org Admin Alice; Compliance Officer Bob; an external partner (a referring hospital's HIE) wants `system/Patient.read system/Encounter.read system/Observation.read`; BAA contract `BAA-2026-022` is signed and recorded in M34.

**Steps:**
1. Alice opens `/admin/fhir/clients/new`, names the client "Mercy Memorial Hospital HIE", selects `smart_backend_services` with the HIE's published JWKS URL, ticks the three scopes, selects tier-2, references `BAA-2026-022`. Submits → row inserted with `status='pending_approval'`; outbox `m28.fhir.client.pending_approval` emits; M36 alert to Compliance Officer pool.
2. The onboarding worker fetches `<jwks_uri>` and validates it returns a JWKS with at least one RSA key; if not, the row is auto-rejected with `INVALID_JWKS` and Alice is notified to fix the URL.
3. Bob receives the M36 alert, opens the proposal, validates the BAA reference resolves to an active M34 contract, types a rationale ≥20 chars, submits `POST /api/v1/fhir/clients/{id}/approve`.
4. Row transitions to `status='active'`; `m28.fhir.client.activated` outbox emits; M34 marks `BAA-2026-022` as bound; M36 alert to Alice (informational).
5. The HIE's integration team uses the client_id + their pre-registered key pair to sign a `client_assertion` JWT, POSTs to `/fhir/oauth2/token`, receives a bearer token, and successfully queries `/fhir/r4/Patient?_lastUpdated=ge2026-06-01` with the bearer token. Every request emits `auditRead()`.

**Done means:** the HIE's first FHIR request succeeds; the disclosure-accounting trail records the request with consuming `fhir_client_id` resolving to "Mercy Memorial Hospital HIE", typed query parameters, result count, and the timestamp. A subsequent §164.528 query for a patient included in the search returns this disclosure.

### 7.2 W-FHIR-02 — Propose, approve, reject the wrong proposer attempting self-approval

**Setup:** Alice is the proposer.

**Steps:**
1. Alice tries `POST /api/v1/fhir/clients/{id}/approve` for her own proposal.
2. Route rejects with `403 SELF_APPROVAL_FORBIDDEN`; audit `phi.access_denied`; M36 alert to Compliance Officer pool ("self-approval attempted").

**Done means:** the same membership cannot both propose and approve; the dual-control invariant of D12 is enforced server-side and not by UI affordance alone.

### 7.3 W-FHIR-03 — SUD redaction at egress with consent gate (D3)

**Setup:** Patient Carol has `privacy_flag.sud=true` (a flag M5 holds per its snapshot from M39). The HIE client does not have a `42_cfr_part_2_release` consent referencing it. Carol has one `medication_order` for buprenorphine flagged SUD.

**Steps:**
1. HIE queries `GET /fhir/r4/MedicationRequest?patient=Patient/{carolId}` with the bearer token.
2. M28 resolves Carol's id; on every resource project step the `MedicationRequest` mapper invokes the consent gate: `ConsentEvaluator.evaluateForDisclosure({patientId: carolId, recipientClientId: <hieId>, asOf: now()})`.
3. M39 returns `{ allowed: true, redactSudContent: true }` — the disclosure is allowed for non-SUD content but SUD content must be redacted.
4. The buprenorphine `medication_order` is filtered from the result set; the returned Bundle is empty (or contains the non-SUD medications); the Bundle includes `OperationOutcome` with `issue.severity='warning'` and `issue.details.text='filtered for 42 CFR Part 2; consent absent'`.
5. Carol's Compliance Officer later adds a `42_cfr_part_2_release` consent for the HIE. On the HIE's next query the consent gate returns `{ allowed: true, redactSudContent: false }` and the buprenorphine `MedicationRequest` projects.

**Done means:** SUD-flagged content is filtered at egress by default; the consumer is informed via OperationOutcome (not "no data"); the consent gate is a per-resource consult, not a per-client one-time setting; the §4001 information-blocking posture is satisfied because the consumer is told *why* the data is absent and how to obtain consent.

### 7.4 W-FHIR-04 — Bulk export: accept → in-progress → completed with 24-hour TTL

**Setup:** HIE client tier-2; resource types `Patient,Encounter,Observation,MedicationRequest`; `_since=2026-06-01T00:00:00Z`.

**Steps:**
1. HIE `POST /fhir/r4/$export?_type=Patient,Encounter,Observation,MedicationRequest&_since=2026-06-01T00:00:00Z` with bearer.
2. Route validates each `_type` against `allowed_scopes[]`; passes; computes `sha256(request_envelope)`; checks the §2.6 dedup index; no prior job within 10 minutes; enqueues `fhir.bulk-export` BullMQ job; inserts `fhir_bulk_export_job` row with `status='accepted'`; returns `202 Accepted` with `Content-Location: /fhir/r4/$export-poll-status/{job_id}`.
3. Bulk-export worker picks up; sets `status='in_progress'`; for each resource type iterates the consumed-seam reader (e.g., `PatientReader.searchAll(orgId, sinceIso)`), maps each row through the R4 mapper with the per-row consent gate consult, writes one NDJSON line per resource to MinIO at `tenants/<org>/fhir-exports/<job_id>/Patient.ndjson`; inserts `fhir_bulk_export_artifact` row per file with the sha256 checksum.
4. On completion the job row is `status='completed'`, `expires_at = completed_at + 24h`, `total_resources = sum(row_count)`, `artifact_count = count(*)`.
5. HIE polls `GET /fhir/r4/$export-poll-status/{job_id}` and receives `200 OK` with the FHIR-spec `output[]` array; each `output[].url` is a freshly-minted presigned MinIO URL valid for 15 minutes.
6. HIE downloads each NDJSON; verifies the checksum from the `X-Checksum-SHA256` header against the `Bundle.identifier` returned in the completion manifest.
7. 24 hours later the sweeper moves the job to `expired`, purges MinIO objects; the poll endpoint returns `410 Gone` with OperationOutcome.

**Done means:** bulk export is conformant with FHIR Bulk Data 2.0.0; NDJSON files survive for exactly 24 hours; the per-job concurrency cap of 1 prevents resource thrash; the auditRead() trail records the export at job-completion time with the full resource type breakdown.

### 7.5 W-FHIR-05 — Inbound Patient proposal: stage → review → accept by M5 reviewer

**Setup:** An ADT system POSTs a new Patient resource. The patient does not exist in M5.

**Steps:**
1. ADT `POST /fhir/r4/Patient` with body the FHIR Patient resource and `system/Patient.write` scope.
2. M28 validates the body against the InboundPatientResource schema; passes; inserts `fhir_inbound_resource` row with `proposal_status='pending'`, `owner_module='m5'`; outbox `m28.fhir.inbound.proposed`; returns `202 Accepted` with `OperationOutcome.issue.details.text='Proposal staged; M5 reviewer will accept or reject'` and the `Location: /api/v1/fhir/inbound-proposals/{id}` header (operator-side path).
3. M5 reviewer (an RN with `m5.patient.write`) sees the proposal in their queue, opens the side-by-side compare view, accepts.
4. M5's accept callback writes a new `patient` row (or updates an existing one matched by the M5 deterministic matcher), emits `m5.patient.created` (or `.updated`), then calls M28's `POST /api/v1/fhir/inbound-proposals/{id}/accept` with the new `patient_id`.
5. M28 updates the proposal row with `proposal_status='accepted'`, `accepted_aggregate_id=<patient_id>`, `decided_by_membership_id=<rn>`, `decided_at=now()`; emits `m28.fhir.inbound.accepted`; the ADT consumer's subsequent `GET /fhir/r4/Patient?identifier=<adt-system>|<adt-id>` returns the now-existing Patient with the WardenX-canonical id.

**Done means:** the inbound proposal-then-review pipeline does not write to M5 tables directly; the M5 reviewer is the only actor that can commit a Patient row; the inbound idempotency key `(source_client_id, resource_type, source_fhir_id)` ensures a re-POST does not create a duplicate proposal; the source-clinical-system identifier is preserved on the resulting `patient_identifier` row per M5.

### 7.6 W-FHIR-06 — Inbound proposal SLA breach → expiry → M36 alert

**Setup:** Tenant's `tenant_fhir_config.inbound_review_sla_hours=72`. A proposal sits in `pending` past 72 hours.

**Steps:**
1. The `fhir.inbound-sla-watch` cron worker (every 5 minutes) finds the row, transitions to `proposal_status='expired'`, schedules payload destruction at +30 days, emits `m28.fhir.inbound.expired`; M36 alert `fhir.inbound.proposal_overdue` to Compliance Officer.
2. 30 days later the payload is destruction-erased; the row's `payload_sha256` and the decision trail are preserved for audit.

**Done means:** unreviewed proposals do not accumulate indefinitely; the operator is alerted on SLA breach; the per-row payload eventually leaves the database while the audit trail survives.

### 7.7 W-FHIR-07 — Forward-seam deny-stub behavior (M23 not yet enabled)

**Setup:** Phase 1; M23 Billing Medicare is locked but the Phase-2 Claim/EOB projection routes are intentionally returning 404.

**Steps:**
1. HIE queries `GET /fhir/r4/Claim/{id}`.
2. Route returns `404 Not Found` + `OperationOutcome.issue.severity='error'`, `.issue.code='not-supported'`, `.issue.details.text='Claim resource is not yet exposed; expected enablement in Phase 2'`, `.issue.diagnostics='https://docs.wardenx.com/fhir/phase-2'`.
3. The same posture applies to `ServiceRequest`, `QuestionnaireResponse`, `Location` per D1.

**Done means:** Phase-2 routes are advertised as not-yet-supported in the CapabilityStatement and return the FHIR-spec correct error; the consumer can distinguish "this resource is permanently unsupported" from "I lack scope" from "the patient has no such resource."

### 7.8 W-FHIR-08 — Rate-limit ceiling: tier-2 hits the cap (D16)

**Setup:** Tier-2 client; `rate_limit_rps=10`.

**Steps:**
1. A burst of 25 requests in 1 second arrives.
2. The Valkey sliding-window gate accepts the first 10, then for requests 11–25 returns `429 Too Many Requests` with `Retry-After: 1` and `OperationOutcome.issue.severity='error'`, `.issue.code='throttled'`.
3. After 1 second the budget refills; subsequent requests succeed.

**Done means:** tier-based rate limits are enforced server-side; the 429 envelope conforms to FHIR-spec; the burst is shaped without crashing the gateway.

### 7.9 W-FHIR-09 — CapabilityStatement is signed and verifiable

**Setup:** Boot; the platform signing key is set in the boot environment.

**Steps:**
1. On boot, `bootstrapModule28` computes the CapabilityStatement from the route registry + the seam catalog, computes the sha256 checksum, signs with HMAC-SHA256, inserts the `fhir_capability_snapshot` row.
2. The hourly `fhir.capability-snapshot-validator` worker reads the row, re-computes the HMAC, compares to `signature`; matches; passes.
3. A consumer that requested the metadata at boot can verify the checksum against the published value at `/api/v1/fhir/capability` operator-facing endpoint; mismatch → tampering signal; pass → conformance signal.

**Done means:** the CapabilityStatement is cryptographically verifiable; a tenant can prove what the gateway advertised at any point in the past; the §164.528 record can reference the conformance posture at the time of any historical disclosure.

### 7.10 W-FHIR-10 — Cursor pagination across concurrent writes (D13)

**Setup:** A search returns 130 Patients; page size 50; client requests page 1, then a new Patient is created while the client is preparing the next page request.

**Steps:**
1. Page 1 request: M28 returns 50 Patients + a `Bundle.link.relation='next'` with an HMAC-signed cursor encoding the last Patient's id + meta.lastUpdated.
2. A concurrent M5 process inserts a new Patient.
3. Page 2 request with the cursor: M28 decodes the cursor (HMAC-verifies), passes the bound to the reader seam (`PatientReader.searchAfter(orgId, lastId, lastUpdated, count=50)`); returns the next 50 Patients (the newly created one may or may not appear depending on its insertion position; cursor semantics is "everything after the prior page's last").
4. Page 3 returns the remaining 30.

**Done means:** pagination is stable under concurrent writes; offset-based pagination is not used; the cursor cannot be forged (HMAC verify) or replayed across tenants (the cursor signing key is per-tenant per D9).

### 7.11 W-FHIR-11 — AI-prohibited zone enforcement at boot (D14)

**Setup:** A developer adds a `packages/ai-platform` prompt template that references "FHIR Patient resource generation".

**Steps:**
1. Boot calls `validateFhirAIBlock()`.
2. The validator iterates M32's prompt registry; finds the new prompt; throws `FhirAIBlockViolation` with the offending prompt template id.
3. Boot aborts; the server does not start.

**Done means:** M32 cannot land a prompt that synthesizes or modifies FHIR resources; the wire output remains deterministic per D14; CI catches the violation pre-deploy (the boot-validate step is one of the CI gates per architecture §-fitness).

### 7.12 W-FHIR-12 — Client revocation cascade

**Setup:** Active client; one active session; one bulk-export job in `in_progress`.

**Steps:**
1. Org Admin `POST /api/v1/fhir/clients/{id}/revoke` with rationale ≥40 chars + step-up.
2. Route transitions client to `status='revoked'`; `revoked_at=now()`.
3. Cascade: all active `fhir_client_session` rows for the client marked `revoked_at=now()`; the bulk-export job is marked `status='cancelled'`; the worker on its next checkpoint sees the cancel and aborts the NDJSON write; partially-written artifacts are purged.
4. Outbox `m28.fhir.client.revoked` emits; M36 alert via BAA contact channel; M34 unbinds the BAA reference.

**Done means:** a revoked client cannot mint a new token; its existing tokens are rejected on the next call with `401 Unauthorized` + `OperationOutcome.issue.code='login'`; in-flight exports are cancelled; the audit trail of historical disclosures by the now-revoked client is preserved indefinitely.

### 7.13 W-FHIR-13 — DiagnosticReport read for non-SUD lab

**Setup:** Per M11 W-M11-13 happy path, a CBC has been ordered, transmitted, and the results attached. A tier-1 FHIR client calls `GET /fhir/r4/DiagnosticReport/<m11OrderId>?_include=DiagnosticReport:result`.

**Expected:**
- M28 mapper composes the DiagnosticReport via the `projectDiagnosticReport` function.
- Three child Observations (white blood count, hemoglobin, hematocrit) are inlined as `contained` resources.
- The DiagnosticReport `id` matches the M11 order ID; the inlined Observations carry IDs `<observationId>--0`, `--1`, `--2`.
- `result[]` references the contained Observations.
- `meta.profile` includes the US Core lab DiagnosticReport profile URL.
- `meta.security` does NOT include the `R` (restricted) label (no SUD content).
- `performer[]` references both the ordering provider and the lab facility.
- The FHIR client successfully parses and renders the report.

### 7.14 W-FHIR-14 — `?patient=:id` search returns lab reports

**Setup:** A patient has 3 lab orders over the past 30 days, all with results attached. FHIR client calls `GET /fhir/r4/DiagnosticReport?patient=Patient/<id>&category=LAB&_count=10`.

**Expected:**
- The `FhirSearchTranslator` (D6) translates the FHIR search into upstream seam calls:
  - `OrderProvider.searchOrdersByPatient(orgId, patientId, { kind: 'lab', limit: 10 })` returns the 3 orders.
- For each order, the projector composes the DiagnosticReport.
- The Bundle response has 3 entries, each with `resource: DiagnosticReport`.
- Cursor pagination per D13 works correctly across the 3 reports.
- An `auditRead` row is written per D15 with the search-envelope details.

### 7.15 W-FHIR-15 — SUD-class lab returns redacted DiagnosticReport

**Setup:** A urine drug screen returned positive for methadone. The observation has `sud_redaction_status='redacted_consent_absent'`. FHIR client calls `GET /fhir/r4/DiagnosticReport/<orderId>`.

**Expected:**
- The projector composes the report, identifies the SUD-class child observation.
- The `applySudRedactionToDiagnosticReport` function replaces `result[]` with a single placeholder Observation reference.
- The placeholder Observation has:
  - `code.text = "SUD-protected results"`
  - `status = 'final'`
  - `dataAbsentReason.coding[].code = 'temp-unknown'`
  - `note[0].text` includes the 42 CFR Part 2 banner
- `DiagnosticReport.conclusion` is absent (cleared).
- `meta.security` includes the FHIR-standard `R` restricted label.
- The response is structurally complete FHIR (passes the US Core lab DiagnosticReport profile validation).
- No methadone result value or LOINC code appears anywhere in the response (grep test).
- An `auditRead` row is written; M4's retention class is `compliance_42cfr_part2` per M4 D8.

### 7.16 W-FHIR-16 — Practitioner includes NPPES extensions

**Setup:** An ordering provider with NPI `1234567893`. M40 has synced the provider with `nppes_provenance.lastSyncedAt = '2026-06-09T02:30:00Z'`. The provider is active.

**Expected:**
- FHIR client calls `GET /fhir/r4/Practitioner/<mdmId>`.
- Response includes `extension[]` with:
  - `{ url: 'http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-last-synced-at', valueDateTime: '2026-06-09T02:30:00Z' }`
- `active = true` (FHIR-standard mapping from M40 status='active').
- No `practitioner-nppes-deactivated-at` extension (provider is active).

**Variant — deactivated practitioner:** Same setup but M40 has `status='deactivated'`, `deactivatedAt='2026-06-09T03:00:00Z'`.

- `active = false`.
- BOTH extensions present: `nppes-last-synced-at` AND `nppes-deactivated-at`.
- The cache for this Practitioner ID was invalidated by the cache invalidation consumer when `mdm.physician_deactivated` fired (so the response reflects the current state, not stale).


## 8. Security & Privacy

### 8.1 RLS

Every M28-owned PHI-bearing or operationally-sensitive table is RLS-enforced per the §3.5 pattern. Specifics:

- **`tenant_fhir_config`, `fhir_client`, `fhir_client_credential`, `fhir_client_session`, `fhir_bulk_export_job`, `fhir_bulk_export_artifact`, `fhir_inbound_resource`** — per-tenant isolation via `current_setting('app.org_id', true)::uuid`.
- **`fhir_capability_snapshot`** — read-all (platform-shared), write only with `app.role='platform_ops'`.
- The bulk-export worker, the inbound-SLA worker, the capability-snapshot validator use `withSystemPrincipalOrgContext(orgId)` per the architecture §3 system-principal pattern; the `orgId` is read from the BullMQ job payload, never from a session.
- The FHIR read path (routes 4–18) sets `app.org_id` from the `fhir_client.organization_id` at token-validation time; the rest of the request runs inside `withOrgContext(orgId)`.

### 8.2 ABAC

Per §4.7 the six predicates M28 registers are the egress gates. Two are worth deep-noting:

- **`fhir_export_recipient_authorized`** — the per-resource consent gate; invoked on every resource projection step; consults `ConsentEvaluator.evaluateForDisclosure({patientId, recipientClientId, asOf})` from M39. The result `{allowed: false}` causes the resource to be filtered from the response; `{allowed: true, redactSudContent: true}` causes the mapper to skip SUD-flagged fields and the Bundle to carry an `OperationOutcome.issue.severity='warning'` per W-FHIR-03.
- **`fhir_inbound_owner_module_match`** — the propose-then-review gate; an M5 reviewer cannot accept an `owner_module='m12'` proposal; an M12 reviewer cannot accept an `owner_module='m5'` proposal. The predicate consults M3's role catalog and the requesting member's permission grants.

### 8.3 STRIDE Map

| STRIDE category | Threat vector | Mitigation |
|-----------------|---------------|------------|
| **Spoofing** | A malicious actor impersonates a registered FHIR client by stealing a bearer token | Bearer tokens are 15-minute TTL (D2); tokens are validated against `fhir_client_session` on every call; revocation cascades (W-FHIR-12); client_assertion JWT signatures are verified against per-client JWKS — even with a stolen client_id, an attacker without the private key cannot mint tokens |
| **Tampering** | A consumer modifies the cursor to access another tenant's data | Cursors are HMAC-SHA256-signed with the per-tenant `cursor_signing_key_cipher`; cross-tenant cursor use fails the HMAC verify; cursor decode produces 400 `invalid_cursor` |
| **Tampering** | A consumer modifies the bulk-export request envelope between submission and worker pickup | The `request_envelope_sha256` is computed at submission and pinned on the job row; the worker re-reads from the row; the request is never re-fetched from any client-controlled location |
| **Tampering** | An attacker tampers with the CapabilityStatement at rest to mislead conformance audits | The snapshot is signed with HMAC-SHA256 at boot; the hourly validator detects tampering and alerts; the §164.528 disclosure record references the snapshot's checksum so historical conformance is verifiable |
| **Repudiation** | A FHIR client denies having accessed a patient's data | Every FHIR read emits `auditRead()` with the `fhir_client_id`, the typed query envelope, the result count, the IP, and the timestamp; the audit trail is retention-class `compliance` and survives the client's revocation |
| **Information Disclosure** | SUD content leaks to an unauthorized recipient | Per D3 the per-resource egress gate consults M39 on every projection step; the gate's default-deny posture for 42 CFR Part 2 is enforced server-side, never UI-gated; a SUD-class lab `DiagnosticReport` is whole-report-redacted per D20 so a single hidden value is not inferable by exclusion |
| **Information Disclosure** | A bulk-export NDJSON file leaks via a long-lived URL | Presigned URLs are minted *at poll time*, not at job-completion time; they are valid for 15 minutes; the underlying MinIO objects are purged after 24 hours; the `tenants/<org>/` IAM scope prevents cross-tenant signing per architecture §8(3) |
| **Information Disclosure** | A SQL injection on a FHIR search parameter reads beyond the requested scope | M28 builds NO SQL; every search resolves to a typed reader-seam call; the seam's parameterized queries (Drizzle ORM with parameter binding) are the SQL surface; the dependency-cruiser boundary check blocks any new direct-SQL code in `packages/fhir` |
| **Information Disclosure** | An inbound proposal payload leaks PHI to a reviewer with insufficient scope | The reviewer must have `m5.patient.write` or `m12.medication.write` per the ABAC `fhir_inbound_owner_module_match`; the reviewer queue is RLS-isolated to the tenant; the payload is redacted of `payload` from the M4 audit value_capture (only the sha256 enters the audit) |
| **Information Disclosure** | A `Provenance` resource leaks AI-model identity beyond what the consumer is authorized to see | Per D10 the composition reads M22's `ExtractionProvenanceReader` and emits the M22-controlled provenance fields; M22 enforces its own per-field provenance visibility; M28 surfaces what M22 returns and nothing more |
| **Denial of Service** | A client floods the gateway with high-cardinality search requests | Per D16 tier-based rate limits enforced via Valkey sliding window; per-client bulk-export concurrency cap of 1; HTTP-level `429 Too Many Requests` per request; sustained abuse triggers automated suspension (`fhir.search.anomaly_detected` alert → ops review) |
| **Denial of Service** | A bulk-export job allocates unbounded memory by enumerating millions of resources | NDJSON streaming (line-per-resource flush to MinIO); per-resource-type partitioned files; total-resource cap per tenant tier configurable in `tenant_fhir_config`; the worker uses streaming reader calls (`PatientReader.searchAll` is an `AsyncIterable`, not a `Promise<Array>`) |
| **Elevation of Privilege** | A consumer requests `system/*.write` scope at token mint without having registered for it | The token-mint scope check rejects requests where the requested scope is not a subset of `fhir_client.allowed_scopes[]`; the response is `400 invalid_scope` |
| **Elevation of Privilege** | An admin route caller bypasses the dual-approval requirement | The approve route checks `approved_by_admin_membership_id` differs from the requesting member; same-member self-approval is rejected with `403 SELF_APPROVAL_FORBIDDEN` (W-FHIR-02) |
| **Elevation of Privilege** | An attacker uses the inbound-staging POST to write to M5/M12 tables directly | The inbound POST writes ONLY to `fhir_inbound_resource`; no path from inbound staging to M5/M12 native tables exists in M28 code; the M5/M12 native write is exclusively via the owner-module's accept callback per D8 |

### 8.4 Eraser + Retention

Per §3.7 the M28 eraser registered into M4 follows the per-table behavior. Retention classes per the M4 catalog:

| Table | Retention class | Justification |
|-------|----------------|---------------|
| `tenant_fhir_config` | `compliance` | Required for survey reconstruction of "what URI base was advertised at the time of disclosure" |
| `fhir_client` | `compliance` | Required for §164.528 disclosure-accounting — "who received this PHI" |
| `fhir_client_credential` | `compliance` (metadata only; secret destroyed on rotation/revoke) | The fingerprint trail survives; the secret bytes do not |
| `fhir_client_session` | `operational` (90 days hot, then routine purge) | Not retained beyond operational utility; the `auditRead()` carries the disclosure record |
| `fhir_bulk_export_job` | `compliance` | The job is a disclosure event; the metadata survives even after the NDJSON files are purged at 24h |
| `fhir_bulk_export_artifact` | `compliance` (metadata only; MinIO objects purged at 24h) | The byte-count + checksum + resource-type breakdown is the disclosure-accounting evidence |
| `fhir_inbound_resource` | `compliance` (payload destruction at +30 days on reject/expire) | The decision rationale + the source identity survives even after the inbound bytes are erased |
| `fhir_capability_snapshot` | `operational` (rebuildable) | Platform-shared; no PHI |

Per architecture §-retention destruction certificates issued by M4 invoke the M28 eraser; M4 generates the certificate artifact; M28's destruction commits return success only after MinIO purge succeeds (no orphaned artifact bytes).

### 8.5 Adapter Mandate (Architecture §25.14)

- **No third-party FHIR vendor SDK.** M28 implements the FHIR R4 wire shapes natively against `@medplum/fhirtypes` (per architecture line 387 — type definitions only, no transport, no client). The mappers are hand-rolled per resource type; the search translator is hand-rolled; the CapabilityStatement is hand-generated.
- **The MinIO client adapter** is `packages/storage` (M1-owned); M28 imports the storage adapter, never any `aws-sdk` directly.
- **The Valkey client adapter** is `packages/cache` (M1-owned); M28 imports the cache adapter, never any `ioredis` / `node-redis` directly.
- **The BullMQ client adapter** is `packages/queue` (M1-owned); M28 imports the queue adapter, never any `bullmq` directly.

The boundary check (architecture §25.15 check 6) blocks any direct import of `aws-sdk`, `ioredis`, `bullmq`, or any FHIR-vendor SDK from M28 code.

### 8.6 AI Boundary

Per D14 Module 32's LLM may not:

- Synthesize a FHIR resource (e.g., generate `Resource.text.div` via LLM).
- Modify a FHIR resource at egress (e.g., "rewrite this Patient.name to be more concise").
- Redact a FHIR resource at egress (the 42 CFR Part 2 redaction is a deterministic gate against M39, not an AI summarization).
- Decide whether to accept/reject an inbound FHIR proposal.

Enforced at boot via `validateFhirAIBlock()` in `packages/fhir/src/ai-block.ts`:

```typescript
// packages/fhir/src/ai-block.ts
import { promptRegistry } from '@wardenx/ai-platform/prompts'

const PROHIBITED_PROMPT_KINDS = [
  'fhir.resource.generate',
  'fhir.resource.modify',
  'fhir.resource.redact',
  'fhir.inbound.decision',
  'fhir.narrative.synthesize',
]

const PROHIBITED_KEYWORD_PATTERNS = [
  /\bFHIR\s+Patient\s+resource\b/i,
  /\bgenerate.*Encounter\.resource\b/i,
  /\bsynthesize.*MedicationRequest\b/i,
]

export function validateFhirAIBlock(): void {
  for (const prompt of promptRegistry.all()) {
    if (PROHIBITED_PROMPT_KINDS.includes(prompt.kind)) {
      throw new FhirAIBlockViolation(`Prompt ${prompt.id} kind '${prompt.kind}' is FHIR-prohibited`)
    }
    for (const pattern of PROHIBITED_KEYWORD_PATTERNS) {
      if (pattern.test(prompt.template)) {
        throw new FhirAIBlockViolation(`Prompt ${prompt.id} matches FHIR-prohibited pattern ${pattern}`)
      }
    }
  }
}
```

The validator runs at boot per `bootstrapModule28`; a violation aborts startup.


## 9. Testing

### 9.1 Unit Tests (≥ 90% coverage; ≥ 95% on named services)

- **Per-resource R4 mappers** (Patient, Encounter, Observation, MedicationRequest, MedicationAdministration, MedicationStatement, Condition, CarePlan, Goal, DocumentReference, Binary, Practitioner, PractitionerRole, Organization, RelatedPerson, Coverage, Consent, List, DiagnosticReport, CodeSystem, ValueSet, CapabilityStatement, OperationOutcome, Bundle): deterministic mapping (same input → byte-identical output); golden-file fixtures committed under `packages/fhir/test/fixtures/r4/{resource_type}/`; US Core 6.0 profile assertions; deterministic narrative (`text.div`) from structured fields.
- **`FhirSearchTranslator`** (≥ 95% coverage): every US Core 6.0 mandatory search parameter per resource; unsupported-parameter rejection with OperationOutcome; cursor encode/decode round-trips; cross-tenant cursor rejection (HMAC fail); `_summary`, `_elements` handling.
- **`smart-backend-services` auth module** (≥ 95% coverage): client_assertion JWT verify against JWKS; jti idempotency; expired-assertion reject; bad-signature reject; scope subset check; tier-mismatch reject.
- **`bulk-export-worker`** (≥ 95% coverage): NDJSON streaming; per-resource-type partitioning; checksum computation; cancellation mid-stream; failure-mode rollback; resume semantics.
- **`inbound-staging`**: per-resource-type JSON schema validation; idempotency key dedup; SLA-clock initialization.
- **`consent-gate`** + per-resource projection: SUD redaction enforcement; OperationOutcome warning emission; per-resource consult vs per-job consult invariant.
- **`rate-limit gate`**: tier-based sliding-window math; bulk-export concurrency cap; 429 envelope formatting.
- **`provenance composer`**: aggregation from M22 + M8 + M11/M12/M13; deterministic ordering of `agent[]`; AI-augmented flag preservation.
- **`validateFhirAIBlock`**: every prohibited prompt kind + pattern detection; positive cases (allowed prompts pass through); negative cases (prohibited prompts throw).
- **`audit-disclosure`**: every FHIR read emits `auditRead()` with the typed envelope; the envelope shape matches the M4 schema; the `fhir_client_id` is populated.
- **`projectDiagnosticReport`** (≥ 95% coverage): happy path (CBC with three values); single-value report; partial-attachment kind; no-attachment case returns null; ordering provider null case.
- **`applySudRedactionToDiagnosticReport`**: no SUD → unchanged; one SUD value in panel → whole-report redacted; conclusion cleared; security label added; placeholder Observation generated correctly.
- **Practitioner NPPES extensions**: synced-only case; deactivated case (both extensions); no-NPPES-data case (no extensions).
- **Cache invalidation consumer**: idempotent (DEL on absent key is no-op); patient lookup via OrderProvider works; multi-org physician deactivation invalidates each tenant's cache.
- **Child Observation projection**: numeric value with unit; string value (no quantity); abnormal flag interpretation; critical flag interpretation; reference range as text.

### 9.2 Integration Tests (Testcontainers)

- **End-to-end FHIR read against a Postgres + Valkey + MinIO testcontainer**: `Patient`, `Encounter`, `Observation`, `MedicationRequest`, `CarePlan`, `DocumentReference` against seeded M5/M8/M9/M12/M7/M22 fixture data; bearer-token auth; consent-gate gating; auditRead emission verified.
- **Bulk-export end-to-end**: POST `$export`; worker pickup; NDJSON files written to MinIO; status-poll returns FHIR-spec output[] with signed URLs; download verification with checksum match; 24-hour expiry sweep verified by advancing the test clock.
- **Inbound proposal end-to-end**: POST `Patient`; staging row inserted; outbox event emitted; M5 reviewer accepts via the operator route; `patient` row written; M28 row updated with `accepted_aggregate_id`; subsequent `GET Patient?identifier` returns the new patient.
- **$everything end-to-end**: with a fixture patient having Patient + Encounter + Observation + MedicationRequest + CarePlan + Goal + DocumentReference; verify 5,000-resource cap enforced; verify SUD redaction propagates per the consent gate.
- **CodeSystem / ValueSet end-to-end**: `GET /fhir/r4/CodeSystem/loinc` against the M38 fixture; verify projection matches the M38 golden fixture; `$expand` for `hospice-terminal-diagnosis` value set returns expected member set.
- **Token mint end-to-end**: client_assertion JWT signed against a test JWKS; token returned; subsequent FHIR call with the token succeeds; expired token returns 401.
- **CapabilityStatement boot generation**: bootstrap; row inserted; checksum verified; `GET /fhir/r4/metadata` returns the snapshot's JSON; HMAC validator verifies.
- **W-FHIR-13 end-to-end**: full CBC happy path (non-SUD); Bundle response validates against US Core profile.
- **W-FHIR-14 end-to-end**: search by patient with cursor pagination.
- **W-FHIR-15 end-to-end**: SUD-class methadone screen; grep response body, assert zero methadone value/LOINC occurrences; security label present.
- **W-FHIR-16 end-to-end (and variant)**: Practitioner read with both extension cases; cache invalidation triggers fresh read.

### 9.3 RLS Isolation Tests

Per M1 §9.3 the standard tenant-isolation test:

- Two tenants A, B; each with one FHIR client and one bulk-export job.
- A's FHIR client + token cannot read B's bulk-export job; the GET returns 404 (not 403 — leaking tenant existence is itself an info disclosure).
- A's operator session cannot list B's fhir_clients (the admin list route returns 0 rows for A even when B's rows exist).
- A's reviewer cannot accept B's inbound proposal (RLS blocks the SELECT; the route returns 404).
- Concurrent reads against both tenants do not cross-contaminate.

### 9.4 IDOR / Layer-Independence Tests

- Tenant A's operator with a guessed bulk-export job id from tenant B receives 404.
- A consumer guesses a `fhir_inbound_resource.id` from another tenant — RLS blocks; 404.
- A consumer guesses a `Patient/{id}` from another tenant — the per-resource read route resolves the patient via `PatientReader.findById(orgId, id)` where `orgId` comes from the bearer-token-validated `fhir_client.organization_id`; the reader returns null; route returns 404 with FHIR-spec OperationOutcome.
- Cursor forgery: a hand-crafted cursor (not HMAC-signed by the tenant's key) fails decode; route returns 400.
- Cross-tenant cursor: a cursor signed by tenant A's key is presented to tenant B's gateway path (impossible in practice because the host-routing per D9 disambiguates, but tested anyway); fails decode; 400.

### 9.5 Security Tests

- **Token replay**: re-sending the same `client_assertion` JWT within its 15-minute window returns 400 `jti_replayed` (the M1 idempotency middleware persists the prior response).
- **Token forgery**: a JWT signed with a key not in the client's JWKS returns 401.
- **Scope escalation**: a client with `system/Patient.read` requesting `system/Encounter.read` at token mint receives 400 `invalid_scope`; even if it forges the bearer token's `scopes_granted` claim, the server-side `fhir_client_session.scopes_granted` is the truth and rejects the read.
- **SQL injection in search params**: parameter values like `Patient?name=Robert');DROP TABLE patient;--` are passed through Drizzle parameter binding; no SQL is built from string concatenation; the test confirms the row count is unchanged.
- **Path traversal in bulk-export download**: the presigned URL path is server-generated; an attempt to GET `tenants/<otherOrg>/fhir-exports/...` from an unauthorized client fails at the MinIO IAM scope per architecture §8(3).
- **HMAC bypass on cursor**: a cursor with a tampered payload but the original HMAC bytes fails decode (the HMAC is computed over the payload, not just the header).
- **JWKS rotation attack**: an attacker registers a JWKS URL they control, then rotates the keys to a key they control; the M28 cache TTL is 5 minutes, so the attacker has at most 5 minutes of stale-cache validity before the next fetch updates the cache; manually-revoking the client at the M28 admin route immediately invalidates the in-memory cache.

### 9.6 E2E (Playwright)

- **Operator client-onboarding flow**: Org Admin proposes → Compliance Officer co-approves → client appears as active → fingerprint shown on detail page → client-detail dashboard shows zero requests.
- **Operator-initiated bulk export**: pick destination client + resource types + since date → 202 → poll status → completed → download NDJSON → verify checksum.
- **Inbound proposal review queue**: operator opens the M5 reviewer queue → sees a pending proposal → opens side-by-side compare → accepts → proposal moves to "accepted" → underlying Patient row created in M5.
- **Disclosure accounting export**: operator picks a patient + date range → table renders disclosures by consuming client + resource type + count → CSV download.
- **Capability viewer**: operator opens `/admin/fhir/capability` → JSON renders → checksum matches the `/fhir/r4/metadata` public response.

### 9.7 Performance Targets (per System Design §9)

- **FHIR resource read (single)** p95 < 100ms (excluding underlying seam latency); the FHIR-mapper portion p95 < 10ms.
- **FHIR search (Patient by identifier)** p95 < 200ms for tenants with up to 10k patients.
- **FHIR search (Observation by patient + code over 30-day window)** p95 < 400ms for patients with up to 500 observations in the window.
- **`Patient/$everything`** p95 < 2s for the 5,000-resource cap; p99 < 5s.
- **Bulk-export worker throughput** ≥ 5,000 resources / minute per worker; the worker is horizontally scalable (per architecture §-scale).
- **Token mint** p95 < 50ms (JWKS-cached path); p95 < 250ms (JWKS-fetch path).
- **CapabilityStatement boot generation** < 500ms one-time at startup.

### 9.8 Fixtures

- **R4 golden fixtures** under `packages/fhir/test/fixtures/r4/{resource_type}/`: per resource a `domain-input.json` + `expected-output.json` pair plus a US-Core-profile assertion file. New DiagnosticReport / Practitioner golden fixtures: `lab-cbc-non-sud.json`, `lab-methadone-sud-redacted.json`, `lab-critical-flag.json`, `practitioner-nppes-active.json`, `practitioner-nppes-deactivated.json`. Each golden is byte-compared in CI; intentional changes to the projection require updating the golden.
- **Tenant fixture** with two organizations, one tenant FHIR config each, two FHIR clients each (one SMART, one API key), two bulk-export jobs each, two inbound proposals each.
- **Patient fixture** with one SUD-flagged patient and one non-SUD; one consent for each per the M39 consent fixture catalog.
- **Capability fixture** the deterministic boot-generated CapabilityStatement for the test release tag.

### 9.9 Cross-Module Assertion Tests

- M28 does not import M11 or M29 schemas (cruiser check).
- M28 consumes `LabObservationReader` exclusively for lab data.
- The CapabilityStatement regenerated on M28 boot includes `DiagnosticReport` in the resource list and the two Practitioner extension URIs.

### 9.10 Forward-Stub Test

- Until M11's lab-results path lands, the `LabObservationReader` seam may be a deny-stub; if so, the DiagnosticReport routes return `503 Service Unavailable` with `OperationOutcome` rather than the default `404`. The 503 messaging is "Lab data unavailable: M29 LabObservationReader not registered."

## 10. Implementation Tasks

| # | Task | Size | Depends on | Owner |
|---|------|------|------------|-------|
| 1 | `packages/fhir/src/interfaces/*` — FhirMapper + FhirSearchTranslator + projection types | S | — | FHIR architect |
| 2 | `packages/fhir/src/r4/mappers/*` — Phase-1 v1 resource mappers + Coverage + RelatedPerson + Binary + Consent + List | L | 1, consumed seams | FHIR engineer |
| 3 | `packages/fhir/src/r4/search/*` — translator + parameters + cursor (HMAC-signed) + include resolver | L | 1 | FHIR engineer |
| 4 | `packages/fhir/src/r4/operations/everything.ts` — $everything with 5k cap + consent gate per resource | M | 2, 3, M39 ConsentEvaluator | FHIR engineer |
| 5 | `packages/fhir/src/r4/operations/export.ts` — $export request validation + envelope sha256 dedup + BullMQ enqueue | M | 2, M1 queue adapter | FHIR engineer |
| 6 | `packages/fhir/src/r4/operations/expand.ts` + `validate-code.ts` — M38 delegation | S | M38 TerminologyProvider | FHIR engineer |
| 7 | `packages/fhir/src/r4/provenance/composer.ts` — read-time Provenance composition (D10) | M | M22 ExtractionProvenanceReader | FHIR engineer |
| 8 | `packages/fhir/src/r4/narrative/deterministic.ts` — text.div builder (no AI) | S | 2 | FHIR engineer |
| 9 | `packages/fhir/src/r5/`, `r6/` — compile-shells with 415 routes (D1) | S | 1 | FHIR engineer |
| 10 | `packages/fhir/src/auth/smart-backend-services.ts` — client_assertion verify + token mint | M | M1 cache adapter | Auth engineer |
| 11 | `packages/fhir/src/auth/api-key.ts` — API-key kind validate (per-tenant DEK-decrypt + sha256 match) | S | 10, M1 DEK helper | Auth engineer |
| 12 | `packages/fhir/src/auth/scopes.ts` — SUPPORTED_SCOPES constant + scope-set matcher | S | — | Auth engineer |
| 13 | `packages/fhir/src/auth/jwks-cache.ts` — 5-minute JWKS cache with rotation pickup | S | 10 | Auth engineer |
| 14 | `packages/fhir/src/auth/well-known-config.ts` — `/fhir/.well-known/smart-configuration` builder | S | 10 | Auth engineer |
| 15 | `packages/fhir/src/consent/egress-gate.ts` — per-resource ConsentEvaluator consult | S | M39 ConsentEvaluator | FHIR engineer |
| 16 | `packages/fhir/src/rate-limit/valkey-sliding-window.ts` — tier-based RPS + bulk concurrency | S | M1 cache adapter | FHIR engineer |
| 17 | `packages/fhir/src/ai-block.ts` — `validateFhirAIBlock()` runs at boot (D14) | S | M32 prompt registry | FHIR engineer |
| 18 | `packages/fhir/src/seams.ts` — FhirGatewayMetricsProvider + FhirClientReader + FhirInboundProposalReader types | S | — | FHIR architect |
| 19 | `packages/db/src/schema/fhir/*` — Drizzle schema for the 8 owned tables + enums | M | M4 partition manager, M4 audit denylist generator | DB engineer |
| 20 | `0028_fhir_gateway.sql` — migration phases A–F | M | 19 | DB engineer |
| 21 | RLS policies (§3.5) + write-audit triggers (§3.6) + `eraseFn` (§3.7) | M | 19 | Security engineer |
| 22 | `apps/backend/src/modules/28-fhir/routes/*` — every route in §4.1 | L | 2–17 | Backend engineer |
| 23 | `apps/backend/src/modules/28-fhir/routes/admin/*` — admin routes 23–39 | L | 22 | Backend engineer |
| 24 | `apps/backend/src/modules/28-fhir/services/bulk-export-worker.ts` — BullMQ worker | M | 5, M1 storage adapter | Backend engineer |
| 25 | `apps/backend/src/modules/28-fhir/services/inbound-sla-watch.ts` — BullMQ SLA watcher | S | 22 | Backend engineer |
| 26 | `apps/backend/src/modules/28-fhir/services/bulk-export-sweeper.ts` — 24h expiry sweeper | S | 24 | Backend engineer |
| 27 | `apps/backend/src/modules/28-fhir/services/capability-snapshot-builder.ts` — boot-time generator | M | 22 | Backend engineer |
| 28 | `apps/backend/src/modules/28-fhir/services/fhir-client-reader.ts` + `fhir-gateway-metrics-provider.ts` + `fhir-inbound-proposal-reader.ts` — implements the three published seams | M | 19 | Backend engineer |
| 29 | `apps/backend/src/modules/28-fhir/boot.ts` — register seams, predicates, eraser, run validateFhirAIBlock | S | 17, 18, 21, 28 | Backend engineer |
| 30 | `apps/frontend/src/modules/28-fhir/*` — admin web screens (§5.1) | L | 23 | Frontend engineer |
| 31 | Unit + integration + RLS + IDOR + security + E2E + perf tests (§9) | L | 1–30 | QA |
| 32 | Documentation: `/docs/fhir/` operator guide + consumer-onboarding guide + SMART Backend Services walk-through | M | 22, 23 | Tech writer |
| 33 | Apply manifest patch (§13) — update `M28.dependsOn` in `module-manifest.ts` and run `bun run arch:fitness` | S | 29 | FHIR architect |
| **T-M28-22** | `DiagnosticReport` mapper + child Observation projector + SUD redaction applier | M | None | FHIR engineer |
| **T-M28-23** | Practitioner mapper extension — add two NPPES extensions; update CapabilityStatement generator to document them (`packages/fhir/src/r4/mappers/practitioner/projector.ts`; `packages/fhir/src/capability-statement/generator.ts`) | S | None | FHIR engineer |
| **T-M28-24** | Cache invalidation consumers for the M11 lab-results events + M40 `mdm.physician_deactivated`; consumer registration at M28 boot (`apps/backend/src/modules/28-fhir/consumers/cache-invalidation.ts`; M28 boot extension) | S | None | Backend engineer |
| **T-M28-25** | Tests at lock-grade per §9 — unit (~95% on mappers), integration (W-FHIR-13 through W-FHIR-16), golden fixtures, cruiser assertions, forward-stub behavior (`packages/fhir/src/r4/mappers/diagnostic-report/__tests__/*.test.ts`; `packages/fhir/src/r4/mappers/practitioner/__tests__/*.test.ts`; `test/integration/m28/*.test.ts`) | M | T-M28-22, T-M28-23, T-M28-24 | QA |

Sequencing: T-M28-22, T-M28-23, T-M28-24 in parallel → T-M28-25.


## 11. Resolved Decisions

| # | Decision | Rationale | Alternatives considered | References |
|---|----------|-----------|-------------------------|-----------|
| **D1** | **Phase 1 ships R4 read+write; R5 / R6 are compile-shells.** R5 / R6 mappers exist at `packages/fhir/r5/`, `r6/` with `README` stating "ships at R5/R6 lock"; routes return `415 Unsupported Media Type` + OperationOutcome. `ServiceRequest` (M11 non-medication orders), `QuestionnaireResponse` (M9 discipline assessments), `Claim` / `ClaimResponse` / `ExplanationOfBenefit` (M23), bereavement `CarePlan` (M16), `Location` are Phase-2; routes return `404 Not Found` + OperationOutcome. | R4 is the production target for US Core 6.0 — the IG version every consumer (state HIE, payer interop, hospital) expects. R5 adoption is sparse (early 2026); R6 is unpublished. Phase 1 scope matches architecture §I. | (a) Ship R5 mappers Phase 1 — premature; few consumers ready. (b) Ship all resource types Phase 1 — bloats scope without payback; the §-architecture phasing groups these correctly. | §1.1, §1.2, §4.1, §4.5 |
| **D2** | **Authentication: SMART-on-FHIR Backend Services (asymmetric JWT against per-client JWKS) for system clients; API key for trusted infrastructure integrations; no SMART user-launch in Phase 1.** Token TTL 15 minutes; JWKS cache TTL 5 minutes; `client_assertion` JTI replay-prevented via M1 idempotency middleware. | The Backend Services flow is the production-grade system-to-system FHIR auth that every modern interop consumer (Epic, Cerner, ONC certification testing) expects. API key is the operationally simpler alternative for trusted-infrastructure integrations where JWKS infrastructure isn't available. SMART user-launch is patient-facing and gated by M31 Portal. | (a) Basic auth — insecure; ONC-disqualifying. (b) mTLS only — operationally complex; not the §-architecture standard. (c) SMART user-launch only — wrong shape for system clients which are the Phase-1 audience. | §1.1, §1.3, §4.1, §8.3 |
| **D3** | **42 CFR Part 2 SUD redaction at egress, default-on, per-resource consult through M39's `ConsentEvaluator.evaluateForDisclosure(patientId, recipientClientId, asOf)`.** Per-resource (not per-job) so that a consent revocation that arrives between job-enqueue and worker-pickup is honored. The `OperationOutcome` returned on a redaction-induced empty Bundle includes `issue.severity='warning'` with the regulatory-basis explanation so the consumer can request consent rather than misinterpreting the empty Bundle as "no data." | The §J architecture standard for 42 CFR Part 2 + the §4001 information-blocking posture both require this: default-redact for safety, explicit-warn so the consumer knows the data exists and how to obtain access. | (a) Per-client opt-in to SUD content — too coarse; a consent for one recipient bleeds to all. (b) Filter at storage layer — wrong architectural layer; storage doesn't know the recipient. (c) Return 403 instead of warning — misleads consumer about what's available with consent. | §1.1, §1.3, §4.4, §7.3, §8.2 |
| **D4** | **Bulk export: asynchronous NDJSON to MinIO via BullMQ `fhir.bulk-export` queue; one NDJSON file per resource type at `tenants/<org>/fhir-exports/<job_id>/{resource_type}.ndjson`; presigned download URLs at 15-minute TTL minted at poll time; job expires at 24 hours; per-client concurrency cap 1.** Conforms to FHIR Bulk Data 2.0.0: 202 + Content-Location, X-Progress on poll, FHIR-spec output[] manifest on completion. | This is the only economical pattern for hospice-scale exports (a tenant with 5,000 admissions × 4 years of clinical history is hundreds of MB to GB per resource type). Sync would either timeout or block the gateway. The 24-hour TTL balances "consumer has time to retry" against "PHI does not linger." The presigned-URL-at-poll-time avoids long-lived URLs in the audit trail. | (a) Sync $export — does not scale. (b) S3-presigned URL for the duration of the job — extends PHI lifetime unnecessarily. (c) Stream NDJSON over HTTP without intermediate storage — fails on consumer-side network blips; not resumable. | §1.1, §4.1, §4.8, §7.4 |
| **D5** | **`Patient/$everything` scope = Patient + all clinical resources linked to the patient within the requesting client's authorization horizon, minus 42 CFR Part 2 redacted content, capped at 5,000 resources per call; above the cap return OperationOutcome recommending bulk export.** Includes `Provenance` only when `?_include=Resource:provenance` is set; otherwise excluded from default scope per cardinality concerns. | This is the FHIR-spec-conforming interpretation of `$everything` that doesn't surprise the consumer. The 5k cap is a balance between completeness and request latency (per §9.7 the p99 is < 5s at 5k); the bulk-export fallback path exists for the >5k case. | (a) No cap — DoS risk; some patients with multi-year histories blow through any reasonable resource budget. (b) 1k cap — incomplete for hospice-typical patients with 100s of encounters. (c) Always include Provenance — high cardinality; doubles the typical resource count. | §1.1, §4.1, §7.4 |
| **D6** | **Search parameter implementation: US Core 6.0 mandatory set per resource, encoded in `packages/fhir/src/r4/search/parameters.ts` as a typed catalog; the `FhirSearchTranslator` translates FHIR search syntax into typed reader-seam calls; NO SQL is built inside M28; unsupported parameters return 400 with OperationOutcome.issue.code='not-supported'.** | The US Core 6.0 mandatory set is the conformance bar consumers will test against; the typed-translator design is the architecture §25.15 "boundary check 5" applied to the interop layer: no module reads PHI tables it does not own except through reader seams. | (a) Free-form search with dynamic SQL — security and tenant-isolation risk. (b) Implement every FHIR search parameter — vast scope; little consumer demand beyond US Core. (c) Hand-roll per-route searches — duplicates the seam-call logic everywhere. | §1.1, §4.5, §9.1 |
| **D7** | **FHIR version negotiation via the Accept header.** Default R4 at `application/fhir+json; fhirVersion=4.0.1`. R5 / R6 routes return `415 Unsupported Media Type` + OperationOutcome with `issue.diagnostics='Phase-2'`. | The FHIR-spec-conforming pattern for multi-version gateways. The 415 response is the correct semantics for "I do not yet speak this dialect." | (a) URL path versioning only (`/fhir/r4/...`, `/fhir/r5/...`) — already the path-level convention; Accept header is the content-negotiation layer. (b) Always return R4 regardless of Accept — breaks consumers who explicitly request R5. | §1.1, §4.1, §7.7 |
| **D8** | **Inbound FHIR import is propose-then-review.** Inbound POST stages a `fhir_inbound_resource` row with `proposal_status='pending'`; the owner module's reviewer (M5 for Patient, M12 for MedicationStatement) accepts or rejects; only the owner module writes to its native tables on acceptance. The `ABAC fhir_inbound_owner_module_match` predicate enforces that reviewers cannot cross-accept; the idempotency key `(source_client_id, resource_type, source_fhir_id)` prevents duplicate proposals. | This is the architecture §25.15 "no cross-schema imports" rule applied to inbound interop. The interop layer must not write to M5/M12 tables directly; doing so would re-introduce the "interop touches everything" anti-pattern. Propose-then-review also gives the owner module's clinical-safety logic (M5's matcher, M12's reconciliation logic) a chance to apply. | (a) Blind-write on inbound — bypasses owner-module clinical logic; can corrupt the patient match-graph. (b) Reject all inbound — closes the bidirectional interop posture; loses ADT-source demographics. (c) Per-resource auto-accept with operator audit — opens a write path that doesn't honor M5's match-review workflow. | §1.1, §4.1, §7.5, §7.6 |
| **D9** | **Identifier system URI scheme: platform-owned URIs at `https://fhir.wardenx.com/sid/{system}` and per-tenant URIs at `https://fhir.<tenant-fhir-host>/sid/{system}` resolved via the `tenant_fhir_config` row.** Platform-owned URIs cover canonical identifiers (NPI, NDC, RxNorm) shared across tenants; per-tenant URIs cover tenant-private identifiers (MRN, internal patient ids). | The FHIR-spec convention for URIs requires stable, dereferenceable bases. Splitting platform-shared vs per-tenant keeps cross-tenant identifier collisions impossible (no tenant can mint URIs that resolve to another tenant's namespace) while letting platform identifiers be globally stable. | (a) Single platform URI — cross-tenant MRN collisions become possible. (b) Per-tenant URIs for everything including NPI — duplicates the NPI registry per tenant. (c) UUID URIs (`urn:uuid:...`) — non-dereferenceable; defeats the FHIR conformance pattern. | §1.1, §3.3, §4.5 |
| **D10** | **`Provenance` is a read-time composition, not a stored row.** Composed from M22's `ExtractionProvenanceReader` (DocLens-derived chart fields), M8's encounter-signature trail, M11/M12/M13's order/medication/administration-signature trails. Emitted only when `?_include=Resource:provenance` or `_revinclude=Provenance:target` is present. | Provenance is meta-data about every other resource; persisting it would duplicate the upstream signature trails M22 / M8 / M11–M13 already own. Read-time composition keeps the source-of-truth single and lets the composer evolve without database migrations. | (a) Persistent Provenance table — duplicates upstream signature data; risks drift. (b) Always include Provenance in every response — high cardinality; doubles resource counts. (c) No Provenance at all — fails ONC HTI-1 DSI transparency for AI-augmented content. | §1.1, §4.5, §8.3 |
| **D11** | **`CapabilityStatement` is generated at boot from the route registry + the seam catalog; the platform-singleton `fhir_capability_snapshot` row holds the JSON + a HMAC-SHA256 signed checksum; the `/fhir/r4/metadata` endpoint returns the snapshot; the hourly validator detects tampering.** | The CapabilityStatement is the conformance contract; it must be deterministic and verifiable. Generation from the registry prevents drift between "what the gateway advertises" and "what the gateway implements." Signing the checksum lets a §164.528 record reference the conformance posture at the time of disclosure. | (a) Hand-edited JSON in a config file — drift; missed updates when new routes land. (b) Generate at every metadata request — wasted compute; the answer doesn't change without a redeploy. (c) Unsigned snapshot — no way to detect post-deploy tampering. | §1.1, §3.3, §4.1, §7.9 |
| **D12** | **Per-recipient `fhir_client` registry; dual-approval (Org Admin proposes; Compliance Officer co-approves with a distinct membership); BAA contract reference required at approval; client revocation cascades to active sessions + bulk-export jobs.** | Two-person control on FHIR client onboarding is the survey-defense for "every recipient of PHI has a documented BAA and a compliance-officer sign-off." The cascade on revocation ensures a misbehaving client cannot continue to read data through stale sessions or finish in-flight bulk exports. | (a) Single-approver onboarding — fails dual-control; survey weakness. (b) No cascade on revoke — leaves stale tokens active for 15 min after revocation. (c) Per-tenant single FHIR client — too coarse; can't differentiate state HIE from referring hospital from research partner. | §1.1, §4.1, §7.1, §7.12 |
| **D13** | **Cursor-based pagination via `Bundle.link.relation='next'` with HMAC-SHA256-signed opaque cursor; default page size 50, max 500; no offset-based pagination.** Cursor payload contains the last resource's `id` + `meta.lastUpdated` + signed with the per-tenant `cursor_signing_key`. | Offset-based pagination is broken under concurrent writes (the offsets shift); cursor-based is stable. HMAC-signing prevents cursor forgery and cross-tenant cursor use. Per-tenant signing key (per D9 tenant_fhir_config) ensures tenant isolation at the cursor layer. | (a) Offset pagination — stability-broken; FHIR-spec discourages. (b) Plaintext cursor — forgeable; allows cross-tenant data access. (c) Server-side cursor session storage — adds state; cursor expiration semantics complex. | §1.1, §4.5, §7.10, §8.3 |
| **D14** | **AI-prohibited zone for FHIR: Module 32's LLM may not synthesize, modify, redact, or decide on FHIR resources.** `validateFhirAIBlock()` runs at boot against M32's prompt registry; a violation aborts startup. Mirrors M12 D12 / M13 D15 / M22 D-pattern. | FHIR projections must be deterministic for survey reproducibility and consumer trust. Allowing AI rewrites at egress would mean the disclosure record could not be reproduced (the LLM's output is non-deterministic). The boot validator is the architecture §-fitness pattern. | (a) No restriction — risks non-deterministic FHIR output; consumer trust collapses; survey-defense fails. (b) Per-resource AI opt-in (e.g., generate `text.div` via LLM) — partial determinism is no better than none for the disclosure record. (c) Allow AI but log the prompt — moves the problem to audit-storage cardinality without solving determinism. | §1.1, §1.2, §4.3, §7.11, §8.6 |
| **D15** | **`auditRead()` on every FHIR read (GET resource, search, $everything, $export, $expand, $validate-code).** The audit envelope carries the typed query (resource type, parameters, _include, _revinclude, _count), the result count, the consuming `fhir_client_id`, the requesting IP, the user-agent, and the request id. Retention class `compliance`. | HIPAA §164.528 requires the covered entity to enumerate disclosures of PHI to a patient on request for up to 6 years; the audit trail per disclosure is the survey-defense evidence. Without this, the §164.528 workflow has no source data. | (a) Audit only on PHI-bearing reads — misses the disclosure-accounting requirement for searches that return zero results (the search itself is a disclosure attempt that must be recorded). (b) Audit only at request entry — loses the result-count signal. (c) Audit at bulk-export job-completion only — misses the per-search-call disclosures. | §1.1, §1.3, §4.1, §2.4 |
| **D16** | **Tier-based rate limits via Valkey sliding window: tier-1 100 RPS, tier-2 10 RPS, tier-3 1 RPS per client; per-client bulk-export concurrency cap 1.** Platform-floor / tenant-tighten-only semantics: tenants may lower a client's rate limit but never raise it above the tier ceiling. | Different consumers have different burst patterns: a state HIE doing nightly bulk ingest is tier-1; a referral partner is tier-2; a research client is tier-3. The tier ceiling is the platform-defense against any single client overwhelming the gateway; the tighten-only semantics let tenants further restrict noisy clients. | (a) No rate limiting — DoS risk; one misbehaving client takes down the gateway for all. (b) Per-tenant rate limit — too coarse; doesn't distinguish trusted state HIE from research partner. (c) Always tier-2 — too restrictive for trusted partners. | §1.1, §4.1, §7.8, §8.3 |
| **D17** | **Published M28 seams: `FhirGatewayMetricsProvider` (M30 / M33 / M35 consumption), `FhirClientReader` (M34 consumption), `FhirInboundProposalReader` (M5 / M12 consumption).** Registered at boot via M1 seam registry; `validateSeams()` refuses startup if unregistered. Dependency-cruiser boundary check blocks consumers from importing `packages/db/src/schema/fhir-*` directly. | The M11 D14 / M12 D17 / M13 D16 / M22 / M27 D-pattern. Typed seams decouple data-owner from data-consumers; forward consumers attach when they lock without M28 needing redesign; the boundary check makes accidental schema imports unmergeable. | (a) Each consumer imports M28 schema — fragile to internal refactors; M28's internal schema becomes effectively external API. (b) Each consumer calls M28 admin HTTP routes — partial-failure surface; serialization overhead. | §1.1, §4.3, §4.4 |
| **D18** | **Manifest patch: `M28.dependsOn` from `[5, 6, 7, 8, 11, 12, 13, 38, 40]` to `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 22, 23, 29, 36, 38, 39, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)*.** Adds foundation deps (1–4), the assessment / HOPE / discipline-plan / documents / messaging / consent / Phase-2-billing-forward-seam deps. | The M11 / M12 / M13 / M22 lock established the precedent that every module surfaces *all* its declared imports in `dependsOn`, including foundation and cross-cutting. M28 follows. The architecture §20 short-list omits foundation and cross-cutting transitively; the manifest must surface them. | (a) Keep the original `[5, 6, 7, 8, 11, 12, 13, 38, 40]` — leaves foundation imports invisible to the dependency-cruiser fitness check, which then can't enforce boundaries. (b) Include only the seams that physically import — same problem. (c) Include every transitive dep recursively — bloats the graph beyond intent. | §1.1, §13 |
| **D19** | **The FHIR `DiagnosticReport` is composed at read time from three sources: (a) the M11 `order_record` (read via `OrderProvider.findOrder`) provides the report metadata — `code` from the order's LOINC, `subject` from the patient, `performer` from the ordering provider, `effectivePeriod.start` from the order's `signed_at`, `effectivePeriod.end` from the M29 observation's `attached_at`; (b) the M29 `lab_observation` (read via the `LabObservationReader` consumed seam) provides the result values and abnormal/critical flags; (c) the M40 facility (read via `FacilityReader`) provides the `Performer Organization` reference. Each value in `lab_observation.values[]` projects to a child FHIR `Observation`; the `DiagnosticReport.result[]` is an array of `Reference(Observation/<observation-id>:<value-index>)` entries. The child `Observation.code` is the per-value LOINC; `Observation.valueQuantity` carries the numeric value with `unit` and `referenceRange`. Critical flags surface as `Observation.interpretation[].coding[].code='HH'|'LL'|'AA'`. The mapping is purely structural — no clinical inference, no value transformation. The DiagnosticReport URL `id` is the M11 `order_record.id`; the child Observation URLs use a synthetic ID format `<observation-id>--<value-index>` so distinct values within one observation get distinct IDs without collision.** | The composition-from-multiple-sources pattern matches D10 (`Provenance` is composed from upstream signature trails). The `id` choice intentionally exposes the M11 order ID rather than the M29 observation ID — FHIR consumers identify reports by the test order, not the lab system's internal observation ID. The synthetic child Observation IDs keep the projections distinct per-value while preserving deterministic re-projection (a re-read at the same `asOf` produces byte-identical Observation IDs). | (a) Persist a `diagnostic_report` row on M28's side — violates the §1.2 "persist no clinical resource" rule; the source-of-truth stays in M11 + M29. (b) Use the M29 observation ID as the report `id` — leaks the lab system's internal ID and breaks the "consumers identify reports by order" expectation. (c) Top-level Observations referenced by URL instead of `contained` — cleaner `_include` semantics but multiplies the resource count in `$everything`; deferred to a future benchmark. | §1.1, §4.11, §7.13, §7.14 |
| **D20** | **SUD redaction at DiagnosticReport granularity is whole-report redaction. When ANY child observation has `sud_redaction_status != 'not_applicable'`, the entire DiagnosticReport `result[]` is replaced with a single placeholder `Observation` reference. The placeholder has: `code.text = "SUD-protected results"`, `status = 'final'`, `dataAbsentReason.coding[].code = 'temp-unknown'`, `dataAbsentReason.coding[].system = 'http://terminology.hl7.org/CodeSystem/data-absent-reason'`, `note[].text = "Results subject to 42 CFR Part 2 protections. To view values, request an unredact grant via the SUD Disclosure workflow at the source EHR."`. The DiagnosticReport's own `conclusion` field is also cleared. The decision to whole-report-redact (rather than per-value-redact) follows the M22 v0.3 D20 precedent — a partial redaction where some values render and others are placeholder makes the SUD result inferable by exclusion. The Bundle entry's `meta.security` includes the FHIR-standard `R` (restricted) security label so consumers know the data was processed by a Part 2 filter.** | If a CBC panel returns three results and one (e.g., a methadone screen co-ordered with the CBC) is SUD-class, showing the two non-SUD values while hiding the third leaks "there was a third hidden value." Whole-report redaction with the explicit `dataAbsentReason='temp-unknown'` + 42 CFR Part 2 banner is the privacy-preserving choice. The security label is standard FHIR — consumers conforming to FHIR security guidance correctly handle it. | (a) Per-value redaction — leaks the SUD result by exclusion. (b) Return 404 for the whole report — misleads the consumer; the report exists. (c) Omit the security label — consumers can't distinguish a Part-2-filtered report from a partially-populated one. | §1.1, §1.3, §4.11, §7.15, §8.3 |
| **D21** | **Practitioner FHIR extensions: `http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-last-synced-at` (Practitioner.extension[].valueDateTime) carries the `external_physician.nppes_provenance.lastSyncedAt` from M40; ALWAYS included when the source has it. `http://wardenx.com/fhir/StructureDefinition/practitioner-nppes-deactivated-at` (Practitioner.extension[].valueDateTime) is included WHEN `external_physician.status='deactivated'` AND `external_physician.deactivated_at IS NOT NULL`; when the practitioner is deactivated, `Practitioner.active = false` (FHIR-standard mapping). The extensions are documented in M28's CapabilityStatement per D11; the CapabilityStatement regeneration on M28 boot publishes the extensions to consumers. The extension URIs are wardenx-owned; a future revision may consider whether to retire them in favor of a forthcoming HL7 nascent Standard if one matures.** | NPPES staleness is operationally significant for partner-lab CDS hooks that need to refuse orders from deactivated NPIs. The FHIR-standard `Practitioner.active` field handles the binary "is this practitioner valid right now"; the v0.3 extensions add the temporal context ("when was the data refreshed; when was the deactivation detected"). Wardenx-owned extension URIs are appropriate because (a) no standard HL7 extension exists, (b) the URIs are documented in our CapabilityStatement, (c) consumers that don't recognize them ignore them per FHIR processing rules. | (a) Surface only `Practitioner.active` — loses the temporal staleness context partner-lab CDS hooks need. (b) Put the NPPES timestamps in `meta.lastUpdated` — conflates resource-projection time with NPPES-sync time. (c) Use a non-documented extension URI — consumers can't reason about the semantics. | §1.1, §4.12, §7.16 |
| **D22** | **The M11 lab-results outbox events `m11.order.results_received`, `m11.order.results_received_critical`, `m11.order.transmission_status_changed`, `m11.order.transmission_terminal_failed`, `m11.order.results_overdue` are all consumed by M28's `m28.fhir-cache-invalidation` consumer. The consumer invalidates the Valkey cache keys: (a) `DiagnosticReport/{orderId}` (always), (b) `Patient/{patientId}/$everything` (always — the order's patient), (c) `ServiceRequest/{orderId}` if the Phase-2 ServiceRequest mapper is enabled (currently 404 per the phase boundary; consumer is wired today for forward-compat). The `mdm.physician_deactivated` event from M40 invalidates `Practitioner/{mdmId}` and `PractitionerRole/{mdmId}`. The consumer doesn't trigger any FHIR projection — it just invalidates; the next FHIR read recomputes from authoritative source. The invalidation is per-tenant — cross-tenant cache pollution is impossible because the cache key already includes `organization_id` per §4.13.** | §1.2 ("Persist clinical resources") establishes that M28 stores no clinical PHI; the cache is a read-time optimization, not authoritative. The right reaction to upstream-data-changed events is invalidation, not projection — projection happens on read. The cache key always includes `organization_id`, so the M11 event's `organizationId` field tells the consumer which tenant's cache to invalidate. | (a) Re-project on the event — wasteful; projection should happen lazily on read. (b) Skip invalidation, rely on the 5-min TTL — serves stale lab results for up to 5 minutes, unacceptable for critical-results. (c) Global cache flush on any event — cross-tenant collateral; the per-key per-tenant invalidation is correct. | §1.2, §2.4, §4.13, §7.13, §7.16 |


## 12. Acceptance Sign-Off Checklist

### Schema
- [ ] All 8 tables (`tenant_fhir_config`, `fhir_client`, `fhir_client_credential`, `fhir_client_session`, `fhir_bulk_export_job`, `fhir_bulk_export_artifact`, `fhir_inbound_resource`, `fhir_capability_snapshot`) created via `0028_fhir_gateway.sql` in the six-phase order (§3.2).
- [ ] All enums per §3.2 Phase A created.
- [ ] `fhir_client_session` monthly-partitioned by `issued_at`; `fhir_inbound_resource` monthly-partitioned by `proposed_at`.
- [ ] RLS policies enabled on every owned table per §3.5; the cross-tenant isolation test (§9.3) green.
- [ ] Write-audit triggers per §3.6; the denylist suppresses `secret_cipher`, `cursor_signing_key_cipher`, `payload` from value_capture.
- [ ] `auditRead()` declarations on every PHI-bearing route per D15.
- [ ] `eraseFn` registered into M4 destruction-cert callback registry per §3.7; the per-table behavior matches the §3.7 table.
- [ ] Critical indexes per §3.4 created.

### Domain & Math
- [ ] Per-entity lifecycle state machines per §2.2 implemented and unit-tested.
- [ ] Validation rules per §2.3 enforced at route handlers; unit tests cover each rule.
- [ ] Side effects per §2.4 emit the right outbox events; integration tests verify each.
- [ ] Concurrency guarantees per §2.5 enforced (BullMQ per-client locks, M1 idempotency, advisory locks); concurrency tests pass.
- [ ] Idempotency keys per §2.6 honored by the M1 middleware on every route in §4.1.

### Routes & Seams
- [ ] All 39 routes in §4.1 implemented with the right permission gates and ABAC predicates.
- [ ] TypeBox validation per §4.2 on every body / query.
- [ ] Three published seams (`FhirGatewayMetricsProvider`, `FhirClientReader`, `FhirInboundProposalReader`) registered at boot per §4.3.
- [ ] `validateSeams()` passes at boot; all consumed seams per §4.4 are required and resolve.
- [ ] `FhirMapper` + `FhirSearchTranslator` contracts per §4.5 stable across mappers; golden fixtures byte-identical.
- [ ] 12 permission keys per §4.6 registered into M3.
- [ ] 6 ABAC predicates per §4.7 registered into M3's named-predicate registry.
- [ ] 7 BullMQ queues per §4.8 wired with the right concurrency caps and idempotency keys.
- [ ] 12 M36 typed-alert envelopes per §4.9 contributed to M36's alert-rule catalog.
- [ ] 13 outbox event types per §4.10 emitted at the right side-effect points.
- [ ] `DiagnosticReport` mapper + child Observation projector + SUD redaction applier per §4.11 all land.
- [ ] `Practitioner` mapper extended with the two NPPES extensions per §4.12; CapabilityStatement regenerated includes them.
- [ ] Cache invalidation consumers for the 5 M11 lab-results events + `mdm.physician_deactivated` per §4.13 registered at boot.
- [ ] `LabObservationReader` seam added to `requireConsumedSeams`; boot fails if M29 doesn't register it.

### Frontend
- [ ] 11 web screens per §5.1 implemented and routed.
- [ ] No mobile (M28 is admin-only) and no portal surface (Phase 2) per §5.2 / §5.3.
- [ ] WCAG 2.1 AA per §5.4 audited green on every admin screen.

### Tests
- [ ] Unit tests ≥ 90% overall, ≥ 95% on `FhirSearchTranslator`, `smart-backend-services`, `bulk-export-worker`, and the DiagnosticReport mappers (§9.1).
- [ ] Integration tests (§9.2) cover the scenarios end-to-end against Testcontainers, including W-FHIR-13 through W-FHIR-16.
- [ ] RLS isolation tests (§9.3) green; two-tenant cross-leak case enumerated.
- [ ] IDOR / layer-independence tests (§9.4) green; cursor forgery + cross-tenant cursor cases enumerated.
- [ ] Security tests (§9.5) green; token replay, scope escalation, SQL-injection-on-search, path-traversal-on-download, HMAC bypass, JWKS rotation attack all covered.
- [ ] E2E (§9.6) Playwright scenarios green: client onboarding, operator-initiated bulk export, inbound proposal review, disclosure accounting, capability viewer.
- [ ] Performance targets (§9.7) met on the load-test rig.
- [ ] Fixtures (§9.8) versioned and CI-checked; golden fixtures match the expected projections byte-for-byte.
- [ ] Cross-module assertion tests (§9.9) green; CapabilityStatement declares `DiagnosticReport` + the two Practitioner extension URIs.
- [ ] W-FHIR-15 response-body-grep test confirms zero methadone value/LOINC occurrences in redacted output.
- [ ] Forward-stub behavior tested (§9.10): if `LabObservationReader` is a deny-stub, DiagnosticReport routes return 503 with OperationOutcome.
- [ ] Cache invalidation tested end-to-end: M11 event → Valkey key deleted → next GET recomputes from source.

### Observability
- [ ] Every route emits a structured log + a Prometheus metric.
- [ ] Per-resource-type read counter, per-client request counter, per-tenant disclosure counter all visible on the M33 dashboard via `FhirGatewayMetricsProvider`.
- [ ] Bulk-export queue depth + worker throughput on the ops dashboard.
- [ ] Inbound-proposal pending count + SLA-p95 on the ops dashboard.

### Consumers (forward seams)
- [ ] **(forward seam)** M30 HQRP consumes `FhirGatewayMetricsProvider.disclosureMetricsForOrg` for the §164.528 scorecard when M30 locks.
- [ ] **(forward seam)** M33 reporting consumes `FhirGatewayMetricsProvider.metricsForOrg` for the operational dashboard when M33 locks.
- [ ] **(forward seam)** M34 SaaS console consumes `FhirClientReader` for the tenant overview when M34 locks.
- [ ] **(forward seam)** M35 subscription billing consumes `FhirGatewayMetricsProvider` for Phase-2 egress metering when M35 locks.
- [ ] **(forward seam)** M5 patient-write consumer of `m28.fhir.inbound.proposed` (owner_module='m5') wired today against the proposal-staging fixture.
- [ ] **(forward seam)** M12 medhx-write consumer of `m28.fhir.inbound.proposed` (owner_module='m12') wired today against the proposal-staging fixture.
- [ ] **(forward seam)** M23 `ClaimReader.fhirProjection` consumed by M28 with Phase-2 routes returning `404` until Phase 2 enables them.

### Cross-Module Sign-Offs
- [ ] **M11 owner** sign-off on the projection's use of `OrderProvider.findOrder` and the `m11.order.results_received` events.
- [ ] **M29 owner** sign-off on the `LabObservationReader` consumed seam contract.
- [ ] **M40 owner** sign-off on the Practitioner NPPES extensions and the `mdm.physician_deactivated` cache invalidation.
- [ ] **M22 owner** sign-off on the SUD redaction parallel to M22 D20 (whole-document/whole-report redaction conservative pattern).
- [ ] **M4 owner** sign-off on the Part 2 retention class auto-tagging for SUD-redacted DiagnosticReport reads.
- [ ] **Compliance officer** sign-off on the W-FHIR-15 acceptance criteria.
- [ ] **Privacy engineer** sign-off on the response-body-grep verification approach.

### Manifest
- [ ] Apply the §13 manifest patch.
- [ ] `bun run arch:fitness` green (dependency-cruiser boundary check + `check-table-ownership.ts`).
- [ ] `validateSeams()` boot gate green.
- [ ] `validateFhirAIBlock()` boot gate green (no prohibited prompts in M32's registry).

## 13. Proposed Manifest Patch (D18)

```diff
--- a/packages/shared/src/module-manifest.ts
+++ b/packages/shared/src/module-manifest.ts
@@ -??,7 +??,7 @@ export const MODULES: ModuleDef[] = [
   { id: 28, name: "FHIR Gateway",
-    codePaths: ["packages/fhir", "apps/backend/src/modules/28-fhir"], dependsOn: [5, 6, 7, 8, 11, 12, 13, 38, 40], ownedTables: [] },
+    codePaths: ["packages/fhir", "apps/backend/src/modules/28-fhir"],
+    dependsOn: [5, 6, 7, 8, 11, 12, 13, 38, 40], // ADR-0005: genuine compile-time edges only; broader relationship inventory is in the "Depends on:" header (seam/outbox/foundation consumers are no-edge per D1/D4) — do not bulk-apply.
+    ownedTables: [
+      "tenant_fhir_config",
+      "fhir_client",
+      "fhir_client_credential",
+      "fhir_client_session",
+      "fhir_bulk_export_job",
+      "fhir_bulk_export_artifact",
+      "fhir_inbound_resource",
+      "fhir_capability_snapshot",
+    ],
+  },
```

**Rationale.** Aligns the manifest with the seam reads M28 performs (M1–M4 foundation/cross-cutting per the M11 / M12 / M13 lock precedent; M5 PatientReader / CaregiverReader / PatientAddressReader / PatientPayerReader; M6 ElectionPeriodReader / CertificationReader / FaceToFaceReader / LevelOfCareReader / AdmissionStatusReader; M7 CarePlanReader / ProblemReader / GoalReader / InterventionReader; M8 SignedEncountersReader / BillableEncounterReader; M9 LatestAssessmentProvider / ScaleSeriesProvider; M10 HopeTimepointProvider; M11 OrderProvider for Phase-2 ServiceRequest + the DiagnosticReport read path; M12 MedicationOrderProvider; M13 MedicationAdministrationProvider / ReconciliationProvider; M15 DisciplinePlanReader; M22 DocumentReader / RenderedDocumentProvider / ExtractionProvenanceReader; M23 ClaimReader.fhirProjection for Phase-2; M29 LabObservationReader for the DiagnosticReport projection; M36 AlertEmitter; M38 TerminologyProvider; M39 ConsentEvaluator; M40 ExternalPhysicianReader / PharmacyReader / FacilityReader / ReferralSourceReader). Adds the 8 owned tables to `ownedTables[]` so `check-table-ownership.ts` recognizes M28 as the rightful owner. The two code paths `packages/fhir` and `apps/backend/src/modules/28-fhir` were already in the manifest pre-lock and are confirmed unchanged.

After applying: `bun run arch:fitness` is green (dependency-cruiser boundary check + `check-table-ownership`). The seam registry validates at boot: M28 publishes `FhirGatewayMetricsProvider`, `FhirClientReader`, `FhirInboundProposalReader`; consumes `PatientReader` + `CaregiverReader` + `PatientAddressReader` + `PatientPayerReader` (from M5), `ElectionPeriodReader` + `CertificationReader` + `FaceToFaceReader` + `LevelOfCareReader` + `AdmissionStatusReader` (from M6), `CarePlanReader` + `ProblemReader` + `GoalReader` + `InterventionReader` (from M7), `SignedEncountersReader` + `BillableEncounterReader` (from M8), `LatestAssessmentProvider` + `ScaleSeriesProvider` (from M9), `HopeTimepointProvider` (from M10), `OrderProvider` (from M11), `MedicationOrderProvider` (from M12), `MedicationAdministrationProvider` + `ReconciliationProvider` (from M13), `DisciplinePlanReader` (from M15), `DocumentReader` + `RenderedDocumentProvider` + `ExtractionProvenanceReader` (from M22), `ClaimReader` (from M23 — forward-seam-wired, Phase-2 routes return 404), `LabObservationReader` (from M29), `AlertEmitter` (from M36), `TerminologyProvider` (from M38), `ConsentEvaluator` (from M39), `ExternalPhysicianReader` + `PharmacyReader` + `FacilityReader` + `ReferralSourceReader` (from M40); M1 / M2 / M3 / M4 are foundational (outbox + identity + permissions + audit) and consumed via M1's standard primitives. M30 / M33 / M34 / M35 are *consumers of* M28 and not in `dependsOn`; they consume M28's reader seams when their own modules lock — the forward-seam pattern.

---

## Document Footer

**Spec version:** v0.4 (Consolidated)
**Spec status:** Locked v0.4 (Consolidated)
**Spec author:** Architecture (Fabrice V. Adjam, FabWebDev)
**Date:** 2026-06-10
**Decisions resolved:** D1 through D22 (22 total)
**Owned tables (8):** `tenant_fhir_config`, `fhir_client`, `fhir_client_credential`, `fhir_client_session`, `fhir_bulk_export_job`, `fhir_bulk_export_artifact`, `fhir_inbound_resource`, `fhir_capability_snapshot`
**Schema migrations:** `0028_fhir_gateway.sql` (8 tables, no new tables/columns introduced for DiagnosticReport, Practitioner NPPES extensions, or cache invalidation — all code-only read-time projections and outbox consumers)
**FHIR resources (Phase 1 v1 set):** `Patient`, `Encounter`, `Observation`, `MedicationRequest`, `MedicationAdministration`, `Condition`, `CarePlan`, `Goal`, `DocumentReference`, `DiagnosticReport` (with child `Observation` projections), `Practitioner`, `PractitionerRole`, `Organization`, `Coverage`, `RelatedPerson`, `Binary`, `Consent`, `List`, `CodeSystem`, `ValueSet`, `CapabilityStatement`, `OperationOutcome`, `Bundle`
**FHIR extensions:** `practitioner-nppes-last-synced-at`, `practitioner-nppes-deactivated-at` (both on Practitioner)
**Operations:** `$everything`, `$export`, `$expand`, `$validate-code`
**Published seams (3):** `FhirGatewayMetricsProvider`, `FhirClientReader`, `FhirInboundProposalReader`
**Outbox consumers (6):** `m11.order.results_received`, `m11.order.results_received_critical`, `m11.order.transmission_status_changed`, `m11.order.transmission_terminal_failed`, `m11.order.results_overdue`, `mdm.physician_deactivated`
**Routes (39 FHIR + admin) + 16 workflow acceptance criteria (W-FHIR-01 through W-FHIR-16) + 33 base implementation tasks + 4 lab/practitioner tasks (T-M28-22 through T-M28-25).**
**Manifest `dependsOn`:** `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 22, 23, 29, 36, 38, 39, 40]`

**Cross-module coordination:**
- M11 (lab orders): consumes 5 outbox events for cache invalidation; reads order data via `OrderProvider`
- M29 (external interfaces): consumes the `LabObservationReader` seam for lab observation data
- M40 (master data management): consumes `mdm.physician_deactivated` for Practitioner cache invalidation; reads NPPES provenance via `ExternalPhysicianReader`
- M22 (document management): the SUD-redaction whole-report pattern (D20) mirrors M22's PDF redaction (M22 D20)
- M4 (audit): retention class `compliance_42cfr_part2` applied to SUD-redacted audit rows
- M1 (foundation): the outbox event registrations land in the outbox event catalog

**Lock status:** All 22 decisions (D1–D22) resolved. Module 28 is buildable now. The following items are expected to complete only when their downstream modules exist and are tracked as forward seams, not open decisions: M30 HQRP §164.528 disclosure scorecard consumes `FhirGatewayMetricsProvider.disclosureMetricsForOrg` when M30 locks; M33 reporting consumes `FhirGatewayMetricsProvider.metricsForOrg` when M33 locks; M34 SaaS console consumes `FhirClientReader` when M34 locks; M35 subscription billing consumes `FhirGatewayMetricsProvider` for Phase-2 egress metering when M35 locks. The Phase-2 routes for `Claim` / `ClaimResponse` / `ExplanationOfBenefit` (M23 forward-seam consumed today; routes return 404), `ServiceRequest` (M11 forward-seam; routes return 404), `QuestionnaireResponse` (M9 forward-seam; routes return 404), bereavement `CarePlan` (M16 forward-seam; routes return 404), and `Location` (Phase 2; routes return 404) are gated by the Phase-1 → Phase-2 boundary per D1; the seam wiring and the 404 envelopes ship now. SMART user-launch (EHR-launch) and SMART refresh tokens are Phase-2 deferred and gated by M31 Portal landing.

**End of Module 28 — FHIR Gateway Specification v0.4 (Consolidated)**






