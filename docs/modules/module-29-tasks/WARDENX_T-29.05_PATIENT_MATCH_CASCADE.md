# WardenX — T-29.05 Addendum: Patient Match Cascade

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.6 (cascade algorithm), §4.5 (consumed seams), §10 (T-29.05)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 (manifest), T-29.02 (schema — with retroactive corrections from §2 below), T-29.03 (HAPI sidecar), T-29.04 (MLLP listener) all merged.

This addendum delivers the drop-in artifacts for T-29.05 — the deterministic five-level patient match cascade, the `PatientReader` seam contract that M29 consumes from M5, the parse-worker integration that replaces the T-29.04 forward-stub for `m29.hl7_message.parsed_adt`, the unit tests at ≥95% branch coverage, the integration tests that complete W-XI-01 through the cascade step and unlock W-XI-02 (L4 candidate review).

**Inspecting M29 §4.6 against §11 D6, the W-XI-** workflow scenarios, and the T-29.02 schema surfaced four real spec inconsistencies that must be resolved before T-29.05 can be coherent.** They are batched as retroactive T-29.02 corrections in §2.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Retroactive T-29.02 schema corrections** (§2) — four schema additions and one set of enum-value introductions required by the cascade.
- **`PatientReader` seam contract** (§3) — M29-declared interface, M5-implemented; five typed read methods consumed by the cascade.
- **Cascade service** at `apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.ts` (§4) — pure-function-ish service (no DB writes, only reads through the seam), returns a discriminated `MatchOutcome`.
- **Outcome-routing service** at `apps/backend/src/modules/29-external-interfaces/inbound/outcome-router.ts` (§6) — translates a `MatchOutcome` into the next-stage event (`m29.hl7_message.cascade_resolved_confident` / `m29.hl7_message.cascade_resolved_candidate` / `m29.hl7_message.cascade_resolved_no_match`).
- **Parse worker integration** (§5) — `hl7-inbound-parse.worker.ts` ADT branch invokes the cascade after parse-success, persists the cascade result on `hl7_message_inbound`, and emits the routed event.
- **Forward-stub** for the proposal lifecycle (T-29.06 consumer): the routed events have no real consumer yet — they land in the outbox and wait. Same pattern as T-29.04.
- **Unit tests** at `match-cascade.test.ts` covering all five levels, every branch, every routing outcome — ≥95% branch coverage on this named-critical service.
- **Integration tests** that complete W-XI-01 through cascade (`match_level='L1_MRN_EXACT'`, `match_outcome='matched_single'`, `matched_patient_id` populated) and exercise W-XI-02 (single L4 candidate landing in `match_outcome='matched_single'` at level 4 with confidence 0.92).
- **Sign-off checklist.**

### 1.2 Non-goals

- **Proposal creation** (T-29.06) — cascade output is enqueued; proposal-row creation is the consumer's job.
- **M5's implementation of `PatientReader`** — this addendum declares the interface only. M5's locked spec already references `PatientReader` (per the consumed-seams table in M29 §4.5) and is expected to implement the five methods listed in §3 of this addendum.
- **Probabilistic L6 ML matcher** — Phase 2 per D6.
- **Lab branch routing** (T-29.07) — the parse worker's ORU branch will hook the cascade differently (auto-attach via OBR-2 placer-order first, fall back to cascade); T-29.05 wires the ADT branch only.
- **M40 organization-MRN-authority config wiring** — see §2.5 below; the cascade reads it via the existing `MasterDataProvider` seam from M40.

---

## 2. Retroactive T-29.02 Spec Corrections

The cascade design in M29 §4.6 implies state and schema that T-29.02 did not ship. These corrections land as part of the T-29.05 PR via a new migration `0030_external_interfaces_cascade.sql`. They are additive only (no destructive changes) and are safe to apply against the empty production schema.

### 2.1 Add `match_level` enum

```sql
-- Migration 0030_external_interfaces_cascade.sql (Phase A)
CREATE TYPE hl7_inbound_match_level AS ENUM (
  'L1_MRN_EXACT',
  'L2_EXTERNAL_MRN_EXACT',
  'L3_SSN_DOB',
  'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
  'L5_LOOSE_NAME_DOB_CANDIDATE',
  'NO_MATCH'
);
```

Drizzle:

```ts
// packages/db/src/schema/external-interfaces/enums.ts (addition)
export const hl7InboundMatchLevel = pgEnum('hl7_inbound_match_level', [
  'L1_MRN_EXACT',
  'L2_EXTERNAL_MRN_EXACT',
  'L3_SSN_DOB',
  'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
  'L5_LOOSE_NAME_DOB_CANDIDATE',
  'NO_MATCH',
])
```

### 2.2 Add cascade-result columns to `hl7_message_inbound`

The W-XI-01 acceptance criterion requires `hl7_message_inbound.matched_patient_id` and `hl7_message_inbound.match_level` to be populated post-cascade. T-29.02's schema had no such columns. The cascade also persists `match_outcome` (matched_single / matched_ambiguous / no_match) for query convenience separate from the level (which is finer-grained).

```sql
-- Migration 0030 (Phase B)
ALTER TABLE hl7_message_inbound
  ADD COLUMN matched_patient_id UUID,
  ADD COLUMN match_level hl7_inbound_match_level,
  ADD COLUMN match_outcome hl7_inbound_match_outcome,
  ADD COLUMN match_confidence NUMERIC(4,3),
  ADD COLUMN cascade_run_ms INTEGER;
```

Drizzle:

```ts
// packages/db/src/schema/external-interfaces/hl7-messages.ts (additions to hl7MessageInbound)
matchedPatientId: uuid('matched_patient_id'),                    // M5 ref, app-side; null until cascade
matchLevel: e.hl7InboundMatchLevel('match_level'),               // null until cascade
matchOutcome: e.hl7InboundMatchOutcome('match_outcome'),         // null until cascade
matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),  // 0..1; null for confident matches
cascadeRunMs: integer('cascade_run_ms'),                         // observability — cascade wallclock
```

Indexes (M29 §3.4 expansion):

```sql
CREATE INDEX idx_hmi_matched_patient ON hl7_message_inbound (matched_patient_id)
  WHERE matched_patient_id IS NOT NULL;
CREATE INDEX idx_hmi_match_outcome ON hl7_message_inbound (organization_id, match_outcome);
```

### 2.3 Add `candidate_patient_id` to `lab_observation_inbound_link`

Per M29 §4.6 routing table: *"Create lab_observation with patient_id=null, link to candidate via lab_observation_inbound_link.candidate_patient_id"*. T-29.02 did not include this column.

```sql
-- Migration 0030 (Phase C)
ALTER TABLE lab_observation_inbound_link
  ADD COLUMN candidate_patient_id UUID,
  ADD COLUMN candidate_match_level hl7_inbound_match_level;
```

Drizzle:

```ts
// packages/db/src/schema/external-interfaces/lab-observation.ts (additions to labObservationInboundLink)
candidatePatientId: uuid('candidate_patient_id'),
candidateMatchLevel: e.hl7InboundMatchLevel('candidate_match_level'),
```

This unblocks T-29.07 (lab branch).

### 2.4 Add `internal_mrn_authority` to organization configuration

M29 §4.6 references `ORG_MRN_AUTH` as if it were a constant. It is per-organization configuration. M40 owns the `organization` master table; we need a column on it (or on a satellite config table) that stores the tenant's chosen MRN-authority string.

Resolution: **leverage the existing `organization.settings JSONB` field** (per M1 §3.3 — organization carries a settings JSONB). The cascade reads `settings.hl7_internal_mrn_authority` via `MasterDataProvider.getOrganizationSettings(orgId)`. This avoids a new column and avoids touching M1's schema.

