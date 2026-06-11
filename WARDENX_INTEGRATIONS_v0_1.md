# WardenX — Integration Catalog

**Document ID:** WARDENX_INTEGRATIONS
**Status:** v0.2 (Phase-5 remediation, 2026-06-11 — ADR-0020)

> **Phase-5 remediation (ADR-0020).** Eight external surfaces that modules had shipped without the
> mandatory INT-002 five-step addition (X8) are now catalogued: inventory rows **26–33** (§2), BAA-
> register entries (§5), and degraded-mode rows (§8). Every PHI surface is gated on an **executed
> BAA / trading-partner agreement (INT-014 hard gate)** before production PHI flows; the external
> triage vendor additionally on a **QSOA** for 42 CFR Part 2 data; HIBP carries no PHI and needs no
> BAA. No Phase-1 "done" gate may depend on an un-executed-BAA PHI surface.
**Owner:** Fabrice V. Adjam (Engineering)
**Companion to:** WARDENX_ARCHITECTURE v0.10 (§2 System Context, §8 Tenant Isolation, §10.7 Model Backend Abstraction, §25.14 External Service Calls, Module Catalog §11), WARDENX_SYSTEM_DESIGN v0.3, WARDENX_SECURITY_HARDENING v0.1, WARDENX_AI_GOVERNANCE v0.2, WARDENX_DR_BCP v0.1, WARDENX_OPS_RUNBOOK v0.1
**Review cadence:** Quarterly minimum; ad-hoc on new integration introduction, vendor contract change, BAA renewal, or API version deprecation
**Last reviewed:** 2026-06-08

**Changelog:**

- **v0.1:** Initial integration catalog. Establishes the cross-cutting integration patterns, the master integration inventory, the BAA register, the credential/secrets model, the consolidated webhook catalog, the per-integration contracts, the failure/degraded-mode matrix, and per-integration tenant onboarding flows.

**Scope distinction:** This document is the **vendor- and protocol-facing contract layer**. It owns the *what* and *how* of each external connection. It is the document referenced when:

- A new integration is added (it must get a section here before build).
- A vendor contract, BAA, or API version changes.
- A customer security review asks "what leaves your perimeter and to whom?"
- An on-call engineer needs the failure mode and degraded behavior of a specific integration (cross-referenced to DR_BCP for SEV-1 vendor outages).

It is **not**:

- The threat model or control catalog — see WARDENX_SECURITY_HARDENING.
- The AI model-risk policy — see WARDENX_AI_GOVERNANCE (this doc owns the Anthropic/local-model *wire contract*; AI Governance owns the *model-risk policy* and PHI-handling rules).
- The catastrophic vendor-outage response — see WARDENX_DR_BCP §2 (vendor outage scenarios).
- The routine operational procedure (credential rotation steps, etc.) — see WARDENX_OPS_RUNBOOK §8.
- A module implementation spec — see `docs/modules/<NN-name>/SPEC.md`. Module specs reference this document for their "External integration points" section (§22 item 9 of the per-module spec template).

-----

## 1. Purpose & Scope

### 1.1 What This Document Is

The Integration Catalog is the single source of truth for every connection WardenX makes outside its own perimeter. For each integration it pins down a fixed contract:

- **Direction & protocol** — inbound, outbound, or bidirectional; REST, EDI X12, HL7 v2 MLLP, FHIR, OAuth, webhook, file drop.
- **Credential model** — what credentials exist, where they are stored, scope (platform vs per-tenant), rotation owner.
- **BAA status** — whether PHI flows, whether a Business Associate Agreement is required, and its execution state.
- **Sandbox vs production** — environment topology, how we test without touching real data or real money.
- **Webhook specs** — inbound callback endpoints, signature verification, replay protection, idempotency.
- **Retries, backoff, idempotency** — what we do on transient failure.
- **Failure handling** — degraded behavior, customer-facing message, DR tier alignment.
- **Rate-limit posture** — known limits, our pacing strategy, burst handling.

### 1.2 What This Document Is Not

See **Scope distinction** above. In short: this is the contract, not the threat model, not the AI policy, not the DR runbook, not the module spec.

### 1.3 Conventions

- **PHI** = Protected Health Information per HIPAA. An integration is "PHI-bearing" if any request or response can contain PHI.
- **Adapter package** = the `packages/<vendor>-client/` workspace that wraps the integration. Per architecture §25.14, the rest of the system depends on the adapter interface, never on the vendor SDK directly.
- **DR tier** references WARDENX_DR_BCP §3 service tiers (Tier 1 critical patient care … Tier 4 no customer impact).
- Credentials are described by **scope**: `platform` (one WardenX-held credential for all tenants), `per-tenant` (each Organization holds its own), or `per-provider-entity` (scoped to a CCN-bearing ProviderEntity).
- **TBD/confirm** markers flag values that must be filled from the executed vendor contract or sandbox testing before the consuming module ships. They are deliberate placeholders, not omissions.
- Unless marked DEV, endpoints and credential paths describe production.

### 1.4 Relationship to Other Documents

|Document|Relationship|
|--------|------------|
|WARDENX_ARCHITECTURE §2|System context diagram — the canonical list of external actors this catalog details|
|WARDENX_ARCHITECTURE §8|Tenant isolation — per-tenant credential isolation requirements (DoseSpot, Xero, Gusto)|
|WARDENX_ARCHITECTURE §10.7|Model backend abstraction — the AI wire contracts (Anthropic, Ollama, vLLM) detailed in §6.14–§6.15 here|
|WARDENX_ARCHITECTURE §25.14|External service-call pattern — circuit breaker, `DegradedError`, per-vendor adapter package. This doc applies that pattern per integration|
|WARDENX_AI_GOVERNANCE §15|Vendor / model-operator section — owns the policy; this doc owns the connection|
|WARDENX_SECURITY_HARDENING|Vendor security reviews, secret rotation schedule — this doc names the secrets; Security owns the rotation cadence|
|WARDENX_DR_BCP §2|Vendor outage scenarios — this doc's §8 degraded-mode matrix is the per-integration input to DR vendor-outage response|
|WARDENX_OPS_RUNBOOK §8|Credential/secret rotation procedures — the executable steps for the credential models named here|

-----

## 2. Integration Inventory

The master list. Every external connection appears here exactly once. New integrations are added here first, then get a §6 contract section, then a module may consume them.

