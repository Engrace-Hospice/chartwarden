# WardenX — Module 29: External Interfaces — Spec v0.4 (Consolidated)

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) are ground truth for as-built behavior. Mechanism choices named here may be superseded — see ADR-0036…0040 and ADR-0030/0032/0035 for the recorded divergences (outbox not Socket.IO, TypeScript not Python sidecars, app-layer AES-256-GCM not pgcrypto, pure transition tables not XState, hand-rolled HTTP hardening not `@fastify/*`, Vite + react-router not TanStack Start).


**Spec status:** Re-locked v0.5 (Phase-3 remediation; supersedes Locked v0.4)

> **Phase-3 remediation (2026-06-11).** **M29-F03 (BLOCKER, S11, ADR-0014 D2):** the
> persist-before-parse ingress ordering is corrected to **persist-after-redact** — SUD/Part-2
> redaction + consent evaluation runs at the wire boundary before any durable write; only the
> **redacted** payload is persisted (refused-ingress SUD frames record an accounting marker with no
> raw bytes). §2.2/§3.3/§8.3 reconciled with D15/W-XI-14 (`hl7_message_inbound` lifecycle, §3.3).
> Outbound HL7 disclosures write the §164.528 record to M4's sink at egress (ADR-0013). (M29-F01 JVM
> sidecar and M29-F02 NPPES ownership are Phase-5/Phase-6 reconciliation items.)
**Owns:** `apps/backend/src/modules/29-external-interfaces` (the manifest's only M29 codePath — the once-planned `packages/hl7-worker` / `packages/nppes-client` extractions were never created; HL7 and NPPES code live module-side, per the module-29-boundary rule)
**Depends on:** 1 (Foundation — `organization`, `withOrgContext`, `withPlatformContext`, `audit()` / `auditRead()` helpers, outbox dispatcher, idempotency middleware, RLS generator, partitioned-table conventions, per-tenant DEK envelope-encryption helper for `external_feed_credential.secret_cipher` and the HL7 raw-message at-rest cipher columns `hl7_message_inbound.payload_cipher` / `hl7_message_outbound.payload_cipher`, BullMQ on Valkey, circuit-breaker and `DegradedError` envelope, the typed `SeamRegistry` with boot validation, the MinIO client with per-tenant bucket scope used only for the rare large-payload HL7 message (>256 KB segment chain — spilled to MinIO with the DB row carrying a presigned-URL pointer per §3.3), the system status event), 2 (Identity — `user`, `membership`, `location`, `organization` consumed for the operator surfaces that approve feed configurations, review inbound ADT proposals, manage NPPES sync runs; SESSION_POLICY step-up enforcement on `external_feed.write`, `external_feed_credential.rotate`, `nppes.sync.trigger_manual`, and `hl7_inbound_proposal.accept` paths per D18; the per-membership credential resolution for the `ExternalInterfacesOperator` and `ComplianceOfficer` session classes that gate the dual-approval feed-onboarding flow), 3 (Authorization — the seventeen permission keys M29 contributes to M3's catalog (§4.6) and the six ABAC predicates `external_feed_organization_scope`, `hl7_inbound_proposal_owner_module_match`, `lab_observation_patient_caseload_or_scope`, `external_feed_compliance_co_approver_distinct`, `nppes_platform_job_caller`, `external_feed_baa_satisfied` registered into M3's named-predicate registry (§4.7); the standard `caseload_or_scope` predicate is consulted on the lab-observation reader routes because lab results are patient-scoped clinical data; the `caseload_or_scope` predicate is **not** consulted on the feed-administration routes which are scoped by `external_feed_organization_scope` plus the operator role gate), 4 (Audit — PHI write-audit trigger generator on the M29-owned tables; **`auditRead()` declaration on every route that surfaces HL7 message content, lab observation values, NPPES provider records, or inbound proposal payloads** because every HL7 message received by M29 is a HIPAA §164.528 *receipt-of-disclosure-event* and every lab observation surfaced to an operator or to M28 for FHIR egress is itself a HIPAA disclosure that requires reproducible accounting per architecture §11.A; retention class `compliance` for `hl7_message_inbound`, `hl7_message_outbound`, `hl7_inbound_proposal`, `lab_observation`, `lab_observation_value`, `lab_observation_inbound_link`, `external_feed`, `external_feed_credential`, `external_feed_health`, `nppes_sync_run` (these rows are *part of* the disclosure-accounting record and a future §164.528 request must reproduce the wire-shape transmitted years later; the data-sharing-agreement obligations with sending hospitals and reference labs likewise mandate audit retention), retention class `operational` for `nppes_provider` (the canonical NPPES record is platform-shared, public-directory data and is rebuildable from a re-sync), `eraseFn` registered into M4's destruction-cert callback registry per §3.7, the encrypted-at-rest credential columns are denylisted from audit value-capture per §3.6, and the HL7 raw payload at-rest cipher is denylisted to its `payload_sha256` digest until the proposal is decided — then either flowed to the owner module via outbox or destruction-erased on rejection), 5 (Patient & Demographics — `PatientReader` consumed via `packages/patient/seams` — never direct schema import — for the deterministic ADT patient-match algorithm (D6) and the lab-result patient-binding back-resolution; the `patient.privacy_flag_snapshot` consulted *transitively* through M39's `ConsentEvaluator` for the SUD redaction at lab ingest (D15) — M29 never reads the M5 privacy flag directly; the `m5.patient.merged → merged_into_id` redirect resolved at every lookup so an inbound ADT for a pre-merge MRN routes to the surviving record; `m5.patient.deceased` consumed via outbox to freeze inbound ADT processing for the decedent and to refuse any post-death A01/A04 events with a typed OperationOutcome; the MBI / SSN encrypted columns are **never** read into a HL7 outbound payload — the outbound ORM `PID-19` field is `null`-projected and the §3.6 denylist enforces this), 11 (Orders — `OrderProvider.activeOrdersForPatient` and `OrderProvider.getOrderByPlacerId` consumed for matching inbound ORU lab-result messages back to the originating M11 lab order (the `OBR-2` placer order number carries the M11 `order_record.id` as the canonical join key per D8); M29 consumes the **`m11.order.hl7_orm_requested` outbox event** as a typed listener — the M11 spec publishes this contract (M11 §4 forward-seam to M29) and M29 wires the live consumer at lock; the typed payload `{orderId, labOrderPayload (PID/ORC/OBR/NTE)}` is mapped 1:1 to the HL7 v2.5.1 ORM^O01 wire shape and dispatched to the destination lab per the `external_feed` configuration matched by `order_record.lab_destination_facility_id` (the M40 Facility id resolved at M11 lock); M29 emits `m29.lab_order.transmitted` / `m29.lab_order.transmission_failed` consumed by M11 to update `order_record.transmission_status`; M29 does not import M11 schema), 22 (Document Management — when an inbound lab observation arrives bearing an attached PDF report (some labs send the human-readable report as a base64-encoded OBX-5 segment of type `^ED^PDF^Base64^...`), M29 emits `m29.document.upload_requested` with the raw PDF bytes and the patient + order back-link; M22 stores the document under retention class `clinical_record` and returns the canonical `document_id` via outbox `m22.document.created`; M29 wires the document_id back onto the `lab_observation.attached_document_id` column via a small `consumers/m22-document-backref.ts` that follows the M22 §1.1 handshake protocol; M29 holds no MinIO code), 27 (Cost Report — **bidirectional read-share** per architecture §11.B and M27 D6: M27 owns `packages/xero-client` and `packages/gusto-client` (the only repo code allowed to import the Xero/Gusto SDKs per the architecture §25.14 adapter mandate); M29 consumes M27's `XeroClientFactory` and `GustoClientFactory` seams for non-cost-report Xero / Gusto uses (Phase-2 AR-sync and payroll-event ingest); both factories yield typed per-tenant clients with M27-managed OAuth refresh so the OAuth refresh token is held in exactly one place per tenant; M29 emits no Xero or Gusto outbox events directly — those flow through the M27-owned packages; M29 does not import M27 schema), 36 (Secure Messaging & Alerts — M29 emits typed alerts (`hl7_feed.listener_down`, `hl7_feed.ack_storm`, `hl7_feed.message_rejected`, `hl7_feed.sender_unauthorized`, `hl7_inbound.proposal_pending`, `hl7_inbound.proposal_overdue`, `hl7_outbound.transmission_failed`, `lab_observation.abnormal_flag_critical`, `lab_observation.unmatched_patient`, `lab_observation.unmatched_order`, `nppes.sync_failed`, `nppes.preferred_physician_deactivated`, `external_feed.baa_expiring`, `external_feed.baa_expired`); M29 owns no out-of-band delivery code — every SMS/email/push path is M36's; M29 publishes no Socket.IO room — operator dashboards subscribe through M36's standard `org:<orgId>` and `provider_entity:<id>` rooms; M29 contributes the `hl7_listener_down_operator` and `abnormal_lab_to_caseload_rn` resolvers M36's alert-rule engine consults for routing), 38 (Clinical Terminology — `TerminologyProvider.validate(loincCode)` and `.lookup({system: 'loinc', code, asOfDate})` consulted on every inbound ORU OBX-3 LOINC code before the observation is persisted; LOINC codes not present in the M38 catalog at the message's `OBR-7` observation date cause the observation to land with `terminology_validation='unknown_code'` and a typed M36 alert routed to the tenant terminology administrator — the observation is *not* dropped, because the lab is authoritative for the test name even when LOINC mapping lags, but downstream FHIR projection and HQRP-derived measures filter on `terminology_validation='valid'`; M38 also consulted at outbound ORM dispatch for the OBR-4 universal service identifier (the HL7 v2.5.1 CWE shape) so the placer-side LOINC matches the lab's expected code; M29 does not import M38 schema), 39 (Consent & Authorization Management — `ConsentEvaluator.evaluateForDisclosure(patientId, recipientClientId, asOf)` is **not** consulted at inbound ingest because inbound is data *arriving at* WardenX (the perimeter ingress, not a disclosure); however `ConsentEvaluator.evaluateForIngressRedaction(patientId, dataClass, asOf)` IS consulted at lab-observation ingest for the 42 CFR Part 2 SUD-test class so a SUD-flagged lab (e.g., urine drug screen ordered for substance-use monitoring) is either persisted under the SUD-redacted classification (default-on per D15) or, if explicit SUD consent is present, persisted without redaction; M29 does not import M39 schema), 40 (Master Data Management — `ExternalPhysicianReader`, `PharmacyReader`, `FacilityReader`, `ReferralSourceReader` consumed for the resolution of HL7 message senders to canonical M40 entities (HL7 `MSH-3` sending application + `MSH-4` sending facility resolved against M40 Facility records per architecture §11.F so an inbound ADT from "MERCY-EPIC" maps to the canonical `Mercy Medical Center` facility record); `FacilityReader.preferredPharmaciesForOrg` consulted at outbound ORM destination resolution; `ExternalPhysicianReader.byNPI` is the public-facing key for NPPES sync write-back (M29 emits `m29.nppes.provider_synced` consumed by M40's NPPES-sync handler to update canonical `external_physician` rows); the M40 `mdm.baaStatus(orgId, kind, id)` BAA gate is consulted before any inbound feed activation **and** before any outbound HL7 dispatch — a feed cannot be activated and an outbound message cannot transmit if the M40 BAA record for the destination is `missing` or `expired` per the M40 D8 disclosure-gate contract; M29 does not import M40 schema)

**Consumed by:** 5 (Patient & Demographics — `m29.hl7_inbound_proposal.accepted` (the as-built name; the once-specced `m29.adt.demographic_update_accepted` was never cataloged) consumed by M5's ADT-derived demographic-update consumer after the M29 propose-then-review accepts an inbound A08; M5 also subscribes to `m29.adt.admission_event` to surface the "incoming patient" signal in the intake workflow when an A01/A04 arrives for a not-yet-WardenX-known patient; M5 does not read M29 schema), 9 (Clinical Assessments Suite — `LabObservationReader.observationsForPatient(patientId, since)` consumed Phase-2 for the M9 lab-trending overlay in the assessment-history surface (e.g., displaying serial CBC values alongside PAINAD scores for a patient whose pain assessment was triggered by an anemia workup); the M9 consumer wires at M9's Phase-2 lock, not at M9's current Phase-1 lock; M9 does not read M29 schema), 11 (Orders — `m29.lab_order.transmitted` / `m29.lab_order.transmission_failed` consumed by M11 to update `order_record.transmission_status` per the M11 outbound-HL7 forward seam; M11 also receives `m29.lab_observation.received` (with order back-link) to flip `order_record.fulfillment_status` to `fulfilled` for `kind='lab'` orders; the relationship is mutual outbox — M29 holds no M11 schema and M11 holds no M29 schema), 28 (FHIR Gateway — `LabObservationReader` consumed for the FHIR `Observation` projection where the `Observation.code` is M38-validated LOINC; the `Observation.basedOn` references the M11 ServiceRequest projection (Phase 2 per M28 D1); the `Observation.derivedFrom` references the source `hl7_message_inbound.id` so a downstream auditor can trace the FHIR resource back through the M28 disclosure-accounting record to the M29 receipt-of-disclosure record; `NppesProviderReader.byNPI` consumed by M28's Practitioner mapper for the canonical-NPI enrichment that lets an external FHIR client receive an authoritative `Practitioner.identifier` with `system='http://hl7.org/fhir/sid/us-npi'` and the canonical NPPES `display` even when the M2 / M40 record carries the per-tenant overlay name; M28 does not read M29 schema), 30 (HQRP & Quality — `ExternalInterfaceMetricsProvider.feedHealthForOrg(orgId, period)` consumed by M30 for the survey-readiness scorecard's "external-data-source connection health" indicator; `LabObservationReader.observationsForPeriod(orgId, period)` consumed for the timely-symptom-management quality dimension where serial lab values support a "timely follow-up to abnormal finding" HOPE-context measure; the M30 consumer wires at M30 lock — forward-seam-deny-stub today; M30 does not read M29 schema), 33 (Reporting & Dashboards — the entire external-interfaces operational dashboard surface: feed uptime, ack/nak rate per feed, inbound proposal review SLA percentile, outbound HL7 transmission success rate, NPPES sync freshness per ProviderEntity, lab abnormal-flag volume per tenant, unmatched-patient queue depth, the per-message-type inbound rate (A01/A03/A04/A08/A11/ORU breakdown); M33 wires at M33 lock using materialized views built from M29 reader projections; the projections ship now), 34 (SaaS Tenant Platform — `ExternalFeedReader.feedsForOrg(orgId)` consumed by the tenant-admin SaaS console for surfacing configured feeds + their BAA / TLS / sender-allowlist posture to the platform-ops "tenant overview" view; the BAA reference identifier on each `external_feed` row is the join key into the M34 contract catalog per the M40 D8 pattern; M34 wires at M34 lock — forward-seam-deny-stub today), 35 (Subscription Billing — Phase-2 inbound HL7 message volume and outbound HL7 transmission count may be metered against the M35 subscription tier; M29 publishes the metering counters via `ExternalInterfaceMetricsProvider`; M35 deny-stub today, real wiring at M35 lock), 37 (Inpatient Unit (IPU) Management — when M37 admits a patient under inpatient general care (GIP) and the IPU is co-located with or partnered with a hospital ED, M37 subscribes to `m29.adt.admission_event` filtered to the IPU's partner facility allowlist so an inpatient admission at the partner hospital surfaces in the IPU's intake worklist; M37 wires at M37 lock — forward-seam-deny-stub today), 40 (Master Data Management — `m29.nppes.provider_synced` consumed by M40's nightly NPPES-sync handler to update canonical `external_physician` rows with the latest NPPES record; `m29.nppes.provider_deactivated` consumed when NPPES marks a provider deactivated (death, license revocation) so M40 can flag tenant overlays that referenced the deactivated provider; M40 does not read M29 schema beyond these outbox events).

## Changelog

- **v0.4 (Consolidated)** — Rolls the v0.2 base and v0.3 delta into a single self-contained specification. No scope change; no decision reversals.

- **v0.3 (Locked)** — Folded in all retroactive corrections accumulated across T-29.02 through T-29.06 PRs. No decisions reversed; no scope changed; the four-pillar Phase-1 cut and all twenty-four D-decisions stand. Corrections by area:
  - **§3.1 sidecar wire-format clarification (from T-29.03):** the parser-sidecar uses **gRPC over Unix Domain Socket**, not JSON-over-HTTP. The §3.1 path comment is corrected. The Java sidecar build uses **Gradle Kotlin DSL** (`build.gradle.kts`) — Maven was the initial guess but the WardenX repo is JS/TS-tooled and adding Maven would duplicate the dependency-resolution channel.
  - **§3.3 schema additions (from T-29.05 + T-29.06):** a new enum `hl7_inbound_match_level` (`L1_MRN_EXACT`, `L2_EXTERNAL_MRN_EXACT`, `L3_SSN_DOB`, `L4_DEMOGRAPHIC_BRIDGE_CANDIDATE`, `L5_LOOSE_NAME_DOB_CANDIDATE`, `NO_MATCH`); seven new columns on `hl7_message_inbound` (`matched_patient_id`, `match_level`, `match_outcome`, `match_confidence`, `cascade_run_ms`, `parsed_segments_cipher`, `parsed_segments_sha256`); two new columns on `lab_observation_inbound_link` (`candidate_patient_id`, `candidate_match_level`); one new value (`new_patient`) on the existing `hl7_inbound_proposal_kind` enum. The cumulative migration plan is `0029_external_interfaces.sql` (T-29.02) → `0030_external_interfaces_cascade.sql` (T-29.05) → `0031_external_interfaces_proposal.sql` (T-29.06).
  - **§3.6 audit denylist extensions (from T-29.05 + T-29.06):** `hl7_message_inbound` denylist gains `parsed_segments_cipher`; per-tenant DEK destruction at eraser run also renders the parsed-segments ciphertext unrecoverable. The `payload_sha256` projection remains in clear for tamper detection.
  - **§4.6 cascade and routing rewrites (from T-29.05 + T-29.06):** the patient-match cascade is **five levels** (L1 internal MRN exact → L2 external MRN exact → L3 SSN-last4 + DOB → L4 exact name + DOB + sex → L5 loose name + DOB); L1-L3 are confident-match candidates, L4-L5 are candidate-match candidates, multiple-hit at L3/L4 is `ambiguous`. The MRN authority is per-tenant via `organization.settings.hl7_internal_mrn_authority`, not a platform constant. Merge-redirect resolution is baked into the cascade up to 3 hops. The routing table for ADT outcomes is **rewritten to propose-then-review for every outcome including confident match** — this aligns §4.6 with D5 (propose-then-review) and W-XI-01 (proposal expected even on L1, patient row not mutated until reviewer accepts). The earlier "L1 auto-applies" wording was an unintended remnant of an earlier design.
  - **§4.10 outbox event catalog additions (from T-29.05 + T-29.06):** nine new events — `m29.hl7_message.cascade_resolved_confident`, `cascade_resolved_candidate`, `cascade_resolved_no_match` (T-29.05); `m29.hl7_message.routing_dropped` (T-29.06 — for A03/A11 no-match drop); `m29.hl7_inbound_proposal.{created,accepted,rejected,discarded,expired}` (T-29.06). The cascade events carry the cascade output for downstream proposal-creator consumption; the proposal events carry the typed payload for M5/M6 owner-module consumption.
  - **§4.11 listener supervisor topology (from T-29.04):** the listener supervisor is a **sibling Node process** to the Fastify HTTP server, not a `cluster.fork()` child. Crash isolation between HTTP serving and HL7 ingest is the goal. The docker-compose definition adds an `hl7-listener` service alongside `backend` and `hl7-sidecar`. The 8MB frame-size DoS guard, the per-feed `MAX_CONCURRENT_CONNECTIONS=16` cap, the 60s socket read timeout, and the in-process semaphore per-feed soft cap (parse worker concurrency = 8 globally, 4 per-feed) are explicit floors.
  - **§13.2 dependency-cruiser rule path correction (from T-29.02):** schema package path is `packages/db/src/schema/external-interfaces`, not `packages/db-schema/src/external_interfaces`. Two cruiser rules updated in-place. The canonical schema package is `packages/db` per M1 §3.3, M22, and M28 conventions.
  - **§W-XI-* workflow scenarios:** match-level enum values throughout (`L1_MRN_EXACT`, `L4_DEMOGRAPHIC_BRIDGE_CANDIDATE`, etc.) confirmed canonical against the schema enum; loose `'PATIENT_UPDATE'` wording in W-XI-01 normalized to `'patient_demographic_update'`.
  - **§10 implementation tasks acceptance scoping:** T-29.04 acceptance is scoped to "listener through parse-result"; W-XI-01 fully closes only after T-29.06 (proposal lifecycle). The original §10 text implying W-XI-01 closes at T-29.04 was an over-eager dependency promise; corrected here.
  - **PR cross-references** (so future engineers can trace each correction): T-29.01 (`WARDENX_T-29.01_FORWARD_SEAM_DENY_STUBS.md`), T-29.02 (`WARDENX_T-29.02_SCHEMA_PACKAGE.md`), T-29.03 (`WARDENX_T-29.03_HAPI_SIDECAR.md`), T-29.04 (`WARDENX_T-29.04_MLLP_LISTENER.md`), T-29.05 (`WARDENX_T-29.05_PATIENT_MATCH_CASCADE.md`), T-29.06 (`WARDENX_T-29.06_PROPOSAL_LIFECYCLE.md`).
- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all twenty-four open questions into binding decisions (§11). Defines the **four-pillar scope** (HL7 v2 inbound listener, HL7 v2 outbound transmitter, NPPES public-API client + sync platform job, and Xero/Gusto factory consumption from M27 — D1, §1.1), the **HAPI HL7 v2 parser (Java sidecar) with a typed-message-segment registry on the WardenX side** (D2, §3.1), the **MLLP listener topology with port-per-feed and sending-facility allowlist** (D3, §3.1, §8), the **partitioned `hl7_message_inbound` / `hl7_message_outbound` storage with envelope-encrypted raw payload and a sha256 digest projected for audit value-capture** (D4, §3.3, §3.6), the **propose-then-review pattern for inbound ADT mirroring the M28 D8 inbound-FHIR pattern** (D5, §2.2, §7.1), the **deterministic patient-match algorithm with five-level precedence cascade and a manual-match queue for ambiguous cases** (D6, §4.5), the **auto-attach behavior for lab observations with the abnormal-flag-routes-to-caseload-RN alert path** (D7, §2.2, §7.2), the **OBR-2 placer-order-number-keyed back-resolution of ORU to M11 order** (D8, §2.2, §4.4), the **outbound ORM dispatch with per-feed idempotency and the `m11.order.hl7_orm_requested` consumer pattern** (D9, §4.4, §4.10), the **NPPES public-API client with no credentials and the per-provider record cache backed by a nightly platform-job sync** (D10, §3.1, §4.4, §4.8), the **platform-role NPPES sync job consuming `withPlatformContext` and emitting `m29.nppes.provider_synced` outbox events for M40 consumption** (D11, §4.8, §4.10), the **M27-owned Xero/Gusto factory consumption for non-cost-report uses** (D12, §1.1, §4.4), the **HL7 raw-message envelope encryption with payload_sha256 indexed for audit replay** (D13, §3.3, §3.6), the **`(sending_facility_id, message_control_id)` global idempotency on every inbound HL7 message + the M1 standard idempotency middleware on every administrative route** (D14, §2.6, §4.1), the **SUD redaction at lab ingest via `ConsentEvaluator.evaluateForIngressRedaction` with default-on behavior matching M28 D3** (D15, §7.3, §8.2), the **M40 BAA gate consulted on every feed activation and every outbound HL7 dispatch with refuse-on-`missing`-or-`expired`** (D16, §8.3, §7.5), the **per-feed circuit breaker and listener-health telemetry with the M36 `hl7_feed.listener_down` alert path** (D17, §4.8, §7.6), the **step-up auth requirement on `external_feed.write`, `external_feed_credential.rotate`, `nppes.sync.trigger_manual`, and `hl7_inbound_proposal.accept` per M2 SESSION_POLICY** (D18, §6, §7.4), the **PHI-minimization denylist on operational logs covering PID, NK1, IN1, GT1, NTE segments — only segment-presence and segment-byte-count surface to ops dashboards** (D19, §8.4), the **six ABAC predicates M29 contributes to M3's named-predicate registry** (D20, §4.7), the **five published seams (`LabObservationReader`, `Hl7InboundProposalReader`, `ExternalFeedReader`, `NppesProviderReader`, `ExternalInterfaceMetricsProvider`) registered at boot with the typed `SeamRegistry`** (D21, §4.3), the **forward-seam consumers wired today against fixture envelopes for M30 / M33 / M34 / M35 / M37** (D22, §12), the **mutual-TLS posture on every MLLP listener with per-feed channel certificate pinning and per-feed sending-facility IP allowlist** (D23, §8.1), and the **manifest patch expanding `M29.dependsOn` from `[5, 11, 40]` to `[1, 2, 3, 4, 5, 11, 22, 27, 36, 38, 39, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)*, adding owned `packages/hl7-worker` + `packages/nppes-client`, and populating eleven owned tables** (D24, §13). Wires the seventeen permission keys this module registers into M3 (§4.6), the six ABAC predicates (§4.7), the seven BullMQ queue catalog entries (§4.8), the M36 typed-alert payload catalog (§4.9), the outbox event contract (§4.10), and the destruction `eraseFn` registered with M4 (§3.7). Includes the proposed manifest patch (§13) and the architecture-fitness verification path. Phase boundary: the four-pillar Phase-1 cut ships everything in this spec except (a) probabilistic ML patient-matching deferred to Phase 2 per architecture roadmap (deterministic cascade only in Phase 1 — D6 alternative (b)), (b) outbound ADT to HIE deferred to Phase 2 (no HIE consumer in Phase 1), (c) SFTP-based lab feed transport deferred to Phase 2 (MLLP only — the SFTP code path is scaffolded but gated behind a tenant-config feature flag), (d) Xero AR-sync and Gusto payroll-event ingest deferred to Phase 2 (M27 factories consumed today; the AR/payroll handlers ship at Phase 2), and (e) Direct Trust secure messaging deferred to Phase 2 (architecture §10 forward reference). The HL7 inbound listener, HL7 outbound dispatcher, NPPES sync, the M40 BAA gate, and the M27 factory consumption seam are all Phase 1.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 29 is **the single perimeter-ingress and perimeter-egress surface for HL7 v2 message traffic and the public-NPI-directory data source for WardenX.** It is the bidirectional boundary between the WardenX tenant database and the four heterogenous external systems the architecture §11.I designates as M29's responsibility:

**Pillar 1 — HL7 v2 Inbound MLLP Listener (PHI-bearing).** Per-tenant, per-feed MLLP TCP listeners terminate inbound HL7 v2.5.1 messages from sending facilities under a documented data-sharing agreement. Two message families are in scope at Phase 1:

- **ADT messages** (Admit, Discharge, Transfer) — A01 (Admit), A03 (Discharge), A04 (Register outpatient — used by some referring facilities for outpatient hospice referral handoffs), A08 (Update patient information), A11 (Cancel admission). Every inbound ADT is parsed, decoded, audited at the wire level (raw payload envelope-encrypted at rest), patient-matched per the deterministic five-level precedence cascade (D6), and **staged into `hl7_inbound_proposal` for owner-module review** — M29 never writes to M5 patient tables directly. The propose-then-review pattern is the same architecture-fitness check (architecture §25.15 boundary check 5) M28 applies for inbound FHIR.

- **Lab result messages** (ORU^R01) — inbound observation results from reference labs. Lab orders originated in M11 (via the outbound ORM^O01 path below) and the inbound ORU is patient-matched via `OBR-2` (placer order number = M11 `order_record.id`) per D8. Lab results **auto-attach** to the patient chart (no propose-then-review) because the lab is the authoritative source for the test value and a hospice clinician already authorized the order; the auto-attach behavior is bounded by D7's abnormal-flag routing path and D15's SUD-at-ingress redaction.

**Pillar 2 — HL7 v2 Outbound MLLP Transmitter.** Per-feed outbound transmission of:

- **ORM^O01 lab orders** for `kind='lab'` orders signed in M11. M11 publishes the typed payload via outbox `m11.order.hl7_orm_requested` per the M11 forward-seam declaration (M11 §10 task list, the lock checklist item "M29 HL7 ORM outbound consumes `m11.order.hl7_orm_requested` when M29 locks"); M29 consumes the typed payload and dispatches the wire-shape ORM^O01 message to the destination lab over MLLP per the `external_feed` configuration matched by the order's `lab_destination_facility_id`.

- **Outbound ADT** is **Phase 2 deferred** — no consumer in Phase 1; the dispatcher scaffolding ships behind a feature flag.

**Pillar 3 — NPPES Public API Client & Nightly Sync Platform Job.** The NPPES (National Plan and Provider Enumeration System) public REST API is the canonical source for U.S. healthcare provider NPIs and the platform-shared identity record for any `ExternalPhysician` in M40. M29 owns `packages/nppes-client` (the only repo code allowed to import the NPPES API client per the architecture §25.14 adapter mandate) and the platform-role nightly sync job that fetches NPPES update files (the monthly `NPPES Data Dissemination` deactivation files and the daily incremental updates), refreshes the platform-shared `nppes_provider` cache, and emits `m29.nppes.provider_synced` / `m29.nppes.provider_deactivated` outbox events for M40 consumption (M40 owns the canonical `external_physician` write-back; M29 owns only the cache + the sync orchestration). The NPPES API is public-directory data (no PHI, no BAA, no per-tenant credential); the M40 D8 `mdm.baaStatus()` gate is **not** consulted for NPPES because no BAA is required for a public registry.

**Pillar 4 — Xero / Gusto Factory Consumption (the cross-module facade).** Per M27 D6 and architecture §11.B, the Xero and Gusto OAuth adapters are owned by M27 (`packages/xero-client`, `packages/gusto-client`) — these are the *only* repo packages allowed to import the Xero SDK and the Gusto SDK per the architecture §25.14 adapter mandate. M27 publishes `XeroClientFactory` and `GustoClientFactory` seams that yield typed per-tenant clients with shared OAuth-refresh handling. M29 **consumes** these factories for non-cost-report uses (Phase-2 AR-sync, Phase-2 payroll-event ingest); M29 does **not** own the OAuth tokens, does **not** own the Xero/Gusto SDKs, does **not** own the per-tenant connection state — that all lives in M27. The four-pillar grouping in M29 is the architecture §11.I taxonomy ("External Interfaces"); the implementation split honors the architecture §25.14 adapter mandate by routing Xero/Gusto through M27 rather than duplicating refresh state.

Concretely M29 delivers:

- **The `external_feed` table** — per-tenant configuration of each HL7 v2 inbound or outbound feed. Each row carries the feed kind (`adt_inbound` | `lab_inbound` | `orm_outbound`), the MLLP host:port, the sending-facility allowlist (M40 Facility id list), the channel certificate pin, the BAA reference identifier, the active-from / active-through window, the operator approver and the compliance-officer co-approver (the dual-approval pattern from M28 D12), and the per-feed circuit-breaker configuration.

- **The `external_feed_credential` table** — per-feed authentication credentials (MLLP channel TLS client certificate, optional channel password). The secret is envelope-encrypted with the per-tenant DEK; only the `sha256(certificate_pem)` is matched at handshake.

- **The `hl7_message_inbound` and `hl7_message_outbound` tables** — audit-grade record of every HL7 v2 message received or transmitted. Raw wire-bytes are envelope-encrypted at rest; the `payload_sha256` is projected for indexing and audit value-capture; the per-segment summary (segment names + byte counts) is projected for operational diagnostics without exposing PHI to ops dashboards (D19).

- **The `hl7_inbound_proposal` table** — staged ADT events awaiting M5 reviewer accept/reject. One proposal row per ADT event, with the parsed PID demographic candidate, the patient-match outcome (matched / ambiguous / no-match), and the proposal lifecycle (`pending` | `accepted` | `rejected` | `expired`). The propose-then-review pattern mirrors M28 D8.

- **The `lab_observation` and `lab_observation_value` tables** — received lab results, LOINC-coded, patient-bound and order-bound, with per-component values (e.g., a CBC ORU yields one `lab_observation` row with seven `lab_observation_value` rows for WBC/RBC/Hgb/Hct/Plt/MCV/RDW). The abnormal-flag (`H` | `L` | `HH` | `LL` | `A` | `N`) drives the M36 alert path per D7.

- **The `lab_observation_inbound_link` table** — back-link table joining `lab_observation` to its source `hl7_message_inbound` (for audit replay) and to its source `order_record` in M11 (for fulfillment status update). The cross-module FK to `order_record` is **app-side**, never enforced as a DB constraint — preserves the outbox-only-cross-module boundary.

- **The `nppes_provider` table** — platform-shared cache of NPPES records keyed by NPI. Populated by the nightly sync job; never written by tenant operators. Consulted by M5 / M23 / M40 via `NppesProviderReader.byNPI` per the M40 D2 canonical-NPI pattern.

- **The `nppes_sync_run` table** — audit record of every nightly sync (start time, end time, providers fetched, providers updated, providers deactivated, errors). Surfaces in the operator-platform dashboard for sync freshness monitoring.

- **The `external_feed_health` table** — per-feed listener-health rolling metrics (ack count, nak count, byte count, message count, last-message timestamp, listener-up indicator). One row per feed per hour; M33 reads via `ExternalInterfaceMetricsProvider`.

- **The HL7 v2 parser sidecar** — `packages/hl7-worker` wraps the HAPI HL7 v2 Java library in a JVM sidecar process (per the M32 ml-worker sidecar pattern in architecture §12). The TypeScript backend communicates with the parser via typed **gRPC over a Unix Domain Socket** (the JVM is grpc-netty on epoll, no TCP port exposed); the HAPI library is the only Java code in the repo and lives behind the sidecar boundary so the rest of the codebase remains pure TypeScript (D2).

- **The NPPES public-API client** — `packages/nppes-client` wraps the NPPES public REST API (`https://npiregistry.cms.hhs.gov/api/`) with retry, per-second pacing (NPPES throttles), and a typed result shape. The adapter mandate (architecture §25.14) is satisfied because the NPPES API client is imported **only** inside `packages/nppes-client`; no other code anywhere in the repo may construct an HTTP call to the NPPES API surface.

- **The MLLP listener and dispatcher workers** — BullMQ-coordinated workers that own the TCP socket lifecycle, the message framing (`<VT>...<FS><CR>`), the ACK/NAK generation, the inbound message persistence path, and the outbound message transmission path with per-feed concurrency caps and the per-feed circuit breaker.

The module-architectural decision that distinguishes M29 from peer offerings is **the propose-then-review boundary at the perimeter ingress for ADT, combined with the auto-attach-with-redaction-gate boundary for lab results** (D5, D7, D15). Most hospice EHR products either blind-write ADT into the patient table (which corrupts patient match-graphs over time as multiple sending facilities send conflicting demographic updates) or refuse inbound HL7 entirely. M29 stages every ADT for owner-module review — the M5 patient match-and-merge logic runs the same way for an ADT-derived demographic update as for a manually-entered demographic update, and the M5 D8 patient-merge clinical-safety logic is therefore never bypassed by the perimeter ingress. The lab path is auto-attach because the lab is authoritative for the test value and a hospice clinician authorized the order — but the SUD-at-ingress redaction gate (D15) and the abnormal-flag-routes-to-caseload-RN alert path (D7) keep the auto-attach behavior bounded by clinical-safety and 42 CFR Part 2 considerations.

### 1.2 What This Module Does Not Do

- **M29 does not write to M5 patient tables.** Inbound ADT proposals are staged in `hl7_inbound_proposal`; M5's reviewer accepts; M5 writes. The cross-module schema-write boundary is enforced by dependency-cruiser per architecture §25.15.

- **M29 does not own the Xero or Gusto OAuth tokens, the per-tenant connection state, the trial-balance pull, or the wage-data pull.** Those are M27-owned per M27 D6. M29 consumes M27's `XeroClientFactory` / `GustoClientFactory` seams for non-cost-report uses only.

- **M29 does not own the canonical `external_physician` record.** That is M40-owned. M29 owns the `nppes_provider` *cache* of public-directory data; M40 owns the canonical `external_physician` rows with tenant overlay. M29 emits `m29.nppes.provider_synced`; M40 writes.

- **M29 does not own the M11 order or the M11 lab order placer.** M11 owns the order; M29 transmits the order via HL7 ORM. The relationship is M11-publishes-payload, M29-transmits-wire-shape.

- **M29 does not own the FHIR `Observation` projection of lab results.** M28 owns the FHIR Observation wire shape per M28 D6; M29 publishes `LabObservationReader` consumed by M28's Observation mapper. Same pattern as M9 → M28.

- **M29 does not perform clinical interpretation of lab values.** The abnormal-flag carried in the OBR-8 segment of the ORU is the authority — M29 surfaces the lab's flag, never invents one. AI-based clinical interpretation of lab trends is M32 territory (Phase 2 capability "lab trend narrative") and consumes M29's `LabObservationReader`.

- **M29 does not perform probabilistic patient-matching in Phase 1.** Deterministic five-level cascade only (D6); the probabilistic ML matcher is Phase 2 forward seam.

- **M29 does not own the Direct Trust secure messaging infrastructure.** Phase 2 deferred per architecture §10.

- **M29 does not own MinIO bucket-scope code, encryption-at-rest helpers, RLS policy generators, or the audit trigger generator.** Those are M1 / M4 primitives consumed.

- **M29 does not bypass the M36 alert delivery path.** Every clinical alert (abnormal lab, listener down, BAA expiring) is dispatched via M36's typed-alert envelope.

### 1.3 Regulatory & Operational Drivers

- **HIPAA §164.502(b) minimum-necessary applied at perimeter ingress.** Inbound HL7 messages are kept in audit-grade storage; per-segment denylist (D19) prevents PID/NK1/IN1/GT1/NTE PHI from surfacing in ops dashboards.

- **HIPAA §164.528 disclosure accounting.** Every outbound ORM transmission is a HIPAA disclosure subject to the §164.528 accounting requirement; every inbound message is a receipt-of-disclosure-event documented under the same retention class for survey replay.

- **42 CFR Part 2 SUD redaction at perimeter ingress** for SUD-classified labs (D15) — `ConsentEvaluator.evaluateForIngressRedaction` consulted before the observation is surfaced to non-SUD-authorized readers.

- **42 CFR §418 hospice CoP — care plan and physician orders.** Inbound lab results bound to a covering M11 order satisfy CoP 418.104(a) physician-order documentation; the lab-to-order back-link via OBR-2 (D8) is the wire-level fulfillment-evidence link.

- **Data-sharing agreements with sending facilities and reference labs.** Each per-tenant feed requires a documented BAA per HIPAA §164.504(e); the M40 BAA gate (D16) refuses feed activation absent a documented BAA reference.

- **CMS NPPES API public-access terms.** NPPES is a public registry; no BAA, no PHI. The platform-shared cache is governed under the public-registry usage terms, not under HIPAA disclosure terms.

- **MLLP protocol conformance** per HL7 v2.5.1 specification + the MLLP Minimal Lower Layer Protocol spec; ACK/NAK generation per the AA/AE/AR application-acknowledgment codes.

### 1.4 Competitive Context

The competing hospice EHR products either (a) refuse inbound HL7 traffic entirely (Axxess, WellSky home health offerings — hospice modules don't ship HL7 listeners), (b) blind-write ADT-derived demographic updates into the patient table without owner-module review (FireNote — observed in operator interviews; corrupts the patient match-graph over time), or (c) charge per-feed per-tenant setup fees that prohibit small hospice agencies from connecting (CommunityHealth — enterprise-only). M29 ships the propose-then-review boundary by default, the per-tenant deterministic patient matcher by default, the M40 BAA gate by default, and the M27-mediated Xero/Gusto factory consumption so per-tenant accounting connections are governed by the SaaS console (M34 onboarding) rather than per-engineering-ticket.

The module-architectural decision that distinguishes M29 from peer offerings is **the strict separation of perimeter-ingress concerns (HL7 parsing, raw-message persistence, sender allowlist, BAA gate) from owner-module concerns (patient match, demographic write, clinical interpretation)**. This is the architecture-fitness rule (architecture §25.15 boundary check 5) applied to the perimeter-ingress layer: the perimeter must not own the clinical data model, only the wire-shape parsing and the propose-then-review staging.


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
│  external_feed        │  │  hl7_message_inbound  │    │  hl7_message_outbound       │
│  ─────────────────    │  │  ─────────────────    │    │  ─────────────────          │
│  id (UUID)            │  │  id (UUID)            │    │  id (UUID)                  │
│  organization_id  ────┼──┤  organization_id      │    │  organization_id            │
│  kind                 │  │  feed_id ──► external │    │  feed_id ──► external_feed  │
│   ('adt_inbound'      │  │   _feed               │    │  message_type               │
│   |'lab_inbound'      │  │  message_type         │    │   ('ORM^O01')               │
│   |'orm_outbound')    │  │   ('ADT^A01'|...      │    │  message_control_id         │
│  display_name         │  │   |'ORU^R01')         │    │  payload_cipher (encrypted) │
│  host                 │  │  message_control_id   │    │  payload_sha256             │
│  port                 │  │  payload_cipher       │    │  segments_summary (jsonb)   │
│  protocol             │  │   (envelope-encrypted │    │  source_aggregate_kind      │
│   ('mllp_tls'|        │  │    raw HL7 bytes)     │    │   ('m11.order_record'|...)  │
│   'mllp_plain')       │  │  payload_sha256       │    │  source_aggregate_id        │
│  channel_cert_pin     │  │  segments_summary     │    │  destination_facility_id    │
│   (sha256 of certPEM) │  │   (jsonb — segment    │    │   (M40 Facility ref)        │
│  sending_facility_    │  │    names + byte cnts) │    │  transmitted_at             │
│   allowlist[]         │  │  received_at          │    │  ack_status                 │
│   (M40 Facility ids)  │  │  parse_status         │    │   ('aa'|'ae'|'ar'|'timeout')│
│  baa_contract_ref     │  │   ('parsed'|'parse_   │    │  ack_received_at            │
│  baa_expires_on       │  │    error'|'rejected') │    │  ack_payload_cipher         │
│  active_from          │  │  parse_error          │    │  retry_count                │
│  active_through       │  │   (jsonb,nullable)    │    │  next_retry_at              │
│  status               │  │  sending_facility_id  │    │  status                     │
│   ('proposed'|        │  │   (M40 ref, nullable) │    │   ('queued'|'in_flight'     │
│    'pending_approval'|│  │  sending_facility_    │    │    |'acked'|'naked'|        │
│    'active'|          │  │   raw_id (the MSH-4   │    │    'failed'|'dlq')          │
│    'suspended'|       │  │    string)            │    │  idempotency_key            │
│    'revoked')         │  │  idempotency_key      │    │   ((feed_id,source_kind,    │
│  approved_by_op_id    │  │   (sending_facility_  │    │    source_id)-hash)         │
│  approved_by_compl_id │  │    id, message_       │    └─────────────────────────────┘
│  rate_limit_msg_per_s │  │    control_id)        │
│  retry_policy (jsonb) │  └───────────┬───────────┘
└───────────────────────┘              │
            │                          │  (one inbound message yields zero-or-one
            │                          │   inbound proposal for ADT-family
            ▼                          │   messages; lab messages auto-attach
┌────────────────────────────┐         │   without proposal staging)
│  external_feed_credential  │         │
│  ─────────────────         │         ▼
│  id (UUID)                 │   ┌──────────────────────────────────────────────┐
│  feed_id ──► external_feed │   │  hl7_inbound_proposal                        │
│  kind                      │   │  ─────────────────                           │
│   ('mllp_client_cert'|     │   │  id (UUID)                                   │
│    'mllp_channel_password')│   │  organization_id                             │
│  secret_cipher (per-tenant │   │  source_message_id ──► hl7_message_inbound   │
│   DEK-encrypted)           │   │  resource_kind                               │
│  fingerprint               │   │   ('patient_demographic_update' |            │
│   (sha256 first 8 hex      │   │    'admission_event' |                       │
│    for ops display)        │   │    'discharge_event' |                       │
│  rotated_at                │   │    'cancel_admission')                       │
│  status                    │   │  proposed_patient_candidate (jsonb)          │
│   ('active'|'retired')     │   │  match_outcome                               │
└────────────────────────────┘   │   ('matched_single'|'matched_ambiguous'|     │
                                 │    'no_match'|'merged_target')               │
                                 │  matched_patient_id (M5 ref, nullable)       │
                                 │  match_confidence (numeric, 0.0–1.0)         │
                                 │  match_candidate_ids[] (M5 ref array,        │
                                 │   populated when matched_ambiguous)          │
                                 │  proposed_at                                 │
                                 │  owner_module ('m5')                         │
                                 │  proposal_status                             │
                                 │   ('pending'|'accepted'|'rejected'|'expired')│
                                 │  decided_by_membership_id                    │
                                 │  decided_at                                  │
                                 │  decision_rationale (≥40 chars for reject)   │
                                 │  accepted_aggregate_id (the M5 patient_id    │
                                 │   created/updated on acceptance)             │
                                 │  validation_errors (jsonb)                   │
                                 │  expires_at (proposed_at + 72h SLA)          │
                                 └──────────────────────────────────────────────┘

                                 ┌──────────────────────────────────────────────┐
                                 │  lab_observation                             │
                                 │  ─────────────────                           │
                                 │  id (UUID)                                   │
                                 │  organization_id                             │
                                 │  source_message_id ──► hl7_message_inbound   │
                                 │  patient_id (M5 ref)                         │
                                 │  order_id (M11 order_record ref, nullable —  │
                                 │   nullable for the rare case where the OBR-2 │
                                 │   placer-order-number does not resolve)      │
                                 │  observation_date                            │
                                 │  collection_date                             │
                                 │  result_status                               │
                                 │   ('preliminary'|'final'|'corrected'|        │
                                 │    'cancelled')                              │
                                 │  performing_lab_facility_id (M40 ref)        │
                                 │  ordering_physician_npi (nullable)           │
                                 │  loinc_code (the OBR-4 universal service id) │
                                 │  loinc_display_text                          │
                                 │  terminology_validation                      │
                                 │   ('valid'|'unknown_code'|'deprecated')      │
                                 │  abnormal_summary                            │
                                 │   ('any_critical'|'any_abnormal'|            │
                                 │    'all_normal'|'no_flags')                  │
                                 │  attached_document_id (M22 ref, nullable —   │
                                 │   set when an OBX-5 ED segment carries a     │
                                 │   PDF report routed to M22)                  │
                                 │  sud_redacted_at_ingest (bool — D15)         │
                                 │  received_at                                 │
                                 └──────────────────┬───────────────────────────┘
                                                    │
                                 ┌──────────────────▼───────────────────────────┐
                                 │  lab_observation_value                       │
                                 │  ─────────────────                           │
                                 │  id (UUID)                                   │
                                 │  observation_id ──► lab_observation          │
                                 │  obx_set_id (integer, the OBX-1 set id)      │
                                 │  loinc_code                                  │
                                 │  loinc_display_text                          │
                                 │  terminology_validation                      │
                                 │  value_type                                  │
                                 │   ('NM'|'ST'|'CE'|'SN'|'TX'|'DT')            │
                                 │  numeric_value (numeric, nullable)           │
                                 │  string_value (text, nullable)               │
                                 │  units (UCUM)                                │
                                 │  reference_range (text)                      │
                                 │  abnormal_flag                               │
                                 │   ('H'|'L'|'HH'|'LL'|'A'|'N'|null)           │
                                 │  performed_at                                │
                                 └──────────────────────────────────────────────┘

                                 ┌──────────────────────────────────────────────┐
                                 │  lab_observation_inbound_link                │
                                 │  ─────────────────                           │
                                 │  id (UUID)                                   │
                                 │  observation_id ──► lab_observation          │
                                 │  source_message_id ──► hl7_message_inbound   │
                                 │  source_order_id (M11 order ref, app-side)   │
                                 │  obr_placer_order_number (the OBR-2 value)   │
                                 │  match_method                                │
                                 │   ('obr_placer_id'|'patient_loinc_date'|     │
                                 │    'manual'|'unmatched')                     │
                                 │  match_confidence (0.0–1.0)                  │
                                 └──────────────────────────────────────────────┘

                                 ┌──────────────────────────────────────────────┐
                                 │  nppes_provider  (platform-shared)           │
                                 │  ─────────────────                           │
                                 │  npi (CHAR(10), PK)                          │
                                 │  enumeration_type ('NPI-1'|'NPI-2')          │
                                 │  status ('active'|'deactivated')             │
                                 │  deactivation_date (nullable)                │
                                 │  deactivation_reason (nullable)              │
                                 │  reactivation_date (nullable)                │
                                 │  basic (jsonb — name, gender, credential,    │
                                 │   sole_proprietor, enumeration_date)         │
                                 │  addresses (jsonb — array of addr_purpose)   │
                                 │  taxonomies (jsonb — array of                │
                                 │   {code,desc,primary,license,state})         │
                                 │  identifiers (jsonb — array of other ids)    │
                                 │  endpoints (jsonb — Direct Trust endpoints)  │
                                 │  last_updated_in_nppes (date — the           │
                                 │   nppes-reported last_updated_epoch)         │
                                 │  fetched_at                                  │
                                 │  organization_id (NULL — platform row)       │
                                 └──────────────────────────────────────────────┘

                                 ┌──────────────────────────────────────────────┐
                                 │  nppes_sync_run  (platform-shared audit)     │
                                 │  ─────────────────                           │
                                 │  id (UUID)                                   │
                                 │  kind                                        │
                                 │   ('daily_incremental'|'weekly_dissemination'│
                                 │    |'monthly_deactivation'|'manual')         │
                                 │  triggered_by                                │
                                 │   ('platform_cron'|'platform_admin')         │
                                 │  triggered_by_membership_id (nullable)       │
                                 │  started_at                                  │
                                 │  completed_at (nullable)                     │
                                 │  status                                      │
                                 │   ('in_progress'|'completed'|'failed')       │
                                 │  providers_fetched_count                     │
                                 │  providers_updated_count                     │
                                 │  providers_deactivated_count                 │
                                 │  errors_count                                │
                                 │  error_details (jsonb, nullable)             │
                                 │  source_file_url (text, the NPPES file URL)  │
                                 │  organization_id (NULL — platform row)       │
                                 └──────────────────────────────────────────────┘

                                 ┌──────────────────────────────────────────────┐
                                 │  external_feed_health                        │
                                 │  ─────────────────                           │
                                 │  id (UUID)                                   │
                                 │  feed_id ──► external_feed                   │
                                 │  organization_id                             │
                                 │  hour_bucket (timestamp, hourly truncation)  │
                                 │  listener_up_seconds                         │
                                 │  listener_down_seconds                       │
                                 │  inbound_message_count                       │
                                 │  outbound_message_count                      │
                                 │  ack_aa_count                                │
                                 │  ack_ae_count                                │
                                 │  ack_ar_count                                │
                                 │  ack_timeout_count                           │
                                 │  inbound_bytes                               │
                                 │  outbound_bytes                              │
                                 │  parse_error_count                           │
                                 │  sender_rejected_count                       │
                                 │  last_message_at                             │
                                 │  PRIMARY KEY (feed_id, hour_bucket)          │
                                 └──────────────────────────────────────────────┘
```

**Tables M29 owns (eleven):** `external_feed`, `external_feed_credential`, `hl7_message_inbound`, `hl7_message_outbound`, `hl7_inbound_proposal`, `lab_observation`, `lab_observation_value`, `lab_observation_inbound_link`, `nppes_provider`, `nppes_sync_run`, `external_feed_health`.

**Tables M29 reads via reader seams (never schema imports):** every relevant table in M5 (patient match), M11 (lab order back-resolution), M22 (document storage), M27 (Xero/Gusto factory consumption), M38 (LOINC validation), M39 (SUD ingress consent), M40 (Facility/ExternalPhysician/Pharmacy/BAA gate). The dependency-cruiser boundary check (architecture §25.15) blocks any `import` from a non-listed code path.

### 2.2 Per-Entity Lifecycle

#### `external_feed` — feed onboarding state machine

```
                ┌─── proposed ────┐
                │  (Operator      │
                │   requests)     │
                ▼                  │
          ┌───────────┐            │
          │  pending  │            │
          │ _approval │  (rejected)│
          └─────┬─────┘─────────►  rejected
                │ (Compliance Officer
                │  co-approves, distinct
                │  from operator — D18)
                ▼
          ┌──────────┐
          │  active  │
          └────┬─────┘
               │ (manual suspend
               │  OR baa_expired
               │  OR cert pin mismatch storm)
               ▼
          ┌──────────────┐
          │  suspended   │
          └────┬─────────┘
               │ (operator un-suspend
               │  after BAA refresh / cert rotate)
               ▼
          ┌──────────┐
          │  active  │
          └──────────┘
               │ (operator revoke;
               │  permanent)
               ▼
          ┌──────────┐
          │ revoked  │  ─── terminal — feed_id retained for audit
          └──────────┘
```

A feed is `proposed` by an Operator (the `ExternalInterfacesOperator` session class), `pending_approval` until a Compliance Officer with a *distinct membership* co-approves (the M28 D12 dual-approval pattern reapplied; ABAC predicate `external_feed_compliance_co_approver_distinct` enforces). Activation is gated by the M40 BAA check (D16): if `mdm.baaStatus(orgId, kind='Facility', id=sending_facility)` returns `missing` or `expired`, activation refuses with a typed error. While `active`, the MLLP listener is bound and the sender allowlist is enforced. The feed enters `suspended` on a documented operational reason (BAA expiration, certificate-pin mismatch storm, sender allowlist breach) and returns to `active` only after the documented remediation. Revocation is permanent; the row is retained for audit because every inbound message has a `feed_id` FK that must remain resolvable.

#### `hl7_message_inbound` — per-message lifecycle

**M29-F03 / S11 / ADR-0014 D2 — persist-AFTER-redact.** The prior "persist every raw wire byte
**before** parsing" ordering directly contradicted D15/W-XI-14 ("strip DG1/OBX SUD segments at the
wire boundary, before encryption — never land in encrypted-at-rest storage"). The two are mutually
exclusive, and persisting raw bytes pre-parse lands **unredacted SUD-bearing bytes in storage
before the consent gate runs**, defeating the Part 2 ingress gate. The ordering is corrected:

1. A frame is received; the SUD/Part-2 redaction + consent-evaluation pass (`evaluateForIngressRedaction`,
   M39) runs **at the wire boundary, before any durable write**.
2. **Only the redacted payload is persisted**, envelope-encrypted, with `parse_status='in_progress'`.
   For a frame whose SUD segments cannot lawfully be ingested (no consent/QSOA naming the recipient),
   the redacted-to-empty frame is recorded as a **refused-ingress** disclosure-accounting marker —
   **no raw SUD bytes are ever stored**.
3. On successful parse the status flips to `'parsed'` and the segment summary is materialized; on
   parse failure to `'parse_error'` with the parser diagnostic (over the **redacted** payload).
   Allowlist-failing senders land `parse_status='rejected'` with a NAK.

An unparseable message is still part of the disclosure-accounting record and reproducible by audit —
but the record holds the **redacted** payload, never raw pre-gate SUD wire bytes. §2.2/§3.3/§8.3 are
reconciled to this redact-then-persist ordering.

A successfully parsed ADT message triggers the staging worker to create an `hl7_inbound_proposal` row. A successfully parsed ORU message triggers the lab-observation worker to materialize one `lab_observation` + N `lab_observation_value` rows (auto-attach per D7).

The MLLP ACK/NAK response is governed by HL7 v2.5.1 application-acknowledgment semantics: `AA` (Application Accept) on `parsed`, `AE` (Application Error) on `parse_error` for malformed messages, `AR` (Application Reject) on `rejected` for sender-allowlist violations. The ACK shape and timing follow the HL7 conformance spec — outside the application-ack window the sender's MLLP library times out and re-sends; the M29 idempotency key per D14 dedupes the re-send.

#### `hl7_inbound_proposal` — propose-then-review lifecycle

```
                ┌──── pending ────┐
                │  (created on    │
                │   ADT parse)    │
                ▼                  │
          ┌───────────┐            │
          │  pending  │            │
          └─────┬─────┘  (decided_at > expires_at;
                │        72h SLA window)
                ▼                  │
            ┌─────────┐            │
            │ expired │  ──────────┘
            └─────────┘  ─── terminal; M36 alert on expiry
                │
   (M5 reviewer acts within window)
                │
                ▼
          ┌─────────────┬──────────────┐
          │             │              │
          ▼             ▼              ▼
      accepted      rejected       (matched_ambiguous
                                    → operator picks
                                    a candidate OR
                                    creates new patient)
```

The 72-hour SLA per `inbound_review_sla_hours` (default 72h, tenant-overridable; the platform floor is 168h hard cap — the propose-then-review pattern is operational, not life-safety, so a longer ceiling is acceptable; tighten-only). On acceptance the M5 reviewer endpoint is invoked (`POST /api/v1/patients/:id/apply-adt-update` for A08; `POST /api/v1/patients/from-adt` for A01/A04); the M5 endpoint owns the patient write per the cross-schema boundary; M29 only records `accepted_aggregate_id` after the M5 write succeeds. On rejection a ≥40-char rationale is required; on expiry an `m29.hl7_inbound.proposal_expired` outbox event fires and the M36 `hl7_inbound.proposal_overdue` alert is dispatched to the configured operator. Expired proposals are not auto-accepted because a stale ADT could carry demographic shifts the chart no longer reflects.

#### `lab_observation` — auto-attach lifecycle

Lab observations are persisted directly on inbound ORU parse (no proposal staging) under D7. The persistence path:

1. The parser materializes the OBR + OBX segments into a typed `OruInboundPayload`.
2. The patient-binding resolver attempts the OBR-2 placer-order-number match against M11 (D8); fallback to patient-LOINC-date matching against existing M9 / M11 records if OBR-2 is empty or unresolvable.
3. The SUD-at-ingress redaction gate (D15) consults `ConsentEvaluator.evaluateForIngressRedaction(patientId, dataClass='lab_sud', asOf=observation_date)`. SUD-flagged labs land with `sud_redacted_at_ingest=true` and are routed through the M5 PrivacyFlag pipeline so only SUD-authorized readers see the values.
4. The LOINC validation gate (D-terminology in §1) consults M38; unknown codes flag `terminology_validation='unknown_code'` and route an M36 alert to the tenant terminology administrator but do not drop the observation.
5. The abnormal-flag rollup is computed from the OBX-8 flags across all values; the rollup drives the M36 alert path (D7).
6. The `lab_observation_inbound_link` row records the OBR-2 placer-order-number and the match method.
7. `m29.lab_observation.received` fires; M28 (Phase 2 lab-trending consumer M9), M33 (reporting), and M36 (abnormal alerts) consume.

Lab observation values are immutable post-persistence (a corrected result is a new `lab_observation` row with `result_status='corrected'` that references the prior observation via a `previous_observation_id` column — the wire-level OBR-25 result status flag drives the lifecycle). The destruction path is governed by M4 retention class `compliance` (the lab is part of the patient chart and a survey-evidence record).

#### `nppes_provider` — cache lifecycle

Populated and refreshed exclusively by the nightly platform-role sync job (`withPlatformContext`); never written by a tenant-scoped session. The status flips `active → deactivated` when NPPES marks a deactivation (death, license revocation, voluntary termination). Reactivation is recorded with `reactivation_date` populated and `status='active'`. The `fetched_at` column is the cache-freshness signal — readers may consult freshness if a downstream workflow requires "fetched within the last N days" guarantees (e.g., the M5 D9 "physician NPI must be current per NPPES within 90 days for cert eligibility" rule).

#### `nppes_sync_run` — sync orchestration audit

One row per sync invocation. The nightly cron writes one row per night; manual triggers (by a platform admin) also write a row with `triggered_by='platform_admin'`. The row is the canonical audit record of when the cache was last refreshed and what changed.

#### `external_feed_health` — rolling hourly metrics

Materialized by a 5-minute aggregator worker that rolls `hl7_message_inbound` / `hl7_message_outbound` / listener-uptime events into the per-feed-per-hour metric row. Older than 90 days are aged out by the M4 retention runner (retention class `operational`). The rollup is the source for M33 dashboards and the M36 `hl7_feed.listener_down` alert path (D17 threshold: 5 consecutive minutes of `listener_down_seconds` accrual triggers the alert).

### 2.3 Validation Rules (Domain-Level, Not the Wire-Shape Schemas)

| Rule | Where | Detail |
|------|-------|--------|
| Feed activation refuses with `missing_baa` if `mdm.baaStatus()` returns `missing` or `expired` | `external_feed.activate` route | D16 |
| Feed activation refuses with `no_compliance_co_approver` if approver is same membership as operator | ABAC `external_feed_compliance_co_approver_distinct` | M28 D12 pattern |
| Inbound message persists *before* parse (audit-grade record preserved on parse error) | `inbound-listener.worker.ts` | §2.2 |
| Inbound message from non-allowlisted sender returns AR NAK and persists with `parse_status='rejected'` | `inbound-listener.worker.ts` | D3 |
| Inbound idempotency key `(sending_facility_id, message_control_id)` permanent dedup | M1 idempotency middleware | D14 |
| ADT proposal expiry at `proposed_at + 72h` (platform-tunable, tenant tighten-only) | `inbound-sla-watch.worker.ts` | §2.2 |
| Lab observation patient match attempts OBR-2 → patient-LOINC-date → manual queue cascade | `lab-observation-binder.ts` | D8 |
| SUD-flagged lab consults `ConsentEvaluator.evaluateForIngressRedaction` before non-redacted persistence | `lab-observation-binder.ts` | D15 |
| Outbound ORM idempotency key `(feed_id, source_aggregate_kind, source_aggregate_id)` permanent dedup | M1 idempotency middleware | D14 |
| Outbound ORM refuses dispatch if `mdm.baaStatus(orgId, 'Facility', destination_facility_id)` is `missing`/`expired` | `outbound-dispatcher.worker.ts` | D16 |
| Outbound ORM retry policy: exponential backoff with 5 attempts, then DLQ + M36 alert | `outbound-dispatcher.worker.ts` | D9 |
| NPPES sync runs only under `withPlatformContext`; tenant context refused by ABAC `nppes_platform_job_caller` | `nppes-sync.worker.ts` | D11 |
| `lab_observation.order_id` is app-side FK; never a DB constraint | schema | architecture §25.15 boundary |

### 2.4 Side Effects

Every state transition emits exactly one outbox event (no event firehose; no synchronous cross-module call):

| Transition | Outbox event | Consumers |
|------------|--------------|-----------|
| `external_feed.create` (proposed) | `m29.external_feed.proposed` | M36 (alert co-approver), M33 (audit dashboard) |
| `external_feed.approve` (active) | `m29.external_feed.activated` | M33, M34 (SaaS console) |
| `external_feed.suspend` | `m29.external_feed.suspended` | M33, M36 |
| `external_feed.revoke` | `m29.external_feed.revoked` | M33 |
| `hl7_message_inbound.persisted` (parsed) | `m29.hl7_message.received` | M33 (metrics), audit |
| `hl7_message_inbound.parse_error` | `m29.hl7_message.parse_error` | M36 (alert), M33 |
| `hl7_inbound_proposal.create` (ADT) | `m29.adt.proposed` | M5 (notify reviewer), M36 |
| `hl7_inbound_proposal.accept` | `m29.adt.demographic_update_accepted` or `m29.adt.admission_event` (kind-discriminated) | M5 (write), M37 (IPU partner-facility filter), M33 |
| `hl7_inbound_proposal.reject` | `m29.adt.proposal_rejected` | M5 (audit), M33 |
| `hl7_inbound_proposal.expire` | `m29.adt.proposal_expired` | M5 (audit), M36 (alert), M33 |
| `lab_observation.persisted` | `m29.lab_observation.received` | M9 (Phase 2 trending), M11 (mark order fulfilled), M28 (FHIR), M33 |
| `lab_observation.abnormal_flag_detected` | `m29.lab_observation.abnormal_flag` | M36 (alert caseload RN per D7) |
| `hl7_message_outbound.acked` | `m29.lab_order.transmitted` | M11 (update transmission_status), M33 |
| `hl7_message_outbound.naked` or `dlq` | `m29.lab_order.transmission_failed` | M11, M36 (alert) |
| `nppes_sync_run.complete` | `m29.nppes.sync_run.completed` | M40 (canonical sync), M33 |
| `nppes_provider.deactivated` | `m29.nppes.provider_deactivated` | M40 (flag overlays referencing deactivated NPI) |
| `nppes_provider.updated` | `m29.nppes.provider_synced` | M40 (canonical write) |

### 2.5 Concurrency

- **MLLP listener:** one TCP socket per feed; the BullMQ worker that owns the socket has `concurrency=1` per feed (a single TCP connection from a single sender is sequential by protocol). Sender re-connections after a disconnect are accepted; the listener does not multiplex unrelated senders onto the same socket.
- **Inbound parse worker:** `concurrency=4` per feed; messages within a feed are parsed in receipt order via the per-feed BullMQ queue.
- **ADT proposal review:** Operator-driven; per-proposal advisory lock prevents two operators from accepting the same proposal simultaneously (M1 advisory-lock helper).
- **Lab observation persistence:** per-message; the LOINC validation and SUD redaction gate are read-only consults, no cross-resource lock.
- **Outbound ORM dispatch:** per-feed `concurrency=1` (MLLP is a sequential transport over a single TCP connection per channel); per-message retry with exponential backoff governed by the per-feed retry policy.
- **NPPES sync:** platform-wide `concurrency=1` (one sync job runs at a time platform-wide; the nightly cron and manual triggers both wait on the same lock).
- **Feed credential rotation:** per-feed advisory lock; the listener picks up the new credential at the next socket reconnection (graceful rotation, no message loss).

### 2.6 Idempotency

| Path | Idempotency key | Window |
|------|-----------------|--------|
| Inbound HL7 message persistence | `(sending_facility_id, message_control_id)` | permanent |
| ADT proposal creation | `source_message_id` | permanent (one proposal per message) |
| Lab observation persistence | `source_message_id` | permanent |
| Outbound ORM dispatch | `(feed_id, source_aggregate_kind, source_aggregate_id)` | permanent |
| Outbound ORM ack receipt | `(feed_id, message_control_id, acked_at)` | permanent |
| NPPES per-provider upsert | `npi` | permanent (last-write-wins by `last_updated_in_nppes`) |
| `external_feed.create` | M1-server-generated client-side key | 10-min window |
| `hl7_inbound_proposal.accept` / `.reject` | `proposal_id` | permanent (decided is decided) |
| `nppes.sync.trigger_manual` | M1-server-generated client-side key | 10-min window |


## 3. Drizzle Schema

### 3.1 Package Layout

```
packages/hl7-worker/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                              # public exports (no Java imports leak)
│   ├── parser-sidecar-client.ts              # typed gRPC-over-UDS client to the HAPI Java sidecar (T-29.03)
│   ├── mllp-listener.ts                      # MLLP framing + ACK/NAK lifecycle
│   ├── mllp-transmitter.ts                   # outbound MLLP send + ack-await
│   ├── segments/
│   │   ├── msh.ts                            # Message Header (decoded shape)
│   │   ├── pid.ts                            # Patient Identification
│   │   ├── pv1.ts                            # Patient Visit
│   │   ├── obr.ts                            # Observation Request
│   │   ├── obx.ts                            # Observation/Result
│   │   ├── orc.ts                            # Order Control
│   │   ├── nk1.ts                            # Next of Kin
│   │   ├── in1.ts                            # Insurance
│   │   ├── gt1.ts                            # Guarantor
│   │   └── nte.ts                            # Notes & Comments
│   ├── messages/
│   │   ├── adt-a01.ts                        # ADT^A01 typed envelope
│   │   ├── adt-a03.ts
│   │   ├── adt-a04.ts
│   │   ├── adt-a08.ts
│   │   ├── adt-a11.ts
│   │   ├── oru-r01.ts                        # ORU^R01 lab result
│   │   └── orm-o01.ts                        # ORM^O01 lab order (outbound)
│   ├── interfaces/
│   │   ├── parser.ts                         # HL7Parser contract
│   │   ├── transmitter.ts                    # HL7Transmitter contract
│   │   └── listener.ts                       # HL7Listener contract
│   └── boot.ts                               # registers parser-sidecar with M1 system-status
│
└── parser-sidecar/                           # Java HAPI sidecar (gRPC server; UDS only — no TCP port exposed)
    ├── Dockerfile
    ├── build.gradle.kts                      # Gradle Kotlin DSL — HAPI HL7 v2.5.1 + grpc-netty + Netty epoll UDS
    ├── settings.gradle.kts
    ├── gradle.properties
    └── src/main/java/com/wardenx/hl7/
        ├── ParserServiceImpl.java            # gRPC service: Parse / Build / Health
        ├── SegmentMapper.java                # HAPI tree → proto Segment mapping
        ├── BuilderService.java               # proto Segments → HAPI tree → wire bytes
        ├── UdsServerBootstrap.java           # Netty epoll UDS bind + lifecycle
        └── App.java                          # main entrypoint

packages/nppes-client/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── client.ts                             # the ONLY repo code allowed to import NPPES HTTP client
│   ├── pacing.ts                             # per-second rate limiter (NPPES throttles)
│   ├── interfaces/
│   │   ├── nppes-api.ts                      # NppesApiClient contract
│   │   └── nppes-record.ts                   # canonical record shape
│   └── boot.ts

apps/backend/src/modules/29-external-interfaces/
├── routes.ts
├── routes/                                   # AS-BUILT (GAP-184): one file per resource under the §4.1/§4.2 prefixes
│   │                                         #   operator surface  = /api/admin/external-interfaces
│   │                                         #   clinician surface = /api/clinical/labs
│   ├── feed.routes.ts                        # GET/POST /feeds · GET/PATCH /feeds/:feedId · POST /feeds/:feedId/{activate,suspend,revoke}
│   │                                         #   · GET/POST /feeds/:feedId/credentials (POST = mint/rotate) · GET /feeds/:feedId/health
│   ├── proposal.routes.ts                    # GET /inbound-proposals · GET /inbound-proposals/:proposalId
│   │                                         #   · POST /inbound-proposals/:proposalId/{accept,reject,defer}
│   ├── labs.routes.ts                        # GET /observations · GET /observations/{unmatched,:observationId}
│   │                                         #   · POST /observations/:observationId/{attach-patient,discard,acknowledge-abnormal}
│   ├── message.routes.ts                     # GET /messages/{inbound,outbound}[/:messageId]
│   │                                         #   · POST /messages/inbound/:messageId/{decrypt,replay} · POST /messages/outbound/:messageId/retry
│   ├── nppes.routes.ts                       # GET /nppes/providers/:npi · GET/POST /nppes/sync-runs (platform-admin)
│   ├── ops.routes.ts                         # GET /health/aggregate · GET /metrics/listener-status
│   ├── actor.ts / guards.ts / mount.ts       # request actor, permission + ABAC guard bindings, route mount
│   ├── store.ts / store-drizzle.ts           # the route-facing store port and its Drizzle implementation
│   ├── lab-list-scope.ts                     # caseload narrowing for the lab list
│   ├── feed-input.ts / m29-typebox.ts        # wire schemas
│   │
│   │   DEFERRED rows of the original layout (no route registered; not defects, roadmap):
│   │     · feeds/approve        — activation itself carries the D18 distinct co-approver, there is no separate approve verb
│   │     · match-candidates     — the L4 candidate list is not exposed; the proposal detail carries the diff only
│   │     · nppes/search         — parameterized NPPES search is unbuilt; lookup is by NPI only
│   │     · health/feeds         — folded into `GET /feeds/:feedId/health` (feed.routes.ts)
├── services/
│   ├── feed-onboarding.ts                    # dual-approval workflow (D18)
│   ├── feed-revocation.ts                    # listener teardown on revoke
│   ├── inbound-listener.ts                   # bootstrap the per-feed MLLP listeners
│   ├── inbound-staging.ts                    # ADT proposal staging
│   ├── inbound-sla-watch.ts                  # 72h expiry detection
│   ├── lab-observation-binder.ts             # OBR-2 → M11 order resolution + SUD gate + LOINC gate
│   ├── outbound-dispatcher.ts                # consume m11.order.hl7_orm_requested + transmit
│   ├── outbound-ack-watcher.ts               # ack timeout detection + DLQ routing
│   ├── nppes-sync.ts                         # nightly platform-role sync orchestration
│   ├── nppes-lookup.ts                       # ad-hoc lookup with cache-first read-through
│   ├── feed-health-aggregator.ts             # 5-min rollup into external_feed_health
│   ├── consent-ingress-gate.ts               # SUD-at-ingress redaction gate (D15)
│   ├── audit-disclosure.ts                   # auditRead() wrapper per D4
│   └── seam-implementations/
│       ├── lab-observation-provider.ts       # implements LabObservationReader
│       ├── hl7-inbound-proposal-reader.ts    # implements Hl7InboundProposalReader
│       ├── external-feed-reader.ts           # implements ExternalFeedReader
│       ├── nppes-provider-reader.ts          # implements NppesProviderReader
│       └── external-interface-metrics.ts     # implements ExternalInterfaceMetricsProvider
├── workers/
│   ├── inbound-listener.worker.ts            # MLLP socket lifecycle per feed
│   ├── inbound-parse.worker.ts               # parse + persist + emit
│   ├── inbound-stage.worker.ts               # ADT proposal staging
│   ├── inbound-sla-watch.worker.ts           # 72h expiry
│   ├── lab-binder.worker.ts                  # OBR-2 + SUD + LOINC
│   ├── outbound-dispatch.worker.ts           # ORM dispatch
│   ├── outbound-ack-watch.worker.ts          # ack timeout
│   ├── nppes-sync.worker.ts                  # nightly platform-role sync
│   └── feed-health-aggregator.worker.ts      # 5-min rollup
└── boot.ts                                   # registers M29's contributions, runs validateExternalInterfaceConfig()
```

The package-leaf rule (architecture §25.5) is honored: `packages/hl7-worker` depends on `packages/db`, `packages/shared`, `packages/types`, `packages/domain`, `packages/audit`, plus the JVM sidecar binary; no module-specific package imports it except `apps/backend/src/modules/29-external-interfaces`. The HAPI Java library is contained in the sidecar Dockerfile; no TypeScript code in the repo imports a Java class. The NPPES HTTP client is contained in `packages/nppes-client` only; the dependency-cruiser rule blocks any other code from constructing an HTTP call to `npiregistry.cms.hhs.gov`.

### 3.2 Migration Script Phases (`0029_external_interfaces.sql`)

**Phase A — enums, then helper types.**

```sql
CREATE TYPE external_feed_kind AS ENUM ('adt_inbound', 'lab_inbound', 'orm_outbound');
CREATE TYPE external_feed_protocol AS ENUM ('mllp_tls', 'mllp_plain');
CREATE TYPE external_feed_status AS ENUM ('proposed', 'pending_approval', 'active', 'suspended', 'revoked', 'rejected');
CREATE TYPE external_feed_credential_kind AS ENUM ('mllp_client_cert', 'mllp_channel_password');
CREATE TYPE external_feed_credential_status AS ENUM ('active', 'retired');
CREATE TYPE hl7_inbound_parse_status AS ENUM ('in_progress', 'parsed', 'parse_error', 'rejected');
CREATE TYPE hl7_inbound_proposal_kind AS ENUM ('patient_demographic_update', 'admission_event', 'discharge_event', 'cancel_admission', 'new_patient');
CREATE TYPE hl7_inbound_proposal_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');
CREATE TYPE hl7_inbound_match_outcome AS ENUM ('matched_single', 'matched_ambiguous', 'no_match', 'merged_target');
CREATE TYPE hl7_inbound_match_level AS ENUM ('L1_MRN_EXACT', 'L2_EXTERNAL_MRN_EXACT', 'L3_SSN_DOB', 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE', 'L5_LOOSE_NAME_DOB_CANDIDATE', 'NO_MATCH');
CREATE TYPE hl7_outbound_ack_status AS ENUM ('aa', 'ae', 'ar', 'timeout');
CREATE TYPE hl7_outbound_status AS ENUM ('queued', 'in_flight', 'acked', 'naked', 'failed', 'dlq');
CREATE TYPE lab_result_status AS ENUM ('preliminary', 'final', 'corrected', 'cancelled');
CREATE TYPE lab_abnormal_summary AS ENUM ('any_critical', 'any_abnormal', 'all_normal', 'no_flags');
CREATE TYPE lab_abnormal_flag AS ENUM ('H', 'L', 'HH', 'LL', 'A', 'N');
CREATE TYPE lab_value_type AS ENUM ('NM', 'ST', 'CE', 'SN', 'TX', 'DT');
CREATE TYPE lab_terminology_validation AS ENUM ('valid', 'unknown_code', 'deprecated');
CREATE TYPE lab_match_method AS ENUM ('obr_placer_id', 'patient_loinc_date', 'manual', 'unmatched');
CREATE TYPE nppes_enumeration_type AS ENUM ('NPI-1', 'NPI-2');
CREATE TYPE nppes_provider_status AS ENUM ('active', 'deactivated');
CREATE TYPE nppes_sync_kind AS ENUM ('daily_incremental', 'weekly_dissemination', 'monthly_deactivation', 'manual');
CREATE TYPE nppes_sync_trigger AS ENUM ('platform_cron', 'platform_admin');
CREATE TYPE nppes_sync_status AS ENUM ('in_progress', 'completed', 'failed');
```

**Phase B — tables** in dependency order: `external_feed` first (no FKs to other M29 tables); `external_feed_credential` (FK to `external_feed`); `hl7_message_inbound` (FK to `external_feed`; monthly partitioned by `received_at` per M4 §3.6 PHI conventions); `hl7_message_outbound` (FK to `external_feed`; monthly partitioned by `transmitted_at`); `hl7_inbound_proposal` (FK to `hl7_message_inbound`; monthly partitioned by `proposed_at`); `lab_observation` (FK to `hl7_message_inbound`; monthly partitioned by `received_at`); `lab_observation_value` (FK to `lab_observation`; partitioned with parent); `lab_observation_inbound_link` (FK to `lab_observation`, FK to `hl7_message_inbound`); `nppes_provider` (platform-shared, NOT partitioned, no `organization_id`); `nppes_sync_run` (platform-shared, NOT partitioned); `external_feed_health` (composite PK `(feed_id, hour_bucket)`; aged by M4 retention runner at 90 days).

**Phase C — RLS policies per the standard pattern (§3.5).** Note that `nppes_provider` and `nppes_sync_run` are platform-shared (no `organization_id`) and use the `wardenx_admin` role for write + `wardenx_app` for read; the per-tenant tables use the standard `withOrgContext` pattern.

**Phase D — write-audit triggers per the M4 §3.6 denylist (§3.6).**

**Phase E — indexes per §3.4.**

**Phase F — seed rows.** The platform `nppes_sync_run` placeholder for the initial sync state. No per-tenant seed at platform install — feeds are tenant-provisioned at onboarding.

### 3.3 Schema Files (Drizzle)

```typescript
// packages/db/src/schema/external-interfaces/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core'

export const externalFeedKind = pgEnum('external_feed_kind', ['adt_inbound', 'lab_inbound', 'orm_outbound'])
export const externalFeedProtocol = pgEnum('external_feed_protocol', ['mllp_tls', 'mllp_plain'])
export const externalFeedStatus = pgEnum('external_feed_status', ['proposed', 'pending_approval', 'active', 'suspended', 'revoked', 'rejected'])
export const externalFeedCredentialKind = pgEnum('external_feed_credential_kind', ['mllp_client_cert', 'mllp_channel_password'])
export const externalFeedCredentialStatus = pgEnum('external_feed_credential_status', ['active', 'retired'])
export const hl7InboundParseStatus = pgEnum('hl7_inbound_parse_status', ['in_progress', 'parsed', 'parse_error', 'rejected'])
export const hl7InboundProposalKind = pgEnum('hl7_inbound_proposal_kind', ['patient_demographic_update', 'admission_event', 'discharge_event', 'cancel_admission', 'new_patient'])
export const hl7InboundProposalStatus = pgEnum('hl7_inbound_proposal_status', ['pending', 'accepted', 'rejected', 'expired'])
export const hl7InboundMatchOutcome = pgEnum('hl7_inbound_match_outcome', ['matched_single', 'matched_ambiguous', 'no_match', 'merged_target'])
export const hl7InboundMatchLevel = pgEnum('hl7_inbound_match_level', ['L1_MRN_EXACT', 'L2_EXTERNAL_MRN_EXACT', 'L3_SSN_DOB', 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE', 'L5_LOOSE_NAME_DOB_CANDIDATE', 'NO_MATCH'])
export const hl7OutboundAckStatus = pgEnum('hl7_outbound_ack_status', ['aa', 'ae', 'ar', 'timeout'])
export const hl7OutboundStatus = pgEnum('hl7_outbound_status', ['queued', 'in_flight', 'acked', 'naked', 'failed', 'dlq'])
export const labResultStatus = pgEnum('lab_result_status', ['preliminary', 'final', 'corrected', 'cancelled'])
export const labAbnormalSummary = pgEnum('lab_abnormal_summary', ['any_critical', 'any_abnormal', 'all_normal', 'no_flags'])
export const labAbnormalFlag = pgEnum('lab_abnormal_flag', ['H', 'L', 'HH', 'LL', 'A', 'N'])
export const labValueType = pgEnum('lab_value_type', ['NM', 'ST', 'CE', 'SN', 'TX', 'DT'])
export const labTerminologyValidation = pgEnum('lab_terminology_validation', ['valid', 'unknown_code', 'deprecated'])
export const labMatchMethod = pgEnum('lab_match_method', ['obr_placer_id', 'patient_loinc_date', 'manual', 'unmatched'])
export const nppesEnumerationType = pgEnum('nppes_enumeration_type', ['NPI-1', 'NPI-2'])
export const nppesProviderStatus = pgEnum('nppes_provider_status', ['active', 'deactivated'])
export const nppesSyncKind = pgEnum('nppes_sync_kind', ['daily_incremental', 'weekly_dissemination', 'monthly_deactivation', 'manual'])
export const nppesSyncTrigger = pgEnum('nppes_sync_trigger', ['platform_cron', 'platform_admin'])
export const nppesSyncStatus = pgEnum('nppes_sync_status', ['in_progress', 'completed', 'failed'])
```

```typescript
// packages/db/src/schema/external-interfaces/feed.ts
import { pgTable, uuid, text, integer, timestamp, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import * as e from './enums'

export const externalFeed = pgTable('external_feed', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  kind: e.externalFeedKind('kind').notNull(),
  displayName: text('display_name').notNull(),
  host: text('host'),                                              // null for inbound listener (we own the address)
  port: integer('port').notNull(),
  protocol: e.externalFeedProtocol('protocol').notNull(),
  channelCertPin: text('channel_cert_pin'),                        // sha256(certPEM) — null only for mllp_plain (test only)
  sendingFacilityAllowlist: jsonb('sending_facility_allowlist').notNull().default([]).$type<string[]>(),  // M40 Facility ids
  baaContractRef: text('baa_contract_ref'),                        // null for orm_outbound to public-cert lab? No — BAA required (D16); enforced at activation
  baaExpiresOn: timestamp('baa_expires_on'),                       // soft expiry; warning emitted at -30d
  activeFrom: timestamp('active_from'),
  activeThrough: timestamp('active_through'),
  status: e.externalFeedStatus('status').notNull().default('proposed'),
  proposedByMembershipId: uuid('proposed_by_membership_id').notNull(),
  approvedByOpId: uuid('approved_by_op_id'),                       // null until activate
  approvedByComplId: uuid('approved_by_compl_id'),                 // null until activate
  approvedAt: timestamp('approved_at'),
  rateLimitMsgPerSec: integer('rate_limit_msg_per_sec').notNull().default(50),
  retryPolicy: jsonb('retry_policy').notNull().default({ maxAttempts: 5, backoffSecs: [1, 4, 16, 64, 256] }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  orgKindIdx: index('idx_external_feed_org_kind').on(t.organizationId, t.kind),
  uniqOrgPortKind: uniqueIndex('uq_external_feed_org_port_kind').on(t.organizationId, t.port, t.kind),
  statusIdx: index('idx_external_feed_status').on(t.status),
}))

export const externalFeedCredential = pgTable('external_feed_credential', {
  id: uuid('id').primaryKey().defaultRandom(),
  feedId: uuid('feed_id').notNull().references(() => externalFeed.id),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  kind: e.externalFeedCredentialKind('kind').notNull(),
  secretCipher: text('secret_cipher').notNull(),                   // envelope-encrypted with per-tenant DEK
  fingerprint: text('fingerprint').notNull(),                       // sha256 first 8 hex for ops display
  rotatedAt: timestamp('rotated_at').notNull().defaultNow(),
  status: e.externalFeedCredentialStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  feedStatusIdx: index('idx_efc_feed_status').on(t.feedId, t.status),
}))
```

```typescript
// packages/db/src/schema/external-interfaces/hl7-messages.ts
// IMPORTANT: monthly-partitioned by received_at / transmitted_at per M4 §3.6 PHI conventions
import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import { externalFeed } from './feed'
import * as e from './enums'

// Logical view of the partitioned table (the SQL migration creates the parent + partitions)
export const hl7MessageInbound = pgTable('hl7_message_inbound', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  feedId: uuid('feed_id').notNull().references(() => externalFeed.id),
  messageType: text('message_type').notNull(),                     // 'ADT^A01' | 'ADT^A08' | 'ORU^R01' | ...
  messageControlId: text('message_control_id').notNull(),          // MSH-10
  payloadCipher: text('payload_cipher').notNull(),                 // envelope-encrypted raw HL7 wire bytes
  payloadSha256: text('payload_sha256').notNull(),                  // digest for audit value-capture + dedup
  segmentsSummary: jsonb('segments_summary').notNull(),            // {segments: [{name:'PID',byteCount:128},...]} — no PHI
  receivedAt: timestamp('received_at').notNull().defaultNow(),
  parseStatus: e.hl7InboundParseStatus('parse_status').notNull().default('in_progress'),
  parseError: jsonb('parse_error'),
  sendingFacilityId: uuid('sending_facility_id'),                  // M40 Facility, app-side resolution
  sendingFacilityRawId: text('sending_facility_raw_id').notNull(), // MSH-4 string verbatim
  idempotencyKey: text('idempotency_key').notNull(),               // hash(sending_facility_id, message_control_id)
  // ── Cascade result (populated by T-29.05 parse worker after match cascade runs; null until then) ──
  matchedPatientId: uuid('matched_patient_id'),                    // M5 ref, app-side; null on no_match / ambiguous
  matchLevel: e.hl7InboundMatchLevel('match_level'),               // L1..L5 / NO_MATCH; null until cascade runs
  matchOutcome: e.hl7InboundMatchOutcome('match_outcome'),         // matched_single | matched_ambiguous | no_match
  matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),  // 0..1; null for confident L1-L3
  cascadeRunMs: integer('cascade_run_ms'),                         // observability — cascade wallclock
  // ── Parsed-segment tree (populated by T-29.06 parse worker after sidecar.parse succeeds) ──
  parsedSegmentsCipher: text('parsed_segments_cipher'),            // envelope-encrypted JSON of parsed tree
  parsedSegmentsSha256: text('parsed_segments_sha256'),            // digest for audit + dedup
}, (t) => ({
  // composite PK with partition key
  pk: index('pk_hl7_message_inbound_id_received').on(t.id, t.receivedAt),
  orgFeedIdx: index('idx_hmi_org_feed').on(t.organizationId, t.feedId),
  statusIdx: index('idx_hmi_parse_status').on(t.parseStatus),
  uniqIdempotency: index('uq_hmi_idempotency').on(t.idempotencyKey),
  shaIdx: index('idx_hmi_sha256').on(t.payloadSha256),
}))

export const hl7MessageOutbound = pgTable('hl7_message_outbound', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  feedId: uuid('feed_id').notNull().references(() => externalFeed.id),
  messageType: text('message_type').notNull(),
  messageControlId: text('message_control_id').notNull(),
  payloadCipher: text('payload_cipher').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  segmentsSummary: jsonb('segments_summary').notNull(),
  sourceAggregateKind: text('source_aggregate_kind').notNull(),     // 'm11.order_record' | ...
  sourceAggregateId: uuid('source_aggregate_id').notNull(),         // app-side reference; no DB FK across modules
  destinationFacilityId: uuid('destination_facility_id'),           // M40 ref (app-side)
  transmittedAt: timestamp('transmitted_at'),                       // null while queued
  ackStatus: e.hl7OutboundAckStatus('ack_status'),
  ackReceivedAt: timestamp('ack_received_at'),
  ackPayloadCipher: text('ack_payload_cipher'),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at'),
  status: e.hl7OutboundStatus('status').notNull().default('queued'),
  idempotencyKey: text('idempotency_key').notNull(),               // hash(feed_id, source_aggregate_kind, source_aggregate_id)
}, (t) => ({
  pk: index('pk_hl7_message_outbound_id_transmitted').on(t.id, t.transmittedAt),
  orgFeedIdx: index('idx_hmo_org_feed').on(t.organizationId, t.feedId),
  statusIdx: index('idx_hmo_status').on(t.status),
  uniqIdempotency: index('uq_hmo_idempotency').on(t.idempotencyKey),
  nextRetryIdx: index('idx_hmo_next_retry').on(t.nextRetryAt).where('status IN (\'queued\',\'naked\')'),
}))
```

```typescript
// packages/db/src/schema/external-interfaces/inbound-proposal.ts
import { pgTable, uuid, text, timestamp, jsonb, numeric, index } from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import { hl7MessageInbound } from './hl7-messages'
import * as e from './enums'

export const hl7InboundProposal = pgTable('hl7_inbound_proposal', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  sourceMessageId: uuid('source_message_id').notNull(),             // app-side FK to hl7_message_inbound — see §3.5 cross-partition note
  resourceKind: e.hl7InboundProposalKind('resource_kind').notNull(),
  proposedPatientCandidate: jsonb('proposed_patient_candidate').notNull(),    // parsed PID demographics
  matchOutcome: e.hl7InboundMatchOutcome('match_outcome').notNull(),
  matchedPatientId: uuid('matched_patient_id'),                              // M5 ref, app-side
  matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),  // 0.000–1.000
  matchCandidateIds: jsonb('match_candidate_ids').notNull().default([]).$type<string[]>(),
  proposedAt: timestamp('proposed_at').notNull().defaultNow(),
  ownerModule: text('owner_module').notNull().default('m5'),
  proposalStatus: e.hl7InboundProposalStatus('proposal_status').notNull().default('pending'),
  decidedByMembershipId: uuid('decided_by_membership_id'),
  decidedAt: timestamp('decided_at'),
  decisionRationale: text('decision_rationale'),
  acceptedAggregateId: uuid('accepted_aggregate_id'),
  validationErrors: jsonb('validation_errors'),
  expiresAt: timestamp('expires_at').notNull(),
}, (t) => ({
  pk: index('pk_hl7_inbound_proposal_id_proposed').on(t.id, t.proposedAt),
  orgStatusIdx: index('idx_hip_org_status').on(t.organizationId, t.proposalStatus),
  expiresIdx: index('idx_hip_expires').on(t.expiresAt).where('proposal_status = \'pending\''),
  matchedPatientIdx: index('idx_hip_matched_patient').on(t.matchedPatientId).where('matched_patient_id IS NOT NULL'),
}))
```

```typescript
// packages/db/src/schema/external-interfaces/lab-observation.ts
import { pgTable, uuid, text, timestamp, numeric, boolean, integer, index } from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import { hl7MessageInbound } from './hl7-messages'
import * as e from './enums'

export const labObservation = pgTable('lab_observation', {
  id: uuid('id').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  sourceMessageId: uuid('source_message_id').notNull(),
  patientId: uuid('patient_id').notNull(),                          // M5 ref, app-side
  orderId: uuid('order_id'),                                        // M11 ref, app-side, nullable
  observationDate: timestamp('observation_date').notNull(),
  collectionDate: timestamp('collection_date'),
  resultStatus: e.labResultStatus('result_status').notNull(),
  performingLabFacilityId: uuid('performing_lab_facility_id'),      // M40 ref, app-side
  orderingPhysicianNpi: text('ordering_physician_npi'),
  loincCode: text('loinc_code').notNull(),
  loincDisplayText: text('loinc_display_text').notNull(),
  terminologyValidation: e.labTerminologyValidation('terminology_validation').notNull(),
  abnormalSummary: e.labAbnormalSummary('abnormal_summary').notNull(),
  attachedDocumentId: uuid('attached_document_id'),                 // M22 ref, app-side, nullable
  sudRedactedAtIngest: boolean('sud_redacted_at_ingest').notNull().default(false),
  previousObservationId: uuid('previous_observation_id'),           // for corrected results
  receivedAt: timestamp('received_at').notNull().defaultNow(),
}, (t) => ({
  pk: index('pk_lab_observation_id_received').on(t.id, t.receivedAt),
  orgPatientIdx: index('idx_lo_org_patient').on(t.organizationId, t.patientId),
  patientDateIdx: index('idx_lo_patient_date').on(t.patientId, t.observationDate),
  orderIdx: index('idx_lo_order').on(t.orderId).where('order_id IS NOT NULL'),
  abnormalIdx: index('idx_lo_abnormal').on(t.abnormalSummary).where('abnormal_summary IN (\'any_critical\',\'any_abnormal\')'),
}))

export const labObservationValue = pgTable('lab_observation_value', {
  id: uuid('id').notNull(),
  observationId: uuid('observation_id').notNull(),
  obxSetId: integer('obx_set_id').notNull(),
  loincCode: text('loinc_code').notNull(),
  loincDisplayText: text('loinc_display_text').notNull(),
  terminologyValidation: e.labTerminologyValidation('terminology_validation').notNull(),
  valueType: e.labValueType('value_type').notNull(),
  numericValue: numeric('numeric_value', { precision: 18, scale: 6 }),
  stringValue: text('string_value'),
  units: text('units'),
  referenceRange: text('reference_range'),
  abnormalFlag: e.labAbnormalFlag('abnormal_flag'),
  performedAt: timestamp('performed_at'),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
}, (t) => ({
  pk: index('pk_lab_observation_value_id_received').on(t.id, t.receivedAt),
  observationIdx: index('idx_lov_observation').on(t.observationId, t.obxSetId),
  loincIdx: index('idx_lov_loinc').on(t.loincCode),
}))

export const labObservationInboundLink = pgTable('lab_observation_inbound_link', {
  id: uuid('id').primaryKey().defaultRandom(),
  observationId: uuid('observation_id').notNull(),
  sourceMessageId: uuid('source_message_id').notNull(),
  sourceOrderId: uuid('source_order_id'),
  obrPlacerOrderNumber: text('obr_placer_order_number'),
  matchMethod: e.labMatchMethod('match_method').notNull(),
  matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
  // ── Candidate patient routing (populated by T-29.07 when lab matches cascade L4/L5 candidate) ──
  candidatePatientId: uuid('candidate_patient_id'),                     // populated when unmatched-with-candidate
  candidateMatchLevel: e.hl7InboundMatchLevel('candidate_match_level'), // L4_DEMOGRAPHIC_BRIDGE_CANDIDATE | L5_LOOSE_NAME_DOB_CANDIDATE
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  observationIdx: index('idx_lol_observation').on(t.observationId),
  placerIdx: index('idx_lol_placer').on(t.obrPlacerOrderNumber).where('obr_placer_order_number IS NOT NULL'),
}))
```

```typescript
// packages/db/src/schema/external-interfaces/nppes.ts
// Platform-shared tables — NO organization_id; written under withPlatformContext
import { pgTable, uuid, char, text, timestamp, jsonb, date, integer, index } from 'drizzle-orm/pg-core'
import * as e from './enums'

export const nppesProvider = pgTable('nppes_provider', {
  npi: char('npi', { length: 10 }).primaryKey(),
  enumerationType: e.nppesEnumerationType('enumeration_type').notNull(),
  status: e.nppesProviderStatus('status').notNull(),
  deactivationDate: date('deactivation_date'),
  deactivationReason: text('deactivation_reason'),
  reactivationDate: date('reactivation_date'),
  basic: jsonb('basic').notNull(),
  addresses: jsonb('addresses').notNull().default([]),
  taxonomies: jsonb('taxonomies').notNull().default([]),
  identifiers: jsonb('identifiers').notNull().default([]),
  endpoints: jsonb('endpoints').notNull().default([]),
  lastUpdatedInNppes: date('last_updated_in_nppes'),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
}, (t) => ({
  statusIdx: index('idx_np_status').on(t.status),
  fetchedAtIdx: index('idx_np_fetched_at').on(t.fetchedAt),
}))

export const nppesSyncRun = pgTable('nppes_sync_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: e.nppesSyncKind('kind').notNull(),
  triggeredBy: e.nppesSyncTrigger('triggered_by').notNull(),
  triggeredByMembershipId: uuid('triggered_by_membership_id'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  status: e.nppesSyncStatus('status').notNull().default('in_progress'),
  providersFetchedCount: integer('providers_fetched_count').notNull().default(0),
  providersUpdatedCount: integer('providers_updated_count').notNull().default(0),
  providersDeactivatedCount: integer('providers_deactivated_count').notNull().default(0),
  errorsCount: integer('errors_count').notNull().default(0),
  errorDetails: jsonb('error_details'),
  sourceFileUrl: text('source_file_url'),
}, (t) => ({
  startedIdx: index('idx_nsr_started').on(t.startedAt),
  statusIdx: index('idx_nsr_status').on(t.status),
}))
```

```typescript
// packages/db/src/schema/external-interfaces/feed-health.ts
import { pgTable, uuid, integer, timestamp, bigint, primaryKey } from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import { externalFeed } from './feed'

export const externalFeedHealth = pgTable('external_feed_health', {
  feedId: uuid('feed_id').notNull().references(() => externalFeed.id),
  hourBucket: timestamp('hour_bucket').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id),
  listenerUpSeconds: integer('listener_up_seconds').notNull().default(0),
  listenerDownSeconds: integer('listener_down_seconds').notNull().default(0),
  inboundMessageCount: integer('inbound_message_count').notNull().default(0),
  outboundMessageCount: integer('outbound_message_count').notNull().default(0),
  ackAaCount: integer('ack_aa_count').notNull().default(0),
  ackAeCount: integer('ack_ae_count').notNull().default(0),
  ackArCount: integer('ack_ar_count').notNull().default(0),
  ackTimeoutCount: integer('ack_timeout_count').notNull().default(0),
  inboundBytes: bigint('inbound_bytes', { mode: 'number' }).notNull().default(0),
  outboundBytes: bigint('outbound_bytes', { mode: 'number' }).notNull().default(0),
  parseErrorCount: integer('parse_error_count').notNull().default(0),
  senderRejectedCount: integer('sender_rejected_count').notNull().default(0),
  lastMessageAt: timestamp('last_message_at'),
}, (t) => ({
  pk: primaryKey({ columns: [t.feedId, t.hourBucket] }),
}))
```

### 3.4 Critical Indexes (Beyond Above)

- **`hl7_message_inbound`:** `(organization_id, feed_id, received_at DESC)` — the operator dashboard "recent inbound by feed" query.
- **`hl7_message_inbound`:** `(idempotency_key)` — unique; the M1 idempotency middleware lookup.
- **`hl7_message_inbound`:** `(payload_sha256)` — replay detection on the rare "duplicate physical message under a new control id" case.
- **`hl7_message_outbound`:** `(status, next_retry_at)` partial index — the outbound retry worker's claim query.
- **`hl7_inbound_proposal`:** `(expires_at)` WHERE `proposal_status='pending'` — the SLA-watch worker's expiry scan.
- **`lab_observation`:** `(patient_id, observation_date DESC)` — patient-chart "recent labs" query.
- **`lab_observation`:** `(order_id)` WHERE `order_id IS NOT NULL` — M11's "fulfillment by order" query.
- **`lab_observation_value`:** `(observation_id, obx_set_id)` — the per-result-row read.
- **`nppes_provider`:** `(last_updated_in_nppes DESC)` — the incremental-sync diff query.

### 3.5 RLS Policy Pattern

```sql
-- Standard per-tenant RLS on M29 tables that carry organization_id
ALTER TABLE external_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_feed_org_isolation ON external_feed
  USING (organization_id = current_setting('app.org_id', true)::uuid);