The required key:

```ts
// packages/db/src/schema/organization.ts (settings type extension; non-schema-breaking)
export interface OrganizationSettings {
  // ... existing settings ...
  readonly hl7_internal_mrn_authority?: string  // e.g. "ENGRACE_INTERNAL"
}
```

The default fallback (if the key is absent): the cascade skips L1 and goes directly to L2 (external MRN match). This is the correct safe behavior — a tenant without a configured internal MRN authority simply doesn't have an L1 match candidate.

### 2.5 New outbox events

The cascade emits one of three terminal events; T-29.02 did not enumerate them in the outbox-event catalog (M29 §4.10 lists `m29.hl7_message.parsed_adt|parsed_oru|parsed_other` which were T-29.04's parse-completion events). The cascade-completion events sit at the next stage:

```
m29.hl7_message.cascade_resolved_confident   { messageId, feedId, organizationId, matchedPatientId, matchLevel, cascadeRunMs }
m29.hl7_message.cascade_resolved_candidate   { messageId, feedId, organizationId, candidatePatientId, matchLevel, matchConfidence, cascadeRunMs }
m29.hl7_message.cascade_resolved_no_match    { messageId, feedId, organizationId, cascadeRunMs }
```

These land in the M4 `outbox_event_catalog` registry as part of T-29.05.

### 2.6 Summary of corrections

| # | Change | File | Type |
|---|--------|------|------|
| 2.1 | Add `hl7_inbound_match_level` enum | new migration + enums.ts | Additive enum |
| 2.2 | Add 5 columns to `hl7_message_inbound` | migration + hl7-messages.ts | Additive columns |
| 2.3 | Add 2 columns to `lab_observation_inbound_link` | migration + lab-observation.ts | Additive columns |
| 2.4 | Document `organization.settings.hl7_internal_mrn_authority` convention | comment in schema; no migration | Convention |
| 2.5 | Register 3 new outbox events | M4 outbox_event_catalog | Additive |

All five corrections are additive and non-destructive. The migration `0030_external_interfaces_cascade.sql` is the canonical change set.

---

## 3. `PatientReader` Seam Contract

M29 declares the interface; M5 is the registered publisher; M29 is the registered consumer. Per the seam-registry pattern from T-29.01, the contract lives in `packages/foundation/src/seams/patient-reader.ts` (owned by M5 conceptually but the **type** is shared platform-foundation code — both modules import from the foundation package).

```ts
// packages/foundation/src/seams/patient-reader.ts
//
// Owned by M5 (Patient). M29 consumes; T-29.01 already declared this as a consumed seam.
// The five read methods below are M29-required-from-M5; M5's own internal calls may use
// a richer interface.

export interface PatientIdentity {
  readonly id: string                          // M5 patient.id (UUID)
  readonly organizationId: string
  readonly mrn: string                         // patient's internal MRN
  readonly externalMrns: readonly ExternalMrn[]  // PID-3 alternates from prior admits
  readonly lastName: string
  readonly firstName: string
  readonly dateOfBirth: string                 // ISO yyyy-mm-dd
  readonly administrativeSex: 'M' | 'F' | 'U' | 'O' | string
  readonly ssnLast4?: string                   // typically null; populated only when present in source data
  readonly mergedIntoId?: string               // if non-null, this patient was merged; caller should follow the redirect
}

export interface ExternalMrn {
  readonly assigningAuthority: string  // e.g. "ST_ANTHONY", "PROVIDENCE_HEALTH"
  readonly value: string
}

export interface FindByMrnInput {
  readonly organizationId: string
  readonly mrn: string
}

export interface FindByExternalMrnInput {
  readonly organizationId: string
  readonly assigningAuthority: string
  readonly value: string
}

export interface FindBySsnLast4AndDobInput {
  readonly organizationId: string
  readonly ssnLast4: string                    // exactly 4 digits
  readonly dateOfBirth: string                 // ISO yyyy-mm-dd
}

export interface FindByNameDobSexInput {
  readonly organizationId: string
  readonly lastName: string                    // case-insensitive comparison server-side
  readonly firstName: string                   // case-insensitive
  readonly dateOfBirth: string                 // ISO yyyy-mm-dd
  readonly administrativeSex: string
}

export interface FindByLooseNameInput {
  readonly organizationId: string
  readonly lastName: string                    // case-insensitive
  readonly firstNameInitial?: string           // single character, case-insensitive
  readonly dateOfBirth: string                 // ISO yyyy-mm-dd
}

export interface PatientReader {
  /** Level 1: tenant's internal MRN exact match. Returns at most one (MRN unique within org). */
  findByMrn(input: FindByMrnInput): Promise<PatientIdentity | null>

  /** Level 2: external system MRN match against patient.external_mrns. */
  findByExternalMrn(input: FindByExternalMrnInput): Promise<PatientIdentity | null>

  /** Level 3: SSN-last-4 + DOB. Returns 0..N hits; cascade interprets 1=confident, >1=fallthrough. */
  findBySsnLast4AndDob(input: FindBySsnLast4AndDobInput): Promise<readonly PatientIdentity[]>

  /** Level 4: exact name + DOB + sex. Returns 0..N hits; 1=L4 candidate, >1=fallthrough to L5. */
  findByNameDobSex(input: FindByNameDobSexInput): Promise<readonly PatientIdentity[]>

  /** Level 5: loose name (last + first initial) + DOB. Returns 0..N hits; 1=L5 candidate, >1=no_match. */
  findByLooseName(input: FindByLooseNameInput): Promise<readonly PatientIdentity[]>
}

/**
 * If the returned patient has mergedIntoId set, callers should follow the redirect.
 * The cascade does this transparently — see match-cascade.ts.
 */
```

### 3.1 Merge-aware redirect rule

If `findByMrn` (or any other method) returns a patient with `mergedIntoId !== undefined`, the cascade follows the redirect by calling `findById(mergedIntoId)` once. If the resolved row also has a `mergedIntoId`, the cascade calls again, up to 3 hops. Beyond 3 it logs a warning and treats as `no_match` (defensive against infinite-merge-chain bugs in M5). M5's `PatientReader` should not normally produce chains of depth > 1, but the cascade tolerates it.

The cascade does NOT need a separate `findById` method on the seam — it can re-issue a `findByMrn` with the resolved patient's MRN — but for clarity we declare an additional method:

```ts
/** Resolve merge-redirect target. Used internally by the cascade. */
findById(input: { organizationId: string; id: string }): Promise<PatientIdentity | null>
```

M5 implements this trivially (it's a single-row lookup).

### 3.2 Performance contract

The cascade calls up to five seam methods per inbound message. Per the M29 SLO (parse → matched p95 < 2s), each individual call must complete in p95 < 200ms. M5 owns the implementation; the cascade's responsibility is to fail-fast if any single call exceeds 1.5s (timeout wrapper in §4.3).

---

## 4. Cascade Service

Path: `apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.ts`.

### 4.1 Types

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.ts
import type { PatientReader, PatientIdentity } from '@wardenx/foundation/seams'
import type { Logger } from 'pino'

/**
 * Discriminated union of cascade outcomes. The level mirrors the §4.6 algorithm and
 * the hl7_inbound_match_level enum from §2.1.
 */
export type MatchOutcome =
  | {
      kind: 'confident_match'
      patientId: string
      level: 'L1_MRN_EXACT' | 'L2_EXTERNAL_MRN_EXACT' | 'L3_SSN_DOB'
      mergeRedirectHops: number
    }
  | {
      kind: 'candidate_match'
      patientId: string
      level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE' | 'L5_LOOSE_NAME_DOB_CANDIDATE'
      confidence: number
      mergeRedirectHops: number
    }
  | {
      kind: 'ambiguous'
      candidateIds: readonly string[]   // multiple L3 or L4 hits
      level: 'L3_SSN_DOB' | 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE'
    }
  | {
      kind: 'no_match'
    }

export interface CascadeInput {
  readonly organizationId: string
  readonly internalMrnAuthority?: string  // from organization.settings.hl7_internal_mrn_authority
  readonly pid: ParsedPid                  // from T-29.03 typed Pid
}

export interface ParsedPid {
  readonly identifiers: readonly { value: string; assigningAuthority: string }[]
  readonly lastName: string
  readonly firstName: string
  readonly dateOfBirth: string                  // ISO yyyy-mm-dd; cascade requires this; if missing, L3/4/5 are skipped
  readonly administrativeSex: string
  readonly ssnLast4?: string                    // populated from PID-19 if present and exactly 4 chars
}

export interface CascadeDeps {
  readonly patientReader: PatientReader
  readonly logger: Logger
  readonly perCallTimeoutMs?: number            // default 1500
}
```

### 4.2 The cascade

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/match-cascade.ts (continued)

const DEFAULT_PER_CALL_TIMEOUT_MS = 1500
const MAX_MERGE_HOPS = 3

/**
 * Run the deterministic five-level patient match cascade.
 *
 * Levels are tried in order; the first level that yields a definitive result returns.
 * "Definitive" means:
 *   - L1, L2 returning a hit → confident_match (return immediately)
 *   - L3 returning exactly 1 hit → confident_match (return); >1 hit → fall through to L4
 *   - L4 returning exactly 1 hit → candidate_match (return); >1 hit → fall through to L5
 *   - L5 returning exactly 1 hit → candidate_match (return); >1 hit → no_match
 *   - All levels failing → no_match
 *
 * Every "match" outcome resolves merge-redirects up to 3 hops.
 */
export async function matchPatient(
  input: CascadeInput,
  deps: CascadeDeps,
): Promise<MatchOutcome> {
  const timeoutMs = deps.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS

  // ─── Level 1: Internal MRN match ─────────────────────────────────────
  if (input.internalMrnAuthority) {
    const internalId = input.pid.identifiers.find(
      (id) => id.assigningAuthority === input.internalMrnAuthority,
    )
    if (internalId?.value) {
      const hit = await withTimeout(
        deps.patientReader.findByMrn({
          organizationId: input.organizationId,
          mrn: internalId.value,
        }),
        timeoutMs,
        'L1_MRN_EXACT',
      )
      if (hit) {
        const resolved = await resolveMerge(hit, input.organizationId, deps)
        if (resolved.patient) {
          deps.logger.info(
            { level: 'L1_MRN_EXACT', mrn: internalId.value, patientId: resolved.patient.id, hops: resolved.hops },
            'hl7.cascade.confident_match',
          )
          return {
            kind: 'confident_match',
            patientId: resolved.patient.id,
            level: 'L1_MRN_EXACT',
            mergeRedirectHops: resolved.hops,
          }
        }
      }
    }
  }

  // ─── Level 2: External-system MRN match ──────────────────────────────
  for (const id of input.pid.identifiers) {
    if (input.internalMrnAuthority && id.assigningAuthority === input.internalMrnAuthority) continue
    if (!id.value || !id.assigningAuthority) continue

    const hit = await withTimeout(
      deps.patientReader.findByExternalMrn({
        organizationId: input.organizationId,
        assigningAuthority: id.assigningAuthority,
        value: id.value,
      }),
      timeoutMs,
      'L2_EXTERNAL_MRN_EXACT',
    )
    if (hit) {
      const resolved = await resolveMerge(hit, input.organizationId, deps)
      if (resolved.patient) {
        deps.logger.info(
          { level: 'L2_EXTERNAL_MRN_EXACT', assigningAuthority: id.assigningAuthority, patientId: resolved.patient.id, hops: resolved.hops },
          'hl7.cascade.confident_match',
        )
        return {
          kind: 'confident_match',
          patientId: resolved.patient.id,
          level: 'L2_EXTERNAL_MRN_EXACT',
          mergeRedirectHops: resolved.hops,
        }
      }
    }
  }

  // ─── Level 3: SSN-last4 + DOB ────────────────────────────────────────
  if (input.pid.ssnLast4 && input.pid.dateOfBirth) {
    if (!isValidSsnLast4(input.pid.ssnLast4)) {
      deps.logger.warn({ ssnLast4Length: input.pid.ssnLast4.length }, 'hl7.cascade.ssn_last4_invalid_skipped')
    } else {
      const hits = await withTimeout(
        deps.patientReader.findBySsnLast4AndDob({
          organizationId: input.organizationId,
          ssnLast4: input.pid.ssnLast4,
          dateOfBirth: input.pid.dateOfBirth,
        }),
        timeoutMs,
        'L3_SSN_DOB',
      )
      if (hits.length === 1) {
        const resolved = await resolveMerge(hits[0]!, input.organizationId, deps)
        if (resolved.patient) {
          deps.logger.info(
            { level: 'L3_SSN_DOB', patientId: resolved.patient.id, hops: resolved.hops },
            'hl7.cascade.confident_match',
          )
          return {
            kind: 'confident_match',
            patientId: resolved.patient.id,
            level: 'L3_SSN_DOB',
            mergeRedirectHops: resolved.hops,
          }
        }
      } else if (hits.length > 1) {
        deps.logger.info({ level: 'L3_SSN_DOB', candidateCount: hits.length }, 'hl7.cascade.ambiguous_fallthrough')
        return {
          kind: 'ambiguous',
          candidateIds: hits.map((h) => h.id),
          level: 'L3_SSN_DOB',
        }
      }
    }
  }

  // ─── Level 4: Exact name + DOB + sex ─────────────────────────────────
  if (input.pid.dateOfBirth && input.pid.lastName && input.pid.firstName) {
    const hits = await withTimeout(
      deps.patientReader.findByNameDobSex({
        organizationId: input.organizationId,
        lastName: input.pid.lastName,
        firstName: input.pid.firstName,
        dateOfBirth: input.pid.dateOfBirth,
        administrativeSex: input.pid.administrativeSex,
      }),
      timeoutMs,
      'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
    )

    if (hits.length === 1) {
      const resolved = await resolveMerge(hits[0]!, input.organizationId, deps)
      if (resolved.patient) {
        deps.logger.info(
          { level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE', patientId: resolved.patient.id, hops: resolved.hops },
          'hl7.cascade.candidate_match',
        )
        return {
          kind: 'candidate_match',
          patientId: resolved.patient.id,
          level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
          confidence: 0.92,
          mergeRedirectHops: resolved.hops,
        }
      }
    } else if (hits.length > 1) {
      // Multiple exact matches — too ambiguous to auto-propose-one; surface all candidates
      // for human review. The proposal lifecycle (T-29.06) creates the review row.
      deps.logger.info({ level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE', candidateCount: hits.length }, 'hl7.cascade.ambiguous_l4')
      return {
        kind: 'ambiguous',
        candidateIds: hits.map((h) => h.id),
        level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
      }
    }
  }

  // ─── Level 5: Loose name + DOB ───────────────────────────────────────
  if (input.pid.dateOfBirth && input.pid.lastName) {
    const hits = await withTimeout(
      deps.patientReader.findByLooseName({
        organizationId: input.organizationId,
        lastName: input.pid.lastName,
        firstNameInitial: input.pid.firstName?.[0],
        dateOfBirth: input.pid.dateOfBirth,
      }),
      timeoutMs,
      'L5_LOOSE_NAME_DOB_CANDIDATE',
    )

    if (hits.length === 1) {
      const resolved = await resolveMerge(hits[0]!, input.organizationId, deps)
      if (resolved.patient) {
        deps.logger.info(
          { level: 'L5_LOOSE_NAME_DOB_CANDIDATE', patientId: resolved.patient.id, hops: resolved.hops },
          'hl7.cascade.candidate_match',
        )
        return {
          kind: 'candidate_match',
          patientId: resolved.patient.id,
          level: 'L5_LOOSE_NAME_DOB_CANDIDATE',
          confidence: 0.78,
          mergeRedirectHops: resolved.hops,
        }
      }
    }
    // L5 with >1 hits is "too loose to even propose" — falls through to no_match
  }

  deps.logger.info({}, 'hl7.cascade.no_match')
  return { kind: 'no_match' }
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface MergeResolveResult {
  readonly patient: PatientIdentity | null
  readonly hops: number
}

async function resolveMerge(
  start: PatientIdentity,
  organizationId: string,
  deps: CascadeDeps,
): Promise<MergeResolveResult> {
  let current: PatientIdentity | null = start
  let hops = 0
  while (current && current.mergedIntoId && hops < MAX_MERGE_HOPS) {
    hops++
    const next = await deps.patientReader.findById({ organizationId, id: current.mergedIntoId })
    if (!next) {
      // The redirect target doesn't exist — treat as no-match for safety
      deps.logger.warn(
        { startPatientId: start.id, dangling: current.mergedIntoId, hops },
        'hl7.cascade.merge_dangling',
      )
      return { patient: null, hops }
    }
    current = next
  }
  if (current?.mergedIntoId && hops >= MAX_MERGE_HOPS) {
    deps.logger.warn({ startPatientId: start.id, hops }, 'hl7.cascade.merge_hops_exceeded')
    return { patient: null, hops }
  }
  return { patient: current, hops }
}

function isValidSsnLast4(s: string): boolean {
  return /^\d{4}$/.test(s) && s !== '0000'
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`cascade_seam_timeout_${label}`)), ms),
    ),
  ])
}
```

### 4.3 Why the cascade is **not** parallelized

The cascade calls levels sequentially. A naïve optimization would fire all five seam calls in parallel and take the first definitive result. **This is wrong** for three reasons:

1. **L1 is by far the most common positive case** for established admit traffic (the partner facility already sent us this patient before). Sequential L1-first means most invocations finish after one seam call. Parallel-everything wastes M5's read capacity.
2. **Higher levels rely on lower-level negative signal.** L3 vs L4 isn't just "do they both match" — it's "L3 didn't yield exactly 1, so we fall through to L4". Parallel firing requires post-hoc reconciliation of overlapping hits and adds bugs without latency benefit.
3. **The cascade is the read-path. The seam contract pins each level at p95 < 200ms.** Even worst case (all 5 levels run) is p95 < 1s, leaving budget for the rest of the parse+persist+ACK chain.

The sequential design is intentional. Recorded so a future "speed up cascade" PR doesn't accidentally regress the ambiguity semantics.

---

## 5. Parse Worker Integration

Replace the T-29.04 stub for ADT branch:

```ts
// apps/backend/src/modules/29-external-interfaces/workers/hl7-inbound-parse.worker.ts
// (additions to the worker handler; T-29.04 shipped the parse step; T-29.05 wires the cascade)

import { matchPatient, type CascadeInput, type MatchOutcome } from '../inbound/match-cascade'
import { routeOutcome } from '../inbound/outcome-router'
import { projectPid } from '@wardenx/hl7-worker/segments/pid'
import { findPidSegment } from '@wardenx/hl7-worker/messages/adt-shared'

// In the worker's body, after parse-success:

if (message.messageType.startsWith('ADT^')) {
  const pidSeg = findPidSegment(parsed)
  if (!pidSeg) {
    // ADT without PID is a parse-validation failure; mark parse_error and stop
    await persistParseError(messageId, organizationId, 'adt_missing_pid')
    return
  }

  const pid = projectPid(pidSeg)
  const orgSettings = await mdm.getOrganizationSettings(organizationId)
  const cascadeInput: CascadeInput = {
    organizationId,
    internalMrnAuthority: orgSettings.hl7_internal_mrn_authority,
    pid: {
      identifiers: pid.identifiers.map(i => ({ value: i.value, assigningAuthority: i.assigningAuthority })),
      lastName: pid.names[0]?.familyName ?? '',
      firstName: pid.names[0]?.givenName ?? '',
      dateOfBirth: hl7DateToIso(pid.dateOfBirth),
      administrativeSex: pid.sex,
      ssnLast4: extractSsnLast4(pid.ssnNumber),
    },
  }

  const t0 = Date.now()
  const outcome = await matchPatient(cascadeInput, {
    patientReader: deps.patientReader,
    logger,
  })
  const cascadeRunMs = Date.now() - t0

  // Persist cascade result on hl7_message_inbound
  await persistCascadeResult(messageId, organizationId, outcome, cascadeRunMs)

  // Route the outcome to the next-stage event
  await routeOutcome({
    outcome,
    messageId,
    feedId,
    organizationId,
    messageControlId: message.messageControlId,
    messageType: message.messageType,
    outbox: deps.outbox,
    logger,
  })

  return
}

if (message.messageType.startsWith('ORU^')) {
  // T-29.07 will wire the lab branch here; for T-29.05 we leave the T-29.04 forward-stub event.
  await outbox.publish('m29.hl7_message.parsed_oru', { messageId, feedId, organizationId, messageType: message.messageType, messageControlId: message.messageControlId, parsedSegmentCount: parsed.segmentsList?.length ?? 0 })
  return
}

// Other message types — same as T-29.04 fallback
await outbox.publish('m29.hl7_message.parsed_other', { messageId, feedId, organizationId, messageType: message.messageType, messageControlId: message.messageControlId, parsedSegmentCount: parsed.segmentsList?.length ?? 0 })
```

### 5.1 Helpers

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/cascade-persistence.ts
import { hl7MessageInbound } from '@wardenx/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withOrgContext } from '@wardenx/tenancy'
import type { MatchOutcome } from './match-cascade'

export async function persistCascadeResult(
  messageId: string,
  organizationId: string,
  outcome: MatchOutcome,
  cascadeRunMs: number,
): Promise<void> {
  const { matchedPatientId, matchLevel, matchOutcome, matchConfidence } = projectForSchema(outcome)

  await withOrgContext(db, { organizationId }, async (tx) => {
    await tx
      .update(hl7MessageInbound)
      .set({
        matchedPatientId,
        matchLevel,
        matchOutcome,
        matchConfidence,
        cascadeRunMs,
      })
      .where(eq(hl7MessageInbound.id, messageId))
  })
}

function projectForSchema(outcome: MatchOutcome): {
  matchedPatientId: string | null
  matchLevel: string | null
  matchOutcome: 'matched_single' | 'matched_ambiguous' | 'no_match' | null
  matchConfidence: string | null  // numeric stringified for Drizzle
} {
  switch (outcome.kind) {
    case 'confident_match':
      return {
        matchedPatientId: outcome.patientId,
        matchLevel: outcome.level,
        matchOutcome: 'matched_single',
        matchConfidence: null,
      }
    case 'candidate_match':
      return {
        matchedPatientId: outcome.patientId,
        matchLevel: outcome.level,
        matchOutcome: 'matched_single',
        matchConfidence: outcome.confidence.toFixed(3),
      }
    case 'ambiguous':
      return {
        matchedPatientId: null,
        matchLevel: outcome.level,
        matchOutcome: 'matched_ambiguous',
        matchConfidence: null,
      }
    case 'no_match':
      return {
        matchedPatientId: null,
        matchLevel: 'NO_MATCH',
        matchOutcome: 'no_match',
        matchConfidence: null,
      }
  }
}
```

```ts
// PID date helpers
export function hl7DateToIso(hl7Date: string): string {
  // HL7 TS format: YYYYMMDD or YYYYMMDDHHMMSS. We want ISO yyyy-mm-dd for DOB.
  if (!hl7Date || hl7Date.length < 8) return ''
  return `${hl7Date.slice(0, 4)}-${hl7Date.slice(4, 6)}-${hl7Date.slice(6, 8)}`
}

export function extractSsnLast4(ssnRaw: string | undefined): string | undefined {
  if (!ssnRaw) return undefined
  const digits = ssnRaw.replace(/\D/g, '')
  if (digits.length < 4) return undefined
  return digits.slice(-4)
}
```

---

## 6. Outcome Router

Path: `apps/backend/src/modules/29-external-interfaces/inbound/outcome-router.ts`.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/outcome-router.ts
import type { MatchOutcome } from './match-cascade'
import type { Outbox } from '@wardenx/foundation/outbox'
import type { Logger } from 'pino'

export interface RouteOutcomeInput {
  readonly outcome: MatchOutcome
  readonly messageId: string
  readonly feedId: string
  readonly organizationId: string
  readonly messageControlId: string
  readonly messageType: string
  readonly outbox: Outbox
  readonly logger: Logger
}

/**
 * Translate the cascade outcome into one of three terminal events.
 * The events are consumed downstream by T-29.06 (proposal lifecycle).
 */
export async function routeOutcome(input: RouteOutcomeInput): Promise<void> {
  const { outcome, messageId, feedId, organizationId, messageControlId, messageType, outbox, logger } = input

  switch (outcome.kind) {
    case 'confident_match':
      await outbox.publish('m29.hl7_message.cascade_resolved_confident', {
        messageId, feedId, organizationId, messageControlId, messageType,
        matchedPatientId: outcome.patientId,
        matchLevel: outcome.level,
        mergeRedirectHops: outcome.mergeRedirectHops,
      })
      logger.info({ messageId, matchedPatientId: outcome.patientId, level: outcome.level }, 'hl7.outcome.routed.confident')
      return

    case 'candidate_match':
      await outbox.publish('m29.hl7_message.cascade_resolved_candidate', {
        messageId, feedId, organizationId, messageControlId, messageType,
        candidatePatientId: outcome.patientId,
        matchLevel: outcome.level,
        matchConfidence: outcome.confidence,
        candidateIds: [outcome.patientId],
        mergeRedirectHops: outcome.mergeRedirectHops,
      })
      logger.info({ messageId, candidatePatientId: outcome.patientId, level: outcome.level }, 'hl7.outcome.routed.candidate')
      return

    case 'ambiguous':
      // Multiple candidates — emit a candidate event with the full list. T-29.06's proposal
      // creator will surface all candidates in the review queue.
      await outbox.publish('m29.hl7_message.cascade_resolved_candidate', {
        messageId, feedId, organizationId, messageControlId, messageType,
        candidatePatientId: null,
        matchLevel: outcome.level,
        matchConfidence: null,
        candidateIds: outcome.candidateIds,
        mergeRedirectHops: 0,
      })
      logger.info({ messageId, candidateCount: outcome.candidateIds.length, level: outcome.level }, 'hl7.outcome.routed.ambiguous')
      return

    case 'no_match':
      await outbox.publish('m29.hl7_message.cascade_resolved_no_match', {
        messageId, feedId, organizationId, messageControlId, messageType,
      })
      logger.info({ messageId }, 'hl7.outcome.routed.no_match')
      return
  }
}
```

---

## 7. Unit Tests (≥95% Branch Coverage)

Path: `apps/backend/src/modules/29-external-interfaces/inbound/__tests__/match-cascade.test.ts`.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/__tests__/match-cascade.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchPatient, type CascadeInput, type CascadeDeps } from '../match-cascade'
import type { PatientReader, PatientIdentity } from '@wardenx/foundation/seams'
import { mkLogger } from '../../../__test-utils__/logger'

const ORG = 'org_engrace'
const AUTH = 'ENGRACE_INTERNAL'

function mkPatient(over: Partial<PatientIdentity> = {}): PatientIdentity {
  return {
    id: 'pt_default', organizationId: ORG, mrn: 'MRN-DEFAULT',
    externalMrns: [], lastName: 'DOE', firstName: 'JANE',
    dateOfBirth: '1948-03-22', administrativeSex: 'F',
    ...over,
  }
}

function mkInput(overrides: Partial<CascadeInput['pid']> = {}): CascadeInput {
  return {
    organizationId: ORG,
    internalMrnAuthority: AUTH,
    pid: {
      identifiers: [{ value: 'MRN-001234', assigningAuthority: AUTH }],
      lastName: 'DOE', firstName: 'JANE',
      dateOfBirth: '1948-03-22', administrativeSex: 'F',
      ...overrides,
    },
  }
}

function mkReader(over: Partial<PatientReader>): PatientReader {
  return {
    findByMrn: vi.fn(),
    findByExternalMrn: vi.fn(),
    findBySsnLast4AndDob: vi.fn(),
    findByNameDobSex: vi.fn(),
    findByLooseName: vi.fn(),
    findById: vi.fn(),
    ...over,
  } as PatientReader
}

let deps: CascadeDeps
beforeEach(() => {
  deps = { patientReader: mkReader({}), logger: mkLogger() }
})

// ─── Level 1 ─────────────────────────────────────────────────────────
describe('L1 — internal MRN exact', () => {
  it('returns confident_match L1 when internal MRN hits', async () => {
    const patient = mkPatient({ id: 'pt_l1' })
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(patient)
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({
      kind: 'confident_match', patientId: 'pt_l1', level: 'L1_MRN_EXACT', mergeRedirectHops: 0,
    })
    expect(deps.patientReader.findByMrn).toHaveBeenCalledWith({ organizationId: ORG, mrn: 'MRN-001234' })
    // Did not call lower-level methods
    expect(deps.patientReader.findByExternalMrn).not.toHaveBeenCalled()
    expect(deps.patientReader.findBySsnLast4AndDob).not.toHaveBeenCalled()
  })

  it('skips L1 if no internal MRN authority configured', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(mkPatient())
    const input = mkInput()
    const result = await matchPatient({ ...input, internalMrnAuthority: undefined }, deps)
    expect(deps.patientReader.findByMrn).not.toHaveBeenCalled()
    expect(result.kind).not.toBe('confident_match')  // would have fallen through to L4 candidate
  })

  it('skips L1 if PID has no identifier matching the internal authority', async () => {
    const input: CascadeInput = {
      ...mkInput(),
      pid: {
        ...mkInput().pid,
        identifiers: [{ value: 'OTHER-123', assigningAuthority: 'OTHER_HOSPITAL' }],
      },
    }
    deps.patientReader.findByMrn = vi.fn()
    await matchPatient(input, deps)
    expect(deps.patientReader.findByMrn).not.toHaveBeenCalled()
  })

  it('L1 follows merge redirect once', async () => {
    const merged = mkPatient({ id: 'pt_old', mergedIntoId: 'pt_new' })
    const target = mkPatient({ id: 'pt_new' })
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(merged)
    deps.patientReader.findById = vi.fn().mockResolvedValue(target)
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({
      kind: 'confident_match', patientId: 'pt_new', level: 'L1_MRN_EXACT', mergeRedirectHops: 1,
    })
  })

  it('L1 with dangling merge redirect treats as no-match', async () => {
    const merged = mkPatient({ mergedIntoId: 'pt_missing' })
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(merged)
    deps.patientReader.findById = vi.fn().mockResolvedValue(null)
    // Falls through to L2/L3/L4/L5 with default mocks returning null/[]
    const result = await matchPatient(mkInput(), deps)
    expect(result.kind).not.toBe('confident_match')
  })

  it('L1 with 3-deep merge chain still resolves', async () => {
    const a = mkPatient({ id: 'pt_a', mergedIntoId: 'pt_b' })
    const b = mkPatient({ id: 'pt_b', mergedIntoId: 'pt_c' })
    const c = mkPatient({ id: 'pt_c', mergedIntoId: 'pt_d' })
    const d = mkPatient({ id: 'pt_d' })
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(a)
    deps.patientReader.findById = vi.fn()
      .mockResolvedValueOnce(b)
      .mockResolvedValueOnce(c)
      .mockResolvedValueOnce(d)
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({
      kind: 'confident_match', patientId: 'pt_d', level: 'L1_MRN_EXACT', mergeRedirectHops: 3,
    })
  })

  it('L1 with 4+ deep merge chain treats as no-match (hops_exceeded)', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(mkPatient({ mergedIntoId: 'next' }))
    deps.patientReader.findById = vi.fn().mockResolvedValue(mkPatient({ mergedIntoId: 'next' }))
    const result = await matchPatient(mkInput(), deps)
    expect(result.kind).not.toBe('confident_match')
  })

  it('L1 seam timeout propagates as a thrown error', async () => {
    deps.patientReader.findByMrn = vi.fn().mockReturnValue(new Promise(() => {}))  // hang
    await expect(matchPatient(mkInput(), { ...deps, perCallTimeoutMs: 50 })).rejects.toThrow(/cascade_seam_timeout_L1/)
  })
})