|#|Integration|Direction|Protocol|PHI?|BAA req'd|Cred scope|Owning module(s)|Adapter pkg|DR tier|
|--|-----------|---------|--------|----|---------|----------|----------------|-----------|-------|
|1|DoseSpot (e-prescribe)|Bidirectional|REST + webhooks|Yes|Yes|per-tenant (clinic reg)|12|`packages/dosespot-client`|Tier 2|
|2|Surescripts (via DoseSpot)|Downstream of DoseSpot|—|Yes|via DoseSpot|n/a (DoseSpot-mediated)|12|(through DoseSpot)|Tier 2|
|3|Medicare MAC — NGS J6 (Engrace)|Outbound + ack|EDI X12 (837I, 999, 277CA, 835) + file drop/portal|Yes|N/A (CMS contractor)|per-provider-entity|23, 25|`packages/x12-worker`|Tier 2|
|4|MAC eligibility — HETS|Outbound query|EDI X12 270/271|Yes|N/A (CMS)|per-provider-entity|5, 23|`packages/x12-worker`|Tier 3|
|5|State Medicaid|Outbound + ack|EDI X12 837 / 270-271 + state portals|Yes|N/A (state)|per-provider-entity + per-state adapter|24, 25|`packages/medicaid-adapters`|Tier 2|
|6|CMS MCReF (cost report)|Outbound upload|ECR file upload (portal/API)|No (financial)|N/A (CMS)|per-provider-entity|27|`packages/x12-worker` (ECR build) + portal|Tier 4|
|7|CMS iQIES (HOPE)|Outbound submission|HL7-style / iQIES file submission|Yes|N/A (CMS)|per-provider-entity|10, 30|`packages/iqies-client`|Tier 3|
|8|CAHPS survey vendor|Bidirectional|Vendor API / file exchange (vendor-pluggable)|Yes (decedent caregiver PII)|Yes|per-tenant|30|`packages/cahps-client` (interface)|Tier 4|
|9|Xero (accounting)|Bidirectional|OAuth 2.0 + REST|No (financial)|No (no PHI)|per-tenant|27, 29|`packages/xero-client`|Tier 4|
|10|Gusto (payroll)|Inbound pull|OAuth 2.0 + REST|No (wage data)|No (no PHI)|per-tenant|27, 29|`packages/gusto-client`|Tier 4|
|11|Stripe (subscription billing)|Bidirectional|REST + webhooks|No (WardenX↔customer billing)|No|platform|35|`packages/stripe-client`|Tier 3|
|12|Twilio — SMS|Outbound|REST + status webhooks|No (no PHI in payload by rule)|Yes (BAA)|platform|36|`packages/twilio-client`|Tier 2 (alert path)|
|13|Twilio — Voice (SOS escalation)|Outbound|REST + TwiML/webhooks|No (no PHI in payload)|Yes (BAA)|platform|20, 36|`packages/twilio-client`|Tier 1 (field safety)|
|14|Postmark (email)|Outbound|REST + bounce/delivery webhooks|No (no PHI in payload by rule)|Yes (BAA)|platform|36|`packages/postmark-client`|Tier 3|
|15|Web Push (VAPID)|Outbound|Web Push Protocol|No (no PHI in payload)|N/A (browser push services)|platform (VAPID keys)|36|`packages/webpush`|Tier 2 (alert path)|
|16|Anthropic API (cloud AI)|Outbound|REST (Messages API)|Yes (with ZDR + redaction)|Yes (BAA + ZDR)|platform|32 (consumed by 8, 10, 22, 36)|`packages/anthropic-client`|Tier 3|
|17|Local AI — Ollama / vLLM / sentence-transformers|Internal (WardenX-operated)|HTTP (loopback/VPC)|Yes (stays in perimeter)|N/A (no third party)|platform (no external cred)|32|`packages/ai` backends|Tier 3|
|18|Hospital ADT feed|Inbound|HL7 v2 over MLLP|Yes|Yes (with sending facility)|per-tenant / per-feed|29, 5|`packages/hl7-worker`|Tier 3|
|19|Lab feeds|Inbound|HL7 v2 / LOINC over MLLP or SFTP|Yes|Yes (with lab)|per-tenant / per-feed|29, 9|`packages/hl7-worker`|Tier 3|
|20|NPI Registry (NPPES)|Outbound query|REST (public)|No (provider directory)|No|platform|5, 23, 40|`packages/nppes-client`|Tier 4|
|21|Telehealth video (Daily.co — ADR-003)|Bidirectional|REST + WebRTC + webhooks|Yes (video is PHI)|Yes|platform or per-tenant (TBD ADR-003)|31|`packages/telehealth-client`|Tier 3|
|22|Map / routing (Mapbox vs OSRM — ADR-007)|Outbound|REST|No (addresses are PHI-adjacent — see §6.22)|Conditional (see §6.22)|platform|17|`packages/routing-client`|Tier 4|
|23|Terminology source feeds (CMS ICD-10, NLM/UMLS SNOMED, Regenstrief LOINC, RxNorm)|Inbound (scheduled)|File download / API + license|No|No (reference data)|platform (license creds)|38|`packages/terminology-loader`|Tier 4|
|24|FHIR Gateway (outbound/inbound interop)|Bidirectional|FHIR R4 REST + bulk NDJSON|Yes|Per-recipient (varies)|per-tenant / per-recipient|28|`packages/fhir`|Tier 3|
|25|Object storage egress (MinIO presigned URLs for external collaborators)|Outbound (scoped)|HTTPS presigned|Yes (scoped docs)|n/a (internal store)|per-tenant bucket prefix|22, §7.6 external collaborator|`packages/storage`|Tier 2|
|26|EVV state aggregators (OR-PTC DCI launch / Sandata-class)|Outbound + poll|REST / SFTP per state|Yes|**Yes** (trading-partner agmt / BAA) — *ADR-0020*|per-provider-entity per-state|18|`packages/evv-aggregators`|Tier 3|
|27|DME vendors|Outbound + confirmation|portal/email/fax (Phase 1); EDI X12 (Phase 2)|Yes (name, address, items)|**Yes**|per-tenant per-vendor|21|`packages/vendor-edi` (deny-stub P1)|Tier 3|
|28|Partner pharmacy (comfort-kit fulfillment)|Bidirectional|vendor API / portal|Yes|**Yes**|per-tenant|21|`packages/pharmacy-client`|Tier 3|
|29|Print/mail vendor (statements, letters)|Outbound|REST / SFTP|Yes (name, address, doc content)|**Yes**|platform or per-tenant|22|`packages/print-mail-client`|Tier 4|
|30|Fax/email document ingest|Inbound|fax-to-API / secure email|Yes|**Yes** (vendor)|per-tenant|22|`packages/intake-extraction`|Tier 3|
|31|External triage vendor (after-hours)|Bidirectional|vendor API / portal|Yes (clinical; SUD ⇒ **QSOA**)|**Yes** (+ QSOA for Part 2)|per-tenant|19|`packages/triage-client`|Tier 2|
|32|HaveIBeenPwned (HIBP) breach check|Outbound query|REST (k-anonymity, SHA-1 prefix)|**No**|**No** (no PHI)|platform|2|`packages/auth` (hibp adapter)|Tier 4|
|33|Outbound HL7 ORM (lab orders)|Outbound|HL7 v2 over MLLP / SFTP|Yes|**Yes** (with lab)|per-tenant / per-feed|11, 29|`packages/hl7-worker`|Tier 3|

> **Counts:** **33** catalogued surfaces. Surfaces **26–33 were added in the Phase-5 remediation
> (ADR-0020)** — they had been shipped by their modules without the mandatory INT-002 five-step
> addition (X8). Each PHI surface (26–31, 33) is gated on an **executed BAA / trading-partner
> agreement (INT-014 hard gate)** before production PHI flows — and the triage vendor (31)
> additionally on a **QSOA** for any 42 CFR Part 2 SUD data. HIBP (32) carries no PHI and needs no
> BAA. DoseSpot webhook event types (M12) extend the already-catalogued surface #1 via the §7 webhook
> catalog. The named-priority integrations remain the §20.C per-integration-contract minimum; the
> remainder are catalogued for completeness and security-review traceability.

-----

## 3. Cross-Cutting Integration Patterns

Every integration inherits these patterns unless its §6 section explicitly overrides. They exist so each integration does not reinvent failure handling, and so security reviews can reason about the whole class at once.

### 3.1 Adapter Package Model (architecture §25.14)

- Each integration is wrapped in a `packages/<vendor>-client/` workspace exposing a **typed interface**, not the vendor's SDK surface. The rest of the system imports the interface.
- The adapter owns: auth/token lifecycle, request/response typing (TypeBox), retry/backoff, circuit breaker, rate-limit pacing, error normalization to `DegradedError`, and per-call telemetry.
- Swapping a vendor (e.g., Daily.co → Twilio Video for telehealth; Mapbox → OSRM for routing) is a new adapter implementation behind the same interface, never a system-wide change.
- **Anti-pattern:** any module calling `fetch()` directly against a vendor URL. All external calls go through an adapter.

### 3.2 Circuit Breaker & DegradedError

- Every external call is wrapped in a circuit breaker with configured timeout, retry count, and backoff.
- Breaker states: **closed** (normal), **open** (failing fast after threshold), **half-open** (probing recovery).
- On failure the adapter raises a typed `DegradedError` carrying `{ integration, operation, retryable, customerMessage, correlationId }`. Raw `fetch` rejections never propagate to clients.
- Open-breaker events emit a **System** alert (Module 36 category "System → integration failure") to the tenant admin and to WardenX ops.

### 3.3 Retry, Backoff & Idempotency