ALTER TABLE external_feed_credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY efc_org_isolation ON external_feed_credential
  USING (organization_id = current_setting('app.org_id', true)::uuid);

-- Pattern repeats for hl7_message_inbound, hl7_message_outbound,
-- hl7_inbound_proposal, lab_observation, lab_observation_value,
-- lab_observation_inbound_link, external_feed_health

-- Platform-shared tables: NPPES — no organization_id; readable by wardenx_app, writable only by wardenx_admin
ALTER TABLE nppes_provider ENABLE ROW LEVEL SECURITY;
CREATE POLICY nppes_provider_read ON nppes_provider FOR SELECT USING (true);
CREATE POLICY nppes_provider_write ON nppes_provider FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);

ALTER TABLE nppes_sync_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY nppes_sync_run_read ON nppes_sync_run FOR SELECT USING (true);
CREATE POLICY nppes_sync_run_write ON nppes_sync_run FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);
```

**Cross-partition app-side FK note.** `hl7_inbound_proposal.source_message_id`, `lab_observation.source_message_id`, and `lab_observation_inbound_link.source_message_id` reference the partitioned `hl7_message_inbound` table. Postgres does not enforce FK constraints to partitioned-parent tables; the references are app-side, validated by the service layer at write time. The same pattern applies to all cross-module references (`order_id`, `patient_id`, `attached_document_id`, `performing_lab_facility_id`, `sending_facility_id`, `destination_facility_id`) per the architecture §25.15 outbox-only-cross-module rule.

### 3.6 Audit Trigger Denylist (M11 D11 / M17 §3.6 Pattern)

Per the M4 §3.6 PHI-table conventions, every M29-owned table has the standard write-audit trigger. The trigger denylist:

| Table | Denylisted columns (value not captured) | Hash digest captured instead |
|-------|------------------------------------------|------------------------------|
| `external_feed_credential` | `secret_cipher` | n/a — the ciphertext is itself only audit-relevant in change-events; the M4 mutation-audit captures the column-changed event without the value |
| `hl7_message_inbound` | `payload_cipher`, `parsed_segments_cipher` | `payload_sha256` already present as a first-class column — value-capture uses it; the parsed-segments tree is captured by its `parsed_segments_sha256` column the same way |
| `hl7_message_outbound` | `payload_cipher`, `ack_payload_cipher` | `payload_sha256` for the request payload; the ack payload is captured by an `ack_payload_sha256` materialized at write time (added by §3.3 schema) |
| `hl7_inbound_proposal` | `proposed_patient_candidate` (carries PHI demographic candidate) | hash digest of the candidate JSON captured |
| `nppes_provider` | none (public-directory data; no PHI) | n/a |

The audit posture: the *fact* of a write to these tables is always captured (timestamp, actor, before/after row identity); the *value* of PHI-bearing or secret-bearing columns is replaced with a hash digest for tamper-detection without surfacing the value in the audit table. The M4 audit-replay tooling consults the per-tenant DEK for the originating row when the disclosure-accounting workflow needs the actual value (e.g., a §164.528 request that names a specific HL7 message).

### 3.7 Eraser Registration (M4 Destruction Workflow)

```typescript
// apps/backend/src/modules/29-external-interfaces/boot.ts (excerpt)
import { registerEraser } from '@wardenx/foundation/eraser-registry'
import type { DataEraser } from '@wardenx/foundation/interfaces'