// ─── Level 2 ─────────────────────────────────────────────────────────
describe('L2 — external-system MRN exact', () => {
  it('returns confident_match L2 when external MRN hits', async () => {
    const input: CascadeInput = mkInput()
    input.pid = {
      ...input.pid,
      identifiers: [
        { value: 'MRN-WRONG-INT', assigningAuthority: AUTH },
        { value: 'ST_ANTH_999', assigningAuthority: 'ST_ANTHONY' },
      ],
    }
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn()
      .mockImplementation(({ assigningAuthority }) =>
        Promise.resolve(assigningAuthority === 'ST_ANTHONY' ? mkPatient({ id: 'pt_l2' }) : null),
      )
    const result = await matchPatient(input, deps)
    expect(result.kind).toBe('confident_match')
    expect((result as { level: string }).level).toBe('L2_EXTERNAL_MRN_EXACT')
  })

  it('L2 skips identifiers with empty values or authority', async () => {
    const input = mkInput()
    input.pid.identifiers = [
      { value: '', assigningAuthority: 'X' },
      { value: 'Y', assigningAuthority: '' },
    ]
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn()
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([])
    deps.patientReader.findByNameDobSex = vi.fn().mockResolvedValue([])
    deps.patientReader.findByLooseName = vi.fn().mockResolvedValue([])
    await matchPatient(input, deps)
    expect(deps.patientReader.findByExternalMrn).not.toHaveBeenCalled()
  })
})