- **Transient failures** (network, 429, 5xx, timeout): exponential backoff with jitter, capped retries (default 3; per-integration overrides in §6).
- **Non-idempotent writes** (claim submission, NewRx, Stripe charge): protected by an **idempotency key** so a retry never double-acts. Where the vendor supports native idempotency keys (Stripe), use them; otherwise the adapter persists an attempt record keyed by `(operation, businessKey)` before the call and reconciles on retry.
- **Outbox pattern** (architecture §25.13) for durable cross-perimeter dispatch: the intent is committed to the outbox in the same DB transaction as the business state change; a BullMQ worker drains the outbox and performs the external call with at-least-once delivery + idempotency. Used for claim submission, iQIES submission, message-notification fan-out.

### 3.4 Credential & Secrets Model

- **No credential in source or in plain env files in production.** Secrets live in the secrets manager (per Security Hardening / Ops Runbook §8); the app reads them at boot and on rotation signal.
- **Scope is enforced structurally:**
  - *Platform* secrets (Anthropic key, Stripe key, Twilio/Postmark keys, VAPID keys, NPPES is keyless, terminology license creds) — one set, held by WardenX, never exposed to tenants.
  - *Per-tenant* secrets (DoseSpot clinic registration, Xero OAuth tokens, Gusto OAuth tokens, CAHPS vendor creds) — stored keyed by `organization_id`, isolated so one tenant's tokens are unreadable in another tenant's context. DoseSpot credentials specifically per architecture §8(4): `packages/dosespot/credentials` keyed by tenant.
  - *Per-ProviderEntity* secrets (MAC submitter IDs, Medicaid trading-partner IDs, iQIES/MCReF submitter credentials) — scoped to the CCN-bearing ProviderEntity, since CMS sees the provider, not the Organization.
- **OAuth token isolation** (Xero, Gusto): refresh tokens stored per-tenant; refresh failures are isolated and do not cascade across tenants.
- Rotation owners and cadence are in WARDENX_SECURITY_HARDENING; rotation *procedures* are in WARDENX_OPS_RUNBOOK §8. This catalog names *which* secret exists per integration in §6.

### 3.5 BAA Register

- Any PHI-bearing integration to a third party requires an executed **Business Associate Agreement** before production PHI flows. The register (§5) tracks status.
- For CMS systems (MAC, HETS, MCReF, iQIES), no BAA is required — CMS is the covered-entity counterparty / regulator, governed by the trading-partner agreement and the EDI enrollment, not a BAA.
- For WardenX-operated local AI (§6.15), there is **no third party** — no BAA needed; WardenX is the model operator (see AI Governance §15).
- The "no PHI by rule" integrations (Twilio, Postmark, Web Push) still carry BAAs as defense-in-depth because metadata and delivery state are handled, and because the rule ("no PHI in payload") is enforced in code but a BAA covers the residual.

### 3.6 Sandbox vs Production Topology

- Every integration MUST have a non-production path used by CI and by tenant onboarding rehearsal. The §6 sections record the sandbox specifics.
- Sandbox credentials are themselves secrets and are never co-mingled with production credentials. Environment is selected by config, never by a code branch.
- **No production PHI in sandbox.** Sandbox runs against synthetic patients. CI uses MSW mocks (web) and recorded fixtures (adapter integration tests), plus vendor sandboxes for contract tests where available.

### 3.7 Webhook Security (inbound callbacks)

For every inbound webhook (DoseSpot, Stripe, Twilio status, Postmark, telehealth):

- **Signature verification** on every request using the vendor's signing scheme; reject unsigned/invalid.
- **Replay protection** via timestamp tolerance + persisted event-ID dedup (idempotent handlers).
- **Allowlisting** of source where the vendor publishes stable egress ranges; otherwise rely on signature.
- Handlers are **idempotent** — the same event delivered twice produces one effect.
- Webhook receipt is audited; PHI-bearing webhook bodies (DoseSpot) are processed inside the perimeter and never logged in the clear (Pino redaction rules, Security Hardening).

### 3.8 Observability Per Integration

- Every adapter emits OpenTelemetry spans tagged `integration=<name>`, `operation=<op>`, `tenant_id`, `correlation_id`.
- Per-integration dashboards (Grafana): success rate, p50/p95/p99 latency, breaker state, 429 rate, retry rate, queue depth (for outbox-backed integrations).
- Per-integration synthetic probe (Uptime Kuma + go-live checklist health checks per DR_BCP) confirms reachability and auth validity on a schedule.
- Cost-bearing integrations (Anthropic tokens, Twilio messages, Stripe is pass-through) feed Module 35 usage metering and AI cost watch (AI Governance).

### 3.9 PHI Minimization at the Boundary

- PHI leaves the perimeter only to PHI-cleared, BAA-covered destinations, and only the minimum necessary (architecture §164.502(b)).
- **Redaction-before-send** for Anthropic per AI Governance — narrative content is sent under ZDR + redaction rules; this catalog enforces the *wire* contract, AI Governance owns the *redaction policy*.
- **No-PHI-in-payload rule** for Twilio/Postmark/Web Push is enforced in the notification builder: outbound notifications carry "You have a new message" + authenticated deep link, never clinical content (architecture Module 36 HIPAA constraints).

-----

## 4. Direction & Protocol Legend

|Symbol|Meaning|
|------|-------|
|Outbound|WardenX initiates; vendor responds|
|Inbound|Vendor/external initiates (webhook, MLLP feed, scheduled file)|
|Bidirectional|Both — request/response plus async callbacks|
|EDI X12|HIPAA-mandated transaction sets (837, 835, 270/271, 277CA, 999)|
|HL7 v2 MLLP|Minimal Lower Layer Protocol over TCP for ADT/lab feeds|
|FHIR R4|RESTful FHIR resources + bulk export (NDJSON)|
|File drop|SFTP or portal upload of a generated file (ECR, some claims)|

-----

## 5. BAA Register

The compliance-facing summary. Surveyors and customer security reviewers receive this table. "Status" must read EXECUTED before that integration carries production PHI.

|Integration|PHI flows?|BAA / agreement type|Counterparty|Status|Notes|
|-----------|----------|--------------------|------------|------|-----|
|DoseSpot|Yes|BAA|DoseSpot|TBD — confirm executed before Module 12 prod|Surescripts coverage flows through DoseSpot's BAA chain|
|Anthropic|Yes|BAA + Zero Data Retention addendum|Anthropic|TBD — confirm executed + ZDR enabled before any cloud AI prod use|ZDR is a hard precondition (AI Governance)|
|Twilio (SMS + Voice)|No (by rule)|BAA|Twilio|TBD|Defense-in-depth; no PHI in payload by code rule|
|Postmark|No (by rule)|BAA|Postmark/ActiveCampaign|TBD|Defense-in-depth; no PHI in payload by code rule|
|CAHPS vendor|Yes (decedent caregiver PII)|BAA|Tenant-selected approved vendor|Per-tenant; TBD at tenant onboarding|Vendor is tenant-configurable (ADR-005 default)|
|Telehealth (Daily.co)|Yes|BAA|Daily.co (pending ADR-003)|TBD — gated on ADR-003|Video stream is PHI|
|Hospital ADT feed|Yes|BAA / data-sharing agreement|Sending hospital/HIE|Per-feed; TBD at feed setup|Counterparty is the data source|
|Lab feed|Yes|BAA|Reference lab|Per-feed; TBD at feed setup||
|Medicare MAC (NGS)|Yes|EDI Trading Partner Agreement + enrollment (not a BAA)|CMS / NGS|Per-ProviderEntity enrollment|CMS is regulator/contractor|
|HETS|Yes|HETS submitter agreement|CMS|Per-ProviderEntity|Eligibility 270/271|
|State Medicaid|Yes|State trading-partner agreement|State Medicaid agency|Per-ProviderEntity per state|Varies by state|
|CMS iQIES|Yes|iQIES access / submitter setup|CMS|Per-ProviderEntity||
|CMS MCReF|No (cost/financial)|MCReF access setup|CMS|Per-ProviderEntity||
|Xero|No (financial only)|None (no PHI)|Xero|n/a|Trial balance / GL — no PHI|
|Gusto|No (wage data)|None (no PHI)|Gusto|n/a|Worksheet S-3 wage data — no PHI|
|Stripe|No (WardenX↔customer billing)|None (no patient PHI)|Stripe|n/a|Subscription billing of the agency, not patient data|
|NPPES|No (public directory)|None|CMS NPPES|n/a|Public provider data|
|Routing (Mapbox/OSRM)|See §6.22|Conditional|Mapbox (if chosen)|Gated on ADR-007|OSRM self-hosted avoids the question|
|Local AI (Ollama/vLLM)|Yes (in-perimeter)|None (no third party)|n/a — WardenX-operated|n/a|WardenX is model operator|
|Terminology feeds|No (reference)|License agreements (UMLS, Regenstrief)|NLM, Regenstrief|License on file|UMLS free w/ license; LOINC free w/ license; ICD-10/RxNorm public|
|EVV state aggregator (OR-PTC/Sandata)|Yes|Trading-partner agreement / BAA|State aggregator (OR-PTC DCI launch)|**Required — EXECUTED before any Medicaid EVV submission (INT-014)**|Phase-5 add (ADR-0020); Oregon launch per ADR-0008|
|DME vendor|Yes (name/addr/items)|BAA|Tenant-selected DME vendor(s)|**Required — EXECUTED before prod (INT-014)**|Phase-5 add; per-tenant per-vendor|
|Partner pharmacy|Yes|BAA|Tenant-selected pharmacy|**Required — EXECUTED before prod**|Phase-5 add; comfort-kit fulfillment|
|Print/mail vendor|Yes (name/addr/doc)|BAA|Tenant/platform print-mail vendor|**Required — EXECUTED before prod**|Phase-5 add (M22)|
|Fax/email ingest|Yes (inbound)|BAA|Fax/secure-email vendor|**Required — EXECUTED before prod**|Phase-5 add (M22)|
|External triage vendor|Yes (clinical; SUD)|BAA **+ QSOA** for 42 CFR Part 2|Tenant-selected triage vendor|**Required — BAA EXECUTED + QSOA before any SUD re-disclosure**|Phase-5 add (M19); Part 2 re-disclosure gate (ADR-0014)|
|HaveIBeenPwned (HIBP)|**No**|None (no PHI — SHA-1 prefix k-anonymity)|HIBP|n/a|Phase-5 add (M02); SEC-029 control|
|Outbound HL7 ORM (labs)|Yes|BAA / trading-partner|Reference lab|**Required — EXECUTED before prod**|Phase-5 add (M11/M29); pairs with inbound lab feed|