const externalInterfacesEraser: DataEraser = {
  className: 'external_interfaces',
  retentionClasses: ['compliance', 'operational'],
  async erase(input) {
    // For each table M29 owns, walk the rows scoped to the destruction-cert target
    // and apply per-row destruction per the M4 destruction-cert workflow.
    // The cryptographic-shred path applies to payload_cipher columns: the per-tenant
    // DEK is destroyed, which renders the envelope-encrypted payload unrecoverable.
    // ...full implementation per M4 §3.7
  },
}

registerEraser('external_interfaces', externalInterfacesEraser)
```

Per-table behavior:

| Table | Retention class | Eraser behavior |
|-------|-----------------|-----------------|
| `external_feed` | `compliance` | Tombstone (`status='revoked'`, `revoked_at` populated); row retained for audit |
| `external_feed_credential` | `compliance` | Active credential retired; `secret_cipher` destroyed via per-tenant DEK destruction |
| `hl7_message_inbound` | `compliance` | Cryptographic-shred (`payload_cipher` rendered unrecoverable via DEK destruction); row metadata retained |
| `hl7_message_outbound` | `compliance` | Same as inbound |
| `hl7_inbound_proposal` | `compliance` | Cryptographic-shred of `proposed_patient_candidate` jsonb (re-encrypt with null); status, timestamps, decision retained |
| `lab_observation` | `compliance` | Per-row destruction following M4 destruction-cert; cascades to `lab_observation_value` and `lab_observation_inbound_link` |
| `lab_observation_value` | `compliance` | Cascade from `lab_observation` |
| `lab_observation_inbound_link` | `compliance` | Cascade from `lab_observation` |
| `nppes_provider` | `operational` | No destruction path for tenants; the platform row is rebuildable from re-sync |
| `nppes_sync_run` | `compliance` | Retained 7 years; platform-shared audit |
| `external_feed_health` | `operational` | Aged at 90 days by M4 retention runner |


---

## 4. API Routes, Seams & Backend Surface

M29 exposes three audiences from its HTTP surface and one set of cross-module-callable seams:

1. **Operator / Compliance Officer routes** (`/api/admin/external-interfaces/...`) — feed CRUD, credential rotation, NPPES manual sync trigger, message search, proposal review.
2. **Clinician routes** (`/api/clinical/labs/...`) — read of attached `lab_observation` rows, abnormal-flag alert acknowledgment, unmatched-lab review.
3. **MLLP listeners** — NOT HTTP. Per D3 these are TCP listeners bound on a per-feed port; documented in §4.11 below. The HTTP surface only exposes their status (read) and lifecycle controls (start/stop on operator action).
4. **Published seams** — typed, deny-by-default cross-module callables registered in `SeamRegistry`; never reachable via HTTP from outside the backend.

The route inventory below uses the standard `<verb> <path>` notation and the M28 §4 conventions (request shape via TypeBox `Static<typeof X>`, response shape, permission key, ABAC predicates, audit category, idempotency posture, step-up requirement, rate-limit class).

### 4.1 Route Inventory — Operator Surface (`/api/admin/external-interfaces`)

#### 4.1.1 Feed Management

| Verb | Path | Purpose | Permission key | Step-up | Audit cat |
|------|------|---------|----------------|---------|-----------|
| `GET` | `/feeds` | List feeds for tenant, paginated, filterable by `feed_type`/`status`/`direction` | `external_interfaces.feed.read` | — | `read` |
| `GET` | `/feeds/:feedId` | Single feed detail, includes redacted credential metadata (rotation history, key version, NEVER ciphertext) | `external_interfaces.feed.read` | — | `read` |
| `POST` | `/feeds` | Create a feed in `pending_activation` (D24 manifest: M40 BAA gate enforced) | `external_interfaces.feed.create` | **Required** (D18) | `write` |
| `PATCH` | `/feeds/:feedId` | Edit non-credential metadata (display name, connectivity hints, peer cert fingerprint pin) | `external_interfaces.feed.update` | **Required** (D18) | `write` |
| `POST` | `/feeds/:feedId/activate` | Transition `pending_activation` → `active`; runs M40 BAA gate (D16); writes outbox `m29.external_feed.activated` | `external_interfaces.feed.activate` | **Required** (D18) | `compliance_action` |
| `POST` | `/feeds/:feedId/suspend` | Transition to `suspended`; writes outbox `m29.external_feed.suspended` (reason required) | `external_interfaces.feed.suspend` | **Required** (D18) | `compliance_action` |
| `POST` | `/feeds/:feedId/revoke` | Transition to `revoked` (terminal); cascade-revoke all credentials | `external_interfaces.feed.revoke` | **Required** (D18); **dual-approval (D20 predicate `external_feed_compliance_co_approver_distinct`)** | `compliance_action` |
| `POST` | `/feeds/:feedId/credentials` | Mint or rotate a credential (mTLS key pair, NPPES bearer token slot, SFTP key slot Phase 2) | `external_interfaces.credential.rotate` | **Required** (D18) | `secret_rotation` |
| `GET` | `/feeds/:feedId/credentials` | List credential metadata (active, retired, rotation history — NEVER ciphertext) | `external_interfaces.credential.read` | — | `read` |
| `GET` | `/feeds/:feedId/health` | Current `external_feed_health` row plus last N events from M4 audit chain | `external_interfaces.feed.read` | — | `read` |

#### 4.1.2 HL7 Inbound Proposal Review (ADT)

The propose-then-review pattern (D5, mirroring M28 D8) routes ADT-derived patient-demographic mutations through a queue that a compliance officer or supervising RN must adjudicate.

| Verb | Path | Purpose | Permission key | Step-up | Audit cat |
|------|------|---------|----------------|---------|-----------|
| `GET` | `/inbound-proposals` | List proposals, filterable by `status`, `owner_module`, `feed_id`, `proposed_for_patient_id` | `external_interfaces.proposal.read` | — | `read` |
| `GET` | `/inbound-proposals/:proposalId` | Single proposal with the full diff between the candidate payload and current M5 row (or "no candidate" for new patient) | `external_interfaces.proposal.read` | — | `read` |
| `POST` | `/inbound-proposals/:proposalId/accept` | Adjudicate → apply via owner-module seam (D5); writes `m29.hl7_inbound_proposal.accepted`; sets `status='accepted'` | `external_interfaces.proposal.accept` | **Required** (D18) | `phi_mutation` |
| `POST` | `/inbound-proposals/:proposalId/reject` | Adjudicate → no mutation; writes `m29.hl7_inbound_proposal.rejected`; reason required | `external_interfaces.proposal.reject` | **Required** (D18) | `compliance_action` |
| `POST` | `/inbound-proposals/:proposalId/defer` | Punt to caseload RN as a task (forward-seam to M19); status stays `pending` | `external_interfaces.proposal.defer` | — | `write` |

ABAC predicate `hl7_inbound_proposal_owner_module_match` (D20) is evaluated on accept/reject: the actor's role must be authorized for the proposal's `owner_module` (e.g., a billing officer cannot accept an ADT proposal whose `owner_module='M5'`).

#### 4.1.3 HL7 Message Search & Replay

| Verb | Path | Purpose | Permission key | Step-up | Audit cat |
|------|------|---------|----------------|---------|-----------|
| `GET` | `/messages/inbound` | Search inbound messages, filterable by `feed_id`, `message_type`, `message_control_id`, `received_at` range, `processing_status` | `external_interfaces.message.read` | — | `read` |
| `GET` | `/messages/inbound/:messageId` | Single inbound message — metadata only by default; full plaintext requires the dedicated decrypt route below | `external_interfaces.message.read` | — | `read` |
| `POST` | `/messages/inbound/:messageId/decrypt` | Server-side decrypt for compliance review; writes M4 disclosure-accounting event; rate-limited (1 per 5s per actor) | `external_interfaces.message.read_plaintext` | **Required** (D18) | `phi_disclosure` |
| `POST` | `/messages/inbound/:messageId/replay` | Re-enqueue parsing/matching pipeline for a message in `quarantined` or `parse_failed` state; idempotent by `(message_id, replay_count)` | `external_interfaces.message.replay` | **Required** (D18) | `compliance_action` |
| `GET` | `/messages/outbound` | Search outbound messages, filterable by `feed_id`, `placer_order_number` (= M11 `order_record.id`), `dispatch_status` | `external_interfaces.message.read` | — | `read` |
| `GET` | `/messages/outbound/:messageId` | Single outbound message, includes ACK/NACK chain | `external_interfaces.message.read` | — | `read` |
| `POST` | `/messages/outbound/:messageId/retry` | Manual retry after DLQ landing (D9); requires `last_attempt_status` to be `nack` or `expired` | `external_interfaces.message.retry` | **Required** (D18) | `compliance_action` |

#### 4.1.4 NPPES Administration

| Verb | Path | Purpose | Permission key | Step-up | Audit cat |
|------|------|---------|----------------|---------|-----------|
| `GET` | `/nppes/providers/:npi` | Read a single platform-shared NPPES row (no PHI; public-directory) | `external_interfaces.nppes.read` | — | `read` |
| `GET` | `/nppes/sync-runs` | List sync run history (platform-shared, requires platform-role caller) | `external_interfaces.nppes.read` | — | `read` |
| `POST` | `/nppes/sync-runs` | Trigger a manual sync; predicate `nppes_platform_job_caller` enforces platform-role (D20); writes `m29.nppes.sync_run.started` | `external_interfaces.nppes.sync_trigger` | **Required** (D18) | `compliance_action` |

#### 4.1.5 Operations Surface (Read-Mostly)

| Verb | Path | Purpose | Permission key | Step-up | Audit cat |
|------|------|---------|----------------|---------|-----------|
| `GET` | `/health/aggregate` | Health overview for tenant — listener up/down, queue depths, error rates, last successful ACK timestamps | `external_interfaces.feed.read` | — | `read` |
| `GET` | `/metrics/listener-status` | Per-feed listener TCP socket status, current connection count vs. `mllp_max_connections` | `external_interfaces.feed.read` | — | `read` |

### 4.2 Route Inventory — Clinician Surface (`/api/clinical/labs`)

The clinician surface is deliberately narrow. Caseload-scoped reads of `lab_observation` and the abnormal-flag review queue.

| Verb | Path | Purpose | Permission key | Step-up | Audit cat |
|------|------|---------|----------------|---------|-----------|
| `GET` | `/observations` | List lab observations for patients in the caller's caseload; filterable by `patient_id`, `loinc_code`, `observation_datetime` range, `abnormal_flag` | `external_interfaces.lab.read` | — | `read` |
| `GET` | `/observations/:observationId` | Single observation with its `lab_observation_value` rows | `external_interfaces.lab.read` | — | `read` |
| `GET` | `/observations/unmatched` | Unmatched lab observations review queue (failed patient-match cascade per D6); compliance/lab-supervisor role | `external_interfaces.lab.review_unmatched` | — | `read` |
| `POST` | `/observations/:observationId/attach-patient` | Manual patient attach for an unmatched observation; writes `m29.lab_observation.manually_matched`; predicate `lab_observation_patient_caseload_or_scope` (D20) | `external_interfaces.lab.review_unmatched` | **Required** (D18) | `phi_mutation` |
| `POST` | `/observations/:observationId/discard` | Discard an unmatched observation (typo NPI on sender, off-tenant patient, etc.); reason required; writes `m29.lab_observation.discarded` | `external_interfaces.lab.review_unmatched` | **Required** (D18) | `compliance_action` |
| `POST` | `/observations/:observationId/acknowledge-abnormal` | RN acknowledges an abnormal-flag alert (D7); clears the M36 alert badge | `external_interfaces.lab.acknowledge_abnormal` | — | `clinical_action` |

The `lab_observation_patient_caseload_or_scope` predicate (D20) is the gatekeeper for both read and write — it ensures the caller either (a) has the patient in their active caseload via `CaseloadProvider`, or (b) has a wide-scope role (e.g., DON, Medical Director) authorized to read across the org.

### 4.3 TypeBox Schemas — Selected (Wire Contracts)

The schema file lives at `apps/backend/src/modules/29-external-interfaces/schemas/index.ts`. Below are the highest-leverage shapes.

```typescript
import { Type, Static } from '@sinclair/typebox'