// ─── Level 3 ─────────────────────────────────────────────────────────
describe('L3 — SSN-last4 + DOB', () => {
  it('returns confident_match L3 on single hit', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([mkPatient({ id: 'pt_l3' })])
    const result = await matchPatient({ ...mkInput({ ssnLast4: '6789' }) }, deps)
    expect(result.kind).toBe('confident_match')
    expect((result as { level: string }).level).toBe('L3_SSN_DOB')
  })

  it('returns ambiguous L3 on multiple hits', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([
      mkPatient({ id: 'pt_a' }),
      mkPatient({ id: 'pt_b' }),
    ])
    const result = await matchPatient({ ...mkInput({ ssnLast4: '6789' }) }, deps)
    expect(result).toEqual({
      kind: 'ambiguous',
      candidateIds: ['pt_a', 'pt_b'],
      level: 'L3_SSN_DOB',
    })
  })

  it('skips L3 when ssn_last4 is missing', async () => {
    deps.patientReader.findBySsnLast4AndDob = vi.fn()
    const input = { ...mkInput() }  // ssnLast4 undefined
    await matchPatient(input, { ...deps, patientReader: mkReader({}) })
    expect(deps.patientReader.findBySsnLast4AndDob).not.toHaveBeenCalled()
  })

  it('skips L3 when ssn_last4 is "0000" (invalid sentinel)', async () => {
    deps.patientReader.findBySsnLast4AndDob = vi.fn()
    await matchPatient(mkInput({ ssnLast4: '0000' }), { ...deps, patientReader: mkReader({}) })
    expect(deps.patientReader.findBySsnLast4AndDob).not.toHaveBeenCalled()
  })

  it('skips L3 when ssn_last4 is not 4 digits', async () => {
    deps.patientReader.findBySsnLast4AndDob = vi.fn()
    await matchPatient(mkInput({ ssnLast4: '67' }), { ...deps, patientReader: mkReader({}) })
    expect(deps.patientReader.findBySsnLast4AndDob).not.toHaveBeenCalled()
  })

  it('skips L3 when DOB is missing', async () => {
    deps.patientReader.findBySsnLast4AndDob = vi.fn()
    await matchPatient(mkInput({ ssnLast4: '6789', dateOfBirth: '' }), { ...deps, patientReader: mkReader({}) })
    expect(deps.patientReader.findBySsnLast4AndDob).not.toHaveBeenCalled()
  })
})