-----

## 6. Per-Integration Contracts

Each section follows the same shape: **Purpose · Direction & protocol · Endpoints/transactions · Credential model · BAA/PHI · Sandbox vs prod · Webhooks · Retry/idempotency · Rate-limit posture · Failure handling · Onboarding.**

### 6.1 DoseSpot — E-Prescribe (Module 12)

- **Purpose:** Full-integration e-prescribing — patient sync, prescriber roster, NewRx, refills, RxBenefit, medication history; EPCS architecture in place (certification deferred per ADR-006). Custom native React prescribing UI over DoseSpot's 250+ APIs (not iframe).
- **Direction & protocol:** Bidirectional REST + inbound webhooks.
- **Operations:** Patient sync (on demographic change), prescriber roster management, NewRx, refill request inbox, RxBenefit, MedicationHistory.
- **Credential model:** **Per-tenant** DoseSpot clinic registration; credentials stored in `packages/dosespot/credentials` keyed by `organization_id` (architecture §8(4)). Per-prescriber DoseSpot identity linkage maintained in `DoseSpotPrescriber`.
- **BAA / PHI:** PHI-bearing. BAA required (§5). EPCS adds DEA controlled-substance requirements — out of scope for prod until ADR-006 certification kickoff; data model and architecture ready.
- **Sandbox vs prod:** DoseSpot staging clinic + sandbox prescribers; synthetic patients only. CI uses recorded fixtures.
- **Webhooks (inbound):** Script status updates; refill requests. Signature-verified, idempotent (dedup on DoseSpot event/message ID), audited. PHI bodies never logged in clear.
- **Retry/idempotency:** NewRx is non-idempotent — guarded by idempotency key on `(prescriber, patient, rx_business_key)`. Patient sync is idempotent (upsert). Webhook handlers idempotent.
- **Rate-limit posture:** Per-clinic limits — TBD confirm with DoseSpot; adapter paces and respects 429 with backoff. Bulk patient sync throttled.
- **Failure handling:** `DegradedError` → prescribing UI shows "e-prescribe temporarily unavailable; orders can be drafted and queued." Drafts persist locally; submitted on recovery. Refill inbox shows last-synced state with staleness indicator. SEV-2 if sustained (DR_BCP).
- **Onboarding:** Module 34 wizard step "DoseSpot certification kickoff" — clinic registration, prescriber enrollment, EPCS deferred toggle.

### 6.2 Surescripts (via DoseSpot)

- **Purpose:** Pharmacy network reachability for NewRx/refills/med history.
- **Contract note:** WardenX does **not** integrate Surescripts directly. Pharmacy connectivity is mediated entirely by DoseSpot. Surescripts terms and certification are DoseSpot's responsibility; coverage flows through DoseSpot's BAA chain. No WardenX-held Surescripts credential exists.

### 6.3 Medicare MAC — NGS J6 / others (Modules 23, 25)

- **Purpose:** Submit institutional hospice claims and receive acknowledgments and remittances. Engrace: NGS J6 (CCN 381588).
- **Direction & protocol:** Outbound claim submission + inbound acknowledgments. EDI X12 via the Python `x12-worker` (pyx12): **837I** (claim), **999** (functional ack), **277CA** (claim ack), **835** (remittance/ERA). Submission via MAC file drop with portal upload.
- **Credential model:** **Per-ProviderEntity** — MAC submitter ID, trading-partner credentials, portal login scoped to the CCN's MAC jurisdiction. Some Organizations operate multiple CCNs across different MAC jurisdictions (architecture §3) — each ProviderEntity carries its own.
- **BAA / PHI:** PHI-bearing; governed by CMS EDI Trading Partner Agreement + enrollment, not a BAA.
- **Sandbox vs prod:** MAC test/CEDI environment for 837I syntax validation; synthetic claims. The Claim Pre-Submission Validation Framework (architecture §11.A, 30+ rules) runs *before* submission to target >99% acceptance.
- **Webhooks:** None — acknowledgment is pull/file-based (999, 277CA, 835 retrieved and parsed by x12-worker).
- **Retry/idempotency:** Submission via **outbox** — claim intent committed transactionally, worker performs file generation + drop with idempotency on claim control number. Duplicate-billing rule in §11.A prevents resubmission of an already-accepted claim.
- **Rate-limit posture:** Batch/file cadence, not request-rate limited; respect MAC submission windows. NOE/NOTR fast path is independent of full-claim batch (5-day window enforced).
- **Failure handling:** Portal/MAC unavailability → claims queue in READY/outbox; no patient-care impact (Tier 2 billing). Rejections (999/277CA) route to the denial worklist (Module 25); unmapped rejection codes auto-suggest a new validation rule (§11.A workflow).
- **Onboarding:** Module 34 "MAC setup wizard" — CCN, MAC jurisdiction, submitter enrollment.

### 6.4 HETS — Medicare Eligibility (Modules 5, 23)

- **Purpose:** Verify Medicare Part A eligibility and MBI on file before claim submission (§11.A eligibility rule, "within 30 days").
- **Direction & protocol:** Outbound query, EDI X12 **270** (request) / **271** (response) via x12-worker.
- **Credential model:** Per-ProviderEntity HETS submitter credentials.
- **BAA / PHI:** PHI-bearing; CMS HETS submitter agreement.
- **Sandbox vs prod:** HETS test environment; synthetic MBIs.
- **Retry/idempotency:** Idempotent query; cache eligibility result with as-of timestamp (drives the 30-day freshness rule).
- **Rate-limit posture:** HETS has published volume/throttling rules — TBD confirm; adapter paces and caches to avoid redundant checks.
- **Failure handling:** Eligibility check failure → claim validation rule produces `warn` (not hard block) with staleness note; override path available with reason.

### 6.5 State Medicaid (Modules 24, 25)