// Reused enum mirrors of the Drizzle pgEnums (kept in sync via a compile-time check)
export const FeedTypeSchema = Type.Union([
  Type.Literal('hl7v2_inbound_adt'),
  Type.Literal('hl7v2_inbound_lab'),
  Type.Literal('hl7v2_outbound_orm'),
  Type.Literal('nppes_public'),
  Type.Literal('xero_consumer'),
  Type.Literal('gusto_consumer'),
])

export const FeedStatusSchema = Type.Union([
  Type.Literal('pending_activation'),
  Type.Literal('active'),
  Type.Literal('suspended'),
  Type.Literal('revoked'),
])

// ─── Feed CRUD ──────────────────────────────────────────────────────────
export const CreateFeedBodySchema = Type.Object({
  feedType: FeedTypeSchema,
  direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound'), Type.Literal('bidirectional')]),
  displayName: Type.String({ minLength: 3, maxLength: 120 }),
  sendingFacilityId: Type.Optional(Type.String({ maxLength: 80 })),
  sendingApplicationId: Type.Optional(Type.String({ maxLength: 80 })),
  mllpHost: Type.Optional(Type.String({ maxLength: 255 })),
  mllpPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
  mllpListenerPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
  peerCertSha256Pin: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  senderIpAllowlist: Type.Array(Type.String({ format: 'cidr' }), { maxItems: 64 }),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
})
export type CreateFeedBody = Static<typeof CreateFeedBodySchema>

export const FeedResponseSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  feedType: FeedTypeSchema,
  direction: Type.String(),
  displayName: Type.String(),
  status: FeedStatusSchema,
  sendingFacilityId: Type.Optional(Type.String()),
  sendingApplicationId: Type.Optional(Type.String()),
  mllpHost: Type.Optional(Type.String()),
  mllpPort: Type.Optional(Type.Integer()),
  mllpListenerPort: Type.Optional(Type.Integer()),
  peerCertSha256Pin: Type.Optional(Type.String()),
  senderIpAllowlist: Type.Array(Type.String()),
  baaSatisfiedAt: Type.Optional(Type.String({ format: 'date-time' })),
  activatedAt: Type.Optional(Type.String({ format: 'date-time' })),
  suspendedAt: Type.Optional(Type.String({ format: 'date-time' })),
  revokedAt: Type.Optional(Type.String({ format: 'date-time' })),
  createdAt: Type.String({ format: 'date-time' }),
  createdBy: Type.String({ format: 'uuid' }),
})
export type FeedResponse = Static<typeof FeedResponseSchema>

// ─── Inbound Proposal Adjudication ──────────────────────────────────────
export const ProposalDecisionBodySchema = Type.Object({
  decisionNote: Type.String({ minLength: 1, maxLength: 2000 }),
  appliedFields: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
})
export type ProposalDecisionBody = Static<typeof ProposalDecisionBodySchema>

export const InboundProposalResponseSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  feedId: Type.String({ format: 'uuid' }),
  inboundMessageId: Type.String({ format: 'uuid' }),
  ownerModule: Type.String(),
  proposalKind: Type.String(),
  proposedForPatientId: Type.Optional(Type.String({ format: 'uuid' })),
  candidateDigest: Type.String(),
  status: Type.String(),
  decidedAt: Type.Optional(Type.String({ format: 'date-time' })),
  decidedBy: Type.Optional(Type.String({ format: 'uuid' })),
  decisionNote: Type.Optional(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
})
export type InboundProposalResponse = Static<typeof InboundProposalResponseSchema>

// ─── Lab Observation (Clinician Surface) ────────────────────────────────
export const LabObservationResponseSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  patientId: Type.Optional(Type.String({ format: 'uuid' })),
  orderRecordId: Type.Optional(Type.String({ format: 'uuid' })),
  loincCode: Type.String(),
  observationDatetime: Type.String({ format: 'date-time' }),
  abnormalFlag: Type.String(),
  acknowledgedAt: Type.Optional(Type.String({ format: 'date-time' })),
  acknowledgedBy: Type.Optional(Type.String({ format: 'uuid' })),
  values: Type.Array(Type.Object({
    valueType: Type.String(),
    numericValue: Type.Optional(Type.Number()),
    unitCode: Type.Optional(Type.String()),
    stringValue: Type.Optional(Type.String()),
    referenceRangeLow: Type.Optional(Type.Number()),
    referenceRangeHigh: Type.Optional(Type.Number()),
  })),
})
export type LabObservationResponse = Static<typeof LabObservationResponseSchema>

// ─── NPPES ──────────────────────────────────────────────────────────────
export const NppesProviderResponseSchema = Type.Object({
  npi: Type.String({ pattern: '^[0-9]{10}$' }),
  enumerationType: Type.String(),
  firstName: Type.Optional(Type.String()),
  lastName: Type.Optional(Type.String()),
  organizationName: Type.Optional(Type.String()),
  primaryTaxonomyCode: Type.Optional(Type.String()),
  primaryTaxonomyDescription: Type.Optional(Type.String()),
  practiceAddress: Type.Optional(Type.Object({
    line1: Type.String(),
    line2: Type.Optional(Type.String()),
    city: Type.String(),
    state: Type.String(),
    postalCode: Type.String(),
  })),
  lastSyncedAt: Type.String({ format: 'date-time' }),
  syncSource: Type.String(),
})
export type NppesProviderResponse = Static<typeof NppesProviderResponseSchema>
```

A compile-time test in `tests/unit/typebox-pgenum-parity.test.ts` verifies that `FeedTypeSchema` and `FeedStatusSchema` (and the other enum-mirror schemas) contain exactly the same string literal set as the corresponding Drizzle `pgEnum` definitions — drift between the two is a build break.

### 4.4 Published Seams (`SeamRegistry`)

Per the WardenX seam-registry pattern, every M29-published cross-module callable is a typed interface, registered at boot, validated by the seam-validation gate (M1 §3.4), and consumed via `SeamRegistry.get(...)`. None of these are HTTP-reachable.

```typescript
// packages/foundation/src/interfaces/external-interfaces-seams.ts

/** Read-side projection of a lab_observation for cross-module consumers (M28 FHIR, M9 Phase 2). */
export interface LabObservationReader {
  /**
   * Read a single observation by id, scoped to the supplied (organizationId, patientId).
   * Returns null when not found OR when the row exists but the (org, patient) pair does
   * not match — the caller cannot disambiguate the two, by design.
   */
  getById(opts: {
    organizationId: string
    patientId: string
    observationId: string
  }): Promise<LabObservationDTO | null>

  /**
   * List observations for a patient, ordered by observation_datetime DESC, paginated.
   * Caller must provide the M3 ABAC predicate-eval token; M29 re-evaluates via
   * `lab_observation_patient_caseload_or_scope`.
   */
  listByPatient(opts: {
    organizationId: string
    patientId: string
    actorContext: ActorContext
    sinceDatetime?: Date
    limit?: number     // default 50, max 500
    cursor?: string
  }): Promise<{ items: LabObservationDTO[]; nextCursor?: string }>

  /**
   * Stream all observations for a patient since a given timestamp.
   * Returns an async iterator. Designed for M28 FHIR `_since` queries and M9 trending.
   */
  streamSince(opts: {
    organizationId: string
    patientId: string
    sinceDatetime: Date
    actorContext: ActorContext
  }): AsyncIterable<LabObservationDTO>
}

/** Read-side projection of HL7 inbound proposals for cross-module review surfaces. */
export interface Hl7InboundProposalReader {
  /**
   * List proposals owned by a specific module that target a patient.
   * Used by M5 to render the "pending demographic changes from HL7" badge.
   */
  listForPatient(opts: {
    organizationId: string
    patientId: string
    ownerModule: 'M5' | 'M6'
    status?: 'pending' | 'accepted' | 'rejected' | 'deferred' | 'superseded'
  }): Promise<InboundProposalDTO[]>

  /**
   * Count of pending proposals for the organization by owner module, used by
   * M14/M19 dashboards to surface review backlog metrics.
   */
  countPendingByOwner(opts: {
    organizationId: string
  }): Promise<Record<'M5' | 'M6', number>>
}

/** Read-side projection of external_feed for cross-module status surfaces. */
export interface ExternalFeedReader {
  /**
   * List feeds for the org, with their current health snapshot. Consumed by
   * M34 (SaaS Console) and M33 (Reporting); never exposes credentials.
   */
  listForOrganization(opts: {
    organizationId: string
    feedType?: FeedType
    status?: FeedStatus
  }): Promise<FeedSummaryDTO[]>

  /**
   * Get the current health snapshot for a single feed, used by M36
   * to attach context to listener-down alerts.
   */
  getHealth(opts: {
    organizationId: string
    feedId: string
  }): Promise<FeedHealthDTO | null>
}

/** Read-side projection of NPPES providers. Platform-shared, no tenant scope. */
export interface NppesProviderReader {
  /**
   * Lookup a single NPI. Returns null when not found in the local cache and
   * the optional `allowLiveFetch` is false; otherwise live-fetches from NPPES
   * public API and caches the row.
   */
  getByNpi(opts: {
    npi: string
    allowLiveFetch?: boolean
  }): Promise<NppesProviderDTO | null>

  /**
   * Batch lookup. Returns one entry per requested NPI (null when not found).
   * Used by M28 Practitioner endpoint and M40 prescriber-roster sync.
   */
  getByNpis(opts: {
    npis: string[]
  }): Promise<Map<string, NppesProviderDTO | null>>
}

/** Metric-shape projection of M29 internal state for M33/M35 reporting. */
export interface ExternalInterfaceMetricsProvider {
  /**
   * Counts, durations, and error rates by feed for a time window.
   * Pure read; no PHI; safe to expose to M33 reporting cubes.
   */
  getFeedMetrics(opts: {
    organizationId: string
    feedId?: string
    windowStart: Date
    windowEnd: Date
  }): Promise<FeedMetricsDTO[]>
}

// Boot-time registration in apps/backend/src/modules/29-external-interfaces/boot.ts
import { SeamRegistry } from '@wardenx/foundation/seam-registry'
SeamRegistry.register('LabObservationReader', new LabObservationReaderImpl(db, deps))
SeamRegistry.register('Hl7InboundProposalReader', new Hl7InboundProposalReaderImpl(db))
SeamRegistry.register('ExternalFeedReader', new ExternalFeedReaderImpl(db))
SeamRegistry.register('NppesProviderReader', new NppesProviderReaderImpl(db, nppesClient))
SeamRegistry.register('ExternalInterfaceMetricsProvider', new ExternalInterfaceMetricsProviderImpl(db))
```

The seam-validation gate at boot (M1 §3.4) asserts the five seams are registered with implementations matching the typed interface; absence → boot-fail.

### 4.5 Consumed Seams

M29 consumes the following seams from other modules. Each is fetched from `SeamRegistry` at request time; the seam-validation gate at boot ensures the deps are present before M29's listeners go live.

| Seam (consumed) | Owner | Why M29 needs it |
|-----------------|-------|------------------|
| `PatientReader` | M5 | Five-level patient-match cascade (D6); proposal adjudication looks up the current M5 row |
| `PatientMutator` | M5 | Proposal accept path applies a candidate diff to M5 demographics |
| `CaseloadProvider` | M5 | Lab abnormal-flag alert routing (D7); ABAC predicate `lab_observation_patient_caseload_or_scope` |
| `OrderRecordReader` | M11 | Outbound ORM dispatch reads the M11 `order_record` to populate OBR-2 (D8); lab-attach uses the same to back-resolve |
| `OrderRecordMutator` | M11 | On lab attach, sets `order_record.status='partially_resulted'` or `'fully_resulted'` via the mutator |
| `EncounterReader` | M8 | ADT A03 (discharge) proposal context surfaces the current visit |
| `MedicationOrderProvider` | M12 | Future: outbound prescription forwarding (Phase 2, deny-stub today) |
| `IdentityResolver` | M2 | Actor-context resolution for step-up checks and audit fields |
| `AuditLogger` | M4 | Every PHI mutation, every phi_disclosure, every secret_rotation event is written here |
| `OutboxPublisher` | M4 | All cross-module events (§4.10) |
| `ConsentEvaluator` | M39 | Ingress SUD redaction (D15); evaluated per inbound message before persistence |
| `BaaStatusProvider` | M40 | BAA gate on feed activation AND outbound dispatch (D16) |
| `TerminologyProvider` | M38 | LOINC code resolution & validation; ICD-10 cross-walk for lab panel naming |
| `MasterDataProvider` | M40 | NPI → platform-role provider resolution; sender-facility-id → tenant resolution for inbound routing |
| `AlertDispatcher` | M36 | Listener-down alerts (D17); abnormal-flag clinician alerts (D7); credential-expiring alerts |
| `XeroClientFactory` | M27 | Phase 2: AR sync; deny-stub today (D12) |
| `GustoClientFactory` | M27 | Phase 2: payroll-event ingest; deny-stub today (D12) |

The dependency-cruiser rule for M29 (per the architecture-fitness tooling) allows imports from the listed packages only; any cross-schema import from another module's `db` files is a hard CI failure.

### 4.6 Patient Match Cascade (D6) — Algorithmic Detail

The deterministic five-level cascade is the single most-consequential algorithm in M29. It runs on every inbound ADT and every inbound lab message; the output is either (a) a confident match → proceed, (b) a candidate match → propose-then-review queue, or (c) no match → unmatched-lab queue or new-patient-proposal queue.

```typescript
// packages/hl7-worker/src/match/patient-match.ts (sketch)
export type MatchOutcome =
  | { kind: 'confident_match'; patientId: string; level: 1 | 2 | 3 }
  | { kind: 'candidate_match'; patientId: string; level: 4 | 5; confidence: number }
  | { kind: 'no_match' }

export async function matchPatient(opts: {
  organizationId: string
  pid: ParsedPidSegment
  patientReader: PatientReader
}): Promise<MatchOutcome> {
  // ─── Level 1: Internal MRN match ─────────────────────────────────────
  // PID-3 carries an identifier list; we look for one whose assigning-authority
  // matches the org's configured `internal_mrn_authority`.
  const mrn = opts.pid.identifiers.find((id) => id.assigningAuthority === ORG_MRN_AUTH)?.value
  if (mrn) {
    const hit = await opts.patientReader.findByMrn({ organizationId: opts.organizationId, mrn })
    if (hit) return { kind: 'confident_match', patientId: hit.id, level: 1 }
  }

  // ─── Level 2: External-system MRN match ──────────────────────────────
  // Some PID-3 identifiers carry the sending hospital's MRN; M5 stores these
  // in `patient.external_mrn_list` (jsonb). Match against (assigning_authority, value).
  for (const id of opts.pid.identifiers) {
    if (id.assigningAuthority === ORG_MRN_AUTH) continue
    const hit = await opts.patientReader.findByExternalMrn({
      organizationId: opts.organizationId,
      assigningAuthority: id.assigningAuthority,
      value: id.value,
    })
    if (hit) return { kind: 'confident_match', patientId: hit.id, level: 2 }
  }

  // ─── Level 3: SSN-tail + DOB match (when SSN present) ────────────────
  // The last-4 SSN is in PID-19 on many feeds. Match (ssn_last4, date_of_birth).
  // Uniqueness within an organization is empirically reliable; we treat collisions
  // (more than one hit) as falling through to level 4.
  if (opts.pid.ssnLast4 && opts.pid.dateOfBirth) {
    const hits = await opts.patientReader.findBySsnLast4AndDob({
      organizationId: opts.organizationId,
      ssnLast4: opts.pid.ssnLast4,
      dateOfBirth: opts.pid.dateOfBirth,
    })
    if (hits.length === 1) return { kind: 'confident_match', patientId: hits[0].id, level: 3 }
  }

  // ─── Level 4: Name + DOB + sex (exact) ───────────────────────────────
  // Exact match on (last_name, first_name, date_of_birth, administrative_sex).
  // Single hit → candidate; multiple hits → confidence-drop to level 5.
  const exactHits = await opts.patientReader.findByNameDobSex({
    organizationId: opts.organizationId,
    lastName: opts.pid.lastName,
    firstName: opts.pid.firstName,
    dateOfBirth: opts.pid.dateOfBirth,
    administrativeSex: opts.pid.administrativeSex,
  })
  if (exactHits.length === 1) {
    return { kind: 'candidate_match', patientId: exactHits[0].id, level: 4, confidence: 0.92 }
  }

  // ─── Level 5: Name + DOB (loose; ignore sex; allow first-name initial) ─
  // Strictly fallback. A single hit → low-confidence candidate; multiple → no_match.
  const looseHits = await opts.patientReader.findByLooseName({
    organizationId: opts.organizationId,
    lastName: opts.pid.lastName,
    firstNameInitial: opts.pid.firstName?.[0],
    dateOfBirth: opts.pid.dateOfBirth,
  })
  if (looseHits.length === 1) {
    return { kind: 'candidate_match', patientId: looseHits[0].id, level: 5, confidence: 0.78 }
  }

  return { kind: 'no_match' }
}
```

The five levels are intentionally rule-based. Per D6 the probabilistic ML matcher is deferred to Phase 2 and will plug in as a sixth level (only invoked when levels 1–5 return `no_match`); the seam contract for that future matcher (`ProbabilisticPatientMatcher`) is declared as a forward-stub seam consumed by M29, currently bound to a deny-stub.

The match-outcome routing table — propose-then-review for ALL ADT outcomes:

| Outcome | ADT message | Lab message |
|---------|-------------|-------------|
| `confident_match` (L1-3) | Create `hl7_inbound_proposal` with `matched_patient_id=hit`, `match_outcome='matched_single'`, `match_level=L1/L2/L3`, `proposal_status='pending'`. **No auto-mutation** — the reviewer accepts/rejects via the §4.1.2 surface. Per D5, hospital ADT data is unreliable enough that even L1 MRN matches require human-in-loop on demographic updates. | Attach observation directly (`lab_observation.patient_id` populated); fire abnormal-flag clinician alert if applicable. Auto-attach for labs (D7) is intentionally distinct from propose-then-review for ADT — lab values are reportable observations, not chart mutations. |
| `candidate_match` (L4-5) | Create `hl7_inbound_proposal` with `matched_patient_id=hit`, `match_outcome='matched_single'`, `match_level=L4/L5`, `match_confidence=0.92|0.78`, `proposal_status='pending'`. Reviewer accepts/rejects same as L1-3, but the candidate label surfaces the lower confidence. | Create `lab_observation` with `patient_id=null`, link to candidate via `lab_observation_inbound_link.candidate_patient_id` + `candidate_match_level`; surfaced in §4.2 unmatched-lab queue with the candidate highlighted. |
| `ambiguous` (L3 or L4 multi-hit) | Create `hl7_inbound_proposal` with `matched_patient_id=null`, `match_outcome='matched_ambiguous'`, `match_candidate_ids=[…]`. The proposal surfaces the candidate list; reviewer picks one or rejects. | Create `lab_observation` with `patient_id=null`; the inbound-link row carries all candidate IDs in `match_candidate_ids` (JSONB) for the unmatched-queue reviewer. |
| `no_match` (ADT A01/A04/A08) | Create `hl7_inbound_proposal` with `matched_patient_id=null`, `resource_kind='new_patient'`, `proposal_status='pending'`. Reviewer creates a new M5 row or rejects. | Create `lab_observation` with `patient_id=null`; surfaced in unmatched-lab queue. |
| `no_match` (ADT A03/A11) | **Drop with audit** — can't discharge/cancel an unknown patient. Emit `m29.hl7_message.routing_dropped` event with reason `cannot_act_on_unknown_patient`. No proposal created. | n/a (only ADT message types A03/A11) |

Confident matches do **not** apply directly to M5/M6 without a proposal — that would contradict D5 (propose-then-review) and W-XI-01 (proposal expected even on L1, patient row not mutated until reviewer accepts). The clinical-safety floor (always human-review demographic updates from external sources) wins over the cascade-confidence floor.

### 4.7 Permission Keys (M3 RBAC)

The full permission-key set published by M29. Per the platform convention each key is `external_interfaces.<entity>.<action>`.

| Key | Default role-mapping | Purpose |
|-----|---------------------|---------|
| `external_interfaces.feed.read` | Compliance Officer, IT Admin, DON, Medical Director | Read feed metadata, health, message metadata |
| `external_interfaces.feed.create` | Compliance Officer, IT Admin | Create a new feed (initial state `pending_activation`) |
| `external_interfaces.feed.update` | Compliance Officer, IT Admin | Edit non-credential metadata |
| `external_interfaces.feed.activate` | Compliance Officer | Activation requires the BAA gate (D16) to clear |
| `external_interfaces.feed.suspend` | Compliance Officer, IT Admin | Pause a feed (operational issue, mid-investigation) |
| `external_interfaces.feed.revoke` | Compliance Officer (+ co-approver) | Terminal revocation; dual-approval (D20) |
| `external_interfaces.credential.read` | Compliance Officer, IT Admin | Read credential metadata (never ciphertext) |
| `external_interfaces.credential.rotate` | Compliance Officer, IT Admin | Mint/rotate (D18 step-up) |
| `external_interfaces.proposal.read` | Compliance Officer, Supervising RN, DON | Read the inbound-proposal review queue |
| `external_interfaces.proposal.accept` | Compliance Officer, Supervising RN | Adjudicate accept; predicate `hl7_inbound_proposal_owner_module_match` |
| `external_interfaces.proposal.reject` | Compliance Officer, Supervising RN | Adjudicate reject |
| `external_interfaces.proposal.defer` | Compliance Officer, Supervising RN | Punt to caseload RN as a task |
| `external_interfaces.message.read` | Compliance Officer, IT Admin (metadata only) | Search/list messages without plaintext |
| `external_interfaces.message.read_plaintext` | Compliance Officer (step-up; rate-limited) | Server-side decrypt for review; M4 disclosure-accounting event written |
| `external_interfaces.message.replay` | Compliance Officer | Re-enqueue a quarantined message |
| `external_interfaces.message.retry` | Compliance Officer, IT Admin | Manual retry of an outbound DLQ landing |
| `external_interfaces.nppes.read` | Compliance Officer, IT Admin, any role that needs NPI lookup (most) | Read NPPES cache |
| `external_interfaces.nppes.sync_trigger` | Platform Operator (NOT a tenant role) | Manual sync trigger; predicate `nppes_platform_job_caller` |
| `external_interfaces.lab.read` | RN, LPN, Supervising RN, Medical Director, DON (within caseload), or wide-scope roles | Read attached lab observations |
| `external_interfaces.lab.review_unmatched` | Compliance Officer, Lab Coordinator | Adjudicate unmatched-lab queue |
| `external_interfaces.lab.acknowledge_abnormal` | RN (caseload), Supervising RN, On-Call RN (M19) | Clear the M36 abnormal-flag alert badge |

### 4.8 ABAC Predicates (M3 Named-Predicate Registry)

Per D20, six new predicates are contributed to the M3 named-predicate registry. Each is declared in `apps/backend/src/modules/29-external-interfaces/predicates/index.ts` and registered in M3's central registry at boot.

```typescript
// apps/backend/src/modules/29-external-interfaces/predicates/index.ts
import { registerPredicate, type PredicateContext } from '@wardenx/modules/03-authorization/predicates'

/** external_feed_organization_scope:
 *  The resource's organization_id must equal the actor's organization_id.
 *  Trivially enforced by RLS for the row itself; this predicate is what M3
 *  evaluates when an action requires a target-feed lookup BEFORE the SQL.
 */
registerPredicate('external_feed_organization_scope', async (ctx: PredicateContext, resourceId: string) => {
  const feed = await ctx.db.query.externalFeed.findFirst({
    where: (t, { eq }) => eq(t.id, resourceId),
    columns: { organizationId: true },
  })
  return feed?.organizationId === ctx.actor.organizationId
})

/** hl7_inbound_proposal_owner_module_match:
 *  When adjudicating a proposal, the actor's authorized owner-modules must
 *  include the proposal's owner_module. (e.g., a billing officer cannot
 *  accept/reject a proposal whose owner_module='M5'.)
 */
registerPredicate('hl7_inbound_proposal_owner_module_match', async (ctx, resourceId: string) => {
  const proposal = await ctx.db.query.hl7InboundProposal.findFirst({
    where: (t, { eq }) => eq(t.id, resourceId),
    columns: { ownerModule: true, organizationId: true },
  })
  if (!proposal) return false
  if (proposal.organizationId !== ctx.actor.organizationId) return false
  return ctx.actor.authorizedOwnerModules.has(proposal.ownerModule)
})

/** lab_observation_patient_caseload_or_scope:
 *  The actor either (a) has the observation's patient in their active caseload
 *  per CaseloadProvider, OR (b) holds a wide-scope role authorized to read across
 *  the org (DON, Medical Director, Compliance Officer for unmatched-queue access).
 */
registerPredicate('lab_observation_patient_caseload_or_scope', async (ctx, resourceId: string) => {
  const obs = await ctx.db.query.labObservation.findFirst({
    where: (t, { eq }) => eq(t.id, resourceId),
    columns: { patientId: true, organizationId: true },
  })
  if (!obs) return false
  if (obs.organizationId !== ctx.actor.organizationId) return false
  if (!obs.patientId) {
    // Unmatched observation: only review-unmatched authorized roles
    return ctx.actor.hasPermission('external_interfaces.lab.review_unmatched')
  }
  if (ctx.actor.hasWideScope('lab_read')) return true
  const caseload = SeamRegistry.get('CaseloadProvider')
  return caseload.isPatientInActiveCaseload({
    actorId: ctx.actor.id,
    patientId: obs.patientId,
    organizationId: obs.organizationId,
  })
})

/** external_feed_compliance_co_approver_distinct:
 *  For the feed-revoke action, the co-approver actor must be a DIFFERENT person
 *  from the primary approver. Mirrors the M22 D12 dual-approval pattern.
 */
registerPredicate('external_feed_compliance_co_approver_distinct', async (ctx, primaryApproverId: string) => {
  return ctx.actor.id !== primaryApproverId
})

/** nppes_platform_job_caller:
 *  The actor must be running under withPlatformContext() — a tenant-scoped role
 *  cannot trigger a platform-shared NPPES sync. Enforced both by the predicate
 *  AND by an additional context-check in the route handler (defense-in-depth).
 */
registerPredicate('nppes_platform_job_caller', async (ctx) => {
  return ctx.actor.isPlatformOperator === true
})

/** external_feed_baa_satisfied:
 *  Composite predicate that checks the BAA gate for the supplied feed BEFORE
 *  activation OR before an outbound dispatch attempt. Consults M40.
 */