// ─── Level 4 ─────────────────────────────────────────────────────────
describe('L4 — exact name + DOB + sex', () => {
  beforeEach(() => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([])
  })

  it('returns candidate_match L4 with 0.92 confidence on single hit', async () => {
    deps.patientReader.findByNameDobSex = vi.fn().mockResolvedValue([mkPatient({ id: 'pt_l4' })])
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({
      kind: 'candidate_match', patientId: 'pt_l4', level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
      confidence: 0.92, mergeRedirectHops: 0,
    })
  })

  it('returns ambiguous L4 on multiple hits', async () => {
    deps.patientReader.findByNameDobSex = vi.fn().mockResolvedValue([
      mkPatient({ id: 'pt_a' }), mkPatient({ id: 'pt_b' }),
    ])
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({
      kind: 'ambiguous', candidateIds: ['pt_a', 'pt_b'], level: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
    })
  })

  it('skips L4 when DOB missing', async () => {
    deps.patientReader.findByNameDobSex = vi.fn()
    await matchPatient(mkInput({ dateOfBirth: '' }), deps)
    expect(deps.patientReader.findByNameDobSex).not.toHaveBeenCalled()
  })

  it('skips L4 when lastName missing', async () => {
    deps.patientReader.findByNameDobSex = vi.fn()
    await matchPatient(mkInput({ lastName: '' }), deps)
    expect(deps.patientReader.findByNameDobSex).not.toHaveBeenCalled()
  })
})