- **Purpose:** Multi-state Medicaid claim submission and eligibility. Architecture treats states as **pluggable adapters** (`packages/medicaid-adapters`).
- **Direction & protocol:** Outbound 837 + 270/271, plus state-specific portals; varies by state.
- **Credential model:** Per-ProviderEntity **and** per-state — each state adapter holds its own trading-partner ID / portal creds.
- **BAA / PHI:** PHI-bearing; per-state trading-partner agreement.
- **Sandbox vs prod:** Per-state test environments where available; synthetic claims.
- **Retry/idempotency:** Same outbox + control-number idempotency as MAC.
- **Rate-limit posture:** Per state; documented in each state adapter.
- **Failure handling:** Per-state degraded behavior; queue and retry. New state = new adapter implementing the common interface, plus a new §6.5.x sub-entry here.
- **Onboarding:** Enabled per ProviderEntity by state of operation; adapter selected by config.

### 6.6 CMS MCReF — Cost Report Upload (Module 27)

- **Purpose:** Submit the Medicare cost report (CMS-1984-14) as an MCReF-ready **ECR** file. Validated by the Cost Report Validation Framework (architecture §11.B) before submission.
- **Direction & protocol:** Outbound ECR file upload (MCReF portal/API).
- **Credential model:** Per-ProviderEntity MCReF access credentials.
- **BAA / PHI:** Financial, not PHI; CMS MCReF access setup.
- **Sandbox vs prod:** ECR syntax validated locally and against MAC-side check; filing deadline rule (within 5 months after FYE) enforced by §11.B.
- **Retry/idempotency:** Annual/low-frequency; manual submission confirmation; idempotent on report period.
- **Failure handling:** Tier 4 — no patient impact. Portal unavailability handled by retry within the filing window.

### 6.7 CMS iQIES — HOPE Submission (Modules 10, 30)

- **Purpose:** Batch submission of HOPE assessments to CMS iQIES. The HOPE Engine (Module 10) is a real-time scheduling engine; iQIES is the submission endpoint. Missing windows → HQRP non-compliance → 4-point APU reduction, so submission reliability is a compliance concern.
- **Direction & protocol:** Outbound batch submission to iQIES; acceptance/validation report retrieved.
- **Credential model:** Per-ProviderEntity iQIES submitter access.
- **BAA / PHI:** PHI-bearing; CMS iQIES setup.
- **Sandbox vs prod:** iQIES test environment; synthetic assessments validated against CMS HOPE spec before submission.
- **Retry/idempotency:** Outbox-backed batch; idempotent on assessment submission record (`HopeSubmission`).
- **Rate-limit posture:** Batch cadence aligned to HOPE timepoints (admission, HUV1 days 6–15, HUV2 days 16–30).
- **Failure handling:** Submission failure raises a clinical-compliance alert (approaching submission deadline) — Tier 3, escalates as deadline nears. Validation rejections route to a correction worklist feeding Module 30.

### 6.8 CAHPS Survey Vendor (Module 30)

- **Purpose:** Decedent caregiver experience survey via a CMS-approved CAHPS Hospice vendor. Vendor is **tenant-configurable** (default per ADR-005).
- **Direction & protocol:** Bidirectional — outbound decedent/caregiver sample file; inbound results ingest. Mechanism varies by vendor (API or secure file exchange) behind a common `packages/cahps-client` interface.
- **Credential model:** Per-tenant vendor credentials.
- **BAA / PHI:** Decedent caregiver PII; BAA required with the selected vendor.
- **Sandbox vs prod:** Vendor sandbox where available; synthetic decedent sample.
- **Retry/idempotency:** Periodic file exchange; idempotent on sample period.
- **Failure handling:** Tier 4; results-ingest failure surfaces in Module 30 dashboard as stale data.
- **Onboarding:** Tenant selects approved vendor; credentials captured; default = ADR-005 partner.

### 6.9 Xero — Accounting (Modules 27, 29)

- **Purpose:** Trial-balance pull for the cost report (Worksheet G ties to Xero balance sheet within $1 — §11.B); optional AR sync.
- **Direction & protocol:** Bidirectional OAuth 2.0 + REST.
- **Credential model:** **Per-tenant** OAuth tokens, refresh isolated per tenant (architecture §8(5)). One tenant's refresh failure cannot affect another.
- **BAA / PHI:** Financial only — **no PHI**, no BAA.
- **Sandbox vs prod:** Xero demo company for dev/CI.
- **Webhooks:** Not required for v1 (pull model); Xero webhooks optional for AR sync (future).
- **Retry/idempotency:** Idempotent reads; token refresh on 401; reconnect flow on refresh-token expiry.
- **Rate-limit posture:** Xero publishes per-tenant + per-app daily/minute limits — adapter respects 429 with backoff; confirm current limits at build.
- **Failure handling:** Tier 4; cost-report data pull retried; tenant prompted to reconnect if OAuth lapses.
- **Onboarding:** Module 34 "Xero connect" — OAuth consent per tenant.

### 6.10 Gusto — Payroll (Modules 27, 29)

- **Purpose:** Wage data pull for cost report Worksheet S-3.
- **Direction & protocol:** Inbound pull, OAuth 2.0 + REST.
- **Credential model:** Per-tenant OAuth tokens, isolated refresh.
- **BAA / PHI:** Wage data — **no PHI**, no BAA.
- **Sandbox vs prod:** Gusto demo/sandbox.
- **Retry/idempotency:** Idempotent reads; token refresh.
- **Rate-limit posture:** Per Gusto API limits — confirm at build; low call volume (periodic).
- **Failure handling:** Tier 4; reconnect prompt on OAuth lapse.
- **Onboarding:** Module 34 "payroll connect."

### 6.11 Stripe — Subscription Billing (Module 35)