registerPredicate('external_feed_baa_satisfied', async (ctx, feedId: string) => {
  const feed = await ctx.db.query.externalFeed.findFirst({
    where: (t, { eq }) => eq(t.id, feedId),
    columns: { organizationId: true, feedType: true, baaSatisfiedAt: true },
  })
  if (!feed) return false
  // For inbound HL7 feeds and outbound ORM, the BAA must be on file with the
  // sending/receiving facility (identified via M40 master-data mapping).
  if (feed.feedType === 'nppes_public') return true
  if (feed.feedType === 'xero_consumer' || feed.feedType === 'gusto_consumer') return true
  const baa = SeamRegistry.get('BaaStatusProvider')
  const status = await baa.checkForFeed({ organizationId: feed.organizationId, feedId })
  return status.kind === 'active'
})
```

All six predicates are referenced explicitly from the route-level permission gates and from the seam-call gates; they are NEVER inlined as ad-hoc SQL checks.

### 4.9 BullMQ Queue Catalog

Per the WardenX background-jobs convention, every M29 background worker is a named BullMQ queue with explicit retry/backoff/DLQ posture. The seven queues:

| Queue name | Producer | Worker concurrency | Retry policy | DLQ posture |
|------------|----------|--------------------|--------------| ------------|
| `m29.hl7_inbound_parse` | MLLP listener (per-feed) on message receipt | 8 per feed | 3 attempts, exp backoff (500ms → 2s → 8s) | After 3 fails → `processing_status='quarantined'`; surfaces in §4.1.3 search; manual replay path |
| `m29.hl7_inbound_match` | `hl7_inbound_parse` worker on parse success | 4 per feed | 2 attempts, exp backoff (1s → 5s) | After 2 fails → quarantine; same surfacing |
| `m29.hl7_inbound_apply` | `hl7_inbound_match` worker on confident-match outcome | 4 | 3 attempts, exp backoff (1s → 5s → 20s) | After 3 fails → quarantine + M36 listener-down-class alert |
| `m29.hl7_outbound_dispatch` | M11 outbox consumer (`m11.order.hl7_orm_requested`) | 2 per feed | **5 attempts, exp backoff (1s → 5s → 25s → 2m → 10m)** per D9 | After 5 fails → DLQ row in `hl7_message_outbound.dispatch_status='dlq'`; manual retry path; M36 outbound-dispatch-fail alert |
| `m29.nppes_sync_full` | Cron (weekly Sun 03:00 UTC) OR manual trigger | 1 (platform-wide) | 2 attempts, exp backoff (1m → 10m) | After 2 fails → `nppes_sync_run.status='failed'`; M36 platform alert |
| `m29.nppes_sync_delta` | Cron (nightly 02:00 UTC) | 1 (platform-wide) | 2 attempts, exp backoff (1m → 10m) | Same as full |
| `m29.feed_health_aggregate` | Cron (every 60s) | 1 per backend instance | None (idempotent recompute) | n/a (read-only aggregator) |

Each queue's processor is implemented in `apps/backend/src/modules/29-external-interfaces/queues/<queue-name>.ts`; the queue definitions live in `apps/backend/src/modules/29-external-interfaces/queues/index.ts` and are registered with the platform BullMQ factory.

### 4.10 Outbox Event Catalog (Cross-Module Publication)

Per the outbox-only cross-module-communication discipline, every cross-module event from M29 is published through M4's `OutboxPublisher`. The full list:

| Event name | Payload (typed) | Consumers (declared) |
|------------|-----------------|----------------------|
| `m29.external_feed.created` | `{ feedId, feedType, direction, displayName, createdAt }` | M4 (audit), M34 (SaaS console — forward) |
| `m29.external_feed.activated` | `{ feedId, activatedAt, activatedBy }` | M4, M34, M36 (informational) |
| `m29.external_feed.suspended` | `{ feedId, suspendedAt, suspendedBy, reason }` | M4, M34, M36 |
| `m29.external_feed.revoked` | `{ feedId, revokedAt, revokedBy, primaryApproverId, coApproverId }` | M4, M34, M36 |
| `m29.external_feed_credential.minted` | `{ feedId, credentialId, kind, expiresAt }` | M4 |
| `m29.external_feed_credential.rotated` | `{ feedId, oldCredentialId, newCredentialId, rotatedAt }` | M4 |
| `m29.external_feed_credential.revoked` | `{ feedId, credentialId, revokedAt }` | M4 |
| `m29.hl7_message.inbound_received` | `{ messageId, feedId, messageType, messageControlId, receivedAt, processingStatus }` | M4 (metadata-only; payload denylisted) |
| `m29.hl7_message.outbound_dispatched` | `{ messageId, feedId, messageType, placerOrderNumber, dispatchedAt, dispatchStatus }` | M4, M11 (consumer) |
| `m29.hl7_message.outbound_acked` | `{ messageId, feedId, messageControlId, ackedAt, ackCode }` | M4, M11 |
| `m29.hl7_message.outbound_failed` | `{ messageId, feedId, attemptCount, lastError, dlqLandedAt }` | M4, M11, M36 |
| `m29.lab_observation.attached` | `{ observationId, patientId, orderRecordId, loincCode, abnormalFlag, observationDatetime }` | M4, M11 (back-resolve order status), M9 (Phase 2 forward), M28 (FHIR Observation projection) |
| `m29.lab_observation.manually_matched` | `{ observationId, patientId, decidedBy, decidedAt }` | M4, M11 |
| `m29.lab_observation.discarded` | `{ observationId, decidedBy, decidedAt, reason }` | M4 |
| `m29.lab_observation.unmatched` | `{ observationId, organizationId, loincCode, reason, receivedAt }` (informational — a returned result could not be auto-matched to an order; awaits manual bind per T-29.13) | M4, M11 (`lab-results-applier`, informational; no order state change) |
| `m29.nppes.sync_run.started` | `{ syncRunId, kind, triggeredBy, startedAt }` | M4, M34 |
| `m29.nppes.sync_run.completed` | `{ syncRunId, kind, completedAt, providersUpserted, providersDeprecated, durationMs }` | M4, M40 (re-resolve cached prescriber rosters), M34 |
| `m29.nppes.sync_run.failed` | `{ syncRunId, kind, failedAt, error }` | M4, M34, M36 |
| `m29.hl7_message.cascade_resolved_confident` | `{ messageId, feedId, organizationId, messageControlId, messageType, matchedPatientId, matchLevel, mergeRedirectHops }` | M4 (audit), M29 proposal-creator |
| `m29.hl7_message.cascade_resolved_candidate` | `{ messageId, feedId, organizationId, messageControlId, messageType, candidatePatientId, matchLevel, matchConfidence, candidateIds, mergeRedirectHops }` | M4, M29 proposal-creator |
| `m29.hl7_message.cascade_resolved_no_match` | `{ messageId, feedId, organizationId, messageControlId, messageType }` | M4, M29 proposal-creator |
| `m29.hl7_message.routing_dropped` | `{ messageId, feedId, organizationId, messageControlId, messageType, reason }` (reason = `cannot_act_on_unknown_patient` for A03/A11 no-match drop) | M4, M36 (compliance dashboard) |
| `m29.hl7_inbound_proposal.created` | `{ proposalId, organizationId, sourceMessageId, resourceKind, ownerModule, matchOutcome, matchedPatientId, matchLevel, matchConfidence, matchCandidateIds, expiresAt }` | M4, M5 (forward-stub today; real consumer at M5 lock), M6 (forward-stub), M33 (proposal-queue dashboard) |
| `m29.hl7_inbound_proposal.accepted` | `{ proposalId, organizationId, sourceMessageId, resourceKind, ownerModule, matchedPatientId, acceptedAggregateId, decidedByMembershipId, decidedAt, decisionRationale, appliedFields, proposedPatientCandidate }` | M4, M5 forward-stub, M6 forward-stub |
| `m29.hl7_inbound_proposal.rejected` | `{ proposalId, organizationId, sourceMessageId, ownerModule, decidedByMembershipId, decidedAt, decisionRationale }` | M4 |
| `m29.hl7_inbound_proposal.discarded` | `{ proposalId, organizationId, sourceMessageId, decidedByMembershipId, decidedAt, decisionRationale }` | M4 |
| `m29.hl7_inbound_proposal.expired` | `{ proposalId, organizationId, expiredAt }` | M4 (expire-sweep worker) |

The total outbox event count is 27. The §12 sign-off checklist line in §12.7 reads "All 27 outbox events from §4.10".

The seam-validation gate verifies every event name is declared in the M4 `outbox_event_catalog` registry.

### 4.11 MLLP Listener Lifecycle

Per **D3** (port-per-feed listener), every active inbound HL7 feed binds a dedicated MLLP TCP listener. Listeners run inside a long-lived **`hl7-listener-supervisor`** sibling Node process owned by M29 (`apps/backend/src/modules/29-external-interfaces/listener/index.ts`, the process entrypoint; `supervisor.ts` is the supervisor class). The supervisor is a **separate operating-system process** from the Fastify HTTP server — not a `cluster.fork()` child, not a Fastify-thread, not a worker_thread. The two processes share Postgres (separate bounded connection pools), Valkey (separate BullMQ connections), and the `/var/run/wardenx/hapi.sock` UDS to the T-29.03 HAPI sidecar; they do **not** share memory, HTTP routing, or the Fastify lifecycle. Crash isolation is the explicit goal: a Fastify route crash does not bring down the listener; a listener crash does not bring down Fastify. Docker compose adds an `hl7-listener` service alongside `backend` and `hl7-sidecar`; in production this is managed by the container orchestrator or a supervisord-equivalent (see Ops Runbook §M29). Listeners run on isolated ports, never bound to the public ingress, and never co-tenant with HTTP traffic on a single port.

#### 4.11.1 Boot Sequence

```ts
// apps/backend/src/modules/29-external-interfaces/listener/supervisor.ts

export async function startListenerSupervisor(deps: SupervisorDeps): Promise<void> {
  // 1. Load all active inbound MLLP feeds tenant-by-tenant via withPlatformContext.
  const activeFeeds = await withPlatformContext(async (db) => {
    return db.query.externalFeed.findMany({
      where: and(
        eq(externalFeed.direction, 'INBOUND'),
        eq(externalFeed.feedType, 'HL7_V2_MLLP'),
        eq(externalFeed.status, 'ACTIVE'),
      ),
    });
  });

  // 2. For each, verify M40 BAA gate (D16) and start listener; if BAA gate refuses, log + skip + alert.
  for (const feed of activeFeeds) {
    const baaOk = await deps.mdm.baaStatus(feed.organizationId, { asOf: new Date() });
    if (!baaOk.isActive) {
      logger.warn({ feedId: feed.id, organizationId: feed.organizationId, baaStatus: baaOk }, 'hl7.listener.baa_refuse');
      await deps.alerts.dispatch({
        severity: 'CRITICAL',
        channel: 'COMPLIANCE',
        title: `BAA gate blocked feed ${feed.displayName}`,
        body: `Feed ${feed.id} on org ${feed.organizationId} cannot activate listener: BAA status = ${baaOk.status}, expiresAt = ${baaOk.expiresAt ?? 'n/a'}`,
      });
      continue;
    }

    await startFeedListener(feed, deps);
  }

  // 3. Subscribe to feed lifecycle events (created/activated/suspended/revoked) for hot reload.
  deps.outbox.subscribe('m29.external_feed.activated', (event) => startFeedListenerById(event.feedId, deps));
  deps.outbox.subscribe('m29.external_feed.suspended', (event) => stopFeedListenerById(event.feedId, 'suspended'));
  deps.outbox.subscribe('m29.external_feed.revoked',   (event) => stopFeedListenerById(event.feedId, 'revoked'));

  // 4. Health-probe loop on a 30s tick: writes external_feed_health rows + emits circuit-breaker trips.
  setInterval(() => deps.healthProbe.run(), 30_000);

  // 5. Register SIGTERM handler for graceful drain (stop accepting; flush in-flight; emit shutdown audit).
  process.on('SIGTERM', () => gracefulShutdown(deps));
}
```

#### 4.11.2 Per-Feed Listener (mTLS + Sender Allowlist)

```ts
async function startFeedListener(feed: ExternalFeed, deps: SupervisorDeps): Promise<void> {
  const cred = await deps.credentials.loadActive(feed.id, 'MTLS_CERT');
  const serverOpts: tls.TlsOptions = {
    cert: cred.serverCertPem,
    key:  cred.serverKeyPem,        // decrypted via M2 envelope KMS
    ca:   cred.expectedClientCaPem, // per-feed pinned (D23)
    requestCert: true,
    rejectUnauthorized: true,       // mTLS required (D23)
    minVersion: 'TLSv1.3',
  };

  const server = tls.createServer(serverOpts, (socket) => {
    const peerAddr = socket.remoteAddress;
    if (!deps.allowlist.includes(feed.id, peerAddr)) {
      logger.warn({ feedId: feed.id, peerAddr }, 'hl7.listener.allowlist_reject');
      socket.destroy();
      return;
    }
    handleMllpConnection(socket, feed, deps);
  });

  await new Promise<void>((resolve) => server.listen(feed.listenerPort!, '0.0.0.0', resolve));
  deps.registry.attach(feed.id, server);
  logger.info({ feedId: feed.id, port: feed.listenerPort }, 'hl7.listener.started');
}
```

Sender allowlist (D23) is per-feed and stored as a JSONB CIDR array on `external_feed.config`. Allowlist edits require step-up (D18) and emit a `m29.external_feed.allowlist_updated` event.

#### 4.11.3 MLLP Frame Handling + Sidecar Dispatch

A single MLLP frame is bounded by `<VT>` (0x0B) and `<FS><CR>` (0x1C 0x0D). The listener:

1. **Buffers** incoming bytes until a full frame is detected (or 60s read timeout → close).
2. **Computes** `sha256(payload)` and `messageControlId` from MSH-10 by a regex-light pre-parse (no full HAPI parse yet — fail-fast on obviously malformed framing).
3. **Idempotency check (D14)**: `SELECT 1 FROM hl7_message_inbound WHERE feed_id = $1 AND message_control_id = $2`. On hit → emit `AA` ACK with the original message-control-id, log `hl7.inbound.duplicate_dropped`, do not re-enqueue.
4. **Persists** the raw frame envelope-encrypted into `hl7_message_inbound` with status `RECEIVED`. The sha256 projection is stored in clear for audit, the payload is encrypted.
5. **Enqueues** `hl7-inbound-parse:{messageType}` BullMQ job (queue catalog §4.9) with `{ messageId, feedId }`.
6. **Emits** MLLP `AA` (application accept) only after Postgres `COMMIT` returns — never before. If the DB insert fails, emit `AR` (application reject) with an error segment.

The **HAPI sidecar** (D2 — only Java in the repo) is invoked from the BullMQ worker, not the listener thread:

```ts
// packages/hl7-worker/src/worker.ts
const parsed = await sidecar.parse({ payload, profile: feed.hl7Profile });
// returns typed segment tree projected into TS via packages/hl7-worker/src/types.ts
```

Sidecar communication: localhost-bound gRPC over UDS (`/var/run/wardenx/hapi.sock`), no network exposure, no PHI logs from sidecar (sidecar log denylist enforced in §3.6 mirror).

#### 4.11.4 Graceful Shutdown

```ts
async function gracefulShutdown(deps: SupervisorDeps): Promise<void> {
  logger.info('hl7.listener.shutdown.begin');
  // 1. Stop accepting new connections on every listener.
  for (const { feedId, server } of deps.registry.all()) {
    server.close();
    logger.info({ feedId }, 'hl7.listener.shutdown.stop_accept');
  }
  // 2. Wait for in-flight MLLP frames to ACK (max 30s).
  await deps.inflight.drain(30_000);
  // 3. Emit shutdown audit per feed.
  for (const { feedId } of deps.registry.all()) {
    await deps.audit.emit({ kind: 'hl7.listener.shutdown', feedId, at: new Date() });
  }
  logger.info('hl7.listener.shutdown.complete');
  process.exit(0);
}
```

In-flight drain timeout is platform-floor 30s; tenants may not loosen (per platform-floor / tenant-tighten-only semantics).

#### 4.11.5 Listener-Down Detection (D17)

Health probe writes `external_feed_health` rows on each tick. The circuit breaker (per-feed):

- **CLOSED** (healthy): last frame received < 5min ago OR within feed's `expectedQuietWindow`.
- **OPEN** (alert): no frames in 5min AND probe TCP-connect fails OR probe TLS-handshake fails. Emits `m29.external_feed.listener_down` → M36 dispatches CRITICAL alert to the **operator-on-call** channel.
- **HALF_OPEN** (recovery): TCP probe succeeds; next received frame transitions back to CLOSED and emits `m29.external_feed.listener_recovered`.

5min is a platform-floor; tenants may tighten to as low as 1min via `external_feed.config.listenerDownThresholdMs` but may not loosen above 5min. Validation is at write time and re-checked at boot.

> **As-built listener-down detection (GAP-043).** The decision is made where it survives the listener process dying. The listener's 30s tick (`listener/health-sweep.ts`) only leaves FACTS in `external_feed_listener_state` (one row per feed, migration 1052: `listener_heartbeat_at`, `listener_bound`) and keeps the hourly `external_feed_health` uptime rollup. A **watcher in the worker role** (`listener/health-watch.ts`, BullMQ `m29.feed_health_watch`, every minute, `M29_LISTENER_WATCH_ENABLED=true`) decides from three independent facts: heartbeat age (stale = older than three ticks, 90s, or never written), an active **TCP connect** probe of `M29_LISTENER_PROBE_HOST:<feed.port>` (2s; `external_feed.host` is the partner's address, not the listener's), and the newest inbound frame; they feed the unchanged pure `evaluateListenerCircuit` as `probe = { tcpOk: connect && heartbeat fresh, tlsOk: heartbeat fresh && bound }`. **No TLS-handshake probe:** the listener requires a client certificate (mTLS, TLSv1.3 minimum), which the watcher does not hold, and mTLS is not weakened to probe; a listener that accepts TCP but whose TLS stack is wedged is caught only by the silence rule. A feed that has never heartbeated gets a grace period of twice its threshold from activation (`approved_at` / `active_from`). Watched feeds are `status = 'active'`, inbound kinds, not revoked, inside `active_from`/`active_through`, and with the feed-level BAA unexpired. The transition and its outbox event (`m29.external_feed.listener_down` / `listener_recovered`, `declaredConsumers: ["m36"]`) are written in **one transaction**; `down` is published once per outage and `recovered` only when a paged outage closes. M36's `feed-health-alerts` consumer pages `external_feed.listener_down` (critical, one page per outage: correlation id carries the outage's open instant, to the seeded `role_set(compliance_officer, org_admin)` rule) and sends the paired `external_feed.listener_recovered` (info). The migration-0740 `hl7_listener_down_operator` resolver was never contributed, so the existing rule stands. **No auto-resolve:** the `alert` table has no open/resolved state (only `outcome`), so recovery is a paired notice. **Switch:** with the flag off the listener process pages `listener_down` exactly as before (no environment is left unpaged); with it on the listener stops paging and the worker owns the decision (set the same value on both processes; a missing `M29_LISTENER_PROBE_HOST` refuses to boot). Per-feed config (PATCH `/feeds/:feedId`): `listenerDownThresholdSeconds` **60..300** (a tenant may only TIGHTEN the 5 minute platform default; `null` = default) and `expectedQuietWindows` (`[{ days: 0-6[], start: "HH:MM", end: "HH:MM", tz: IANA }]`, evaluated through `Intl` so DST is respected; a stored value that no longer parses reads as no window, failing toward alerting). Residual: real partner feeds were never exercised (no vendor sandbox); the watcher does not credit `listener_down_seconds` while the listener process is dead.

### 4.12 Outbound ORM Dispatch (M11 Consumer)

Per **D8** + **D9**, M29 owns the outbound `ORM^O01` lab-order sender that consumes M11's `m11.order.hl7_orm_requested` outbox event. M11 has *no knowledge* of HL7 — it only declares the typed payload (PID, ORC, OBR, NTE per M11 §4.10 catalog). M29 owns the wire format.

#### 4.12.1 Consumer Wiring

```ts
// apps/backend/src/modules/29-external-interfaces/outbox-consumers/orm-dispatcher.ts