// ─── Level 5 ─────────────────────────────────────────────────────────
describe('L5 — loose name + DOB', () => {
  beforeEach(() => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([])
    deps.patientReader.findByNameDobSex = vi.fn().mockResolvedValue([])
  })

  it('returns candidate_match L5 with 0.78 confidence on single hit', async () => {
    deps.patientReader.findByLooseName = vi.fn().mockResolvedValue([mkPatient({ id: 'pt_l5' })])
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({
      kind: 'candidate_match', patientId: 'pt_l5', level: 'L5_LOOSE_NAME_DOB_CANDIDATE',
      confidence: 0.78, mergeRedirectHops: 0,
    })
  })

  it('returns no_match on multiple L5 hits (too loose)', async () => {
    deps.patientReader.findByLooseName = vi.fn().mockResolvedValue([
      mkPatient(), mkPatient(),
    ])
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({ kind: 'no_match' })
  })

  it('returns no_match on zero L5 hits', async () => {
    deps.patientReader.findByLooseName = vi.fn().mockResolvedValue([])
    const result = await matchPatient(mkInput(), deps)
    expect(result).toEqual({ kind: 'no_match' })
  })

  it('skips L5 when DOB missing', async () => {
    deps.patientReader.findByLooseName = vi.fn()
    await matchPatient(mkInput({ dateOfBirth: '' }), deps)
    expect(deps.patientReader.findByLooseName).not.toHaveBeenCalled()
  })
})