- **Purpose:** WardenX charges its customer agencies — subscriptions, invoicing, dunning, payment methods, **Stripe Tax** for sales tax. Plans per ADR-001 (per-seat / per-patient-month / hybrid). Usage metering: active patients, active users, claim volume, AI token usage.
- **Direction & protocol:** Bidirectional REST + inbound webhooks.
- **Credential model:** **Platform** Stripe secret key (this is WardenX's own billing relationship, not per-tenant PHI). Customers are Stripe Customers under WardenX's account.
- **BAA / PHI:** No patient PHI — this is WardenX↔agency commercial billing. No BAA.
- **Sandbox vs prod:** Stripe test mode keys; test clocks for subscription lifecycle in CI.
- **Webhooks (inbound):** `invoice.*`, `customer.subscription.*`, `payment_intent.*`, etc. Signature-verified (Stripe-Signature), idempotent on event ID, replay-protected.
- **Retry/idempotency:** Native Stripe idempotency keys on all create operations. Stripe retries webhooks; handlers idempotent.
- **Rate-limit posture:** Stripe's documented per-account rate limits; adapter respects 429.
- **Failure handling:** Tier 3 — billing degradation does not affect patient care. Webhook backlog drained on recovery.

### 6.12 Twilio — SMS (Module 36)

- **Purpose:** SMS delivery channel for clinical-urgent and field-safety alerts. **No PHI in payload** — "You have a new message" + authenticated deep link (Module 36 HIPAA constraint).
- **Direction & protocol:** Outbound REST + inbound status callback webhooks.
- **Credential model:** Platform Twilio account SID + auth token / API key; messaging service SID.
- **BAA / PHI:** BAA in place (defense-in-depth; no PHI in payload by rule).
- **Sandbox vs prod:** Twilio test credentials + magic test numbers; CI never sends real SMS.
- **Webhooks (inbound):** Delivery/status callbacks; signature-verified (X-Twilio-Signature), idempotent on message SID.
- **Retry/idempotency:** Idempotent send keyed on `notification_delivery_id`; Twilio handles carrier retry; we do not double-send.
- **Rate-limit posture:** Messaging-service throughput (MPS) limits; queue + pace; respect 429.
- **Failure handling:** Tier 2 (alert path). SMS failure falls back per user notification preferences (in-app/push remain); critical field-safety alerts escalate to voice (§6.13).

### 6.13 Twilio — Voice (Modules 20, 36)

- **Purpose:** Voice escalation for **SOS field-safety** alerts only (Module 20 SOS → supervisor voice escalation). No PHI in call content automation.
- **Direction & protocol:** Outbound call origination + TwiML/status webhooks.
- **Credential model:** Same platform Twilio account.
- **BAA / PHI:** BAA in place.
- **Sandbox vs prod:** Twilio test mode.
- **Failure handling:** **Tier 1** — this is a life-safety path. Voice escalation failure raises an immediate critical alert through every other channel and to WardenX ops. This is the highest-criticality external dependency in the catalog.

### 6.14 Postmark — Email (Module 36)

- **Purpose:** Transactional email — alert digests, notifications, invitations. **No PHI in payload** by rule.
- **Direction & protocol:** Outbound REST + inbound bounce/delivery webhooks.
- **Credential model:** Platform Postmark server token; separate message streams (transactional vs broadcast).
- **BAA / PHI:** BAA in place (defense-in-depth).
- **Sandbox vs prod:** Postmark sandbox token (accepts but does not deliver).
- **Webhooks (inbound):** Bounce, delivery, spam-complaint; signature/secret-verified, idempotent.
- **Retry/idempotency:** Idempotent send keyed on delivery ID.
- **Rate-limit posture:** Postmark per-server rate; queue + pace.
- **Failure handling:** Tier 3; failures fall back to in-app per preference; bounce handling updates contactability.

### 6.15 Web Push — VAPID (Module 36)

- **Purpose:** PWA push notifications (portal users; clinical/field via Capacitor native push where applicable). **No PHI in payload** — deep-link only.
- **Direction & protocol:** Outbound Web Push Protocol to browser push services (FCM/APNs endpoints via the standard).
- **Credential model:** Platform VAPID key pair.
- **BAA / PHI:** No PHI; browser push services are not BAA counterparties (which is precisely why no PHI may be in the payload).
- **Retry/idempotency:** Subscription endpoints expire — adapter prunes 410/404 endpoints; idempotent per `notification_delivery_id`.
- **Failure handling:** Tier 2 (alert path); degrade to in-app + email/SMS per preference.

### 6.16 Anthropic API — Cloud AI (Module 32; consumed by 8, 10, 22, 36)

- **Purpose:** Cloud foundation-model backend for HearthNote Layer 2 (default), DocLens vision verification/extraction (default), Copilot clinical/administrative. Backend IDs per architecture §10.7.3: `anthropic-claude-opus-4-7` (high-stakes default), `anthropic-claude-haiku-4-5` (cost-optimized).
- **Direction & protocol:** Outbound REST (Messages API) through `packages/anthropic-client`.
- **Credential model:** **Platform** Anthropic API key. Per-tenant *usage* is metered (Module 35) and gated by per-tenant feature opt-in (`hearthnote_llm_enhancement_enabled` etc., default false — Module 2 TenantConfiguration).
- **BAA / PHI:** PHI-bearing → **BAA + Zero Data Retention** are hard preconditions (AI Governance). Redaction-before-send applied per AI Governance policy. This catalog enforces: no cloud AI call leaves the perimeter for a tenant unless (opt-in flag true) AND (BAA+ZDR confirmed) AND (capability routing allows cloud).
- **Sandbox vs prod:** Dev key against non-PHI synthetic prompts; evaluation datasets per capability (AI Governance) gate releases.
- **Retry/idempotency:** Retries on 429/5xx with backoff; completions are not "idempotent" in a business sense but are safe to retry (no external side effect). Structured-output calls validate against `outputSchema`.
- **Rate-limit posture:** Anthropic per-account token/request limits; adapter paces; AI cost-watch budget limits (AI Governance) can throttle or kill-switch a capability.
- **Failure handling:** Tier 3. On failure, capability routing tries the fallback chain (§10.7.4) — for `local_only`/`prefer_local` tenants or on cloud outage, falls back to a local backend (§6.17) if the tenant has local enabled; otherwise degrades to the deterministic Layer-1 path (HearthNote Layer 1 always operates without AI). **Patient care never blocks on AI availability.**

### 6.17 Local AI — Ollama / vLLM / sentence-transformers (Module 32)

- **Purpose:** In-perimeter model serving for tenants requiring sovereignty/offline/privacy, and as the default for embeddings and document classification (architecture §10.7). Backends: `local-llama-3.1-8b-instruct`, `local-mistral-7b-instruct`, `local-phi-3.5-mini` (Ollama), `local-bge-small-en` / `local-all-minilm-l6-v2` (sentence-transformers), `local-distilbert-classifier` (custom).
- **Direction & protocol:** **Internal** HTTP to the `ml-worker`/`llm-worker` sidecar (loopback/VPC). **No traffic leaves the WardenX perimeter.**
- **Credential model:** No external credential. Service-to-service auth within the perimeter (mTLS internal per architecture §14).
- **BAA / PHI:** PHI stays in-perimeter; **no third party, no BAA** — WardenX is the model operator (AI Governance §15).
- **Sandbox vs prod:** Same model artifacts in dev (MinIO-stored GGUF/safetensors per §10.7.8); deterministic eval harness.
- **Retry/idempotency:** Local retry; safe to retry.
- **Rate-limit posture:** Bounded by local hardware (GPU/CPU); routing accepts lower quality / higher latency per-backend calibration thresholds (§10.7.4).
- **Failure handling:** Tier 3; if the local backend is down and a cloud fallback is allowed for the capability and tenant, route to cloud; else degrade to deterministic path. `local_only` tenants degrade to deterministic — they accepted that trade.

### 6.18 Hospital ADT Feed (Modules 29, 5)

- **Purpose:** Inbound admit/discharge/transfer events to drive patient matching and demographic update.
- **Direction & protocol:** **Inbound** HL7 v2 over **MLLP** listener (`packages/hl7-worker`). Message types A01, A03, A04, A08, A11. Patient-match algorithm before any chart write.
- **Credential model:** Per-tenant / per-feed — listener endpoint, allowlisted sending facility, channel credentials.
- **BAA / PHI:** PHI-bearing; BAA / data-sharing agreement with the sending hospital or HIE.
- **Sandbox vs prod:** HL7 test harness replaying synthetic ADT messages.
- **Retry/idempotency:** MLLP ack (ACK/NAK); idempotent on message control ID; matched events proposed for review (not auto-applied to chart where ambiguous).
- **Failure handling:** Tier 3; listener outage queues at the sender or is re-sent; no patient-care block.
- **Onboarding:** Per-feed setup with the sending facility; channel + allowlist + BAA.

### 6.19 Lab Feeds (Modules 29, 9)

- **Purpose:** Inbound lab results, auto-attach to chart, abnormal-flag alerting (feeds Module 9 trending and Module 36 alerts).
- **Direction & protocol:** Inbound HL7 v2 (ORU) / LOINC-coded over MLLP or SFTP.
- **Credential model:** Per-tenant / per-feed; LOINC mapping via Module 38 terminology service.
- **BAA / PHI:** PHI-bearing; BAA with the reference lab.
- **Retry/idempotency:** Idempotent on filler order / result ID; dedup on redelivery.
- **Failure handling:** Tier 3; queue/resend; abnormal-result alert only fires once per result (idempotent).

### 6.20 NPI Registry — NPPES (Modules 5, 23, 40)

- **Purpose:** Provider verification — attending physician NPI validation (§11.A physician-credentials rule), MDM external-physician records (Module 40, NPI-keyed), NPPES sync.
- **Direction & protocol:** Outbound REST query (public NPPES API).
- **Credential model:** None — public API.
- **BAA / PHI:** Public provider directory — no PHI, no BAA.
- **Sandbox vs prod:** Public API; CI uses fixtures.
- **Retry/idempotency:** Idempotent lookups; cached in MDM with periodic NPPES sync.
- **Rate-limit posture:** NPPES public-API throttling; adapter paces + caches aggressively (provider data is slow-changing).
- **Failure handling:** Tier 4; validation rule degrades to `warn` with cached data when NPPES is unreachable.

### 6.21 Telehealth Video — Daily.co (Module 31; ADR-003 open)

- **Purpose:** Video visits embedded in scheduling; audio-only fallback. Vendor-pluggable behind `packages/telehealth-client`; default Daily.co pending ADR-003 (alternatives: Twilio Video, native WebRTC).
- **Direction & protocol:** Bidirectional REST (room/token creation) + WebRTC media + webhooks (room events).
- **Credential model:** Platform or per-tenant (TBD with ADR-003) API key; short-lived room tokens minted per visit.
- **BAA / PHI:** Video stream is PHI; BAA required (gated on ADR-003 vendor selection).
- **Sandbox vs prod:** Vendor sandbox; synthetic visits.
- **Webhooks (inbound):** Room lifecycle (joined/left/ended); signature-verified, idempotent.
- **Retry/idempotency:** Room creation idempotent per `telehealth_visit_id`.
- **Failure handling:** Tier 3; audio-only fallback; if vendor down, visit reschedules — no chart-write dependency.
- **Open item:** ADR-003 must close before Module 31 telehealth ships; this section is finalized then.

### 6.22 Map / Routing — Mapbox vs OSRM (Module 17; ADR-007 open)

- **Purpose:** Route optimization for field scheduling (Module 17). Behind `packages/routing-client`.
- **Direction & protocol:** Outbound REST (geocoding, matrix, directions).
- **Privacy note:** Patient **addresses** are PHI-adjacent. Sending a patient address to a third-party geocoder is a disclosure consideration. **OSRM self-hosted** (the ADR-007 alternative) keeps addresses in-perimeter and avoids the BAA question entirely; **Mapbox** would require a BAA-or-equivalent assessment and address minimization. The privacy posture is a material input to ADR-007.
- **Credential model:** Platform API key (Mapbox) OR no external credential (OSRM self-hosted).
- **BAA / PHI:** Conditional on ADR-007 outcome (see privacy note).
- **Failure handling:** Tier 4; routing degrades to unoptimized schedule (visits still assignable), no patient-care block.
- **Open item:** ADR-007 must close before Module 17 routing ships.

### 6.23 Terminology Source Feeds (Module 38)

- **Purpose:** Load and update clinical code systems — ICD-10-CM/PCS, SNOMED CT US Edition, LOINC, RxNorm, NDC, CPT/HCPCS, CVX, CARC/RARC.
- **Direction & protocol:** Inbound scheduled downloads/APIs into `packages/terminology-loader`; diff-and-notify workflow per architecture Module 38.
- **Credential model:** Platform license credentials — **UMLS/NLM** account (SNOMED CT, free with license), **Regenstrief** account (LOINC, free with license). ICD-10-CM/PCS and RxNorm are public domain.
- **BAA / PHI:** Reference data — no PHI, no BAA; license agreements on file (§5).
- **Update cadence:** ICD-10-CM annual (effective Oct 1, cron fetch + diff + per-tenant affected-patient report); SNOMED US Edition twice yearly (Mar/Sep); RxNorm monthly; others per source.
- **Retry/idempotency:** Idempotent versioned loads keyed on (system, version); never destructive — old versions retained for as-of validation.
- **Failure handling:** Tier 4; stale terminology is acceptable short-term (codes are slow-changing); update-failure alert to ops; hard-stop only if a load would corrupt versioning.

### 6.24 FHIR Gateway — Interop (Module 28)

- **Purpose:** Standards-based interop — outbound FHIR R4 (Patient, Encounter, Observation, MedicationRequest/Administration, Condition, CarePlan, Goal, DocumentReference, Practitioner(Role), Organization), `$everything`, bulk export (NDJSON to MinIO); inbound import of selected resources (demographics from ADT, medication history). Also exposes Module 38 terminology as FHIR CodeSystem/ValueSet.
- **Direction & protocol:** Bidirectional FHIR R4 REST + bulk NDJSON. US Core v6 (R4) conformance; v10 (R6) when published. Version-pluggable mappers (`packages/fhir/r4|r5|r6`).
- **Credential model:** Per-tenant / per-recipient — SMART-on-FHIR or API-key auth per consuming partner (varies). 42 CFR Part 2 SUD records excluded from export by default (Module 5 / Module 39 consent gating).
- **BAA / PHI:** PHI-bearing; per-recipient agreement (varies by recipient and use).
- **Retry/idempotency:** Reads idempotent; bulk export jobs idempotent per job ID; inbound import proposes (review) rather than blind-writes where ambiguous.
- **Failure handling:** Tier 3; interop is not on the critical care path.

### 6.25 Object Storage Egress — Presigned URLs (Module 22; §7.6)

- **Purpose:** Scoped document delivery to external collaborators (attending physicians, hospital staff, funeral homes via the External Collaborator magic-link pattern) and patient/family portal document shares.
- **Direction & protocol:** Outbound HTTPS presigned URLs from MinIO; bucket prefix `tenant/<org_id>/` with IAM policies preventing cross-tenant signing (architecture §8(3)).
- **Credential model:** Per-tenant bucket scope; short-lived presigned URLs minted per authorized access.
- **BAA / PHI:** Scoped PHI documents; access governed by Module 39 consent + §7.6 collaborator scoping; magic-link sessions are short-lived and view-audited.
- **Failure handling:** Tier 2; storage availability is covered in DR_BCP (MinIO is a WardenX-operated service, not a third party — included here only because it is the egress mechanism for external sharing).

-----

## 7. Consolidated Webhook Catalog

Every inbound callback in one place for security review. All entries inherit §3.7 (signature verification, replay protection, idempotency, audit).

|Source|Events|Verification|Idempotency key|Handler module|PHI in body?|
|------|------|-----------|---------------|--------------|------------|
|DoseSpot|Script status, refill request|Vendor signature|DoseSpot event/message ID|12|Yes (processed in-perimeter, not logged clear)|
|Stripe|`invoice.*`, `subscription.*`, `payment_intent.*`|Stripe-Signature (HMAC)|Stripe event ID|35|No|
|Twilio (SMS)|Delivery/status|X-Twilio-Signature|Message SID|36|No|
|Twilio (Voice)|Call status / TwiML callbacks|X-Twilio-Signature|Call SID|20, 36|No|
|Postmark|Bounce, delivery, spam complaint|Server secret|Message/event ID|36|No|
|Telehealth (Daily.co)|Room joined/left/ended|Vendor signature|Room/event ID|31|No (metadata only; media is WebRTC, not webhook)|
|HL7 ADT (inbound feed)|A01/A03/A04/A08/A11|MLLP channel + allowlist|HL7 message control ID|29, 5|Yes (in-perimeter)|
|HL7 Lab (inbound feed)|ORU results|MLLP/SFTP channel + allowlist|Filler order / result ID|29, 9|Yes (in-perimeter)|

> CMS systems (MAC 999/277CA/835, HETS 271, iQIES reports, MCReF) are **pull/file-based acknowledgments**, not webhooks — handled by scheduled retrieval in the x12/iqies workers, not inbound callbacks.

-----

## 8. Failure Handling & Degraded-Mode Matrix

The per-integration input to WARDENX_DR_BCP §2 vendor-outage response. "Degraded behavior" is what the system does; "customer-facing message" is the honest user-visible state. Patient-care-critical paths (Tier 1/2) are designed so **no external dependency blocks documentation or medication administration**.

|Integration|DR tier|What breaks on outage|Degraded behavior|Customer-facing message|
|-----------|-------|---------------------|-----------------|-----------------------|
|DoseSpot|2|New/refill prescriptions to pharmacy|Orders draft + queue locally; refill inbox shows last sync|"E-prescribe temporarily unavailable — prescriptions are saved and will send on reconnect"|
|MAC / Medicaid|2|Claim submission|Claims sit in READY/outbox; validation still runs|"Claim submission paused — claims are validated and queued"|
|HETS|3|Eligibility verification|Validation rule → `warn`, override available; use cached result|"Eligibility check unavailable — using last known status"|
|iQIES (HOPE)|3|HOPE batch submission|Queue; deadline-approaching alert escalates|"HOPE submission delayed — assessments are saved" (compliance-watched)|
|MCReF|4|Cost report upload|Retry within filing window|(internal only — annual task)|
|CAHPS|4|Survey sample/results exchange|Queue; dashboard shows stale|(internal — quality dashboard staleness)|
|Xero / Gusto|4|Cost-report financial pull|Retry; reconnect prompt on OAuth lapse|"Reconnect your Xero/Gusto account"|
|Stripe|3|WardenX subscription billing|Webhook backlog drains on recovery; no care impact|(WardenX-internal billing; agency unaffected in care)|
|Twilio SMS|2|SMS alert delivery|Fall back to in-app/push/email per preference|(silent fallback; alert still delivered another way)|
|Twilio Voice|**1**|SOS voice escalation|**Immediate critical alert through every other channel + WardenX ops page**|"Field-safety voice escalation degraded — supervisors alerted by all channels"|
|Postmark|3|Email digests/invites|Fall back to in-app per preference|(silent fallback)|
|Web Push|2|Push notifications|Fall back to in-app/email/SMS|(silent fallback)|
|Anthropic (cloud AI)|3|Cloud AI capabilities|Fallback chain → local backend (if enabled) → **deterministic Layer-1 path**|"AI assistance temporarily unavailable — documentation continues normally"|
|Local AI|3|Local AI capabilities|Cloud fallback (if allowed) → deterministic path|same as above|
|Hospital ADT|3|Inbound demographic events|Sender queues/re-sends; manual entry unaffected|(no user-visible block)|
|Lab feeds|3|Inbound results|Queue/re-send; results attach on recovery|(no user-visible block)|
|NPPES|4|Provider verification|Validation → `warn` with cached data|(no block; warns on stale provider data)|
|Telehealth|3|Video visits|Audio-only fallback; reschedule|"Video unavailable — switching to audio / reschedule"|
|Routing|4|Route optimization|Unoptimized schedule; visits still assignable|(no block; routes not optimized)|
|Terminology feeds|4|Code-system updates|Use current loaded version (slow-changing)|(internal — update alert to ops)|
|FHIR Gateway|3|Interop export/import|Retry; bulk jobs resume|(no care impact)|
|EVV aggregator (OR-PTC/Sandata)|3|Medicaid EVV submission|EVV captured offline + queued; aggregator submit retries; never blocks the visit or a Medicare claim (ADR-0008)|(internal; submission-lag alert to ops)|
|DME vendor|3|DME/supply dispatch|Dispatch queues; portal/email/fax fallback; manual confirmation|"Supply order queued — will dispatch on reconnect"|
|Partner pharmacy|3|Comfort-kit fulfillment|Queue; fall back to local stock / manual order|"Pharmacy fulfillment queued"|
|Print/mail vendor|4|Statement/letter mailing|Queue render+mail; retry within SLA|(internal; mailing-lag alert)|
|Fax/email ingest|3|Inbound document ingest|Vendor re-sends; manual upload unaffected|(no user-visible block)|
|External triage vendor|2|After-hours triage|Fall back to on-call supervisor + tenant emergency number (ADR-0009 degraded fallback)|"After-hours triage degraded — calls routed to on-call supervisor"|
|HIBP|4|Password breach check|Accept password, flag for async re-check (M02-F10)|(silent; no block on password set)|
|Outbound HL7 ORM (labs)|3|Lab order transmission|Order queues; M11 lab-transmission retry; results path unaffected|(no care block; transmission-lag alert)|

-----

## 9. Rate-Limit Posture (Summary)

General posture: every adapter respects vendor 429s with exponential backoff + jitter, caps concurrency, and (where reads are slow-changing) caches. Specific published limits are confirmed against the vendor at adapter-build time; values below marked **confirm** are placeholders pending the executed contract / current vendor docs.

|Integration|Posture|Notes|
|-----------|-------|-----|
|DoseSpot|Per-clinic limit (confirm); throttle bulk patient sync|Pace NewRx/refill bursts|
|MAC / Medicaid|File-batch cadence, not request-rate|Respect submission windows; NOE fast-path independent|
|HETS|Published volume rules (confirm); cache 30-day result|Avoid redundant eligibility checks|
|Anthropic|Per-account token/request limits; AI cost-watch budget can throttle/kill-switch|AI Governance owns budget policy|
|Stripe|Per-account API limit; native idempotency keys|Webhook auto-retry by Stripe|
|Twilio|Messaging-service MPS throughput|Queue + pace; voice is low-volume (SOS only)|
|Postmark|Per-server send rate|Queue + pace|
|Xero / Gusto|Per-tenant + per-app daily/minute (confirm)|Low call volume (periodic pulls)|
|NPPES|Public-API throttle; cache aggressively|Provider data slow-changing|
|Web Push|Browser push-service limits; prune expired endpoints|—|
|Terminology feeds|Scheduled, off-peak; no live-traffic limit|—|

-----

## 10. Per-Integration Tenant Onboarding (Module 34)

The Module 34 onboarding workflow touches several integrations. This is the integration-facing view of the go-live checklist (full operational go-live checklist is in DR_BCP / Ops Runbook).

|Onboarding step|Integration(s)|What happens|Pre-prod gate|
|---------------|--------------|------------|-------------|
|Account + CCN registration|—|Organization + ProviderEntity(ies) created|—|
|MAC setup wizard|MAC/NGS, HETS|CCN, MAC jurisdiction, submitter enrollment per ProviderEntity|Test 837I passes MAC syntax; HETS test 271 returns|
|Medicaid setup (if applicable)|State Medicaid|State adapter selected; trading-partner creds|State test claim accepted|
|DoseSpot certification kickoff|DoseSpot|Per-tenant clinic registration; prescriber enrollment; EPCS deferred|DoseSpot staging clinic reachable; test patient sync|
|Xero connect|Xero|Per-tenant OAuth consent|Demo-company trial balance pulls|
|Payroll connect|Gusto|Per-tenant OAuth consent|Sandbox wage pull|
|CAHPS vendor select|CAHPS|Approved vendor chosen (ADR-005 default); creds + BAA|Vendor sandbox exchange|
|AI feature opt-in|Anthropic / Local AI|Per-capability opt-in with informed consent (BAA, audit, cost); routing preference (prefer_cloud/local/etc.)|BAA + ZDR confirmed before any cloud AI; eval datasets green|
|Telehealth enable (if used)|Daily.co|Per-ADR-003 setup; BAA|Sandbox visit|
|Feed setup (if used)|ADT / Lab|Per-feed channel + allowlist + BAA with source|Synthetic message round-trip|
|Subscription activate|Stripe|Customer + subscription created (plan per ADR-001)|Test-mode lifecycle verified|
|Go-live health checks|All|DoseSpot health, Anthropic test call, Twilio test SMS, sample claim validation (per DR_BCP §go-live checklist)|All green|

-----

## 11. Open Items Affecting Integrations

These ADRs (architecture §21) must close before the dependent integration section is finalized and the consuming module ships:

|ADR|Affects|This catalog section|Decision needed|
|---|-------|---------------------|----------------|
|ADR-001|Stripe plan model (per-seat / per-patient-month / hybrid)|§6.11|Determines usage-metering wiring|
|ADR-003|Telehealth vendor (Daily.co / Twilio Video / native WebRTC)|§6.21|Finalizes credential scope + BAA counterparty|
|ADR-005|CAHPS vendor default|§6.8|Sets the default partner + BAA|
|ADR-006|EPCS certification timeline|§6.1|Enables controlled-substance prescribing path|
|ADR-007|Routing provider (Mapbox vs OSRM self-hosted)|§6.22|Decides whether patient addresses leave the perimeter + BAA need|

Additionally, every **BAA marked TBD in §5 must read EXECUTED** before that integration carries production PHI. This is a hard gate, not a tracking note.

-----

## 12. Sign-off

Integration Catalog v0.1 establishes the contract layer. Adding a new integration requires: (1) an inventory row in §2, (2) a §6 contract section, (3) a §5 BAA-register entry if PHI-bearing, (4) a §8 degraded-mode row, and (5) cross-reference from the consuming module spec's "External integration points" section. Vendor contract, BAA, or API-version changes trigger a review of the affected §6 section and the §5 register. SEV-1/2 vendor outages are handled per WARDENX_DR_BCP §2 using the §8 matrix as input.

This document lands in parallel with Modules 2–4 specs per architecture §20.C, since it references foundation concepts (tenancy, secrets, audit) that Module 1 establishes.