outbox.registerConsumer<M11OrderHl7OrmRequestedPayload>({
  eventName: 'm11.order.hl7_orm_requested',
  consumerName: 'm29.orm-dispatcher',  // unique per (event, consumer) — outbox dedup key
  handler: async (event, ctx) => {
    // 1. Resolve target feed: m11 supplies feedId via the order's OrderingFacility binding.
    const feed = await ctx.feeds.findActive(event.payload.feedId);
    if (!feed) {
      throw new RetryableError('feed_not_active', { backoffMs: 60_000 });
    }

    // 2. M40 BAA gate (D16) — refuse on missing/expired.
    const baaOk = await ctx.mdm.baaStatus(feed.organizationId, { asOf: new Date() });
    if (!baaOk.isActive) {
      await ctx.audit.emit({ kind: 'hl7.outbound.baa_refuse', feedId: feed.id, orderRecordId: event.payload.orderRecordId });
      // BAA refuses are TERMINAL for this attempt — do not retry; M40 will re-emit on BAA restoration.
      throw new TerminalError('baa_inactive');
    }

    // 3. Build ORM^O01 message via HAPI sidecar (sidecar is bidirectional: parse + build).
    const ormMessage = await ctx.sidecar.buildOrm({
      msh: { sendingFacility: feed.config.sendingFacility, receivingFacility: feed.config.receivingFacility },
      placerOrderNumber: event.payload.orderRecordId, // D8: OBR-2 = order_record.id
      pid: event.payload.pid,
      orc: event.payload.orc,
      obr: event.payload.obr,
      nte: event.payload.nte,
    });

    // 4. Persist outbound row with envelope-encrypted payload + sha256 projection.
    const outboundRow = await ctx.db.insert(hl7MessageOutbound).values({
      feedId: feed.id,
      messageType: 'ORM^O01',
      messageControlId: ormMessage.msh10,
      payloadCiphertext: await ctx.envelope.encrypt(ormMessage.wire),
      payloadSha256: sha256(ormMessage.wire),
      dispatchStatus: 'PENDING',
      placerOrderNumber: event.payload.orderRecordId,
      attemptCount: 0,
    }).returning();

    // 5. Dispatch via MLLP client with retry policy (D9: 5 attempts exp backoff 30s → 8min).
    await ctx.dispatcher.dispatch(outboundRow[0], feed);
  },
  retryPolicy: {
    maxAttempts: 5,
    backoffMs: [30_000, 60_000, 120_000, 240_000, 480_000],
    onExhausted: 'DLQ',  // outbox lands on M4 DLQ → M11 receives `m11.order.transmission_terminal_failed`
  },
});
```

#### 4.12.2 ACK Handling

When the receiving lab returns an `MSA` segment (typically inside an `ORR^O02` or generic ACK):

- `AA` (Application Accept) → `dispatchStatus = 'ACKED'`, emit `m29.hl7_message.outbound_acked` → M11 transitions `lab_transmission_status = 'TRANSMITTED'`.
- `AR` (Application Reject) → `dispatchStatus = 'NACKED'`, capture MSA-3 error text in `nack_reason`, emit `m29.hl7_message.outbound_failed` → M11 transitions to `TRANSMISSION_FAILED`. **No retry** — AR is a structural rejection (e.g., unknown patient at lab); operator intervention required.
- `AE` (Application Error) → treated as retryable transport error; counts toward attempt budget; if attempt budget exhausted, falls to DLQ.

ACK correlation is by `MSA-2` (Message Control ID) which equals the outbound `MSH-10`. ACKs received without a correlating outbound row are logged `hl7.outbound.orphan_ack` and discarded — they do *not* update any state.

#### 4.12.3 Step-Up Auth on Manual Resend

A failed outbound row (`dispatchStatus` ∈ `{NACKED, DLQ}`) can be manually re-queued by an operator via `POST /api/v1/external-interfaces/hl7-messages/outbound/:id/resend`. This route requires:

- `external_interfaces.hl7.outbound:resend` permission key.
- Step-up auth (D18 — fresh, ≤5min).
- `external_feed_baa_satisfied` predicate (D20).
- Audit emits `hl7.outbound.manual_resend` with `{ messageId, originalDispatchStatus, resendBy, stepUpEvidenceId }`.

The resend creates a *new* outbound row with a new `MSH-10` (no MSH-10 reuse — that would corrupt the receiver's idempotency state). The new row carries `parentMessageId = originalRow.id` for audit chain.

---

## 5. UI Surfaces

M29 ships a **web admin surface** under the `/external-interfaces` route prefix in `apps/web/src/routes/external-interfaces/*`. There is **no mobile surface** (Capacitor target is excluded — operators perform feed lifecycle and credential rotation from desktop only) and **no patient/family portal surface** (per the Architecture portal-scope policy, M29 surfaces are operator/compliance/clinical staff only). All routes require an authenticated session; specific permission keys gate each leaf.

### 5.1 Navigation Tree

```
/external-interfaces
├── /dashboard                        — operator-on-call landing (feed health tiles, unmatched lab queue badge, open proposals badge)
├── /feeds
│   ├── /                             — feed inventory (filterable by direction, type, status)
│   ├── /new                          — create feed wizard (dual-approval initiated)
│   ├── /:feedId                      — feed detail (config, listener state, recent messages summary)
│   ├── /:feedId/credentials          — credential lifecycle (mint / rotate / revoke; step-up required)
│   ├── /:feedId/allowlist            — sender IP allowlist editor (step-up required)
│   ├── /:feedId/messages
│   │   ├── /inbound                  — inbound message search (metadata-only display by default)
│   │   ├── /outbound                 — outbound message search
│   │   └── /:messageId/payload       — payload-view modal (step-up + plaintext rate-limit gate)
│   └── /:feedId/health-history       — `external_feed_health` tail chart (24h / 7d / 30d)
├── /hl7-proposals
│   ├── /inbox                        — pending proposals routed by ownerModule
│   └── /:proposalId                  — proposal detail (side-by-side diff view, accept/reject/partial-accept)
├── /lab-observations
│   ├── /unmatched                    — unmatched lab observations queue (RN/operator review)
│   └── /:observationId               — observation detail (manual-match panel)
├── /nppes
│   ├── /sync-history                 — `nppes_sync_run` history with success/fail filter
│   ├── /providers                    — NPPES provider browser (read-only, platform-shared)
│   └── /trigger-sync                 — manual NPPES sync trigger (step-up + platform-role required)
└── /audit
    └── /feed-activity                — feed-scoped audit query (proxies to M4 with M29 filter)
```

The dashboard tile composition is owned by M34 (SaaS Console) in Phase 2 but ships a **default placeholder** in Phase 1 — a static React layout reading the operator-on-call's tenant scope and rendering the four core tiles directly (no forward-seam to M34 yet, since M34 is unlocked).

### 5.2 Key Screen Specifications (Acceptance-Visible Behavior)

#### 5.2.1 Feed Inventory `/external-interfaces/feeds`

**Columns:** Display Name, Feed Type, Direction, Status badge (PROVISIONAL/ACTIVE/SUSPENDED/REVOKED), BAA badge (per D16: green=active, amber=expiring<30d, red=missing/expired), Last Frame Received (relative timestamp), Listener Port (inbound only), Created At, Actions.

**Status badge color contrast:** WCAG 2.1 AA AA (4.5:1 minimum); badges carry both color and a status icon so colorblind users get redundant signal.

**Filters:** Direction (INBOUND/OUTBOUND/BIDIRECTIONAL), Type (HL7_V2_MLLP/NPPES_SYNC), Status (multi-select), BAA status (active/expiring/missing).

**Sort:** Default by Status (ACTIVE first), then Display Name asc.

**Empty state:** "No external feeds configured. [Create a feed →]" — the CTA is disabled if the caller lacks `external_interfaces.feed:create`.

**Row interaction:** Click row → `/feeds/:feedId`. The "Actions" column ellipsis opens a menu with permission-gated entries (Suspend, Revoke, Edit Allowlist, Rotate Credentials); disabled items show a tooltip explaining the missing permission or step-up requirement.

#### 5.2.2 Create Feed Wizard `/external-interfaces/feeds/new`

Four steps, validated client-side and re-validated server-side via the same TypeBox schema (`createExternalFeedSchema` from §4.3):

1. **Type & Direction** — radio cards (HL7 v2 MLLP Inbound, HL7 v2 MLLP Outbound, HL7 v2 MLLP Bidirectional, NPPES Sync).
2. **Sender/Receiver Identity** — sending-facility, receiving-facility, hl7-profile selector (ADT_A01_v2_5_1, ORU_R01_v2_5_1, ORM_O01_v2_5_1; future profiles registered in the typed segment registry).
3. **Network & Security** — listener port (inbound only; auto-suggests next free port from the reserved range 11000-11999), expected-quiet-window, sender allowlist CIDRs (multi-add).
4. **Approvals & Activation** — primary approver (current user, auto-filled from session, read-only) and co-approver picker (must satisfy `external_feed_compliance_co_approver_distinct` — predicate enforces (a) distinct from primary, (b) holds `external_interfaces.feed:co_approve`). On submit, server creates feed in PROVISIONAL status and emits `m29.external_feed.created` with both approver IDs; co-approver receives an M36 secure message linking to `/external-interfaces/feeds/:feedId/approve`.

**Step-up auth gate:** D18 — step-up evidence must be ≤5min old at submit; if expired, wizard surfaces "Re-authenticate to continue" with an inline step-up modal (does *not* navigate away — preserves form state).

#### 5.2.3 Proposal Detail `/external-interfaces/hl7-proposals/:proposalId`

The propose-then-review surface (D5). Each proposal payload renders as a **side-by-side diff** between the current patient/encounter state and the proposed state from the HL7 message:

```
┌──────────────────────────── ADT^A01 Proposal #px_ABC123 ────────────────────────────┐
│ Proposed by feed: Engrace ↔ St. Anthony Hospital (feed_xyz)                          │
│ Received at:     2026-06-10 14:32:11 PDT                                             │
│ Owner module:    M6 (Admission/Election/Certification)                               │
│ Status:          PENDING                                                             │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Field             │ Current             │ Proposed            │ Accept?              │
├───────────────────┼─────────────────────┼─────────────────────┼──────────────────────┤
│ MRN               │ MRN-001234          │ MRN-001234          │ [no diff]            │
│ DOB               │ 1948-03-22          │ 1948-03-22          │ [no diff]            │
│ Address line 1    │ (none)              │ 124 Pine St         │ ☐                    │
│ Address city      │ (none)              │ Pendleton           │ ☐                    │
│ Address state     │ (none)              │ OR                  │ ☐                    │
│ Address postal    │ (none)              │ 97801               │ ☐                    │
│ Insurance: payer  │ Medicare A          │ Medicare A          │ [no diff]            │
│ Insurance: policy │ (none)              │ 1EG4-TE5-MK72       │ ☐                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Decision note (required on reject, optional on accept):                              │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                                  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│             [ Accept Selected ]   [ Reject ]   [ Defer ]   [ Discard ]               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Acceptance behavior (D5):**
- **Accept Selected** with all rows checked → full apply via `m29.hl7_inbound_proposal.accepted` event, owner-module handler applies fields, emits its own `m5.patient.mutator_applied` or `m6.applier.processed` event.
- **Accept Selected** with subset checked → partial apply; `appliedFields` in the event payload enumerates which proposed fields landed.
- **Reject** → `m29.hl7_inbound_proposal.rejected` event with `decisionNote` (required, non-empty).
- **Defer** → no decision recorded; proposal remains in PENDING, but a "deferred-by" annotation is added so other reviewers see who's looked at it.
- **Discard** (operator-only, permission-gated separately) → for malformed or duplicate-of-prior proposals; emits rejected event with `discardReason`.

**Permission gate:** `hl7_inbound_proposal_owner_module_match` ABAC predicate (D20) — the deciding user must hold the owner-module permission (M5 for patient-update proposals, M6 for election proposals). Cross-module decision is **forbidden** even for global admins; this is enforced server-side, not just hidden in UI.

**Step-up auth:** D18 — proposal accept requires fresh step-up; reject does not (reject is informationally lossy but does not mutate clinical state).

#### 5.2.4 Unmatched Lab Observations Queue `/external-interfaces/lab-observations/unmatched`

Per D7, lab observations that did **not** auto-resolve to a patient via the deterministic five-level cascade (§4.6) land here for RN/operator manual review.

**Columns:** Received At, Sending Lab (from feed), Patient Identifier Hint (MRN if PID-3 present, else "no MRN"), Patient Name Hint (PID-5; minimized — initials only by default, full reveal requires `lab_observation.unmatched:reveal_name` permission), LOINC Code, LOINC Display, Result Text (denylisted from the column view; available only in detail panel), Abnormal Flag, Cascade Stage Reached, Reason for No Match.

**Filters:** Sending Lab, Abnormal Flag (Normal/Abnormal/Critical), Cascade Stage (L1-L5/None), Received Window.

**Row click → detail panel (slide-in, not full nav):** shows the full lab observation payload, the cascade trace (per-level rejection reason), and a **manual-match panel**:

```
┌────────────── Manual Match: Observation obs_DEF456 ──────────────┐
│ Search patient: [____________________]                            │
│   Filters: Active patients only ☑    Caseload only ☐ (overrides)  │
│                                                                   │
│   Results:                                                        │
│     ○ Doe, Jane — MRN-001234 — DOB 1948-03-22 — Active            │
│     ○ Doe, Joan — MRN-001456 — DOB 1948-03-22 — Active            │
│                                                                   │
│ Reason for manual match (required):                               │
│ [_____________________________________________________________]   │
│                                                                   │
│              [ Match to Selected Patient ]   [ Discard ]          │
└───────────────────────────────────────────────────────────────────┘
```

**Discard** records `m29.lab_observation.discarded` and requires a reason ≥10 chars. Discarded observations are retained per the retention schedule (§8) but no longer surface in this queue.

**Step-up auth:** Match-to-patient requires step-up (D18). Discard does **not** require step-up but does require a decision note.

#### 5.2.5 NPPES Sync History `/external-interfaces/nppes/sync-history`

**Columns:** Sync Run ID (last 8 chars), Kind (FULL/DELTA/MANUAL), Started At, Completed At, Duration, Providers Upserted, Providers Deprecated, Triggered By, Status.

**Filters:** Kind, Status (RUNNING/COMPLETED/FAILED), Window.

**Row click → detail page:** Shows the `nppes_sync_run` row's full state machine timeline, any error captures, and (for completed runs) a sampled breakdown of providers added/changed/deprecated. The sampled breakdown is read from M4 audit (not stored on `nppes_sync_run` itself — keeps the run row small).

**Manual trigger:** "Trigger Sync Now" button — opens a modal with kind selector (DELTA default, FULL gated behind a confirmation that warns of API rate-limit consumption). Requires `external_interfaces.nppes:trigger_sync` permission AND step-up (D18). The trigger is forbidden if a sync run is currently `RUNNING` — the button is disabled with a tooltip "Sync in progress (sync_XXX) — wait for completion".

#### 5.2.6 Payload View Modal `/external-interfaces/feeds/:feedId/messages/:messageId/payload`

The single highest-friction surface in M29 by design. Per D13 + §3.6 audit denylist, plaintext HL7 payloads are gated behind:

1. **Permission:** `external_interfaces.hl7.payload:view`.
2. **Step-up auth:** D18 — fresh ≤5min.
3. **Plaintext rate-limit:** per user, per 24h sliding window, configurable per-tenant with platform-floor `maxPlaintextViewsPerUserPer24h = 50`; tenants may tighten but not loosen.
4. **Per-view audit emission:** every modal open emits `hl7.payload.viewed` to M4 with `{ messageId, viewerId, stepUpEvidenceId, viewedAt }`. The audit entry is queryable from M4's compliance-review surface.
5. **PHI redaction toggle (default ON):** modal renders with PII fields (PID-5, PID-7, PID-11, NK1, IN1, GT1) masked unless the user toggles "Reveal PII" — toggle ON also emits a separate `hl7.payload.pii_revealed` audit entry.

The modal does **not** allow copy-to-clipboard (DOM-level `oncopy` interception), does **not** allow download, and watermarks the payload with the viewer's email + a per-view nonce.

### 5.3 Notifications & In-App Alerts

M29 emits the following operator-facing notifications via M36:

| Trigger | Channel | Severity | Recipients |
|---------|---------|----------|------------|
| Listener-down 5min (D17) | `operator-on-call` | CRITICAL | Operator-on-call rotation |
| BAA refuse on activation (D16) | `compliance` | CRITICAL | Compliance officer + tenant admin |
| BAA refuse on outbound (D16) | `compliance` | HIGH | Compliance officer |
| Proposal queue >20 pending (per owner module) | `clinical-lead` | NORMAL | Clinical lead per module |
| Unmatched lab queue >10 pending | `clinical-lead` | NORMAL | Clinical lead, ops |
| NPPES sync failure | `operator-on-call` | HIGH | Operator-on-call |
| Outbound ORM DLQ landing (D9) | `operator-on-call` | HIGH | Operator-on-call, M11 owners |
| Credential rotation reminder (30/7/1 day) | `compliance` | NORMAL → HIGH (escalates) | Compliance officer, feed primary approver |
| Sender allowlist edit applied | `audit-watch` | NORMAL | Compliance officer (read-only) |

All notifications carry deep links to the relevant detail page; recipients are resolved via M36's role-resolution facility (per-tenant role-to-user mapping). The platform-floor escalation cadences match the M36 escalation policy and may be tightened by tenants but not loosened.

### 5.4 Accessibility & i18n

- **WCAG 2.1 AA conformance** is a hard floor; all status badges carry icon + color + text (triple redundancy for colorblind users); modal focus traps via `react-aria`; tab order is keyboard-only navigable across every surface above.
- **i18n:** Phase 1 ships English-only; M29 strings are tagged with the standard `t()` keys under namespace `external-interfaces` so the i18n pipeline (M1 owned) can pick them up. No surface contains user-generated PHI that needs localization — payload views are rendered as-received bytes.
- **Time zones:** All timestamps render in the viewer's profile timezone (M2 owned); UTC is shown in tooltips and copied-to-clipboard formats (the latter only on non-payload surfaces).
- **Per-tenant theming:** Feed badges and dashboard tiles respect the tenant's M40 brand-color tokens, with platform fallback if not set.

---

## 6. Permissions Matrix

The matrix below enumerates **every** UI-surfaced or API-surfaced action against the standard role set (per M3 `RoleKey` union). All entries marked ✓ may additionally be filtered by ABAC predicates (see footnotes); entries marked ✗ are unconditionally denied even with explicit grants.

**Role legend:**
- `pl-ops` = Platform Operator (Anthropic-side; platform-role)
- `pl-cmp` = Platform Compliance (Anthropic-side)
- `t-admin` = Tenant Admin
- `t-compl` = Tenant Compliance Officer
- `t-ops` = Tenant Operator (per-tenant operator-on-call)
- `clin-lead` = Clinical Lead (per discipline; nurse/social-work/chaplain/MD)
- `rn-case` = RN Case Manager
- `rn-field` = RN Field Staff
- `md-md` = Medical Director / Hospice Physician
- `mso-coord` = MSO Coordinator (referral intake)
- `bil-mgr` = Billing Manager
- `audit-rd` = Audit Read-Only (auditors)

| Action / Permission Key | pl-ops | pl-cmp | t-admin | t-compl | t-ops | clin-lead | rn-case | rn-field | md-md | mso-coord | bil-mgr | audit-rd |
|------------------------|:------:|:------:|:-------:|:-------:|:-----:|:---------:|:-------:|:--------:|:-----:|:---------:|:-------:|:--------:|
| `external_interfaces.feed:list` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `external_interfaces.feed:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `external_interfaces.feed:create` ¹ ² | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed:co_approve` ¹ ⁴ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed:activate` ¹ ² | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed:suspend` ¹ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed:revoke` ¹ ² | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed:allowlist_edit` ¹ ³ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed.credential:mint` ¹ ² | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed.credential:rotate` ¹ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.feed.credential:revoke` ¹ ² | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.hl7.inbound:search` ³ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `external_interfaces.hl7.outbound:search` ³ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `external_interfaces.hl7.payload:view` ¹ ³ ⁵ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.hl7.outbound:resend` ¹ ³ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.proposal:list` ⁶ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ |
| `external_interfaces.proposal:read` ⁶ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ |
| `external_interfaces.proposal:decide` ¹ ⁶ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| `external_interfaces.proposal:discard` ¹ ⁶ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.lab_observation.unmatched:list` ⁷ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ |
| `external_interfaces.lab_observation.unmatched:reveal_name` ¹ ⁷ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `external_interfaces.lab_observation:manual_match` ¹ ⁷ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `external_interfaces.lab_observation:discard` ¹ ⁷ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.lab_observation:read` ⁷ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| `external_interfaces.nppes:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| `external_interfaces.nppes:trigger_sync` ¹ ⁸ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `external_interfaces.nppes.sync_run:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `external_interfaces.health:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `external_interfaces.audit:query` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

**Footnotes:**

¹ **Step-up auth required (D18).** Caller must present fresh step-up evidence ≤5min old at the moment of the action; otherwise the route returns `403 step_up_required`. Step-up MFA-method requirements are governed by M2 `SESSION_POLICY`.

² **Dual-approval / co-approver-distinct required (D20).** Action requires a `primaryApproverId` and a `coApproverId` that satisfy the `external_feed_compliance_co_approver_distinct` predicate: (a) `coApproverId !== primaryApproverId`, (b) `coApproverId` holds `external_interfaces.feed:co_approve` in the same tenant scope, (c) at most one of {primary, co} may be platform-role; both platform-roles is *forbidden* (no Anthropic-internal-only activation of tenant feeds).

³ **BAA gate required (D16, D20).** The `external_feed_baa_satisfied` predicate enforces `mdm.baaStatus(orgId).isActive === true` at the moment of the action. BAA-missing or BAA-expired refuses the action with audit emission and operator notification, regardless of role grants.

⁴ **Co-approver role gate.** Holding `external_interfaces.feed:co_approve` alone does not authorize feed creation/activation — it only makes the holder eligible to be *chosen* as co-approver by a primary approver. The primary approver still needs `external_interfaces.feed:create` or `external_interfaces.feed:activate`.

⁵ **Plaintext rate-limit (D13, §5.2.6).** Per-user, per-24h sliding window with platform-floor `maxPlaintextViewsPerUserPer24h = 50`; rate-limit hit returns `429 plaintext_view_quota_exceeded`. Tenant may tighten but not loosen.

⁶ **Owner-module-match (D20).** The `hl7_inbound_proposal_owner_module_match` predicate enforces: the caller must hold the *owner module's* "edit" permission. For an ADT proposal owned by M6 (election), the caller must hold `m6.election:edit`. For an ADT proposal owned by M5 (patient), the caller must hold `m5.patient:edit`. Cross-module decision is forbidden even for global admins; the predicate refuses with `403 owner_module_mismatch`.

⁷ **Caseload-or-scope (D20).** The `lab_observation_patient_caseload_or_scope` predicate, post-match, restricts read/manual-match access to either: (a) RN/MD on patient caseload, or (b) tenant-admin/compliance with scope read grant. Pre-match (i.e., `patientId IS NULL`), the predicate degrades to scope-only — anyone with `lab_observation.unmatched:list` may see metadata, but full PII reveal requires `:reveal_name` and step-up.

⁸ **Platform-role only (D11, D20).** The `nppes_platform_job_caller` predicate enforces caller is operating under `withPlatformContext` — i.e., NPPES is platform-shared and tenant-scoped triggers are forbidden. Manual trigger via UI only runs as platform-operator; tenant-admin UI button is disabled with tooltip "NPPES sync is platform-managed".

### 6.1 Permission-to-Predicate Mapping (Test Anchor)

For test enforcement, every permission key above maps to a specific predicate or combination in M3:

```ts
// apps/backend/src/modules/29-external-interfaces/permissions.ts
export const M29_PERMISSION_PREDICATES = {
  'external_interfaces.feed:create':       ['external_feed_compliance_co_approver_distinct', 'external_feed_baa_satisfied', 'step_up_recent'],
  'external_interfaces.feed:activate':     ['external_feed_compliance_co_approver_distinct', 'external_feed_baa_satisfied', 'step_up_recent'],
  'external_interfaces.feed:revoke':       ['external_feed_compliance_co_approver_distinct', 'step_up_recent'],
  'external_interfaces.feed:allowlist_edit': ['external_feed_organization_scope', 'step_up_recent'],
  'external_interfaces.feed.credential:mint': ['external_feed_compliance_co_approver_distinct', 'step_up_recent'],
  'external_interfaces.feed.credential:rotate': ['external_feed_organization_scope', 'step_up_recent'],
  'external_interfaces.feed.credential:revoke': ['external_feed_compliance_co_approver_distinct', 'step_up_recent'],
  'external_interfaces.hl7.payload:view':  ['external_feed_organization_scope', 'plaintext_view_quota', 'step_up_recent'],
  'external_interfaces.hl7.outbound:resend': ['external_feed_organization_scope', 'external_feed_baa_satisfied', 'step_up_recent'],
  'external_interfaces.proposal:decide':   ['hl7_inbound_proposal_owner_module_match', 'step_up_recent'],
  'external_interfaces.proposal:discard':  ['external_feed_organization_scope', 'step_up_recent'],
  'external_interfaces.lab_observation.unmatched:reveal_name': ['lab_observation_patient_caseload_or_scope', 'step_up_recent'],
  'external_interfaces.lab_observation:manual_match': ['lab_observation_patient_caseload_or_scope', 'step_up_recent'],
  'external_interfaces.lab_observation:discard': ['external_feed_organization_scope', 'step_up_recent'],
  'external_interfaces.nppes:trigger_sync': ['nppes_platform_job_caller', 'step_up_recent'],
} as const satisfies Record<string, ReadonlyArray<keyof typeof M3_PREDICATES>>;
```

The boot validator asserts every key here is registered in M3's predicate registry and every predicate referenced exists. Mismatch fails boot.

---

## 7. Workflow Acceptance Criteria

Each criterion below is a **single, binary-deciding scenario** that must pass before lock. They are written in Given / When / Then format with explicit observable outcomes. Test fixtures are catalogued in §9.4.

### W-XI-01 — Confident L1 Match Auto-Apply (ADT^A08)

**Given** a tenant `t-engrace` with active inbound feed `feed_stanthony` (BAA active, listener up) and an existing patient `pt_jane_doe` with `mrn_external = 'MRN-001234'`,

**When** an `ADT^A08` (patient update) frame arrives with `PID-3.1 = MRN-001234`, `PID-3.4 = 'ST_ANTHONY'`, `PID-5 = 'DOE^JANE'`, `PID-7 = '19480322'`, and a new `PID-11` address,

**Then:**
- `hl7_message_inbound` row is created with `processing_status = 'PARSED'` then `MATCHED'`, `matched_patient_id = pt_jane_doe`, `match_level = 'L1_MRN_EXACT'`, within p95 < 2s of frame ACK.
- `hl7_inbound_proposal` row is created with `proposal_kind = 'PATIENT_UPDATE'`, `owner_module = 'M5'`, `status = 'PENDING'`, `proposed_for_patient_id = pt_jane_doe`.
- `m29.hl7_inbound_proposal.created` outbox event is published with the L1 match level and proposed-field list.
- The proposal appears in `/external-interfaces/hl7-proposals/inbox` filtered by M5 owner.
- The patient row is **not** mutated until a reviewer accepts (D5 — propose-then-review semantics).
- MLLP `AA` ACK is emitted to the sender on the same socket within p95 < 1.5s of frame receipt.

### W-XI-02 — L4 Probabilistic-Bridge Candidate (Cascade Stops)

**Given** the same tenant and feed,

**When** an `ADT^A01` frame arrives with `PID-3.1 = MRN-DIFFERENT-9999` (no L1 match) but `PID-5 = 'DOE^JANE'`, `PID-7 = '19480322'`, `PID-8 = 'F'`, `PID-11.5 = '97801'` (which uniquely match `pt_jane_doe`'s L4 attributes per the cascade),

**Then:**
- `hl7_message_inbound.match_level = 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE'`, `processing_status = 'CANDIDATE_REVIEW'`, `matched_patient_id` remains NULL.
- A `hl7_inbound_proposal` is created with `proposal_kind = 'PATIENT_CANDIDATE_REVIEW'`, listing the single L4 candidate in `proposed_payload.candidates[]` with cascade trace.
- The proposal does **not** auto-apply; a reviewer must explicitly bind the candidate to a patient (or reject as no-match).
- The MLLP `AA` ACK is still emitted (acceptance is at message-receipt boundary, not match-resolution boundary; ACK semantics are framing-level, not clinical-correctness-level).
- Audit `hl7.inbound.l4_candidate_review` is emitted.

### W-XI-03 — Partial-Field Accept on Proposal

**Given** a `PATIENT_UPDATE` proposal from W-XI-01 in `PENDING`,

**When** a reviewer with `external_interfaces.proposal:decide` AND `m5.patient:edit` AND fresh step-up evidence opens the proposal detail and checks address fields but leaves the insurance-policy field unchecked, then clicks "Accept Selected" with decision note "Address verified by phone call to patient",

**Then:**
- `m29.hl7_inbound_proposal.accepted` event is emitted with `appliedFields = ['address_line1', 'address_city', 'address_state', 'address_postal']` (insurance policy excluded).
- M5's outbox consumer receives the event and applies only the listed fields; `m5.patient.mutator_applied` is emitted by M5 with the same field list.
- `hl7_inbound_proposal.status = 'PARTIALLY_APPLIED'`, `decided_by = current_user`, `decided_at = now()`, `decision_note` populated.
- M4 audit chain: `hl7.proposal.partial_accepted` → `m5.patient.updated` (via M5's existing audit emission).
- Insurance policy field is not written to `patient.coverage_*`.

### W-XI-04 — Reject With Required Note

**Given** a `PATIENT_CANDIDATE_REVIEW` proposal in PENDING (from W-XI-02),

**When** a reviewer clicks "Reject" with **empty** decision note,

**Then:** the API returns `400 decision_note_required` with form-level error highlighting; no state mutation occurs; no audit emission; no outbox event.

**And when** the reviewer retries with note "L4 demographic match is not Jane Doe — patient previously confirmed by RN visit on 06/03",

**Then:**
- `m29.hl7_inbound_proposal.rejected` event is emitted with the note.
- `hl7_inbound_proposal.status = 'REJECTED'`, `decided_at`, `decided_by`, `decision_note` populated.
- The proposal disappears from the M5/M6 owner inboxes (filter excludes `REJECTED`).
- Audit `hl7.proposal.rejected` is written.

### W-XI-05 — Abnormal Lab Auto-Attach + RN Alert (ORU^R01)

**Given** an active inbound lab feed `feed_quest_engrace`, an existing patient `pt_jane_doe` with caseload RN `user_rn_alice`, and a prior M11 order `order_lab_basic_metabolic` with `id = ord_BMP_xyz` and `lab_transmission_status = 'TRANSMITTED'`,

**When** an `ORU^R01` frame arrives with `OBR-2 (placer-order-number) = ord_BMP_xyz`, `OBR-7 (observation datetime) = today`, and an `OBX` segment with `OBX-3 (loinc) = '2160-0'` (creatinine), `OBX-5 = '3.4'`, `OBX-7 (reference range) = '0.6-1.2'`, `OBX-8 (abnormal flag) = 'HH'` (critically high),

**Then:**
- `lab_observation` row is created with `patient_id = pt_jane_doe`, `order_record_id = ord_BMP_xyz`, `loinc_code = '2160-0'`, `abnormal_flag = 'HH'`, `match_resolution = 'AUTO_VIA_PLACER_ORDER_NUMBER'`.
- `lab_observation_value` row is created with the typed value.
- `lab_observation_inbound_link` joins `hl7_message_inbound.id` to the observation.
- `m29.lab_observation.attached` event is emitted; M11 consumer transitions order to `RESULTS_RECEIVED`.
- M36 dispatches a HIGH-severity alert via `clinical-lead` channel to `user_rn_alice` (caseload RN) with deep link to the patient's encounter view (rendered by M9, not M29).
- No proposal is created (labs are not propose-then-review per D7 — they auto-attach on placer-order match).
- The unmatched-queue badge does **not** increment.

### W-XI-06 — Unmatched Lab Routed to Queue

**Given** the same feed,

**When** an `ORU^R01` arrives with `OBR-2` empty (no placer order), `PID-3` with an unknown MRN, and `PID-5/7/8` that fail the cascade L1-L4,

**Then:**
- `lab_observation` row is created with `patient_id = NULL`, `order_record_id = NULL`, `match_resolution = 'UNMATCHED'`, `cascade_stages_attempted = ['L1','L2','L3','L4']`.
- The observation appears in `/external-interfaces/lab-observations/unmatched`.
- No M11 consumption, no M9 alert; the unmatched-queue badge increments and (if total ≥10) M36 dispatches a NORMAL-severity alert to the clinical-lead channel.
- The lab payload is **not** discarded; it sits in `UNMATCHED` indefinitely until manual match or discard.

### W-XI-07 — Outbound ORM ACK Path

**Given** M11 emits `m11.order.hl7_orm_requested` with `feedId = feed_quest_engrace_out`, valid PID/ORC/OBR/NTE payload, and a placer-order-number `ord_NEW_abc`,

**When** the M29 dispatcher runs:

**Then:**
- M40 BAA gate is checked (D16); passes (active).
- HAPI sidecar builds the ORM^O01 wire frame with `OBR-2 = ord_NEW_abc` (D8).
- `hl7_message_outbound` row is persisted with `dispatch_status = 'PENDING'`, envelope-encrypted payload.
- MLLP client dispatches the frame to the lab; receives `MSA-1 = 'AA'` within network timeout (5s configurable per feed).
- `dispatch_status = 'ACKED'`, `acked_at = now()`, `m29.hl7_message.outbound_acked` event emitted.
- M11 consumer transitions `lab_transmission_status = 'TRANSMITTED'` (per M11's catalog).
- M4 audit chain: `hl7.outbound.dispatched` → `hl7.outbound.acked` → `m29.lab_order.transmitted`.

### W-XI-08 — BAA Refuse Blocks Outbound Dispatch

**Given** the same scenario but with `mdm.baaStatus(feed.organizationId) = { isActive: false, status: 'EXPIRED', expiresAt: '2026-05-01' }`,

**When** the M29 dispatcher receives `m11.order.hl7_orm_requested`:

**Then:**
- BAA gate refuses with `TerminalError('baa_inactive')`.
- `hl7_message_outbound` row is **not** created (refusal is pre-persist).
- M11 outbox event lands on DLQ with `terminalReason = 'baa_inactive'`.
- M4 audit `hl7.outbound.baa_refuse` is emitted.
- M36 dispatches a HIGH-severity `compliance` channel alert to the compliance officer.
- **Critically:** when the tenant later renews BAA (M40 emits `mdm.baa_status_changed` to ACTIVE), M29's `mdm.baa_status_changed` consumer re-evaluates the outbound-HL7 gate and requeues the previously-DLQ'd order events (M29 owns the outbound order DLQ), and the dispatch retries automatically without operator intervention.

### W-XI-09 — DLQ After Five Failed Outbound Attempts

**Given** the dispatcher running an outbound ORM with `attempt_count = 0` and a deliberately-broken receiving lab endpoint (TLS handshake fails repeatedly),

**When** the dispatcher exhausts the 5-attempt budget (D9: 30s, 60s, 120s, 240s, 480s — total wallclock ~15.5min):

**Then:**
- After attempt #5, `dispatch_status = 'DLQ'`, `dlq_landed_at = now()`, `last_error` captures the latest TLS error.
- `m29.hl7_message.outbound_failed` event is emitted with `attemptCount = 5`.
- M11 consumer transitions `lab_transmission_status = 'TRANSMISSION_FAILED'`.
- M36 dispatches HIGH-severity alert to `operator-on-call` channel.
- Operator may manually re-queue via `/external-interfaces/feeds/:feedId/messages/outbound/:messageId/resend` after fixing the upstream issue; resend requires step-up.

### W-XI-10 — Listener-Down Alert at 5min

**Given** an active inbound feed `feed_stanthony` with `lastFrameAt = now()`, healthy state,

**When** the listener loses TCP connectivity to upstream (no incoming frames) for 5 consecutive minutes AND the TCP-probe also fails to handshake to the upstream's known echo port:

**Then:**
- `external_feed_health` row is written at the 5-min boundary with `state = 'OPEN'`, `lastFrameAt = (now - 5min)`, `probeStatus = 'TCP_FAIL'`.
- `m29.external_feed.listener_down` event is emitted.
- M36 dispatches CRITICAL alert to `operator-on-call` channel.
- The dashboard feed-health tile transitions from green to red.
- **Recovery:** when the next frame arrives, `external_feed_health.state` transitions through `HALF_OPEN` → `CLOSED`; `m29.external_feed.listener_recovered` is emitted; alert auto-resolves in M36.

### W-XI-11 — NPPES Nightly DELTA Sync

**Given** a healthy NPPES feed, an existing `nppes_provider` cache, and a scheduled DELTA run at 02:00 UTC,

**When** the nightly job (`nppes-sync-delta` BullMQ recurring) runs:

**Then:**
- A `nppes_sync_run` row is created with `kind = 'DELTA'`, `status = 'RUNNING'`, `started_at = now()`, `triggered_by = 'PLATFORM_SCHEDULER'`.
- The job calls `withPlatformContext` (D11) and fetches the NPPES delta endpoint with `lastSyncedAt = previousRun.completedAt`.
- For each delta record, the job upserts `nppes_provider` with the new attributes (or marks deprecated if API signals decommission).
- On completion: `status = 'COMPLETED'`, `providers_upserted = N`, `providers_deprecated = M`, `duration_ms = T`.
- `m29.nppes.sync_run.completed` event is emitted; M40 consumer re-resolves any cached prescriber roster entries that reference deprecated NPIs.
- No tenant-scoped writes occur; RLS isolation is verified — even a platform-role caller cannot accidentally write to a tenant schema during the sync.

### W-XI-12 — Tenant-Scoped NPPES Trigger Is Refused

**Given** a tenant admin `user_t_admin` with all tenant-level grants,

**When** the user attempts to call `POST /api/v1/external-interfaces/nppes/sync-runs` from a tenant-scoped session:

**Then:**
- The `nppes_platform_job_caller` predicate refuses (D20).
- The route returns `403 platform_role_required`.
- The UI "Trigger Sync Now" button is disabled with tooltip "NPPES sync is platform-managed".
- M4 audit `external_interfaces.nppes.trigger_refused_tenant_scope` is emitted (a deny audit, per the M4 audit-everything-including-denials pattern).

### W-XI-13 — Step-Up Required on Credential Rotation

**Given** a feed `feed_stanthony` and a tenant compliance officer `user_t_compl` with `external_interfaces.feed.credential:rotate` permission,

**When** the user navigates to `/external-interfaces/feeds/feed_stanthony/credentials` and clicks "Rotate mTLS Cert" without recent step-up evidence:

**Then:**
- The route returns `403 step_up_required` with `requiredFactor = 'mfa_token_or_webauthn'`.
- The UI surfaces a step-up modal in-place (preserves the rotation form).
- After completing step-up, retry succeeds: a new `external_feed_credential` row is minted (status `ACTIVE`), the previous row transitions to `ROTATING` (allowed to coexist for a configurable grace window — platform-floor 24h, tenant may tighten not loosen, so the upstream sender can complete in-flight TLS handshakes before discovering the new cert).
- `m29.external_feed_credential.rotated` event is emitted with both old and new credential IDs.
- Audit chain includes step-up evidence ID.

### W-XI-14 — SUD Ingress Redaction (42 CFR Part 2)

**Given** an inbound HL7 feed and a patient `pt_william_doe` whose M39 `ConsentEvaluator.evaluateForIngressRedaction` returns `{ redactSubstanceUseDisorderFields: true }` (patient has *not* consented to receive SUD-related HL7 inbound data from external sources),

**When** an `ADT^A08` arrives with PID matching `pt_william_doe` AND a `DG1` (diagnosis) segment containing F11.20 (Opioid dependence, uncomplicated) AND OBX segments referencing SUD treatment context,

**Then:**
- The pre-persist redaction pass (per D15) calls `m39.consent_evaluator.evaluateForIngressRedaction(patientId)` *before* `hl7_message_inbound` is persisted.
- The DG1 (F11.20) and SUD-context OBX segments are stripped from the payload **at the wire boundary** — they never land in encrypted-at-rest storage.
- A redaction summary is logged: `{ hl7MessageId, segmentsStripped: ['DG1[1]', 'OBX[3]', 'OBX[5]'], reason: 'sud_no_ingress_consent' }`. This is a M4 audit entry with no PHI body — only segment positions and the reason code.
- The proposal that flows downstream contains only the non-SUD fields; the reviewer never sees the SUD diagnosis, and it cannot be retroactively recovered from M29 storage.
- **Critical:** SUD redaction is non-reversible. If the patient later consents to SUD inbound, future frames will be admitted with SUD content; the historical frames remain redacted (no replay-with-different-redaction-policy).

### W-XI-15 — Boot Validator Refuses Missing Predicate

**Given** a hypothetical regression where `external_feed_compliance_co_approver_distinct` is removed from M3's predicate registry,

**When** the backend boots:

**Then:**
- The boot validator (per the architecture fitness tooling) fails with `BootValidationError: M29 references predicate 'external_feed_compliance_co_approver_distinct' not registered in M3.PREDICATE_REGISTRY`.
- The process exits with code 1.
- No HL7 listener is started; the system fails closed.

(This is not a runtime user workflow but is enumerated here because it is a binary-deciding acceptance gate for the spec — without it, predicate-name drift would silently degrade the dual-approval guarantee.)

---

## 8. Security & Privacy

M29 is among the **highest-blast-radius modules** in the platform: it terminates external network traffic carrying live PHI, manages long-lived credentials for partner facilities, and bridges into M40 (BAA), M39 (consent), M27 (factory bindings) and M11 (clinical orders). Every interface boundary is hardened with belt-and-suspenders controls.

### 8.1 RLS Enforcement

All **tenant-owned** M29 tables (`external_feed`, `external_feed_credential`, `hl7_message_inbound`, `hl7_message_outbound`, `hl7_inbound_proposal`, `lab_observation`, `lab_observation_value`, `lab_observation_inbound_link`, `external_feed_health`) carry RLS policies enforcing `organization_id = current_setting('app.org_id')::uuid`. The policy is `FOR ALL` with both `USING` and `WITH CHECK` clauses; INSERTs that supply a different `organization_id` are refused by Postgres, not just the application layer.

**Platform-shared** M29 tables (`nppes_provider`, `nppes_sync_run`) carry a *different* policy:

```sql
CREATE POLICY nppes_provider_platform_only ON external_interfaces.nppes_provider
  FOR ALL
  USING (current_setting('app.tenant_scope', true) = 'PLATFORM')
  WITH CHECK (current_setting('app.tenant_scope', true) = 'PLATFORM');
```

The `app.tenant_scope` GUC is set to `'PLATFORM'` exclusively by `withPlatformContext` (M2-owned helper). Tenant sessions cannot escalate; even a SQL-injection-induced direct table access from a tenant session would be refused at the row-policy boundary. This pattern matches M40 D8 (platform-shared MDM tables) and is verified by the RLS isolation test suite (§9.3.2).

**Read-vs-write asymmetry for NPPES:** All tenant sessions may `SELECT` from `nppes_provider` via the `withPlatformReadOnly` wrapper (which sets `app.tenant_scope = 'PLATFORM_RO'`, gated by a separate read-only policy). Writes are exclusively the sync-job path. This means a tenant clinician can resolve a prescriber NPI to a name without escalating to platform-role.

### 8.2 ABAC Predicate Coverage Matrix

Each ABAC predicate registered by M29 (D20) is exercised by ≥1 test in §9 and is referenced by ≥1 permission key in §6. The coverage matrix:

| Predicate | Permission keys gated | Test anchor |
|-----------|----------------------|-------------|
| `external_feed_organization_scope` | `feed:list`, `feed:read`, `feed.credential:rotate`, `hl7.payload:view`, `hl7.outbound:resend`, `proposal:discard`, `lab_observation:discard` | `test/predicates/external_feed_organization_scope.test.ts` |
| `external_feed_compliance_co_approver_distinct` | `feed:create`, `feed:activate`, `feed:revoke`, `feed.credential:mint`, `feed.credential:revoke` | `test/predicates/co_approver_distinct.test.ts` |
| `external_feed_baa_satisfied` | `feed:create`, `feed:activate`, `hl7.outbound:resend`, *and applied implicitly at outbound dispatch* | `test/predicates/baa_satisfied.test.ts` + `test/integration/dispatch_baa_refuse.test.ts` |
| `hl7_inbound_proposal_owner_module_match` | `proposal:decide` | `test/predicates/owner_module_match.test.ts` |
| `lab_observation_patient_caseload_or_scope` | `lab_observation.unmatched:reveal_name`, `lab_observation:manual_match`, `lab_observation:read` | `test/predicates/lab_caseload_or_scope.test.ts` |
| `nppes_platform_job_caller` | `nppes:trigger_sync` | `test/predicates/nppes_platform_caller.test.ts` |
| `step_up_recent` (M2-provided) | every `¹`-footnoted permission in §6 | `test/predicates/step_up_recent.test.ts` (M2 owned; M29 contributes a fixture-augmented scenario) |
| `plaintext_view_quota` (M2-provided, M29-augmented) | `hl7.payload:view` | `test/integration/plaintext_view_quota.test.ts` |

Every predicate function is called by name through the M3 registry — there is **no** ad-hoc inline ABAC check in M29's route handlers. The boot validator (§W-XI-15) fails closed on any drift.

### 8.3 STRIDE Threat Model

| STRIDE category | Threat | M29 mitigation |
|-----------------|--------|----------------|
| **Spoofing** | A malicious actor impersonates a partner facility's MLLP sender. | mTLS with per-feed pinned client-CA (D23); sender IP allowlist per-feed (D3); rejection at TLS handshake before any HL7 parse. |
| **Spoofing** | A malicious actor impersonates an NPPES response. | NPPES client uses TLS 1.3 against the official `nppes.cms.hhs.gov` endpoint only (HSTS preload + cert pin); responses are validated against the published OpenAPI schema; unrecognized fields are logged and dropped. |
| **Tampering** | An MLLP frame is mutated in transit. | mTLS confidentiality + integrity; received bytes are hashed (`sha256`) immediately and the hash is persisted as an audit projection (D13); any retroactive corruption would produce a mismatch when payload is decrypted and re-hashed. |
| **Tampering** | An operator alters a stored HL7 payload to hide a clinical event. | Payload ciphertext rows are append-only; UPDATE is forbidden by RLS (no UPDATE policy exists on these columns); the payload sha256 audit projection is co-located in the same DB transaction as the ciphertext write, so any mutation breaks the hash chain visible to M4 audit. |
| **Tampering** | A proposal acceptance is replayed to re-apply old data. | Each accept is keyed by `(proposalId, status='PENDING')`; the UPDATE `WHERE status = 'PENDING'` is atomic; second accept returns 0 rows and the route refuses. |
| **Repudiation** | An operator denies authorizing a credential rotation. | Step-up evidence ID (D18) is captured per-action and joined into M4 audit; the evidence is M2-owned, signed, and non-repudiable. Audit emission is in the same transaction as the credential write. |
| **Repudiation** | A reviewer denies accepting a clinical proposal. | Decision record (`decided_by`, `decided_at`, `decision_note`, `step_up_evidence_id`) is required for every state transition; the proposal table is append-update with `status` as the only mutable field, audited by trigger. |
| **Information Disclosure** | PHI in HL7 payload leaks via ops logs. | PHI denylist in pino redaction (§3.6) covers `PID/NK1/IN1/GT1/NTE` segment text. Logs carry only segment summaries (e.g., "PID present, 5 fields") not values. |
| **Information Disclosure** | PHI leaks via error stack traces. | Server-side error envelopes strip payload bodies; only `messageId` (opaque ULID), feed ID, and the message-control-id are surfaced. The full error including segment context lands in encrypted-at-rest error-log storage gated by `external_interfaces.error_log:read`. |
| **Information Disclosure** | Operator with `hl7.payload:view` exfiltrates PHI bulk via screen recording / browser DevTools. | Plaintext-view rate limit (D13, 50/24h floor); per-view audit emission; copy-to-clipboard suppressed at DOM; watermarked rendering; aggregated dashboard surface for compliance review. Defense-in-depth rather than perfect prevention. |
| **Information Disclosure** | An OS-level attacker reads payload ciphertext directly from PG. | Envelope encryption (D13): payload is encrypted with a per-tenant DEK, the DEK is wrapped by the platform KEK (KMS-managed, M2-owned). Disclosure of the ciphertext alone yields nothing without DEK unwrap. |
| **Information Disclosure** | A SUD diagnosis lands in storage despite the patient's consent. | Pre-persist redaction pass (D15) calls M39 consent evaluator *before* writing `hl7_message_inbound`; SUD segments are stripped at the wire boundary. Non-reversible. |
| **Denial of Service** | An attacker floods the MLLP listener with malformed frames. | Per-IP connection rate-limit at the listener (token bucket, configurable per-feed with platform-floor 100/min), allowlist drop-before-handshake (D3), 60s read-timeout per frame, max frame size 8MB (anything larger is dropped at the wire). |
| **Denial of Service** | A sender opens many parallel sockets to exhaust file descriptors. | Per-feed connection cap (platform-floor `maxConcurrentConnections = 16` per feed, tenant may tighten). Beyond the cap, new sockets are refused at `accept(2)` with TCP RST. |
| **Denial of Service** | A flood of L4-candidate proposals overwhelms the review queue. | Per-feed inbound rate-limit (platform-floor 600 frames/hr/feed, tenant may tighten); the rate-limit is enforced at parse-enqueue, not at MLLP receive (so the ACK semantics remain framing-correct). Sustained over-rate emits `m29.external_feed.ingest_rate_alert` to compliance. |
| **Elevation of Privilege** | A tenant-role caller invokes NPPES sync. | `nppes_platform_job_caller` predicate (D20) checks `current_setting('app.tenant_scope') = 'PLATFORM'`; tenant sessions cannot set this GUC (it is granted only to the platform-role connection). |
| **Elevation of Privilege** | A reviewer with M5 edit permission decides an M6-owned proposal. | `hl7_inbound_proposal_owner_module_match` predicate (D20) checks ownership at decide-time; cross-module decision is refused. |
| **Elevation of Privilege** | A primary approver also acts as their own co-approver. | `external_feed_compliance_co_approver_distinct` predicate refuses `coApproverId === primaryApproverId`. |
| **Elevation of Privilege** | Compromised credential is used to send HL7 after revocation. | Credential revocation is checked at TLS handshake (CRL-style in-memory revoke list refreshed on `m29.external_feed_credential.revoked` outbox event); revoked certs refuse handshake immediately, no parse path. |

### 8.4 Data Eraser & Retention

Per the eraser-seam contract (each module that owns tenant-scoped tables must register a `DataEraser` implementation), M29 registers `M29DataEraser` in boot:

```ts
// apps/backend/src/modules/29-external-interfaces/eraser.ts
export class M29DataEraser implements DataEraser {
  readonly moduleId = 29;
  readonly ownedTables = [
    'external_feed',
    'external_feed_credential',
    'hl7_message_inbound',
    'hl7_message_outbound',
    'hl7_inbound_proposal',
    'lab_observation',
    'lab_observation_value',
    'lab_observation_inbound_link',
    'external_feed_health',
  ] as const;

  async eraseTenant(organizationId: string, tx: Transaction, opts: EraseOptions): Promise<EraseResult> {
    // Order matters: link rows first, then dependents, then roots, to avoid FK violations
    // even though FKs are CASCADE-set — explicit order makes the audit chain readable.
    const result: EraseResult = { tables: {}, totalRows: 0 };

    result.tables.lab_observation_inbound_link = await tx.delete(labObservationInboundLink)
      .where(eq(labObservationInboundLink.organizationId, organizationId)).returning({ count: count() });
    result.tables.lab_observation_value = await tx.delete(labObservationValue)
      .where(eq(labObservationValue.organizationId, organizationId)).returning({ count: count() });
    result.tables.lab_observation = await tx.delete(labObservation)
      .where(eq(labObservation.organizationId, organizationId)).returning({ count: count() });
    result.tables.hl7_inbound_proposal = await tx.delete(hl7InboundProposal)
      .where(eq(hl7InboundProposal.organizationId, organizationId)).returning({ count: count() });
    result.tables.hl7_message_outbound = await tx.delete(hl7MessageOutbound)
      .where(eq(hl7MessageOutbound.organizationId, organizationId)).returning({ count: count() });
    result.tables.hl7_message_inbound = await tx.delete(hl7MessageInbound)
      .where(eq(hl7MessageInbound.organizationId, organizationId)).returning({ count: count() });
    result.tables.external_feed_health = await tx.delete(externalFeedHealth)
      .where(eq(externalFeedHealth.organizationId, organizationId)).returning({ count: count() });
    result.tables.external_feed_credential = await tx.delete(externalFeedCredential)
      .where(eq(externalFeedCredential.organizationId, organizationId)).returning({ count: count() });
    result.tables.external_feed = await tx.delete(externalFeed)
      .where(eq(externalFeed.organizationId, organizationId)).returning({ count: count() });

    // NPPES tables are platform-shared — NOT erased on tenant offboarding.

    return result;
  }
}
```

**Retention schedule** (per tenant; platform-floor below, tenant may tighten):

| Table | Retention | Trigger |
|-------|-----------|---------|
| `hl7_message_inbound` (payload ciphertext) | **2 years** post-receipt | Time-based; partitioning makes drop-partition O(1). |
| `hl7_message_inbound` (metadata projection) | **6 years** post-receipt | Per HIPAA §164.530(j)(2) record-retention floor. |
| `hl7_message_outbound` (payload ciphertext) | **2 years** post-dispatch | Time-based; partition drop. |
| `hl7_message_outbound` (metadata projection) | **6 years** post-dispatch | HIPAA floor. |
| `hl7_inbound_proposal` (decided) | **6 years** post-decision | HIPAA floor; PHI is in `proposed_payload_jsonb` so this row is PHI-bearing. |
| `hl7_inbound_proposal` (pending >30 days, not decided) | **Auto-expire to DECLINED** at 30 days | Per D5 propose-then-review; stale proposals are recorded as DECLINED with `decision_note = 'auto_declined_stale'`. |
| `lab_observation` + values | **6 years** post-receipt for matched; **180 days** for unmatched-then-discarded | HIPAA floor for clinical data; discarded-unmatched is operational artifact only. |
| `external_feed_health` | **90 days** rolling | Operational telemetry; ops dashboard reads recent only. |
| `external_feed_credential` (revoked) | **6 years** post-revocation | Audit chain — must be able to verify which cert authorized historical inbound frames. |
| `external_feed` (revoked) | **6 years** post-revocation | Same. |
| `nppes_provider` | **No expiry**; soft-deprecation by NPPES API drives `deprecated_at` flag | Reference data; no PHI. |
| `nppes_sync_run` | **2 years** | Operational telemetry. |

The retention sweeper is a M1-owned cron pattern; M29 contributes the per-table predicate to the registry and is otherwise passive. Partition-drop for `hl7_message_inbound/outbound` is the preferred mechanism over per-row DELETE (an `ALTER TABLE ... DETACH PARTITION` followed by `DROP TABLE` is O(1) and avoids the WAL flood of bulk DELETE).

### 8.5 Adapter Mandate (Architecture §25.14) — Compliance Statement

M29 is a textbook adapter-mandate consumer. Its compliance posture is enumerated below per the architecture mandate:

1. **External-service SDK ownership boundary.** M29 owns `packages/hl7-worker` (HAPI sidecar wrapper) and `packages/nppes-client`. M29 does **not** own `packages/xero-client` or `packages/gusto-client` — those are owned by M27 (per M27 D6). When M29 needs Xero/Gusto (deferred Phase 2), it consumes the `XeroClientFactory` and `GustoClientFactory` seams from M27's published `consumedSeams` surface — no direct SDK import.
2. **Wire-format encapsulation.** No code outside `packages/hl7-worker` or `apps/backend/src/modules/29-external-interfaces/**` may import HL7 segment types, the HAPI sidecar bindings, or construct HL7 wire frames. M11 declares an HL7-shaped intent (`m11.order.hl7_orm_requested` with typed PID/ORC/OBR/NTE payload fields) but does not own the wire format; M29 owns the build step.
3. **Sidecar boundary discipline.** The Java HAPI sidecar (D2) is the **only Java in the entire WardenX repo**. It runs as a separate process bound to a local UDS socket; the TS worker is the sole consumer; no other module may bind a sidecar socket. The dependency-cruiser rule forbids `import` statements referencing `java/`, `.jar`, or the sidecar gRPC stubs outside `packages/hl7-worker/src/sidecar/`.
4. **Outbox-only cross-module communication.** Every cross-module call from M29 flows through M4's outbox. Direct cross-schema reads (e.g., `SELECT * FROM clinical.patient`) are forbidden by dependency-cruiser; M29 reads patient identity via the `PatientReader` seam from M5.
5. **Pre-persist redaction (D15).** SUD-redaction pass happens *before* `hl7_message_inbound` is written. M29 owns the orchestration of this pass via the `ConsentEvaluator` seam from M39 — M29 does not implement consent evaluation itself.

A dependency-cruiser rule (`forbidden`) is added to the architecture fitness config for each of the above; CI fails on any violation. The full rule set is enumerated in §13.2.

### 8.6 AI Boundary

M29 does **not** invoke any AI surface. The deterministic five-level patient match cascade (§4.6) is rule-based by design — probabilistic ML matching is explicitly Phase 2 (per D6) and would land via the `M32.AIPlatform.NarrativeEnhancementProvider`-style seam pattern (a new `ProbabilisticMatchProvider` seam published by M32 in Phase 2, consumed by M29 only after dual-review of model performance per the HOTL governance policy). No AI inference happens inside M29.

The proposal-review surface (§5.2.3) does **not** show AI-generated suggestions, summaries, or recommendations. Reviewers see the raw HL7-derived field deltas only. This is intentional: a wrong AI summary on a critical-care clinical document would be a high-blast-radius failure mode.

### 8.7 MLLP TLS Posture

**Inbound:**
- TLS 1.3 minimum, TLS 1.2 explicitly disabled (no fallback).
- Cipher suites restricted to `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`, `TLS_AES_128_GCM_SHA256`.
- mTLS required (`requestCert: true`, `rejectUnauthorized: true`).
- Client-CA pinned per-feed (each feed's `external_feed_credential` of kind `MTLS_CERT` includes `expected_client_ca_pem`). Cross-feed CA reuse is allowed but each feed independently asserts the pinned CA — no platform-wide trust store.
- Certificate revocation checked via the in-memory revocation list, refreshed on `m29.external_feed_credential.revoked` outbox event; OCSP-stapling supported but not required (some partner facilities don't ship valid OCSP responses).
- Session resumption disabled (no `SSL_session` caching) — every handshake re-validates the client cert and consults the revocation list.

**Outbound:**
- TLS 1.3 minimum, mTLS as the default (some labs don't accept mTLS; per-feed `outboundTlsMode` config supports `MTLS`, `TLS_SERVER_ONLY`, or `NONE` with a hard-refuse-without-explicit-allow rule that requires compliance-officer sign-off captured as a `external_feed.outbound_tls_exception_evidence` field).
- Server cert pin per-receiving-lab (each outbound feed pins the expected lab's server CA in `external_feed_credential` of kind `OUTBOUND_PEER_CA`).
- Hostname verification on every connection.

**Audit:** Every TLS handshake (success or failure) is logged at INFO level with `{ feedId, peerAddr, handshakeMs, cipher, clientCN }`. Failed handshakes additionally log the failure reason (cert-expired, cert-revoked, allowlist-reject, ca-mismatch, etc.) at WARN level and emit `m29.external_feed.handshake_failed` to compliance for pattern-of-failure detection.

### 8.8 PHI Minimization Practices

1. **Audit denylist** (§3.6) excludes PHI-bearing HL7 segments from M4 audit bodies. Only segment summaries are kept.
2. **Search responses** for `/external-interfaces/feeds/:feedId/messages/inbound` return metadata only (message-control-id, message-type, received-at, sending-facility, processing-status, matched-patient-id-redacted-to-last-4). Full payload requires the gated modal (§5.2.6).
3. **Unmatched lab queue** (§5.2.4) shows patient-name initials by default; full reveal requires step-up + a separate permission.
4. **Webhook bodies in error logs** are stripped of HL7 payload before being captured. Error logs include only message-control-id, sending facility, error category, and the line of code that threw.
5. **Backup snapshots** of M29 tables are encrypted at rest (per platform-wide policy from System Design §6) AND additionally carry the payload ciphertext that is itself envelope-encrypted with tenant-DEK-via-platform-KEK. A backup compromise yields ciphertext-of-ciphertext without unwrapping both keys.
6. **Cross-region replication** is disabled by default for M29 tables; tenants must explicitly opt-in for DR replication, captured as a tenant-level config with compliance-officer sign-off audit.

### 8.9 Incident Response Hooks

If a credential compromise or PHI leak is suspected, the operator-on-call has the following emergency controls:

- **Emergency feed suspend** (`POST /api/v1/external-interfaces/feeds/:feedId:emergency-suspend`) — bypasses the dual-approval requirement for revocation (which would normally be required) but logs the bypass with `emergency_reason` (free-text, required), step-up evidence, and emits `m29.external_feed.emergency_suspended` to compliance + tenant-admin notification chains simultaneously. Post-incident review by compliance is mandatory (a follow-up ticket is auto-created in the M19 on-call triage queue, even though this is operator-not-clinical, because that's the only existing incident tracking surface in Phase 1).
- **Platform-wide kill-switch** (platform-role only) — a `platform_emergency_external_interfaces_disable` flag in MDM (M40-owned) that, when set, refuses all new MLLP connections and refuses outbox events for outbound dispatch across all tenants. Recovery requires manual flag-unset by platform-compliance with audit emission to all affected tenant compliance officers.

These controls are documented in the Ops Runbook (`WARDENX_OPS_RUNBOOK_v0_1.md` §M29 section) with full runbook scripts.

---

## 9. Testing

M29's test surface is **the strictest in the platform tier** because of the external-network attack surface and the cross-module clinical-data fanout. Floors:

- **Unit coverage:** ≥90% lines/branches overall; ≥95% on named-critical services (§9.1).
- **Integration coverage:** Every workflow scenario (W-XI-01 … W-XI-15) has a Testcontainers integration test.
- **RLS isolation:** Every tenant-owned table has a cross-tenant-leak test.
- **IDOR:** Every route with a path-param ID is tested with a cross-tenant ID.
- **Security:** mTLS handshake, sender allowlist, plaintext-view quota, step-up, BAA gate are independently tested.
- **E2E:** Playwright suites cover the operator surfaces.
- **Performance:** k6 scripts validate SLOs per System Design §9.

### 9.1 Named-Critical Services (≥95% Branch Coverage)

| Service | File | Why named-critical |
|---------|------|---------------------|
| `Hl7InboundFrameHandler` | `apps/.../inbound/frame-handler.ts` | First line of defense; controls idempotency, ACK semantics, hash-on-receive. |
| `Hl7InboundParser` | `apps/.../inbound/parser.ts` | Calls the HAPI sidecar; converts wire to typed segment tree; PHI redaction handoff to M39. |
| `PatientMatchCascade` | `apps/.../inbound/match-cascade.ts` | The 5-level cascade. Wrong matches are clinical-safety failures. |
| `ProposalLifecycleService` | `apps/.../proposals/lifecycle.ts` | State machine for `hl7_inbound_proposal`; owner-module gate enforcement. |
| `LabObservationAttachment` | `apps/.../labs/attachment.ts` | Auto-attach + abnormal-flag → caseload alert. |
| `OutboundOrmDispatcher` | `apps/.../outbound/orm-dispatcher.ts` | M11 consumer; BAA gate; retry policy; DLQ. |
| `ListenerSupervisor` | `apps/.../listener/supervisor.ts` | Boot, hot-reload, graceful shutdown, listener-down detection. |
| `NppesSyncJob` | `apps/.../nppes/sync-job.ts` | Platform-role context; M40 outbox emission. |
| `EnvelopeEncryptor` | `apps/.../crypto/envelope.ts` | Payload encryption pre-persist; DEK rotation handling. |
| `SudIngressRedactor` | `apps/.../redaction/sud.ts` | M39 consent evaluator handoff; segment stripping at wire boundary. |

Each carries a co-located `.test.ts` with branch-coverage thresholds enforced in CI; PR-level coverage delta is gated by `codecov.yml` thresholds matching M28's posture.

### 9.2 Unit Tests (Selected Scenarios)

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.test.ts

describe('PatientMatchCascade', () => {
  it('L1: exact MRN match returns confident', async () => {
    const pid = { '3.1': 'MRN-001234', '3.4': 'ST_ANTHONY' };
    const result = await cascade.resolve(pid, { feedId: 'feed_stanthony', tenantContext });
    expect(result.matchLevel).toBe('L1_MRN_EXACT');
    expect(result.patientId).toBe('pt_jane_doe');
    expect(result.confidence).toBe('CONFIDENT');
  });

  it('L1 fails but L4 returns single candidate -> CANDIDATE_REVIEW', async () => {
    const pid = { '3.1': 'MRN-WRONG', '5': 'DOE^JANE', '7': '19480322', '8': 'F', '11.5': '97801' };
    const result = await cascade.resolve(pid, { feedId, tenantContext });
    expect(result.matchLevel).toBe('L4_DEMOGRAPHIC_BRIDGE_CANDIDATE');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].patientId).toBe('pt_jane_doe');
    expect(result.confidence).toBe('CANDIDATE_REVIEW');
  });

  it('L4 returns multiple candidates -> AMBIGUOUS, no auto-match', async () => {
    // two patients with same DOB/state/zip
    const pid = { '3.1': 'MRN-WRONG', '5': 'DOE^JANE', '7': '19480322', '8': 'F', '11.5': '97801' };
    const result = await cascade.resolve(pid, { feedId, tenantContext: tenantWithTwoMatchingPatients });
    expect(result.matchLevel).toBe('L4_AMBIGUOUS');
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.confidence).toBe('AMBIGUOUS');
  });

  it('No cascade level matches -> UNMATCHED', async () => {
    const pid = { '5': 'NOPE^NOBODY', '7': '20000101' };
    const result = await cascade.resolve(pid, { feedId, tenantContext });
    expect(result.matchLevel).toBeNull();
    expect(result.cascadeStagesAttempted).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(result.confidence).toBe('UNMATCHED');
  });
});
```

```ts
// apps/backend/src/modules/29-external-interfaces/outbound/orm-dispatcher.test.ts

describe('OutboundOrmDispatcher', () => {
  it('refuses dispatch with TerminalError on inactive BAA', async () => {
    const event = mkOrmEvent({ feedId: 'feed_lab_x' });
    mdm.baaStatus.mockResolvedValue({ isActive: false, status: 'EXPIRED' });
    await expect(dispatcher.handle(event, ctx)).rejects.toThrow(TerminalError);
    expect(ctx.audit.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hl7.outbound.baa_refuse' }));
    expect(db.hl7MessageOutbound.insert).not.toHaveBeenCalled();
  });

  it('persists outbound row before dispatch attempt', async () => {
    const event = mkOrmEvent({ feedId: 'feed_lab_x' });
    mdm.baaStatus.mockResolvedValue({ isActive: true });
    sidecar.buildOrm.mockResolvedValue({ wire: '...', msh10: 'MCID-123' });
    mllpClient.dispatch.mockImplementation(() => new Promise(() => {})); // hang, simulate slow lab
    void dispatcher.handle(event, ctx);
    await waitFor(() => expect(db.hl7MessageOutbound.insert).toHaveBeenCalled());
    expect(db.hl7MessageOutbound.insert).toHaveBeenCalledBefore(mllpClient.dispatch);
  });

  it('AR response transitions to NACKED, no retry', async () => {
    // ...
  });

  it('AE response is retryable; counts toward budget', async () => {
    // ...
  });
});
```

### 9.3 Integration Tests (Testcontainers)

Integration tests run against a real Postgres (with M29 + M3 + M4 + M5 + M11 + M40 schemas migrated), a real Valkey, a mock MLLP server (`packages/hl7-worker/test/mllp-mock.ts`), and a mock HAPI sidecar over UDS.

#### 9.3.1 Workflow-Backed Integration Tests

Every workflow scenario W-XI-01 … W-XI-15 has a one-to-one integration test:

- `test/integration/w-xi-01_l1_confident_match.test.ts`
- `test/integration/w-xi-02_l4_candidate_review.test.ts`
- `test/integration/w-xi-03_partial_field_accept.test.ts`
- `test/integration/w-xi-04_reject_required_note.test.ts`
- `test/integration/w-xi-05_abnormal_lab_attach_alert.test.ts`
- `test/integration/w-xi-06_unmatched_lab_queue.test.ts`
- `test/integration/w-xi-07_outbound_orm_ack.test.ts`
- `test/integration/w-xi-08_baa_refuse_outbound.test.ts`
- `test/integration/w-xi-09_dlq_after_5.test.ts`
- `test/integration/w-xi-10_listener_down_alert.test.ts`
- `test/integration/w-xi-11_nppes_delta_sync.test.ts`
- `test/integration/w-xi-12_nppes_tenant_refused.test.ts`
- `test/integration/w-xi-13_credential_rotate_stepup.test.ts`
- `test/integration/w-xi-14_sud_ingress_redaction.test.ts`
- `test/integration/w-xi-15_boot_predicate_missing.test.ts`

Each is a single `describe` block with the Given/When/Then mapped to setup/act/assert. No conditional skips (`it.skip` / `xdescribe`) are permitted in M29 tests.

#### 9.3.2 RLS Isolation Tests

```ts
// test/integration/rls/cross_tenant_leak.test.ts
describe('M29 RLS isolation', () => {
  it('tenant A cannot SELECT tenant B feed', async () => {
    await seed.feed({ organizationId: 'org_a', id: 'feed_a' });
    await seed.feed({ organizationId: 'org_b', id: 'feed_b' });

    await withOrgContext({ organizationId: 'org_a' }, async (db) => {
      const rows = await db.query.externalFeed.findMany();
      expect(rows.map(r => r.id)).toEqual(['feed_a']);
    });
  });

  it('tenant A cannot UPDATE tenant B credential even with explicit id', async () => {
    await seed.feedCredential({ organizationId: 'org_b', id: 'cred_b' });
    await withOrgContext({ organizationId: 'org_a' }, async (db) => {
      const result = await db.update(externalFeedCredential)
        .set({ revokedAt: new Date() })
        .where(eq(externalFeedCredential.id, 'cred_b'));
      expect(result.rowCount).toBe(0); // RLS refused; affected zero rows
    });
  });

  it('platform-role context can read NPPES providers; tenant cannot write', async () => {
    await seed.nppesProvider({ npi: '1234567890' });

    await withOrgContext({ organizationId: 'org_a' }, async (db) => {
      const rows = await db.query.nppesProvider.findMany();
      expect(rows.length).toBe(1); // platform-shared READ via PLATFORM_RO scope

      await expect(
        db.insert(nppesProvider).values({ npi: '9999999999', /* ... */ })
      ).rejects.toThrow(/new row violates row-level security/);
    });

    await withPlatformContext(async (db) => {
      await db.insert(nppesProvider).values({ npi: '9999999999', /* ... */ }); // allowed
    });
  });
});
```

#### 9.3.3 IDOR Tests

For every route with `:feedId`, `:messageId`, `:proposalId`, `:observationId`, `:credentialId`, `:syncRunId`, there is a test that:
1. Seeds a resource under tenant B.
2. Authenticates as a user in tenant A with all M29 grants.
3. Issues a GET/PATCH/DELETE against the tenant B resource's ID.
4. Asserts `404 not_found` (not `403`; per the security policy, never leak existence cross-tenant).

#### 9.3.4 Security Tests

- **mTLS handshake**: `test/integration/security/mtls_required.test.ts` — connect to listener with no client cert, with expired client cert, with wrong-CA client cert; each refused at handshake.
- **Sender allowlist**: `test/integration/security/allowlist.test.ts` — connect from non-allowlisted IP; refused at socket-accept, no parse path triggered.
- **Plaintext view quota**: `test/integration/security/plaintext_quota.test.ts` — same user views 50 payloads in 24h; 51st returns 429.
- **Step-up freshness**: `test/integration/security/step_up_recent.test.ts` — step-up evidence age 4:59 passes; 5:00 fails.
- **BAA gate on activation**: `test/integration/security/baa_activation.test.ts` — feed activation with BAA-missing returns 403 with audit emission.
- **PHI denylist**: `test/integration/security/phi_log_denylist.test.ts` — generate a parse error mid-frame; capture pino log; assert no PID-5 / NK1 / IN1 text appears.
- **Envelope encryption**: `test/integration/security/envelope_encryption.test.ts` — write a frame; query raw `payload_ciphertext` from DB; assert it is not equal to plaintext; assert decrypt round-trips.

### 9.4 Fixtures

| Fixture | Path | Purpose |
|---------|------|---------|
| ADT^A01 standard admission | `test/fixtures/hl7/adt_a01_standard.txt` | Baseline new-patient admission frame. |
| ADT^A08 update with new address | `test/fixtures/hl7/adt_a08_address_update.txt` | W-XI-01, W-XI-03. |
| ADT^A08 with SUD diagnosis | `test/fixtures/hl7/adt_a08_with_sud.txt` | W-XI-14 redaction. |
| ORU^R01 abnormal creatinine | `test/fixtures/hl7/oru_r01_abnormal_creatinine.txt` | W-XI-05. |
| ORU^R01 unmatched patient | `test/fixtures/hl7/oru_r01_unmatched_patient.txt` | W-XI-06. |
| ORM^O01 outbound build target | `test/fixtures/hl7/orm_o01_basic.txt` | Sidecar build round-trip. |
| Malformed frame (missing MSH-10) | `test/fixtures/hl7/malformed_no_msh10.txt` | Negative parse. |
| Duplicate frame (same MSH-10) | `test/fixtures/hl7/duplicate_msh10.txt` | Idempotency. |
| 8.1MB frame (oversize) | `test/fixtures/hl7/oversize_8_1mb.bin` | Frame-size DoS guard. |
| NPPES API mock — small delta | `test/fixtures/nppes/delta_small.json` | W-XI-11. |
| NPPES API mock — deprecation | `test/fixtures/nppes/provider_deprecated.json` | M40 re-resolve path. |
| BAA active fixture | `test/fixtures/mdm/baa_active.ts` | Default green-path. |
| BAA expired fixture | `test/fixtures/mdm/baa_expired.ts` | W-XI-08. |

### 9.5 E2E Playwright Suites

```
e2e/external-interfaces/
├── feed-create-flow.spec.ts           — wizard end-to-end, dual-approval, step-up modal
├── proposal-review-accept.spec.ts     — open proposal, partial-accept, decision note
├── proposal-review-reject.spec.ts     — reject with empty note (fail), retry with note
├── unmatched-lab-manual-match.spec.ts — match-to-patient + discard paths
├── payload-view-quota.spec.ts         — view 50 payloads; 51st blocked with friendly UI
├── nppes-trigger-tenant-refused.spec.ts — tenant admin sees disabled button + tooltip
├── nppes-trigger-platform-allowed.spec.ts — platform operator triggers DELTA, sees run history
└── listener-down-alert.spec.ts        — simulate listener-down; assert dashboard tile red + M36 alert
```

E2E runs against a docker-compose stack with the full M29 + dependencies; CI runs the suite on every PR touching `apps/web/src/routes/external-interfaces/**` or `apps/backend/src/modules/29-external-interfaces/**`.

### 9.6 Performance / k6

SLOs anchored in System Design §9:

| SLO | Target | k6 script |
|-----|--------|-----------|
| MLLP frame receive → ACK (p95) | <1.5s | `k6/mllp_ack_latency.js` |
| MLLP frame receive → parsed (p95) | <2s | `k6/mllp_parse_latency.js` |
| Inbound sustained throughput per feed | ≥10 frames/sec | `k6/mllp_throughput.js` |
| ORM dispatch → ACK (p95, healthy lab) | <3s | `k6/orm_dispatch_latency.js` |
| Proposal list page render (p95) | <300ms server, <800ms TTI | `k6/proposal_list_render.js` |
| Payload view modal open (p95) | <500ms (including step-up check) | `k6/payload_view_open.js` |
| NPPES DELTA sync wallclock for 1000-row delta | <2min | `k6/nppes_delta_throughput.js` |

k6 outputs land in the platform's perf-history bucket; regressions >10% on any SLO block release per System Design §9.4.

### 9.7 Mutation Testing (Stryker)

Named-critical services (§9.1) carry a Stryker mutation-testing floor of ≥85% killed mutants. This is verified weekly in scheduled CI; PR-level enforcement is opt-in but recommended on changes touching the cascade or dispatcher.

### 9.8 Static Analysis & Lint

- **ESLint rules** (M29-specific): forbid `import 'java/*'` outside the sidecar package; forbid `console.log` in `apps/backend/src/modules/29-external-interfaces/**` (must use pino); forbid `String.prototype.includes` on PHI-tagged variables (custom rule using TS type annotations).
- **Dependency-cruiser rules** (full set in §13.2).
- **Drizzle schema lint**: every table must declare `organization_id` UNLESS it is in the platform-shared registry (`nppes_provider`, `nppes_sync_run`); enforced by the `check-table-ownership.ts` script.
- **HL7 segment registry lint**: every typed segment in `packages/hl7-worker/src/types.ts` must have a registered profile in `packages/hl7-worker/src/profiles/registry.ts`; mismatch fails CI.

---

## 10. Implementation Tasks

Tasks are ordered by dependency (later tasks assume earlier ones). Each `T-29.NN` corresponds to a single PR (or PR-stack for the larger tasks); each carries its acceptance criteria, related W-XI-** scenarios, and a sign-off owner from the team.

### T-29.01 — Manifest Patch + Architecture Fitness

**Purpose:** Land the M29.dependsOn expansion (D24), the ownedTables list, and the dependency-cruiser rules so subsequent PRs are bounded by enforcement from day one.

**Files:**
- `module-manifest.ts` (patch per §13.1)
- `.dependency-cruiser.cjs` (rules per §13.2)
- `boot.ts` (predicate registration stubs)

**Acceptance:**
- `bun run check:manifest` passes.
- `bun run check:cruiser` enforces all M29 rules against the still-empty M29 directory.
- `bun run check:table-ownership` registers `nppes_provider` and `nppes_sync_run` on the platform-shared list and the rest as M29-owned.

**Owner:** Architecture.

### T-29.02 — Drizzle Schema + Migrations

**Purpose:** Land §3 schema in full: 9 tenant-owned tables + 2 platform-shared, partitioning for `hl7_message_inbound/outbound`, RLS policies, indexes, audit denylist registration, eraser registration.

**Files:**
- `packages/db/src/schema/external-interfaces/*.ts` (one file per table)
- `apps/backend/drizzle/migrations/0029_*.sql` (generated)
- `apps/backend/src/modules/29-external-interfaces/eraser.ts`
- `packages/db/src/audit-denylist/m29.ts`

**Acceptance:**
- All migrations run forward and reverse clean.
- RLS isolation test (§9.3.2) passes against the post-migration schema.
- Audit denylist test confirms PHI segments are filtered from M4 audit bodies.

**Owner:** Platform.

### T-29.03 — HAPI Sidecar Bring-Up

**Purpose:** Stand up the Java HAPI HL7v2 sidecar process, the UDS-bound gRPC interface, the TS-side wrapper in `packages/hl7-worker`, and the typed segment registry.

**Files:**
- `packages/hl7-worker/java/` (HAPI Java sidecar — Gradle build, single JAR)
- `packages/hl7-worker/src/sidecar/client.ts` (gRPC client over UDS)
- `packages/hl7-worker/src/types.ts` (typed segments)
- `packages/hl7-worker/src/profiles/registry.ts` (registered profiles: ADT_A01, ADT_A03, ADT_A04, ADT_A08, ADT_A11, ORU_R01, ORM_O01)
- `packages/hl7-worker/src/redaction/sud.ts` (SUD redaction; calls into M39 ConsentEvaluator seam — wired to fixture impl in T-29.03 and to real M39 in T-29.04)
- Dockerfile + docker-compose updates to ship the sidecar alongside the backend.

**Acceptance:**
- Round-trip test: parse a sample ADT^A01, project to typed segments, rebuild to wire — byte-equal modulo whitespace.
- Sidecar handles malformed input gracefully (returns structured error, does not crash).
- UDS socket path is bind-mounted into the container; no TCP port exposed for the sidecar.
- HL7 segment registry lint passes.

**Owner:** Platform + integrations engineer.

### T-29.04 — MLLP Listener Supervisor

**Purpose:** Land the `apps/backend/src/modules/29-external-interfaces/listener/supervisor.ts` with the full lifecycle (§4.11), the BullMQ queue catalog (§4.9), the circuit-breaker / health probe, and the graceful shutdown handler.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/listener/supervisor.ts`
- `apps/backend/src/modules/29-external-interfaces/listener/frame-handler.ts`
- `apps/backend/src/modules/29-external-interfaces/listener/health-probe.ts`
- `apps/backend/src/modules/29-external-interfaces/listener/index.ts` (entry point fork)
- `apps/backend/src/modules/29-external-interfaces/workers/hl7-inbound-parse.worker.ts`

**Acceptance:**
- W-XI-01 (listener through parse-result subset only — full W-XI-01 closes at T-29.06), W-XI-10 (listener-down alert), W-XI-15 (boot validator) integration tests pass. (T-29.04 owns listener + frame handler + idempotency + parse worker, but cascade and proposal creation are T-29.05 and T-29.06 respectively.)
- Frame-size DoS guard rejects 8.1MB fixture.
- Idempotency check on duplicate MSH-10 emits AA without re-enqueuing.
- mTLS handshake with no client cert / wrong CA / expired cert is refused.

**Owner:** Integrations engineer.

### T-29.05 — Patient Match Cascade

**Purpose:** Implement the deterministic five-level cascade (§4.6) as a pure-function service consumed by the inbound parse worker.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.ts`
- `apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.test.ts` (≥95% branch)

**Acceptance:**
- All unit-test scenarios from §9.2 pass.
- W-XI-01, W-XI-02 integration tests pass.
- Consumes `PatientReader` seam from M5 (no direct schema read).
- Cascade stages-attempted projection is correctly persisted on `hl7_message_inbound`.

**Owner:** Clinical engineering.

### T-29.06 — Proposal Lifecycle

**Purpose:** Land the proposal state machine, the owner-module-match ABAC predicate, the partial-accept logic, and the M5/M6 outbox-event downstream wiring.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/proposals/lifecycle.ts`
- `apps/backend/src/modules/29-external-interfaces/proposals/outbox-publisher.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/proposals.ts`
- `apps/backend/src/modules/03-authorization/predicates/hl7_inbound_proposal_owner_module_match.ts` (delivered to M3 by M29 — predicate definition, registered in M3 boot)

**Acceptance:**
- W-XI-03 (partial accept), W-XI-04 (reject required note) integration tests pass.
- Owner-module-mismatch refusal returns `403 owner_module_mismatch`.
- Race-condition test: two concurrent accepts on same proposal — exactly one succeeds.
- M5 consumer applies fields and emits its own update event on partial accept.

**Owner:** Clinical engineering + identity engineer.

### T-29.07 — Lab Observation Attachment + Unmatched Queue

**Purpose:** Land the `LabObservationAttachment` service with auto-attach via OBR-2, abnormal-flag-triggered M36 alerts, and the unmatched queue UI.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/labs/attachment.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/lab-observations.ts`
- `apps/web/src/routes/external-interfaces/lab-observations/`
- `apps/web/src/routes/external-interfaces/lab-observations/unmatched/`

**Acceptance:**
- W-XI-05 (abnormal attach + alert) and W-XI-06 (unmatched queue) integration tests pass.
- M11 receives `m29.lab_observation.attached` and transitions order to RESULTS_RECEIVED.
- M36 alert dispatched to caseload RN on `OBX-8 ∈ {HH, LL, A}`.
- Unmatched queue UI hides PII by default; reveal requires step-up.

**Owner:** Clinical engineering.

### T-29.08 — Outbound ORM Dispatcher

**Purpose:** Land the M11 consumer for `m11.order.hl7_orm_requested`, BAA gate, sidecar build, MLLP client, retry policy, DLQ, manual resend.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/outbox-consumers/orm-dispatcher.ts`
- `apps/backend/src/modules/29-external-interfaces/outbound/mllp-client.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/outbound-messages.ts` (search + resend)

**Acceptance:**
- W-XI-07 (ACK), W-XI-08 (BAA refuse), W-XI-09 (DLQ) integration tests pass.
- AR response transitions to NACKED without retry; AE counts toward attempt budget.
- BAA-restore on M40 republishes DLQ'd order events; dispatch retries automatically.
- Manual resend creates new MSH-10 with `parentMessageId` audit chain.

**Owner:** Integrations engineer + billing engineer (for M11 contract review).

### T-29.09 — NPPES Sync Job

**Purpose:** Land the NPPES public-API client, the FULL/DELTA/MANUAL sync jobs, the `withPlatformContext` execution, M40 outbox emission, and the sync-history admin UI.

**Files:**
- `packages/nppes-client/src/index.ts`
- `apps/backend/src/modules/29-external-interfaces/nppes/sync-job.ts`
- `apps/backend/src/modules/29-external-interfaces/nppes/upsert.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/nppes.ts`
- `apps/web/src/routes/external-interfaces/nppes/`

**Acceptance:**
- W-XI-11 (DELTA sync) and W-XI-12 (tenant trigger refused) integration tests pass.
- Platform-role-only ABAC predicate `nppes_platform_job_caller` enforced.
- M40 receives `m29.nppes.sync_run.completed` and re-resolves cached prescriber rosters with deprecated NPIs.
- Sync-run row persists progress; failed runs land in `FAILED` state with structured error.

**Owner:** Identity engineer + platform.

### T-29.10 — Credential Lifecycle + Step-Up

**Purpose:** Land the mint/rotate/revoke routes, the envelope encryption for credential secrets, the in-memory revocation list refreshed by outbox event, the 24h grace window for in-flight TLS handshakes, and the step-up gate.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/credentials/lifecycle.ts`
- `apps/backend/src/modules/29-external-interfaces/credentials/revocation-list.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/credentials.ts`
- `apps/web/src/routes/external-interfaces/feeds/:feedId/credentials/`

**Acceptance:**
- W-XI-13 (rotation step-up) integration test passes.
- Revoked credential is rejected at TLS handshake within 30s of revocation event.
- Rotation creates new ACTIVE; previous transitions to ROTATING for 24h grace.
- Compliance officer notification on credential events.

**Owner:** Security engineer + identity engineer.

### T-29.11 — SUD Ingress Redaction (M39 Integration)

**Purpose:** Wire the pre-persist SUD redaction pass to the M39 `ConsentEvaluator.evaluateForIngressRedaction` seam.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/redaction/sud.ts` (real M39 wiring; replaces T-29.03 fixture)
- `packages/hl7-worker/src/redaction/segment-stripper.ts` (segment-position-aware strip + audit)

**Acceptance:**
- W-XI-14 integration test passes.
- Stripped segments do not land in `payload_ciphertext`.
- Audit summary captures segment positions without segment contents.
- Non-reversibility test: re-receiving a previously-redacted MSH-10 with the same content does not re-introduce the SUD segments.

**Owner:** Clinical engineering + privacy engineer.

### T-29.12 — Payload-View Quota + Plaintext UI

**Purpose:** Land the rate-limited plaintext-view modal with copy-suppression, watermarking, PHI reveal toggle, and quota enforcement.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/routes/payload-view.ts`
- `apps/backend/src/modules/29-external-interfaces/quota/plaintext-view-quota.ts`
- `apps/web/src/routes/external-interfaces/feeds/:feedId/messages/:messageId/payload/`

**Acceptance:**
- Plaintext quota test (§9.3.4) passes — 51st view returns 429.
- Per-view audit emission verified.
- Copy-to-clipboard interception test passes.
- Watermark renders with viewer email + nonce.

**Owner:** Frontend + security engineer.

### T-29.13 — Operator Dashboard + Notifications

**Purpose:** Land the dashboard surface, all M36 notification triggers, and the M19 emergency-suspend incident hook.

**Files:**
- `apps/web/src/routes/external-interfaces/dashboard/`
- `apps/backend/src/modules/29-external-interfaces/notifications/dispatcher.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/emergency.ts`

**Acceptance:**
- Dashboard tiles render correctly for healthy / degraded / down feeds.
- All §5.3 notification triggers fire under simulated conditions.
- Emergency suspend creates M19 follow-up ticket and dispatches simultaneous compliance + tenant-admin notifications.

**Owner:** Frontend + integrations engineer.

### T-29.14 — Test Suite + Perf Baselines

**Purpose:** Bring up the full test surface (§9) including Stryker mutation thresholds, k6 perf baselines, Playwright E2E, and the per-PR coverage gate.

**Files:**
- `apps/backend/src/modules/29-external-interfaces/**/*.test.ts` (unit)
- `test/integration/w-xi-*.test.ts` (integration)
- `e2e/external-interfaces/*.spec.ts` (Playwright)
- `k6/external-interfaces/*.js` (perf)
- `stryker.conf.json` (mutation thresholds for named services)
- `codecov.yml` (coverage gates updated)

**Acceptance:**
- All §9 floors met.
- CI pipeline runs M29 suites in <12min wall-clock (parallelized).
- Perf SLO baselines captured and stored in the perf-history bucket.

**Owner:** Whole module team.

### Sequencing Diagram

```
T-29.01 ──┬─→ T-29.02 ──┬─→ T-29.03 ──┬─→ T-29.04 ──┬─→ T-29.05 ──┬─→ T-29.06 ─→ T-29.07
          │             │             │             │             │
          │             │             │             │             └─→ T-29.08
          │             │             │             │
          │             │             │             └─→ T-29.09 (NPPES — parallel)
          │             │             │
          │             │             └─→ T-29.10 (credentials — parallel after sidecar)
          │             │
          │             └─→ T-29.11 (SUD redaction — depends on T-29.03 sidecar + M39 ready)
          │
          └─→ T-29.12 (UI — parallel after schema)
             T-29.13 (UI dashboard — after T-29.04/07/08 minimal scaffolding)
             T-29.14 (tests — concurrent with all; gating final lock)
```

T-29.01 is the hard gate; subsequent PRs cannot land without the manifest patch + dependency-cruiser rules in place (they would be enforceable-by-CI from day one rather than retroactively).

---

## 11. Resolved Decisions

| # | Decision | Chosen approach | Alternatives considered & why rejected | Reference |
|---|----------|-----------------|----------------------------------------|-----------|
| **D1** | Module scope: what counts as "external interface" | Four pillars: (a) HL7 v2 inbound MLLP (ADT + Labs ORU^R01), (b) HL7 v2 outbound MLLP (ORM^O01 consumer of M11), (c) NPPES public-API client + platform-shared sync, (d) Xero/Gusto factory **consumption** for non-cost-report Phase-2 uses (adapters owned by M27). | (i) Pull Xero/Gusto adapters into M29 — rejected because M27 already owns them per M27 D6; splitting would violate single-ownership. (ii) Pull FHIR R4 into M29 — rejected because M28 owns FHIR Gateway; M29 is HL7 v2 only. (iii) Pull patient-portal SAML/OIDC into M29 — rejected because M2 (Identity) owns auth federation. | Architecture v0.11 §I, M27 D6 |
| **D2** | HL7 v2 parser implementation | Java HAPI v2.5+ as out-of-process sidecar over UDS gRPC; TS-side typed segment registry. | (i) Pure TS HL7 parser (e.g., `simple-hl7`) — rejected because v2.5.1 + Z-segments are too fragile in JS implementations; HAPI is the de-facto correct reference. (ii) In-process JNI binding — rejected because (a) introduces JVM into the Node process complicating ops, (b) Java exceptions can crash Node. (iii) Cloud-managed HL7 parsing service (e.g., Mirth, Redox) — rejected because HIPAA BAA scope is simpler with everything in-cluster, and lock-in risk is unacceptable for a hospice EHR. | D2 §4.11.3 |
| **D3** | MLLP listener topology | One TCP listener per active feed, on a port from the reserved 11000-11999 range; mTLS required; sender IP allowlist per feed. | (i) Single multi-tenant listener that disambiguates by MSH-3/MSH-4 — rejected because mTLS pinning is per-sender, and an SNI-less raw MLLP socket cannot disambiguate at TLS-handshake time. (ii) Listener-per-tenant rather than per-feed — rejected because a tenant may have multiple distinct upstream partners each needing independent cert pinning. | §4.11.2 |
| **D4** | Inbound message storage shape | Partitioned `hl7_message_inbound` / `hl7_message_outbound` tables; envelope-encrypted `payload_ciphertext` BYTEA; clear `payload_sha256` projection; metadata columns (`message_type`, `message_control_id`, `received_at`, `processing_status`, `match_level`, etc.) in clear for query. | (i) Object-store (MinIO) for payloads, only metadata in PG — rejected because the dual-write makes idempotency at frame receipt harder; envelope encryption in PG is sufficient. (ii) Store decrypted in PG — rejected; PHI in storage requires encryption-at-rest beyond PG TDE for defense-in-depth. | §3.3, §8.4 |
| **D5** | Update semantics for ADT-driven patient changes | **Propose-then-review** for ADT update fields; no auto-mutation of clinical state; reviewer applies fields manually or accepts in bulk. | (i) Auto-apply with retroactive undo — rejected because ADT data from upstream is unreliable (test patients, MRN reuse, address typos) and silent mutation of clinical data is a safety failure. (ii) Auto-apply for "trivial" fields like address but proposal for others — rejected because the line is impossible to draw safely (insurance change "looks trivial" until it isn't). | M28 D8 echo |
| **D6** | Patient matching strategy | Deterministic five-level cascade L1-L4 (MRN exact → MRN+facility → name+DOB+gender → demographic bridge); probabilistic ML matcher deferred Phase 2 behind M32 `ProbabilisticMatchProvider` seam. | (i) Probabilistic ML from day one — rejected because (a) M32 is not yet locked, (b) HOTL governance for clinical safety on ML matching requires more model-perf review than Phase 1 timeline permits. (ii) Manual review for every inbound — rejected because operational cost is prohibitive (>100 frames/day expected). | §4.6 |
| **D7** | Lab observation routing | Auto-attach to M11 order via OBR-2 placer-order-number = order_record.id; abnormal flag (HH/LL/A) triggers M36 alert to caseload RN; unmatched labs go to manual queue. | (i) All labs go to a review queue regardless of placer match — rejected because RN workflow is "review the abnormal results", not "review every lab"; gating routine results behind manual review delays clinical care. (ii) Match on patient identifiers in addition to placer — rejected because placer is unambiguous when present; falling back to patient match only when placer is absent simplifies the state space. | §4.6, W-XI-05 |
| **D8** | OBR-2 placer-order-number identity | Use M11's `order_record.id` (ULID) verbatim as the OBR-2 value on outbound; expect it returned verbatim on inbound results. | (i) Generate an opaque placer-id distinct from order_record.id — rejected because the round-trip identity is what makes back-resolution single-query and free of side-tables. (ii) Use a UUID-based identifier — rejected because ULID is the platform-wide convention and the lab partners' systems accept arbitrary 32-char strings. | §4.6, §4.12.1 |
| **D9** | Outbound ORM retry policy | 5-attempt exponential backoff (30s, 60s, 120s, 240s, 480s — ~15.5min wallclock); DLQ on exhaustion; AR is terminal (no retry); AE counts toward budget. | (i) Indefinite retry — rejected because labs that NACK with AR will NACK forever; runaway retry storms degrade upstream. (ii) Linear backoff — rejected because exp backoff is the platform-wide outbox retry convention. (iii) Higher attempt budget — rejected because anything past ~15min wallclock should be human-resolved, not auto-retried. | §4.12 |
| **D10** | NPPES API client | Public NPPES API (`nppes.cms.hhs.gov/api/`) with no credentials; HSTS-preload + cert pin; rate-limit-friendly client (sleep between batches). | (i) Use a commercial NPI lookup vendor — rejected because NPPES is the authoritative source and free; vendor adds cost and latency without benefit. (ii) Sync via downloadable monthly dump — rejected because deltas matter for prescriber roster freshness; nightly DELTA is more responsive. | §4.6 |
| **D11** | NPPES sync execution context | `withPlatformContext` execution; platform-shared `nppes_provider` and `nppes_sync_run` tables; tenant sessions read-only via `withPlatformReadOnly`. | (i) Per-tenant sync — rejected because NPPES data is identical across tenants; per-tenant sync is wasteful and creates inconsistency. (ii) Bake NPPES into M40 (MDM) — rejected because M40 owns *master* data; NPPES is a *reference* data source. M40 consumes M29's outbox events. | §4.11, §8.1 |
| **D12** | Xero/Gusto factory ownership boundary | M27 owns the adapter packages (`packages/xero-client`, `packages/gusto-client`) per M27 D6; M29 consumes the `XeroClientFactory` and `GustoClientFactory` seams for Phase-2 non-cost-report uses (AR sync, payroll-event ingest). Phase 1: no Xero/Gusto code in M29. | (i) Move adapter ownership to M29 — rejected; would force M27 to import from M29, inverting the established direction (M27 is cost-report-specific; M29 is general-purpose external-interface). (ii) Duplicate adapters in both modules — rejected; violates single-source-of-truth for SDK lifecycle. | M27 D6 |
| **D13** | Payload encryption | Envelope encryption: per-tenant DEK wrapped by platform KEK in KMS; payload encrypted with DEK in pre-persist pass. Plus `sha256(payload)` projection in clear for audit. | (i) PG TDE alone — rejected; TDE protects against disk theft, not DB-credential compromise. (ii) Per-message DEKs — rejected; key-management cost is excessive for the marginal security gain. | §8.3, §8.7 |
| **D14** | Idempotency key for inbound frames | `(sending_facility_id, message_control_id)` permanent uniqueness; duplicate MSH-10 emits AA without re-enqueuing parse. | (i) `(sending_facility_id, message_control_id, received_at_minute)` — rejected; legitimate replays from upstream after their crash would be treated as new messages and would double-emit alerts. (ii) Hash-based dedup — rejected; intentional re-sends with identical payload should also be detected. | §4.11.3 |
| **D15** | SUD (42 CFR Part 2) ingress redaction | Pre-persist redaction pass calls `M39.ConsentEvaluator.evaluateForIngressRedaction(patientId)`; SUD-relevant segments stripped at the wire boundary before encryption; non-reversible. | (i) Store full payload encrypted and redact at read-time — rejected; 42 CFR Part 2 ingress consent model precludes storing SUD data when ingress consent is absent, even encrypted. (ii) Reject the entire frame — rejected; non-SUD fields in the same frame are still legitimately useful clinical data. | §8.5, W-XI-14 |
| **D16** | BAA gate enforcement points | M40 `mdm.baaStatus(orgId)` is consulted at: (a) feed activation, (b) every outbound dispatch attempt, (c) emergency suspend bypass logging. BAA-missing/expired refuses activation and refuses dispatch (terminal, no retry). M40 republishes DLQ'd events on BAA restoration. | (i) BAA check only at feed creation — rejected; BAAs expire mid-life of a feed and the gate must be runtime-current. (ii) Tenant-side override flag — rejected; tenants cannot loosen compliance floors. | §8.5, W-XI-08 |
| **D17** | Listener-down detection threshold | Platform-floor 5 minutes (no frames + probe fail); tenants may tighten to 1min minimum; circuit-breaker triggers M36 CRITICAL alert. | (i) Lower default (e.g., 1min) — rejected; many partner facilities have quiet periods exceeding 5min legitimately, generating false-positive alarms. (ii) Higher default — rejected; sub-15min recovery SLA is the operational expectation. | §4.11.5 |
| **D18** | Step-up auth scope | Required on: feed write/activate/revoke, credential mint/rotate/revoke, NPPES manual trigger, proposal accept/discard, lab manual match/discard, payload view, outbound resend, allowlist edit. Reject decisions do not require step-up. | (i) Step-up on every write — rejected; would degrade operator workflow with no security gain on reads. (ii) Step-up only on credential ops — rejected; proposal accept mutates clinical state and warrants the same scrutiny as a credential rotation. | §6 footnote ¹ |
| **D19** | Audit denylist for HL7 payload bodies | Pino redaction filters `PID`, `NK1`, `IN1`, `GT1`, `NTE` segment text from log lines; segment-summary projections retained (e.g., "PID present, fields populated: [3,5,7,8,11]"). | (i) Hash-then-log — rejected; hashes of PHI are still considered PHI under the platform privacy posture. (ii) No log at all — rejected; segment summaries are essential for debugging without PHI exposure. | §3.6 |
| **D20** | ABAC predicates registered | Six new predicates registered in M3: `external_feed_organization_scope`, `hl7_inbound_proposal_owner_module_match`, `lab_observation_patient_caseload_or_scope`, `external_feed_compliance_co_approver_distinct`, `nppes_platform_job_caller`, `external_feed_baa_satisfied`. | (i) Bake the checks into route handlers — rejected; the named-predicate-registry pattern (M3) is platform-wide; inline checks bypass the boot validator and cannot be statically referenced. | §4.8, §6 |
| **D21** | Published seams | Five seams: `LabObservationReader`, `Hl7InboundProposalReader`, `ExternalFeedReader`, `NppesProviderReader`, `ExternalInterfaceMetricsProvider`. | (i) Single mega-seam `ExternalInterfaceProvider` — rejected; seam granularity should mirror consumer-shape; M11 needs labs but not feed admin; M28 needs NPPES but not proposals. | §4.4 |
| **D22** | Forward-seam deny-stubs | M30, M33, M34, M35, M37 carry deny-stubs against M29 seams (returning `NotImplementedError`) until those modules are locked and ship real consumers. Fixture-wired in tests. | (i) Omit forward seams entirely until consumers exist — rejected; the architecture mandate requires explicit forward declarations to keep the dependency graph honest. | M28 D14 echo |
| **D23** | MLLP TLS posture | mTLS 1.3-only inbound (with TLS_AES_256_GCM_SHA384 / TLS_CHACHA20_POLY1305_SHA256 / TLS_AES_128_GCM_SHA256); per-feed pinned client-CA; per-feed sender IP allowlist; session resumption disabled. Outbound mTLS by default with `outboundTlsMode` per-feed config and `outbound_tls_exception_evidence` for non-mTLS labs. | (i) TLS 1.2 fallback — rejected; no legitimate need. (ii) Platform-wide trust store — rejected; per-feed pinning bounds blast radius of any CA compromise. | §8.7 |
| **D24** | Manifest patch | M29.dependsOn expands from `[5, 11, 40]` to `[1, 2, 3, 4, 5, 11, 22, 27, 36, 38, 39, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)*; M29 ownedTables enumerated; M29 publishedSeams enumerated. | (i) Keep deps minimal at `[5, 11, 40]` — rejected; that omits real consumers (M3 predicates, M4 audit/outbox, M22 document attachments to lab observations, M27 factory seams, M36 messaging, M38 terminology for LOINC, M39 consent for SUD). | §13.1 |

---

## 12. Acceptance Sign-Off Checklist

The module is **LOCKED** when every box below is checked. Each box is binary; "partially-done" is not lock-grade.

### 12.1 Decisions & Architecture

- [ ] All 24 decisions D1–D24 recorded in §11 with chosen approach + rejected alternatives.
- [ ] Manifest patch (§13.1) applied to `module-manifest.ts` and reviewed against the actual `dependsOn` direction (no inverted edges).
- [ ] Dependency-cruiser config (§13.2) merged; CI enforces M29 boundaries.
- [ ] Table-ownership lint registers all 9 tenant tables to M29 and the 2 platform-shared NPPES tables to the platform-shared registry.
- [ ] Six new ABAC predicates landed in M3 registry; boot validator passes.
- [ ] Five published seams declared in M29's `publishedSeams` manifest entry; consumed seams declared.
- [ ] Forward-seam deny-stubs land in M30, M33, M34, M35, M37 with `NotImplementedError` and fixture wiring.

### 12.2 Schema & Data

- [ ] Drizzle schema files exist for all 11 tables; types match §3.
- [ ] Migrations apply forward and reverse clean against a fresh DB.
- [ ] RLS policies on tenant tables enforce `organization_id = current_setting(...)`.
- [ ] RLS policies on `nppes_provider` / `nppes_sync_run` enforce `current_setting('app.tenant_scope') = 'PLATFORM'` for writes, `'PLATFORM' or 'PLATFORM_RO'` for reads.
- [ ] Partitioning on `hl7_message_inbound` and `hl7_message_outbound` by month.
- [ ] Indexes per §3.4 present and used by EXPLAIN of the canonical queries.
- [ ] Audit denylist registers `payload_ciphertext`, PID/NK1/IN1/GT1/NTE projections.
- [ ] `M29DataEraser` registered; eraser test deletes all tenant rows and leaves platform-shared rows intact.

### 12.3 Routes & Seams

- [ ] All routes from §4.1–4.2 implemented; TypeBox schemas in §4.3 enforced.
- [ ] Permission keys from §6 wired to each route; ABAC predicates per §6.1 mapping.
- [ ] All five published seams have implementations registered in `SeamRegistry` at boot.
- [ ] Consumed seams (`PatientReader`, `MedicationOrderProvider`, `ConsentEvaluator`, `XeroClientFactory`, `GustoClientFactory`, etc.) verified present at boot; missing seams fail boot.

### 12.4 Workflow Acceptance

- [ ] W-XI-01 through W-XI-15 integration tests pass against a Testcontainers stack.
- [ ] E2E Playwright suites pass for all surfaces in §5.
- [ ] Manual operator-acceptance walk-through (per the Ops Runbook) signed off by the operator-on-call rotation lead.

### 12.5 Security

- [ ] mTLS handshake refuses no-cert / wrong-CA / expired-cert / revoked-cert.
- [ ] Sender allowlist drops non-allowed IPs before handshake.
- [ ] Step-up auth gates all D18-marked routes; 5min freshness enforced.
- [ ] Plaintext-view quota of 50/24h per user enforced; 51st returns 429.
- [ ] BAA gate refuses feed activation and outbound dispatch when BAA inactive.
- [ ] Envelope encryption verified: raw DB ciphertext is opaque without DEK unwrap.
- [ ] SUD ingress redaction strips segments pre-persist; non-reversibility verified.
- [ ] STRIDE matrix items in §8.3 each have at least one test or compensating control.
- [ ] Emergency suspend hook tested; dual-notification chain dispatched.
- [ ] Platform-wide kill-switch tested; recovery path documented.

### 12.6 Privacy & Compliance

- [ ] PHI denylist filters payload bodies from M4 audit and from pino logs.
- [ ] Plaintext view emits per-view audit with step-up evidence; PII reveal emits separate audit.
- [ ] Retention schedule (§8.4) wired to the M1 sweeper.
- [ ] Cross-region replication disabled by default; opt-in requires compliance sign-off.
- [ ] HIPAA-floor 6-year retention enforced on PHI-bearing metadata even after ciphertext expiry at 2 years.

### 12.7 Observability

- [ ] All 27 outbox events from §4.10 emitted and registered in M4's `outbox_event_catalog`.
- [ ] Per-feed health metrics exported to the platform metrics pipeline (Prometheus tags `module=29`, `feed_id=...`).
- [ ] M36 notifications dispatched per §5.3 table.
- [ ] Pino redaction confirmed on every log call carrying HL7 payload references.

### 12.8 Testing

- [ ] Named-critical services (§9.1) at ≥95% branch coverage.
- [ ] Module-wide ≥90% line/branch coverage.
- [ ] All 15 W-XI-** integration tests pass.
- [ ] RLS isolation test suite passes.
- [ ] IDOR tests cover every `:id` route variant.
- [ ] Security test suite passes (mTLS, allowlist, quota, step-up, BAA, denylist, envelope).
- [ ] k6 SLOs in §9.6 met on baseline; perf-history baseline stored.
- [ ] Stryker mutation testing at ≥85% on named-critical services.

### 12.9 Documentation

- [ ] Operator runbook section for M29 in `WARDENX_OPS_RUNBOOK_v0_1.md` covering: feed activation walkthrough, credential rotation, listener-down response, emergency suspend, NPPES manual trigger, BAA refresh response.
- [ ] DR/BCP entries for M29 in `WARDENX_DR_BCP_v0_1.md`: HL7 listener failover, NPPES sync recovery, outbound DLQ replay.
- [ ] Integrations doc `WARDENX_INTEGRATIONS_v0_1.md` updated with M29's HL7 partner-onboarding playbook.
- [ ] Security hardening doc updated with M29 STRIDE matrix and adapter-mandate compliance.
- [ ] System Design v0.3 cross-referenced; any new SLOs added to §9.

### 12.10 Sign-Offs

- [ ] **Architecture lead** — manifest patch + dependency-cruiser rules.
- [ ] **Platform engineer** — schema, RLS, eraser, retention.
- [ ] **Integrations engineer** — MLLP listener, sidecar, dispatcher.
- [ ] **Identity engineer** — ABAC predicates, step-up integration, platform-context.
- [ ] **Security engineer** — STRIDE matrix, envelope encryption, MLLP TLS, plaintext quota.
- [ ] **Privacy engineer** — SUD redaction, PHI denylist, retention floor.
- [ ] **Clinical engineering** — cascade, proposal lifecycle, lab attachment, abnormal alerting.
- [ ] **Compliance officer (founding tenant — Engrace)** — BAA gate behavior, dual-approval workflow, audit completeness.
- [ ] **Operator-on-call rotation lead** — runbook walkthrough.

---

## 13. Proposed Manifest Patch

### 13.1 `module-manifest.ts` Diff

```diff
 {
   id: 29,
-  dependsOn: [5, 11, 40],
-  codePaths: ['apps/backend/src/modules/29-external-interfaces'],
-  ownedTables: [],
+  dependsOn: [5, 11, 40], // ADR-0005: genuine compile-time edges only; broader relationship inventory is in the "Depends on:" header (seam/outbox/foundation consumers are no-edge per D1/D4) — do not bulk-apply.
+  codePaths: [
+    'apps/backend/src/modules/29-external-interfaces',
+    'apps/web/src/routes/external-interfaces',
+    'packages/hl7-worker',
+    'packages/nppes-client',
+  ],
+  ownedTables: [
+    // Tenant-owned (RLS by organization_id)
+    'external_interfaces.external_feed',
+    'external_interfaces.external_feed_credential',
+    'external_interfaces.hl7_message_inbound',
+    'external_interfaces.hl7_message_outbound',
+    'external_interfaces.hl7_inbound_proposal',
+    'external_interfaces.lab_observation',
+    'external_interfaces.lab_observation_value',
+    'external_interfaces.lab_observation_inbound_link',
+    'external_interfaces.external_feed_health',
+    // Platform-shared (PLATFORM tenant_scope)
+    'external_interfaces.nppes_provider',
+    'external_interfaces.nppes_sync_run',
+  ],
+  // Non-ModuleDef fields (seams/registrations/outbox-event lists/phase/tier/metadata) removed per ARCH-146/ADR-0005 — wired at boot, not in the manifest.
 },
```

### 13.2 Dependency-Cruiser Rules

Append to `.dependency-cruiser.cjs` under `forbidden`:

```js
// M29 — adapter mandate boundaries
{
  name: 'no-hl7-wire-outside-m29',
  comment: 'Only the hl7-worker package and M29 source may import HL7 segment types or HAPI sidecar bindings.',
  severity: 'error',
  from: { pathNot: '^(packages/hl7-worker|apps/backend/src/modules/29-external-interfaces)' },
  to:   { path:    '^packages/hl7-worker/src/(types|sidecar|profiles)' },
},
{
  name: 'no-java-import-outside-sidecar',
  comment: 'No code outside packages/hl7-worker/java/ may reference Java sources or .jar files.',
  severity: 'error',
  from: { pathNot: '^packages/hl7-worker/java' },
  to:   { path: '(\\.jar$|^packages/hl7-worker/java)' },
},
{
  name: 'no-nppes-client-outside-m29',
  comment: 'Only M29 source may import the NPPES public-API client.',
  severity: 'error',
  from: { pathNot: '^(packages/nppes-client|apps/backend/src/modules/29-external-interfaces)' },
  to:   { path:    '^packages/nppes-client/src' },
},
{
  name: 'no-direct-xero-import-from-m29',
  comment: 'M29 must consume Xero/Gusto via factory seams from M27, not direct SDK import.',
  severity: 'error',
  from: { path: '^apps/backend/src/modules/29-external-interfaces' },
  to:   { path: '^packages/(xero-client|gusto-client)/src' },
},
{
  name: 'no-cross-module-schema-import-from-m29',
  comment: 'M29 reads other modules only via published seams and outbox; no direct schema imports.',
  severity: 'error',
  from: { path: '^apps/backend/src/modules/29-external-interfaces' },
  to:   {
    path: '^packages/db/src/schema/(?!external-interfaces)',
    pathNot: '^packages/db/src/schema/_shared',
  },
},
{
  name: 'no-m29-schema-import-from-other-modules',
  comment: 'Other modules read M29 data only via the five published seams; no direct schema reach.',
  severity: 'error',
  from: {
    path: '^apps/backend/src/modules/',
    pathNot: '^apps/backend/src/modules/29-external-interfaces',
  },
  to: { path: '^packages/db/src/schema/external-interfaces' },
},
{
  name: 'no-hl7-build-outside-sidecar',
  comment: 'HL7 wire-format build (ORM, ACK) is the sidecar+worker exclusive concern.',
  severity: 'error',
  from: {
    pathNot: '^(packages/hl7-worker|apps/backend/src/modules/29-external-interfaces/(outbound|listener))',
  },
  to: { path: '^packages/hl7-worker/src/(builder|encoder)' },
},
```

### 13.3 `boot.ts` Additions

```ts
// apps/backend/src/boot.ts (additions; preserve existing structure)

import { registerM29Predicates } from './modules/29-external-interfaces/predicates';
import { registerM29Seams } from './modules/29-external-interfaces/seams';
import { startListenerSupervisor } from './modules/29-external-interfaces/listener/supervisor';
import { M29DataEraser } from './modules/29-external-interfaces/eraser';
import { registerM29AuditDenylist } from './modules/29-external-interfaces/audit-denylist';

export async function boot(deps: BootDeps): Promise<void> {
  // ... existing M1..M28 registrations ...

  // M29 — External Interfaces
  registerM29AuditDenylist(deps.auditRegistry);     // before any M29 emission
  registerM29Predicates(deps.predicateRegistry);    // before any M29 route registration
  registerM29Seams(deps.seamRegistry);              // before any M29 consumer wiring
  deps.eraserRegistry.register(new M29DataEraser());

  // ... existing M30..M40 registrations ...

  // After all registrations: start cross-cutting workers
  if (deps.env.WARDENX_M29_LISTENERS_ENABLED === 'true') {
    await startListenerSupervisor({
      mdm: deps.seamRegistry.get('MdmBaaStatusProvider'),
      outbox: deps.outbox,
      audit: deps.audit,
      alerts: deps.seamRegistry.get('NotificationDispatcher'),
      credentials: deps.modules.m29.credentials,
      allowlist: deps.modules.m29.allowlist,
      envelope: deps.seamRegistry.get('KmsEnvelopeEncryptor'),
      registry: deps.modules.m29.listenerRegistry,
      healthProbe: deps.modules.m29.healthProbe,
      inflight: deps.modules.m29.inflightTracker,
    });
  }
}
```

### 13.4 Seam Registry Declarations

```ts
// apps/backend/src/modules/29-external-interfaces/seams.ts

import type { SeamRegistry } from '../../core/seams';
import { labObservationProviderImpl } from './seams/lab-observation-provider';
import { hl7InboundProposalReaderImpl } from './seams/hl7-inbound-proposal-reader';
import { externalFeedReaderImpl } from './seams/external-feed-reader';
import { nppesProviderReaderImpl } from './seams/nppes-provider-reader';
import { externalInterfaceMetricsProviderImpl } from './seams/external-interface-metrics-provider';

export function registerM29Seams(registry: SeamRegistry): void {
  registry.publish('LabObservationReader', labObservationProviderImpl);
  registry.publish('Hl7InboundProposalReader', hl7InboundProposalReaderImpl);
  registry.publish('ExternalFeedReader', externalFeedReaderImpl);
  registry.publish('NppesProviderReader', nppesProviderReaderImpl);
  registry.publish('ExternalInterfaceMetricsProvider', externalInterfaceMetricsProviderImpl);
}
```

### 13.5 Predicate Registration

```ts
// apps/backend/src/modules/29-external-interfaces/predicates.ts

import type { PredicateRegistry } from '../../core/predicates';
import {
  externalFeedOrganizationScope,
  hl7InboundProposalOwnerModuleMatch,
  labObservationPatientCaseloadOrScope,
  externalFeedComplianceCoApproverDistinct,
  nppesPlatformJobCaller,
  externalFeedBaaSatisfied,
} from './abac';

export function registerM29Predicates(registry: PredicateRegistry): void {
  registry.register('external_feed_organization_scope', externalFeedOrganizationScope);
  registry.register('hl7_inbound_proposal_owner_module_match', hl7InboundProposalOwnerModuleMatch);
  registry.register('lab_observation_patient_caseload_or_scope', labObservationPatientCaseloadOrScope);
  registry.register('external_feed_compliance_co_approver_distinct', externalFeedComplianceCoApproverDistinct);
  registry.register('nppes_platform_job_caller', nppesPlatformJobCaller);
  registry.register('external_feed_baa_satisfied', externalFeedBaaSatisfied);
}
```

### 13.6 Audit Denylist Registration

```ts
// apps/backend/src/modules/29-external-interfaces/audit-denylist.ts

import type { AuditDenylistRegistry } from '../../core/audit';

export function registerM29AuditDenylist(registry: AuditDenylistRegistry): void {
  // Columns whose contents are NEVER captured in M4 audit bodies, only schema-level projections.
  registry.denyColumns({
    'external_interfaces.hl7_message_inbound': ['payload_ciphertext', 'parsed_segments_cipher'],
    'external_interfaces.hl7_message_outbound': ['payload_ciphertext'],
    'external_interfaces.external_feed_credential': ['secret_ciphertext', 'private_key_ciphertext'],
    'external_interfaces.hl7_inbound_proposal': ['proposed_payload_jsonb'],
  });

  // Pino redaction patterns for in-flight log lines (defense-in-depth alongside the column-level deny).
  registry.denyLogPaths([
    '*.hl7.segments.PID',
    '*.hl7.segments.NK1',
    '*.hl7.segments.IN1',
    '*.hl7.segments.GT1',
    '*.hl7.segments.NTE',
    '*.hl7.payload',
    '*.payload_ciphertext',
    '*.parsed_segments_cipher',
    '*.secret_ciphertext',
    '*.private_key_ciphertext',
  ]);
}
```

### 13.7 Forward-Seam Deny-Stub Declarations (for M30/M33/M34/M35/M37)

Each forward-consuming module ships a fixture/deny-stub that satisfies the dependency-cruiser graph until the consumer is lock-grade:

```ts
// apps/backend/src/modules/30-hqrp/seam-stubs/lab-observation-provider.ts
import { NotImplementedError } from '../../../core/errors';
import type { LabObservationReader } from '../../29-external-interfaces/seams/types';

export const m30LabObservationConsumerStub: LabObservationReader = {
  listByPatient: () => { throw new NotImplementedError('m30.lab-observation.list — forward seam'); },
  listAbnormalForCaseload: () => { throw new NotImplementedError('m30.lab-observation.abnormal — forward seam'); },
};
```

The boot validator inspects each forward-seam consumer and confirms one of:
- A real implementation is registered, OR
- A `NotImplementedError`-throwing stub is registered AND the consuming module is marked `phase: 'forward-stub'` in the manifest.

Boot refuses to start if any seam is referenced but unregistered (no silent runtime-null behavior).

---

## Document Footer

**Spec version:** v0.4 (Consolidated — self-contained roll-up of the v0.2 base and v0.3 corrections from T-29.02 through T-29.06)
**Spec author:** Architecture (Fabrice V. Adjam, FabWebDev)
**Date:** 2026-06-10
**Source documents referenced (versions):** Architecture v0.11; Security Hardening v0.2; AI Governance v0.2; System Design v0.3; DR/BCP v0.1; Ops Runbook v0.1; Integrations v0.1; M01 v0.2; M02 v0.2; M03 v0.2; M04 v0.2; M05 v0.2; M06 v0.2; M07 v0.2; M08 v0.2; M09 v0.2; M10 v0.2; M11 v0.2; M12 v0.2; M13 v0.2; M14 v0.2; M15 v0.2; M16 v0.2; M18 v0.2; M19 v0.2; M20 v0.2; M22 v0.2; M27 v0.2; M28 v0.2; M36 v0.2; M38 v0.2; M40 v0.2.
**Implementation PRs folded into this specification:** T-29.01 (forward-seam deny-stubs), T-29.02 (schema package), T-29.03 (HAPI sidecar bring-up), T-29.04 (MLLP listener supervisor), T-29.05 (patient match cascade), T-29.06 (proposal lifecycle).

**Locked decisions:** D1 through D24 (twenty-four).
**Owned tables:** Eleven (9 tenant-owned, 2 platform-shared).
**Published seams:** Five.
**Consumed seams:** Sixteen — `PatientReader` interface specified in detail in T-29.05.
**Owned outbox events:** Twenty-nine.
**Consumed outbox events:** Six.
**Workflow acceptance criteria:** Fifteen (W-XI-01 through W-XI-15).
**Implementation tasks:** Fourteen (T-29.01 through T-29.14); six shipped (T-29.01–T-29.06); remaining eight (T-29.07 → T-29.14) target this specification as their reference.
**ABAC predicates registered:** Six new, plus reuse of `step_up_recent` and `plaintext_view_quota` from M2.

**Phase boundary:** Phase 1 implements HL7 v2 ADT/Labs inbound + ORM outbound, NPPES sync, BAA gate, M27 factory seam consumption. Phase 2 defers: probabilistic ML matcher, outbound ADT to HIE, SFTP lab feed, Xero AR sync, Gusto payroll-event ingest, Direct Trust messaging.

**Next track:** T-29.07 (lab observation attachment) can ship without further retroactive corrections — the cascade and proposal scaffolding it needs are stable. Independent track: M30 (HQRP) lock-grade spec, which becomes the first downstream module to consume the M29 forward-stub seams from T-29.01 with a real implementation.

**End of specification.**