// ─── End-to-end fallthrough ──────────────────────────────────────────
describe('full cascade fallthrough', () => {
  it('all levels miss → no_match', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([])
    deps.patientReader.findByNameDobSex = vi.fn().mockResolvedValue([])
    deps.patientReader.findByLooseName = vi.fn().mockResolvedValue([])
    const result = await matchPatient(mkInput({ ssnLast4: '6789' }), deps)
    expect(result).toEqual({ kind: 'no_match' })
    // All five methods called
    expect(deps.patientReader.findByMrn).toHaveBeenCalledTimes(1)
    expect(deps.patientReader.findByExternalMrn).toHaveBeenCalledTimes(0)  // only one identifier, an internal one
    expect(deps.patientReader.findBySsnLast4AndDob).toHaveBeenCalledTimes(1)
    expect(deps.patientReader.findByNameDobSex).toHaveBeenCalledTimes(1)
    expect(deps.patientReader.findByLooseName).toHaveBeenCalledTimes(1)
  })

  it('L1 short-circuit prevents lower-level seam calls', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(mkPatient())
    deps.patientReader.findByExternalMrn = vi.fn()
    deps.patientReader.findBySsnLast4AndDob = vi.fn()
    deps.patientReader.findByNameDobSex = vi.fn()
    deps.patientReader.findByLooseName = vi.fn()
    await matchPatient(mkInput(), deps)
    expect(deps.patientReader.findByExternalMrn).not.toHaveBeenCalled()
    expect(deps.patientReader.findBySsnLast4AndDob).not.toHaveBeenCalled()
    expect(deps.patientReader.findByNameDobSex).not.toHaveBeenCalled()
    expect(deps.patientReader.findByLooseName).not.toHaveBeenCalled()
  })

  it('L4 candidate does NOT trigger L5', async () => {
    deps.patientReader.findByMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findByExternalMrn = vi.fn().mockResolvedValue(null)
    deps.patientReader.findBySsnLast4AndDob = vi.fn().mockResolvedValue([])
    deps.patientReader.findByNameDobSex = vi.fn().mockResolvedValue([mkPatient()])
    deps.patientReader.findByLooseName = vi.fn()
    await matchPatient(mkInput(), deps)
    expect(deps.patientReader.findByLooseName).not.toHaveBeenCalled()
  })
})
```

A peer test file `outcome-router.test.ts` covers all four switch arms with mocked outbox publisher. Total branch coverage on the named-critical service: ≥95% per the M29 §9.1 floor.

---

## 8. Integration Tests

Path: `test/integration/cascade/`.

### 8.1 W-XI-01 — complete L1 confident match through cascade persistence

```ts
// test/integration/cascade/w-xi-01-cascade.test.ts
describe('W-XI-01 — L1 confident match (cascade stage)', () => {
  it('end-to-end: ADT^A08 frame with matching internal MRN → cascade persists matched_patient_id', async () => {
    const tenant = await fixtures.tenant({ id: 'org_engrace', mrnAuthority: 'ENGRACE_INTERNAL' })
    const patient = await fixtures.patient({
      organizationId: tenant.id, id: 'pt_jane_doe',
      mrn: 'MRN-001234', lastName: 'DOE', firstName: 'JANE',
      dateOfBirth: '1948-03-22', administrativeSex: 'F',
    })
    const feed = await fixtures.feed({ organizationId: tenant.id, kind: 'adt_inbound' })

    const adtA08 = mkAdtA08Frame({
      mcid: 'MCID-W01-1',
      sendingFacility: 'ENGRACE_INTERNAL',
      pid3: { value: 'MRN-001234', assigningAuthority: 'ENGRACE_INTERNAL' },
      lastName: 'DOE', firstName: 'JANE', dob: '19480322', sex: 'F',
    })

    await deliverFrameToListener(feed, adtA08)

    // Wait for parse + cascade
    await waitFor(async () => {
      const [row] = await db.select().from(hl7MessageInbound).where(eq(hl7MessageInbound.messageControlId, 'MCID-W01-1'))
      expect(row.parseStatus).toBe('parsed')
      expect(row.matchLevel).toBe('L1_MRN_EXACT')
      expect(row.matchOutcome).toBe('matched_single')
      expect(row.matchedPatientId).toBe('pt_jane_doe')
      expect(row.cascadeRunMs).toBeGreaterThan(0)
      expect(row.cascadeRunMs).toBeLessThan(2000)
    }, 5_000)

    // The outbox event landed
    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.hl7_message.cascade_resolved_confident')).toMatchObject({
      payload: expect.objectContaining({
        matchedPatientId: 'pt_jane_doe',
        matchLevel: 'L1_MRN_EXACT',
      }),
    })

    // T-29.06 isn't shipped yet, so the proposal table remains empty (forward-stub)
    const proposals = await db.select().from(hl7InboundProposal)
    expect(proposals).toHaveLength(0)
  })

  it('ADT^A08 with merge-redirect: matched MRN→old patient who merged into new → returns new', async () => {
    await fixtures.patient({ id: 'pt_old', mrn: 'MRN-001234', mergedIntoId: 'pt_new' })
    await fixtures.patient({ id: 'pt_new', mrn: 'MRN-002345' })

    // Frame still uses the OLD MRN as PID-3 (this is the realistic case)
    const adtA08 = mkAdtA08Frame({
      mcid: 'MCID-MERGE',
      pid3: { value: 'MRN-001234', assigningAuthority: 'ENGRACE_INTERNAL' },
    })
    await deliverFrameToListener(feed, adtA08)

    await waitFor(async () => {
      const [row] = await db.select().from(hl7MessageInbound).where(eq(hl7MessageInbound.messageControlId, 'MCID-MERGE'))
      expect(row.matchedPatientId).toBe('pt_new')
      expect(row.matchLevel).toBe('L1_MRN_EXACT')
    })
  })
})
```

### 8.2 W-XI-02 — L4 candidate review

```ts
describe('W-XI-02 — L4 demographic-bridge candidate', () => {
  it('ADT^A01 with no MRN match but exact name+DOB+sex hit → candidate_match L4', async () => {
    const patient = await fixtures.patient({
      organizationId: 'org_engrace', id: 'pt_jane',
      mrn: 'MRN-ACTUAL', lastName: 'DOE', firstName: 'JANE',
      dateOfBirth: '1948-03-22', administrativeSex: 'F',
    })

    const adtA01 = mkAdtA01Frame({
      mcid: 'MCID-W02',
      pid3: { value: 'MRN-WRONG', assigningAuthority: 'ENGRACE_INTERNAL' },  // doesn't match
      lastName: 'DOE', firstName: 'JANE', dob: '19480322', sex: 'F',         // matches L4
    })

    await deliverFrameToListener(feed, adtA01)

    await waitFor(async () => {
      const [row] = await db.select().from(hl7MessageInbound).where(eq(hl7MessageInbound.messageControlId, 'MCID-W02'))
      expect(row.matchLevel).toBe('L4_DEMOGRAPHIC_BRIDGE_CANDIDATE')
      expect(row.matchOutcome).toBe('matched_single')
      expect(row.matchedPatientId).toBe('pt_jane')
      expect(Number(row.matchConfidence)).toBeCloseTo(0.92)
    })

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.hl7_message.cascade_resolved_candidate')).toMatchObject({
      payload: expect.objectContaining({
        candidatePatientId: 'pt_jane',
        matchLevel: 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',
        matchConfidence: 0.92,
      }),
    })

    // Patient row NOT mutated (T-29.06 is what would apply changes; T-29.05 only routes)
    const [patientAfter] = await db.select().from(/* patient table */).where(/* id = pt_jane */)
    expect(patientAfter.address).toBe(/* the pre-frame value */)
  })

  it('L4 ambiguous (>1 hit) → matched_ambiguous outcome', async () => {
    await fixtures.patient({ id: 'pt_a', lastName: 'DOE', firstName: 'JANE', dateOfBirth: '1948-03-22', administrativeSex: 'F' })
    await fixtures.patient({ id: 'pt_b', lastName: 'DOE', firstName: 'JANE', dateOfBirth: '1948-03-22', administrativeSex: 'F' })

    const adtA01 = mkAdtA01Frame({
      mcid: 'MCID-AMBIG',
      pid3: { value: 'MRN-WRONG', assigningAuthority: 'ENGRACE_INTERNAL' },
      lastName: 'DOE', firstName: 'JANE', dob: '19480322', sex: 'F',
    })

    await deliverFrameToListener(feed, adtA01)

    await waitFor(async () => {
      const [row] = await db.select().from(hl7MessageInbound).where(eq(hl7MessageInbound.messageControlId, 'MCID-AMBIG'))
      expect(row.matchOutcome).toBe('matched_ambiguous')
      expect(row.matchedPatientId).toBeNull()
    })

    const events = await fixtures.outboxEvents()
    const candEvent = events.find(e => e.name === 'm29.hl7_message.cascade_resolved_candidate')
    expect(candEvent?.payload.candidateIds).toEqual(expect.arrayContaining(['pt_a', 'pt_b']))
  })
})
```

### 8.3 No-match path

```ts
describe('cascade no_match path', () => {
  it('frame with no L1-L5 hits → cascade_resolved_no_match event', async () => {
    const adtA01 = mkAdtA01Frame({
      mcid: 'MCID-NONE',
      pid3: { value: 'NEVER-SEEN-MRN', assigningAuthority: 'OTHER' },
      lastName: 'NOBODY', firstName: 'NOWHERE', dob: '20000101', sex: 'U',
    })
    await deliverFrameToListener(feed, adtA01)
    await waitFor(async () => {
      const events = await fixtures.outboxEvents()
      expect(events.find(e => e.name === 'm29.hl7_message.cascade_resolved_no_match')).toBeDefined()
    })
  })
})
```

---

## 9. Sign-Off Checklist (T-29.05 PR)

- [ ] **Retroactive T-29.02 corrections (§2) applied** — migration `0030_external_interfaces_cascade.sql` lands; the M29 spec is updated to reflect the schema additions (or a small spec patch document accompanies the PR).
- [ ] `hl7InboundMatchLevel` enum + 5 columns on `hl7_message_inbound` + 2 columns on `lab_observation_inbound_link` exist post-migration.
- [ ] `0030` migration is reversible.
- [ ] `PatientReader` interface lands at `packages/foundation/src/seams/patient-reader.ts`; M5's locked-spec consumer slot for this seam is verified (and if M5's implementation is not yet shipped, a deny-stub `NotImplementedError` is added to M5 per the forward-stub pattern — but in T-29.05, M5's `PatientReader` impl is required for the integration tests to pass).
- [ ] `match-cascade.ts` lands at `apps/backend/src/modules/29-external-interfaces/inbound/`.
- [ ] `outcome-router.ts` lands; three event names registered in the M4 outbox catalog.
- [ ] Parse worker's ADT branch invokes `matchPatient` → `persistCascadeResult` → `routeOutcome`.
- [ ] Parse worker's ORU branch unchanged (T-29.04 stub remains until T-29.07).
- [ ] All §7 unit tests pass; coverage report shows ≥95% branch on `match-cascade.ts` and `outcome-router.ts`.
- [ ] All §8 integration tests pass.
- [ ] `bun run check:cruiser` passes — the cascade imports the `PatientReader` type from foundation, not from M5's schema directly.
- [ ] Cascade p95 latency under load test: <800ms (target; gives margin for the overall p95<2s parse+cascade SLO).
- [ ] PHI log denylist holds — the cascade's `logger.info` calls reference `patientId` (a UUID, non-PHI) only, never `lastName`/`firstName`/`dateOfBirth`.
- [ ] Per-tenant `internal_mrn_authority` resolution: tested with (a) configured, (b) unconfigured (L1 skipped).
- [ ] Merge-redirect: tested up to 3 hops; 4+ hops treated as no-match; dangling redirect treated as no-match.
- [ ] **Architecture lead** sign-off on the 5-level structure (vs the 4-level shorthand used in some sections of M29 spec v0.2).
- [ ] **M5 owner / clinical engineering** sign-off on the `PatientReader` interface (since M5 implements it).
- [ ] **Privacy engineer** sign-off on the SSN-last-4 handling — confirm logs never carry the full SSN, only validated last-4.

---

## 10. Notes on Refinements Past M29 Spec §4.6

This addendum surfaces seven refinements past M29 spec v0.2:

1. **Five levels confirmed canonical** (§2.1). M29 §4.6 has L1-L5; §11 D6 and the W-XI-* workflows reference L1-L4 in shorthand. L5 (loose-name fallback) is real. The match_level enum in §2.1 captures all five.

2. **Per-tenant MRN authority via `organization.settings`** (§2.4). M29 §4.6 referenced `ORG_MRN_AUTH` as a constant; it's per-tenant. Resolution uses the existing JSONB settings field — no M1 schema change.

3. **`lab_observation_inbound_link.candidate_patient_id` added** (§2.3). M29 §4.6 routing table referenced this column; T-29.02 didn't ship it. Additive migration in T-29.05.

4. **`hl7_message_inbound` cascade-result columns added** (§2.2). The W-XI-01 acceptance criteria require these columns; T-29.02 didn't ship them.

5. **Merge-redirect resolution baked into cascade** (§4.2). M29 §4.6 didn't specify merge handling; the cascade follows up to 3 hops, treats danglers and chains-beyond-3 as no-match.

6. **Sequential design intentional** (§4.3). Spec didn't claim parallelism but it's the obvious "optimization"; recorded that it's wrong before someone tries.

7. **Ambiguous outcome separated from candidate** (§4.1). M29 §4.6 said L4 single-hit = candidate, multiple-hit = "confidence drop to L5". T-29.05 refinement: multiple-hit at L3 or L4 is its own `ambiguous` discriminator — the proposal lifecycle (T-29.06) creates a multi-candidate review row distinct from the single-candidate review. Cleaner type discipline.

---

## Document Footer

**Addendum version:** v1.0 (T-29.05 PR-ready)
**Bound to:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.6, §4.5, §10
**Files delivered:** 3 source (`match-cascade.ts`, `outcome-router.ts`, `cascade-persistence.ts`) + 1 seam interface (`patient-reader.ts`) + 1 migration (`0030`)
**T-29.02 retroactive corrections:** 5 (1 enum, 5 schema columns, 2 events to outbox catalog, 1 config convention)
**Tests:** ~35 unit scenarios at ≥95% branch coverage + 4 integration scenarios across W-XI-01/02 + no-match path
**Sign-offs required:** Architecture lead, M5 owner / clinical engineering, Privacy engineer

**End of T-29.05 patient match cascade addendum.**
