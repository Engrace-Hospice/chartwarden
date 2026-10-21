// @chartwarden/types — Module 28 (FHIR Gateway) leaf contracts (M28-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package, so every downstream consumer
// (M1's boot validators, M5's inbound-proposal reviewer, M11/M40's cache-invalidation producers, the M33
// metrics reader) imports them with NO `dependsOn` edge. M28 never imports another module's feature
// package — every upstream chart it projects (M5/M6/M7/M8/M11/M12/M13/M22/M29/M38/M39/M40) is reached
// through a reader seam, and the dependency-cruiser boundary check (architecture §25.15) blocks any
// `import` from a non-listed code path.
//
// WHAT T01 SHIPS. The type-level surface every later M28 task builds on: the §3.2 pgEnum value mirrors,
// the vocabularies §2.3 spells inline on `text`/`jsonb` columns (the SMART scopes, the resource-type
// projections), the §2.2 lifecycle vocabulary for the three FSMs (client onboarding, bulk export,
// inbound proposal) + the consumer-facing posture each state implies, the §2.3 domain validation
// constants (tier rate-limit floors, `SUPPORTED_SCOPES`, `KNOWN_OWNER_MODULES`), the §3.5 tenancy scope
// + §3.6 audit denylist + ADR-0004 retention class + §3.6 cipher columns + the §3.3 partitioned-table
// descriptors per owned table (the M4 trigger arguments M28-T02 passes), the §3.7 eraser data-class
// name, and the W-FHIR-07 forward-seam `404` envelope every Claim/EOB/ServiceRequest read returns until
// its D1 unlock.
//
// WHAT T01 DELIBERATELY DOES NOT SHIP. The §4.3 published seam interfaces (`FhirGatewayMetricsProvider`
// / `FhirClientReader` / `FhirInboundProposalReader`, M28-T06), the §4.4 consumed-seam interfaces
// (`LabObservationReader` etc., T04/T07), the §4.5 `FhirMapper`/`FhirSearchTranslator` contracts + the
// per-resource TypeBox projection schemas (T04), the §4.10 outbox catalog + §4.9 alert payloads (T07/T08),
// and the Drizzle table shapes + migration (T02). Those land as their tasks land; T01 is the vocabulary
// they are all typed against.
//
// NAMING: every exported symbol carries a `Fhir` / `FHIR_` / `M28_` prefix. `@chartwarden/types` is
// re-exported wholesale from `./index.ts`, so a bare `ClientStatus` / `Tier` / `OwnerModule` would
// collide the day another module wants the same word (the M14 `IdgDecisionPayload` and M19
// `TriageDisposition` precedents). `Fhir` — not `FHIR` — matches the repo's PascalCase convention for
// type names, while the FHIR-spec resource NAMES (`Patient`, `DiagnosticReport`) stay verbatim because
// they are wire identifiers, not our types.
//
// PHASE-1 POSTURE (Wave H plan, "M28 — read-only US Core R4"). `fhir.write` is OFF: R4-write and R5/R6
// are Phase 3, and the write-facing resources (`Claim`/`ClaimResponse`/`ExplanationOfBenefit`/
// `ServiceRequest`) are registered forward-seam deny-stubs that return `404` until M23's D1 unlock
// (W-FHIR-07). See `FHIR_WRITE_FLAG` and `FHIR_FORWARD_SEAM_RESOURCES` below.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so
//    the package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision)
import type { OrgId, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";

// ── M28-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @chartwarden/db) ──────────

export type FhirClientId = string;
export type FhirClientCredentialId = string;
/** The `fhir_client_session` PK is the JWT ID (`jti`), not a synthetic uuid (§2.2). */
export type FhirClientSessionJti = string;
export type FhirBulkExportJobId = string;
export type FhirBulkExportArtifactId = string;
export type FhirInboundResourceId = string;
export type FhirCapabilitySnapshotId = string;

/** Soft refs M28 stores but does not own: the M34 business-associate contract the approval gate resolves
 *  (§2.3), the WardenX-side aggregate an accepted inbound proposal created/updated in its owner module
 *  (§2.2 `accepted_aggregate_id`), and the platform release tag that keys the capability snapshot (§2.2). */
export type M34ContractReference = string;
export type FhirAcceptedAggregateId = string;
export type PlatformReleaseTag = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts` by an M28-T01 test) ───

/** `fhir_client_type` — the credential family a client authenticates with (§3.2). */
export type FhirClientType = "smart_backend_services" | "api_key";
export const FHIR_CLIENT_TYPES = [
  "smart_backend_services",
  "api_key",
] as const satisfies readonly FhirClientType[];

/** `fhir_client_tier` — the rate-limit class; the floor is `FHIR_TIER_RATE_LIMIT_FLOOR_RPS` (§2.3). */
export type FhirClientTier = "tier-1" | "tier-2" | "tier-3";
export const FHIR_CLIENT_TIERS = [
  "tier-1",
  "tier-2",
  "tier-3",
] as const satisfies readonly FhirClientTier[];

/** `fhir_client_status` — the §2.2 onboarding FSM. */
export type FhirClientStatus = "pending_approval" | "active" | "suspended" | "revoked" | "rejected";
export const FHIR_CLIENT_STATUSES = [
  "pending_approval",
  "active",
  "suspended",
  "revoked",
  "rejected",
] as const satisfies readonly FhirClientStatus[];

/** `fhir_client_credential_kind` — `api_key` in Phase 1; `jwks_pin` is the future pin option (§2.2). */
export type FhirClientCredentialKind = "api_key" | "jwks_pin";
export const FHIR_CLIENT_CREDENTIAL_KINDS = [
  "api_key",
  "jwks_pin",
] as const satisfies readonly FhirClientCredentialKind[];

/** `fhir_client_credential_status` — rotation retires with a 30-day overlap window (§2.2). */
export type FhirClientCredentialStatus = "active" | "retired";
export const FHIR_CLIENT_CREDENTIAL_STATUSES = [
  "active",
  "retired",
] as const satisfies readonly FhirClientCredentialStatus[];

/** `fhir_bulk_export_status` — the §2.2 async-export FSM. */
export type FhirBulkExportStatus =
  | "accepted"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";
export const FHIR_BULK_EXPORT_STATUSES = [
  "accepted",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly FhirBulkExportStatus[];

/** The two `fhir_bulk_export_status` values that hold the §2.5 per-client concurrency lock — a second
 *  submission while a job is in either returns `429 Too Many Requests` with `Retry-After: 60`. */
export const FHIR_BULK_EXPORT_ACTIVE_STATUSES = [
  "accepted",
  "in_progress",
] as const satisfies readonly FhirBulkExportStatus[];

/** `fhir_bulk_export_request_kind` — the `$export` variant a job serves (§3.2). */
export type FhirBulkExportRequestKind = "system" | "group" | "patient";
export const FHIR_BULK_EXPORT_REQUEST_KINDS = [
  "system",
  "group",
  "patient",
] as const satisfies readonly FhirBulkExportRequestKind[];

/** `fhir_inbound_status` — the §2.2 staged-proposal FSM. */
export type FhirInboundStatus = "pending" | "accepted" | "rejected" | "expired";
export const FHIR_INBOUND_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "expired",
] as const satisfies readonly FhirInboundStatus[];

/** The two terminal statuses whose `payload` is destruction-scheduled at +30 days (§2.4, §3.7). */
export const FHIR_INBOUND_PAYLOAD_ERASE_STATUSES = [
  "rejected",
  "expired",
] as const satisfies readonly FhirInboundStatus[];

/** `fhir_inbound_owner_module` — the module owning the native write on acceptance (§3.2, §2.3). */
export type FhirInboundOwnerModule = "m5" | "m12";
export const FHIR_INBOUND_OWNER_MODULES = [
  "m5",
  "m12",
] as const satisfies readonly FhirInboundOwnerModule[];

/** `fhir_version_enum` — the FHIR release a capability snapshot advertises (§3.2). Phase 1 serves R4. */
export type FhirVersion = "4.0.1" | "5.0.0" | "6.0.0";
export const FHIR_VERSIONS = ["4.0.1", "5.0.0", "6.0.0"] as const satisfies readonly FhirVersion[];
/** The one release the Phase-1 gateway actually serves (US Core R4); the other two are compile-shells. */
export const FHIR_PHASE_1_VERSION: FhirVersion = "4.0.1";

// ── §2.3 domain validation constants (leaf DATA every M28 route + worker validates against) ───────────

/**
 * §2.3 — the platform rate-limit FLOOR per tier, in requests-per-second.
 *
 * `fhir_client.rate_limit_rps` must MATCH the floor for its tier at registration; a tenant may then
 * TIGHTEN (lower) it but never LOOSEN (raise) it — the architecture §-fitness "platform-floor /
 * tenant-tighten-only" rule. `fhirRateLimitWithinFloor` below is the check every admin route runs.
 */
export const FHIR_TIER_RATE_LIMIT_FLOOR_RPS: { readonly [K in FhirClientTier]: number } = {
  "tier-1": 100,
  "tier-2": 10,
  "tier-3": 1,
};

/**
 * §2.3 — the closed set of SMART/OAuth scopes a `fhir_client.allowed_scopes[]` may draw from.
 *
 * The AUTHORITATIVE copy is `SUPPORTED_SCOPES` in `packages/fhir/src/auth/scopes.ts` (M28-T03); this leaf
 * mirror lets an admin-route validator and its TypeBox schema reject an out-of-set scope with
 * `INVALID_SCOPE` without importing the module. Phase 1 is READ-ONLY US Core R4, so every scope is a
 * `.read`; the write scopes arrive with `fhir.write` in Phase 3. A new scope is a code-level addition
 * here AND there, never a runtime configuration (§2.3).
 */
export const FHIR_SUPPORTED_SCOPES = [
  "system/Patient.read",
  "system/Encounter.read",
  "system/Condition.read",
  "system/Observation.read",
  "system/MedicationRequest.read",
  "system/MedicationStatement.read",
  "system/MedicationAdministration.read",
  "system/DiagnosticReport.read",
  "system/CarePlan.read",
  "system/Goal.read",
  "system/DocumentReference.read",
  "system/Practitioner.read",
  "system/PractitionerRole.read",
  "system/Organization.read",
  "system/RelatedPerson.read",
  "system/Coverage.read",
  "system/Consent.read",
] as const;
export type FhirSupportedScope = (typeof FHIR_SUPPORTED_SCOPES)[number];

/**
 * §2.3 — the resource types Phase 1 knows how to STAGE inbound, keyed to their owner module.
 *
 * `fhir_inbound_resource.owner_module` must resolve here: a Patient demographic proposal is owned by M5,
 * a MedicationStatement by M12. An inbound POST for any other resource type returns `501 Not
 * Implemented` (§2.3) — distinct from the `404` a write-facing forward-seam resource returns (that
 * resource is KNOWN but gated, this one is UNKNOWN to the inbound pipeline).
 */
export const FHIR_KNOWN_INBOUND_OWNER: { readonly [resourceType: string]: FhirInboundOwnerModule } =
  {
    Patient: "m5",
    MedicationStatement: "m12",
  };

/** §2.2 — a rejection's `decision_rationale` must be at least this many chars (survey-defense detail). */
export const FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS = 40;

/** §2.2/§2.3 defaults the tenant-config carries; a tenant may override within the documented bounds. */
export const FHIR_DEFAULT_INBOUND_REVIEW_SLA_HOURS = 72;
export const FHIR_DEFAULT_EXPORT_DEDUP_WINDOW_MINUTES = 10;
/** §2.2 — the mint-time TTL of a `fhir_client_session` bearer token. */
export const FHIR_SESSION_TTL_MINUTES = 15;
/** §2.2 — the completed bulk-export artifact TTL before the sweeper purges MinIO. */
export const FHIR_BULK_EXPORT_TTL_HOURS = 24;

/**
 * Wave-H flags, default OFF (plan §3 / acceptance §3). Named here so a route or a boot check reads the
 * one canonical spelling rather than re-typing the string.
 *   - `fhir.write` — R4-write / R5 / R6. OFF ⇒ the gateway is read-only US Core R4.
 */
export const FHIR_WRITE_FLAG = "fhir.write" as const;

// ── §2.2 lifecycle — the three FSM vocabularies + the consumer-facing posture ─────────────────────────

/**
 * A legal edge of an M28 FSM. The `packages/fhir` state machines hold the edge SETS; this is only their
 * shape, so a consumer (an admin route, a worker) can type a transition request without importing the
 * module. `fromStatus: null` is the initial insert (the `[*] -->` arrow of each §2.2 diagram).
 */
export interface FhirStatusTransition<TStatus extends string> {
  readonly fromStatus: TStatus | null;
  readonly toStatus: TStatus;
  /** The `audit_event.action` the transition emits (§2.2 "Transitions emit `audit_event.action`"). */
  readonly auditAction: string;
  /** Human-readable gate name, straight from the §2.2 diagram's edge labels. */
  readonly label: string;
}

/**
 * §2.2 `fhir_client` — whether the onboarding state permits the client to authenticate and read.
 *
 * This is the LIFECYCLE leg only. `active` means the registry permits service; the per-request rate
 * limit (§2.5), the IP allowlist (§2.3), the SUD consent gate at egress (§2.5/W-FHIR-03) and the
 * `fhir.write` flag are further gates the request pipeline applies on top. Reading `active` as "every
 * read this client makes will succeed" is the mistake this posture is documented to prevent.
 */
export type FhirClientServePosture =
  /** `active` — the client may mint tokens and read behind the further request-time gates. */
  | { readonly kind: "serving" }
  /** `pending_approval` — awaiting the D12 dual approval; token mint refused. */
  | { readonly kind: "awaiting_approval" }
  /** `suspended` — manually or rate-violation paused; existing sessions revoked, mint refused. */
  | { readonly kind: "suspended" }
  /** `revoked` / `rejected` — terminal; the client is gone. */
  | { readonly kind: "terminated"; readonly terminalStatus: "revoked" | "rejected" };

// ── §3.5–§3.7 owned-table descriptors (the arguments M28-T02 passes to the M4 generators) ─────────────

/** The nine tables `architecture/module-manifest.ts` gives M28. */
export type M28TableName =
  | "fhir_bulk_export_artifact"
  | "fhir_bulk_export_job"
  | "fhir_capability_snapshot"
  | "fhir_client"
  | "fhir_client_credential"
  | "fhir_client_session"
  | "fhir_inbound_resource"
  | "fhir_read_disclosure"
  | "tenant_fhir_config";

/** The same nine as a runtime list (the M4 trigger loop and the §8.1 RLS proof both iterate it). */
export const M28_TABLE_NAMES = [
  "fhir_bulk_export_artifact",
  "fhir_bulk_export_job",
  "fhir_capability_snapshot",
  "fhir_client",
  "fhir_client_credential",
  "fhir_client_session",
  "fhir_inbound_resource",
  "fhir_read_disclosure",
  "tenant_fhir_config",
] as const satisfies readonly M28TableName[];

/**
 * §3.5 — which RLS shape each table takes.
 *
 *   `platform_shared` — no `organization_id`. `fhir_capability_snapshot` alone: `USING (true)` SELECT
 *                       platform-wide (a client must read the conformance statement), INSERT/UPDATE only
 *                       under the `platform_ops` role. The signed checksum is the survey-defense artifact.
 *   `tenant_scoped`   — `organization_id` present, policy keyed ONLY on `app.org_id`. The other seven.
 */
export type M28TableTenancy = "platform_shared" | "tenant_scoped";

export const M28_TABLE_TENANCY: { readonly [K in M28TableName]: M28TableTenancy } = {
  fhir_bulk_export_artifact: "tenant_scoped",
  fhir_bulk_export_job: "tenant_scoped",
  fhir_capability_snapshot: "platform_shared",
  fhir_client: "tenant_scoped",
  fhir_client_credential: "tenant_scoped",
  fhir_client_session: "tenant_scoped",
  fhir_inbound_resource: "tenant_scoped",
  fhir_read_disclosure: "tenant_scoped",
  tenant_fhir_config: "tenant_scoped",
};

/**
 * §3.6 — the columns the M4 write-audit trigger records as `<changed>` rather than by value.
 *
 * Every entry is a secret or a PHI-bearing payload. `fhir_inbound_resource.payload` carries the raw FHIR
 * resource (PHI fragments) until an owner module accepts it, so only the `payload_sha256` enters the
 * audit `value_capture` jsonb — the digest reconstructs "what was proposed" without re-storing PHI
 * (§3.6). What stays OFF the list is verbatim on purpose: `status`, `proposal_status`, the approvals,
 * `baa_contract_reference` and the decision rationale are exactly what a §164.528 accounting reads.
 */
export const M28_AUDIT_DENYLIST: { readonly [K in M28TableName]: readonly string[] } = {
  fhir_bulk_export_artifact: [],
  fhir_bulk_export_job: [],
  fhir_capability_snapshot: [],
  fhir_client: [],
  fhir_client_credential: ["secret_cipher", "secret_digest_sha256"],
  fhir_client_session: [],
  fhir_inbound_resource: ["payload"],
  // Nothing. The disclosure ledger holds no secret and no payload — only who read what, about whom, and
  // when — and every one of those columns is exactly what a §164.528 accounting reads back.
  fhir_read_disclosure: [],
  tenant_fhir_config: ["cursor_signing_key_cipher"],
};

/**
 * ADR-0004 retention class each table's M4 trigger STAMPS.
 *
 * The disclosure-accounting tables (`fhir_client`, `fhir_client_credential`, `fhir_inbound_resource`,
 * `tenant_fhir_config`) file `compliance` — they are the §164.528 record of who read PHI under which
 * agreement. `fhir_capability_snapshot` is `compliance` too (the signed conformance the gateway
 * advertised at disclosure time). `fhir_client_session` is `operational`: no PHI, routine-purged past 90
 * days (§3.7). `fhir_bulk_export_job`/`_artifact` are `compliance` because the job metadata reconstructs
 * a bulk disclosure long after the 24h NDJSON is gone.
 */
export const M28_AUDIT_RETENTION_CLASS: {
  readonly [K in M28TableName]: "operational" | "compliance" | "legal_hold";
} = {
  fhir_bulk_export_artifact: "compliance",
  fhir_bulk_export_job: "compliance",
  fhir_capability_snapshot: "compliance",
  fhir_client: "compliance",
  fhir_client_credential: "compliance",
  fhir_client_session: "operational",
  fhir_inbound_resource: "compliance",
  // The §164.528 accounting itself: six years (§164.530(j)), never purged. Its sibling
  // `fhir_client_session` is `operational` precisely because it is the OTHER half — the credential
  // ledger, which holds no disclosure and can age out at 90 days.
  fhir_read_disclosure: "compliance",
  tenant_fhir_config: "compliance",
};

/** §3.6 — the columns holding a per-tenant DEK envelope-encrypted value (the `bytea *_cipher` columns).
 *  Encryption happens in the M28 service BEFORE insert and decryption at the service, never at the DB, so
 *  a replica or a cold-storage backup never holds plaintext. */
export const M28_CIPHER_COLUMNS: { readonly [K in M28TableName]: readonly string[] } = {
  fhir_bulk_export_artifact: [],
  fhir_bulk_export_job: [],
  fhir_capability_snapshot: [],
  fhir_client: [],
  fhir_client_credential: ["secret_cipher"],
  fhir_client_session: [],
  fhir_inbound_resource: [],
  fhir_read_disclosure: [],
  tenant_fhir_config: ["cursor_signing_key_cipher"],
};

/** The two tables partitioned monthly (§3.3). Their PK must include the partition key (ADR-0022 D1.1,
 *  which `arch:ddl` enforces) — `fhir_client_session`'s PK is `(jti, issued_at)`, the inbound row's is
 *  `(id, proposed_at)`. */
export const M28_PARTITIONED_TABLES: {
  readonly [K in "fhir_client_session" | "fhir_inbound_resource"]: {
    readonly partitionKey: string;
  };
} = {
  fhir_client_session: { partitionKey: "issued_at" },
  fhir_inbound_resource: { partitionKey: "proposed_at" },
};

/**
 * §3.7 — the M4 `DataEraser` data class M28 registers at boot (M28-T02/T08 do the registering and widen
 * `DataClass`; T01 only NAMES it, so adding the union member without a registered eraser cannot fail
 * `validateErasers()` mid-wave).
 *
 * NOT a delete. The eraser is a targeted shred: it zeroes `tenant_fhir_config.cursor_signing_key_cipher`,
 * destroys the credential ciphers, purges the MinIO export objects and replaces
 * `fhir_inbound_resource.payload` with the shred sentinel `{"_destroyed":true}` — while every ROW
 * survives with its status, approvals, `baa_contract_reference`, `payload_sha256` and timestamps intact,
 * because those rows ARE the §164.528 accounting-of-disclosures evidence (§3.7).
 */
export const M28_ERASER_DATA_CLASS = "fhir_gateway" as const;
export type M28EraserDataClass = typeof M28_ERASER_DATA_CLASS;

// ── §4.2 / W-FHIR-07 forward-seam deny-stub envelope ──────────────────────────────────────────────────

/**
 * The write-facing resources Phase 1 registers as forward-seam deny-stubs (§4.6, W-FHIR-07).
 *
 * These are KNOWN resource names the CapabilityStatement does NOT yet advertise; a read against one
 * returns `404 Not Found` with an `OperationOutcome` (NOT a `403` — the resource does not exist for this
 * gateway version, per the FHIR spec's own rule for an unsupported resource), until M23's D1 unlock
 * flips `fhir.write` and lands the Claim/EOB projections. Distinct from a genuinely unknown resource
 * (also `404`) only in the `OperationOutcome.details` text, and from an inbound-unsupported resource
 * (`501`, §2.3). One list so the route table and its test read the same set.
 */
export const FHIR_FORWARD_SEAM_RESOURCES = [
  "Claim",
  "ClaimResponse",
  "ExplanationOfBenefit",
  "ServiceRequest",
] as const;
export type FhirForwardSeamResource = (typeof FHIR_FORWARD_SEAM_RESOURCES)[number];

/**
 * The typed envelope a §4.4 CONSUMED seam whose upstream is not yet live returns instead of throwing —
 * the M20-T01 finding: a deny-stub that throws synchronously makes every caller wrap it in a try/catch
 * and one will forget. A FHIR read that depends on such a seam surfaces this as an `OperationOutcome`
 * with the `reason`, never a 500.
 */
export interface FhirSeamUnavailable {
  readonly status: "seam_unavailable";
  readonly resource: FhirForwardSeamResource | string;
  readonly reason: FhirSeamUnavailableReason;
}

export type FhirSeamUnavailableReason =
  /** W-FHIR-07 — the resource's write-facing projection is behind `fhir.write` / M23's D1 unlock. */
  | "forward_seam_not_yet_enabled"
  /** The upstream reader seam name is registered but no implementation is bound at boot. */
  | "provider_unregistered";

// ── §2.4 disclosure-audit envelope (the `auditRead()` shape D15 requires on EVERY FHIR read) ──────────

/**
 * The typed envelope `auditRead()` records for every served FHIR read (§2.4, §3.6, D15) — the §164.528
 * "what was disclosed to whom, when" record. The resource BYTES are not captured (the requirement is the
 * accounting, not a second copy of the PHI); the query, the result count and the consuming client are.
 * The full write of the row is M28-T08's `audit-disclosure.ts`; T01 fixes the shape it writes.
 */
export interface FhirReadDisclosureEnvelope {
  readonly organizationId: OrgId;
  readonly fhirClientId: FhirClientId;
  readonly resourceType: string;
  /** Present for a single-resource read / `$everything`; absent for a type-level search. */
  readonly patientId?: PatientId;
  /** The normalized search parameters, secrets already stripped (never the raw query string). */
  readonly queryParameters: Readonly<Record<string, string>>;
  readonly resultCount: number;
  readonly servedAt: IsoInstant;
  /** The membership behind an operator-initiated read (a bulk export a staff member kicked off); absent
   *  when the FHIR client itself is the actor. */
  readonly initiatedByMembershipId?: MembershipId;
}

// ── §4.3 published seam interfaces (M28-T06) ───────────────────────────────────────────────────────────
//
// The three READ-ONLY seams M28 publishes into the M1 registry. They live in this leaf — not
// `packages/fhir/src/seams.ts` where §4.3 sketches them — so every downstream consumer imports the
// contract with NO `dependsOn` edge onto M28: M33 reporting / M30 quality / M35 subscription billing
// (`FhirGatewayMetricsProvider`), the M34 SaaS console (`FhirClientReader`), and M5's demographic-
// proposal / M12's medhx-proposal review queues (`FhirInboundProposalReader`). The IMPLEMENTATIONS are
// injected at boot over a Drizzle store (M28's routes/repos land in T08); until then `validateSeams()`
// applies the fail-closed deny-stub, so an unregistered seam denies LOUDLY rather than serving an empty
// projection minted from nothing (the M19/M20 "no store ⇒ register nothing" posture).

/** §4.3 — per-tenant FHIR utilization + the §164.528 disclosure metric. Aggregate COUNTS only, NO PHI. */
export interface FhirGatewayMetricsProvider {
  /** Per-tenant FHIR utilization over a window. Returns aggregated counters; NO PHI. */
  metricsForOrg(args: {
    organizationId: OrgId;
    from: IsoInstant;
    to: IsoInstant;
  }): Promise<FhirGatewayMetrics>;

  /** Per-quarter disclosure metric the M30 HIPAA §164.528 scorecard reads. */
  disclosureMetricsForOrg(args: {
    organizationId: OrgId;
    /** 'YYYY-Q[1234]'. */
    quarter: string;
  }): Promise<FhirDisclosureMetrics>;
}

export interface FhirGatewayMetrics {
  readonly requestsByHour: ReadonlyArray<{ hour: string; count: number }>;
  readonly topResourceTypes: ReadonlyArray<{ resourceType: string; count: number }>;
  readonly topClients: ReadonlyArray<{ clientId: FhirClientId; clientName: string; count: number }>;
  readonly bulkExportJobsAccepted: number;
  readonly bulkExportJobsCompleted: number;
  readonly bulkExportJobsFailed: number;
  readonly inboundProposalsPending: number;
  readonly inboundProposalsAccepted: number;
  readonly inboundProposalsRejected: number;
  readonly inboundProposalReviewSlaP50Hours: number;
  readonly inboundProposalReviewSlaP95Hours: number;
  readonly errorRateByCode: ReadonlyArray<{ code: string; count: number }>;
}

export interface FhirDisclosureMetrics {
  readonly quarter: string;
  readonly totalDisclosures: number;
  readonly distinctRecipientClients: number;
  readonly byResourceType: ReadonlyArray<{ resourceType: string; disclosures: number }>;
  readonly byClient: ReadonlyArray<{
    clientId: FhirClientId;
    clientName: string;
    baaReference: M34ContractReference;
    disclosures: number;
  }>;
}

/** §4.3 — the FHIR client registry read seam the M34 SaaS console embeds. Registry metadata, NO PHI. */
export interface FhirClientReader {
  clientsForOrg(args: { organizationId: OrgId }): Promise<ReadonlyArray<FhirClientSummary>>;
  clientDetail(args: {
    organizationId: OrgId;
    clientId: FhirClientId;
  }): Promise<FhirClientDetail | null>;
}

export interface FhirClientSummary {
  readonly id: FhirClientId;
  readonly name: string;
  readonly type: FhirClientType;
  readonly tier: FhirClientTier;
  readonly status: FhirClientStatus;
  readonly baaContractReference: M34ContractReference;
  readonly approvedAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
}

export interface FhirClientDetail extends FhirClientSummary {
  readonly allowedScopes: ReadonlyArray<string>;
  readonly rateLimitRps: number;
  readonly ipAllowlist: ReadonlyArray<string>;
  readonly jwksUri: string | null;
  /** First 8 chars of the secret digest for `api_key` clients; null for SMART Backend Services. */
  readonly fingerprint: string | null;
  readonly lastSuccessfulRequestAt: IsoInstant | null;
  readonly activeSessionCount: number;
}

/**
 * §4.3 — the staged-inbound-proposal read seam M5 (Patient demographic proposals) and M12
 * (MedicationStatement medhx proposals) resolve their review queues from. PHI: `payload` carries the
 * raw FHIR resource until the owner module accepts it.
 */
export interface FhirInboundProposalReader {
  pendingForOwnerModule(args: {
    organizationId: OrgId;
    ownerModule: FhirInboundOwnerModule;
  }): Promise<ReadonlyArray<FhirInboundProposalSummary>>;

  proposalDetail(args: {
    organizationId: OrgId;
    proposalId: FhirInboundResourceId;
  }): Promise<FhirInboundProposalDetail | null>;
}

export interface FhirInboundProposalSummary {
  readonly id: FhirInboundResourceId;
  readonly resourceType: string;
  readonly sourceClientId: FhirClientId;
  readonly sourceClientName: string;
  readonly sourceFhirId: string | null;
  readonly proposedAt: IsoInstant;
  readonly slaDueAt: IsoInstant;
}

export interface FhirInboundProposalDetail extends FhirInboundProposalSummary {
  /** The raw FHIR resource (after JSON-schema validation). PHI. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly validationErrors: ReadonlyArray<{ path: string; message: string }> | null;
}
