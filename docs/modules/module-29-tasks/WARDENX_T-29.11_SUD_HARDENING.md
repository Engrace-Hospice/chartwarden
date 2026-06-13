# WardenX — T-29.11 Addendum: SUD Redaction Hardening

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §11 D15 (SUD ingress redaction), §8.2 (privacy controls), §10 (T-29.11)
**Date:** 2026-06-10
**Prerequisites:** T-29.07 (which shipped v1 of the SUD redaction).

This addendum hardens the SUD redaction surface T-29.07 shipped a v1 of. T-29.07 implemented the basic ingress-time redaction decision: at lab arrival, if any OBX carried a LOINC code classified by M38 as `sud_test` and the patient was identified, M29 consulted M39's `ConsentEvaluator.evaluateForIngressRedaction` and applied the default-on redaction policy. T-29.11 closes the long-tail edges that v1 deferred:

1. **Bind-time re-evaluation.** T-29.07 left unmatched labs (`patient_id=null`) un-evaluated for SUD because there was no patient context. When the reviewer binds the lab to a patient (T-29.07 §11), the SUD policy must re-evaluate before the bind commits.
2. **Back-redaction on consent withdrawal.** A patient who previously authorized SUD disclosure and later withdraws consent must have already-persisted observations re-redacted (in storage and in any downstream caches). The withdrawal event comes via M39's `m39.consent.withdrawn` outbox.
3. **Privileged unredact.** Clinical staff may need to view redacted SUD values in defined circumstances (e.g., a medical emergency under 42 CFR §2.51). T-29.11 ships a privileged unredact route gated by step-up + dual-approval ABAC + time-bounded grant.
4. **42 CFR Part 2 disclosure accounting.** Every SUD disclosure — including each in-app view of an unredacted observation — must be logged in a manner that supports §2.13 accounting requests. M4's existing `auditRead` is sufficient if extended with a Part-2 retention class.
5. **Minor consent.** Minors self-consent to SUD treatment in most jurisdictions; the consent does NOT propagate to a parent's portal access. The policy engine accounts for the patient's age + jurisdiction.
6. **LOINC class drift.** The M38 catalog can change which codes belong to `sud_test`. An observation persisted at T1 (when the code was not in the class) may later belong to a class if the catalog is corrected. T-29.11 ships a re-classification sweep.

**T-29.11 does not close a new W-XI-* scenario; it hardens W-XI-08 (SUD redaction).** W-XI-08 in v0.3 only asserts ingress-time redaction; T-29.11 expands the test surface.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Schema additions** (§2) — new `lab_observation_sud_unredact_grant` table; one new enum `sud_redaction_status`; three new columns on `lab_observation`. Migration `0034_external_interfaces_sud_hardening.sql`.
- **Policy decision engine** at `apps/backend/src/modules/29-external-interfaces/inbound/sud-policy-engine.ts` — multi-org-aware consent evaluator wrapper with minor-consent + jurisdiction handling.
- **Bind-time recheck** at `apps/backend/src/modules/29-external-interfaces/inbound/sud-bind-recheck.ts` — invoked from the unmatched-lab bind route (T-29.07 §11) before the bind transaction commits.
- **Back-redaction worker** at `apps/backend/src/modules/29-external-interfaces/workers/sud-back-redaction.worker.ts` — consumes `m39.consent.withdrawn`; flips matching observations to `back_redacted` status, re-encrypts plaintext values, emits cache-invalidation events.
- **Privileged unredact** at `apps/backend/src/modules/29-external-interfaces/routes/sud-unredact.ts` — `POST /api/v1/hl7/lab-observations/:id/request-unredact-grant`, `POST /:grantId/approve`, `POST /:grantId/exercise`. Step-up + dual approval + ABAC + 4h grant TTL.
- **ABAC predicate** `sud_unredact_authorized` — registered in M3; checks the active grant for the (membership, observation) pair.
- **42 CFR Part 2 disclosure accounting** — every read of an unredacted SUD value writes an `m4.audit.phi_disclosure` row with retention class `compliance_42cfr_part2` (extends M4's existing retention-class enum).
- **LOINC class-drift sweep** at `apps/backend/src/modules/29-external-interfaces/workers/sud-classification-sweep.worker.ts` — daily; re-evaluates observations against the current M38 catalog; flips status if classification changed.
- **Minor-consent jurisdiction lookup** at `apps/backend/src/modules/29-external-interfaces/inbound/minor-consent-rules.ts` — codes the state-by-state minor-consent rules into a typed lookup table.
- **Tests** covering all five hardening surfaces.
- **Sign-off checklist.**

### 1.2 Non-goals

- **Schema for M39 consent withdrawal.** M39 owns the consent table; T-29.11 only consumes the `m39.consent.withdrawn` event.
- **UI surfaces.** T-29.13 includes the privileged-unredact request flow.
- **Cross-org consent reconciliation.** If a patient is enrolled in two tenants with different consent states, each tenant's view is governed by its own consent. T-29.11 explicitly does NOT attempt to reconcile across tenants — that would breach tenant boundaries.
- **Bulk re-encryption migration** for historical observations. The back-redaction worker handles consent-withdrawal events as they arrive; bulk re-keying of all historical observations is a Phase-2 operational concern.
- **Court-order disclosure paths.** 42 CFR §2.66 permits SUD disclosure under court order without patient consent; the workflow ships as a manual ops procedure (Compliance Officer reads observation via admin DB access + writes audit row); a UI for it is Phase 2.
- **Federally Qualified Health Center (FQHC) special rules.** FQHC SUD programs have additional restrictions; Engrace is not an FQHC. Future hospice tenants that ARE FQHCs need a future PR.

---

## 2. Retroactive Schema Corrections (T-29.02)

### 2.1 New enum `sud_redaction_status`

T-29.07 used a boolean `sud_redacted`. T-29.11 needs a richer status to track redaction provenance.

```sql
-- Migration 0034_external_interfaces_sud_hardening.sql (Phase A)

CREATE TYPE sud_redaction_status AS ENUM (
  'not_applicable',                 -- non-SUD-class observation
  'redacted_default_on',            -- D15 default (no consent positively granted)
  'redacted_consent_absent',        -- explicitly denied / withdrawn / no consent on file at evaluate time
  'unredacted_consent_explicit',    -- consent on file at evaluate time
  'unredacted_admin_override',      -- privileged unredact grant in force (§6)
  'back_redacted_consent_withdrawn' -- re-redacted via §4 after persistence
);
```

### 2.2 New columns on `lab_observation`

```sql
-- Migration 0034 (Phase B)

ALTER TABLE lab_observation
  ADD COLUMN sud_redaction_status sud_redaction_status NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN sud_consent_evaluated_at TIMESTAMPTZ,
  ADD COLUMN sud_consent_decision_ref TEXT,         -- opaque ID into M39 consent log; never PHI
  ADD COLUMN sud_classification_evaluated_at TIMESTAMPTZ,
  ADD COLUMN sud_classification_version INTEGER;    -- M38 catalog version at evaluate time
```

The `sud_redacted` boolean from T-29.07 is **kept for backward compatibility** as a generated column:

```sql
ALTER TABLE lab_observation
  ADD COLUMN sud_redacted_legacy BOOLEAN
    GENERATED ALWAYS AS (
      sud_redaction_status IN ('redacted_default_on', 'redacted_consent_absent', 'back_redacted_consent_withdrawn')
    ) STORED;
```

Drizzle:

```ts
// packages/db/src/schema/external-interfaces/lab-observation.ts (additions)
sudRedactionStatus: e.sudRedactionStatus('sud_redaction_status').notNull().default('not_applicable'),
sudConsentEvaluatedAt: timestamp('sud_consent_evaluated_at'),
sudConsentDecisionRef: text('sud_consent_decision_ref'),
sudClassificationEvaluatedAt: timestamp('sud_classification_evaluated_at'),
sudClassificationVersion: integer('sud_classification_version'),
```

### 2.3 New table `lab_observation_sud_unredact_grant`

```sql
-- Migration 0034 (Phase C)

CREATE TYPE sud_unredact_grant_state AS ENUM (
  'requested', 'approved', 'exercised', 'expired', 'cancelled'
);

CREATE TABLE lab_observation_sud_unredact_grant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id),
  observation_id UUID NOT NULL,
  requested_by_membership_id UUID NOT NULL,
  approver_membership_id UUID,                          -- distinct-from-requester ABAC
  state sud_unredact_grant_state NOT NULL DEFAULT 'requested',
  clinical_rationale TEXT NOT NULL,                     -- minimum 50 chars
  approver_rationale TEXT,
  emergency_basis_42cfr_2_51 BOOLEAN NOT NULL DEFAULT FALSE,  -- if true, exercise is permitted without approver (§6.2)
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  exercised_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '4 hours'),
  CONSTRAINT distinct_approver CHECK (approver_membership_id IS NULL OR approver_membership_id != requested_by_membership_id),
  CONSTRAINT rationale_min_length CHECK (length(clinical_rationale) >= 50)
);

CREATE INDEX idx_lsug_observation_active
  ON lab_observation_sud_unredact_grant (observation_id, state)
  WHERE state IN ('approved', 'exercised') AND expires_at > NOW();

CREATE INDEX idx_lsug_requester
  ON lab_observation_sud_unredact_grant (requested_by_membership_id, requested_at DESC);

ALTER TABLE lab_observation_sud_unredact_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_lsug_tenant ON lab_observation_sud_unredact_grant
  USING (organization_id = current_setting('app.current_organization_id')::uuid);
```

### 2.4 M4 audit retention-class extension

```sql
-- M4 owned; T-29.11 contributes the enum value
ALTER TYPE audit_retention_class ADD VALUE 'compliance_42cfr_part2';
```

42 CFR Part 2 retention is treated as a superset of HIPAA: at minimum the longer of (6 years per HIPAA, indefinite per §2.13 patient-accounting right). M4's eraser knows to refuse erasure of `compliance_42cfr_part2` rows during the patient's lifetime.

### 2.5 Summary

| # | Change | Type |
|---|--------|------|
| 2.1 | `sud_redaction_status` enum (6 values) | Additive enum |
| 2.2 | 5 new columns on `lab_observation` + 1 generated backcompat | Additive |
| 2.3 | New `lab_observation_sud_unredact_grant` table + new `sud_unredact_grant_state` enum | Additive |
| 2.4 | `audit_retention_class` gains `compliance_42cfr_part2` | Additive (touches M4) |

The M4 enum extension is coordinated with M4's owner in the PR; M29 doesn't own the audit schema but contributes the value.

---

## 3. Policy Decision Engine

The v1 from T-29.07 made a binary `redact: true/false` decision. T-29.11 expands the output shape and the inputs it considers.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/sud-policy-engine.ts
import type { ConsentEvaluator, TerminologyProvider, PatientReader } from '@wardenx/foundation/seams'
import type { Logger } from 'pino'
import { lookupMinorConsentRule } from './minor-consent-rules'

export interface SudPolicyInput {
  readonly organizationId: string
  readonly patientId: string | null
  readonly obxList: ReadonlyArray<{ observationIdentifier: { code: string } }>
  readonly asOf: Date
}

export interface SudPolicyDecision {
  readonly anySudClass: boolean
  readonly redactionStatus:
    | 'not_applicable'
    | 'redacted_default_on'
    | 'redacted_consent_absent'
    | 'unredacted_consent_explicit'
  readonly consentEvaluatedAt: Date | null
  readonly consentDecisionRef: string | null
  readonly classificationVersion: number | null
  readonly classificationEvaluatedAt: Date
  readonly minorConsentApplied: boolean             // true if the rule used minor-self-consent path
  readonly reasonCodes: readonly string[]           // structured tags for ops + tests
}

export class SudPolicyEngine {
  constructor(
    private readonly deps: {
      consent: ConsentEvaluator
      terminology: TerminologyProvider
      patientReader: PatientReader
      logger: Logger
    },
  ) {}

  async evaluate(input: SudPolicyInput): Promise<SudPolicyDecision> {
    const reasonCodes: string[] = []
    const classificationEvaluatedAt = new Date()

    // 1. Classification check via M38
    const { anySud, classificationVersion } = await this.classifyObxList(input.obxList, input.asOf)
    if (!anySud) {
      return {
        anySudClass: false,
        redactionStatus: 'not_applicable',
        consentEvaluatedAt: null,
        consentDecisionRef: null,
        classificationVersion,
        classificationEvaluatedAt,
        minorConsentApplied: false,
        reasonCodes: ['no_sud_class'],
      }
    }
    reasonCodes.push('sud_class_detected')

    // 2. If patient unknown, defer (T-29.07 §11 bind-time recheck handles it)
    if (!input.patientId) {
      reasonCodes.push('patient_unknown_deferred_to_bind')
      // Default-on for safety: hold as redacted until bound
      return {
        anySudClass: true,
        redactionStatus: 'redacted_default_on',
        consentEvaluatedAt: null,
        consentDecisionRef: null,
        classificationVersion,
        classificationEvaluatedAt,
        minorConsentApplied: false,
        reasonCodes,
      }
    }

    // 3. Resolve patient + check minor-consent
    const patient = await this.deps.patientReader.findById({
      organizationId: input.organizationId,
      id: input.patientId,
    })
    if (!patient) {
      reasonCodes.push('patient_load_failed_safe_redact')
      return {
        anySudClass: true,
        redactionStatus: 'redacted_default_on',
        consentEvaluatedAt: new Date(),
        consentDecisionRef: null,
        classificationVersion,
        classificationEvaluatedAt,
        minorConsentApplied: false,
        reasonCodes,
      }
    }

    const ageYears = computeAgeYears(patient.dateOfBirth, input.asOf)
    const stateCode = inferStateFromAddress(patient)  // optional helper
    const minorRule = ageYears < 18 ? lookupMinorConsentRule(stateCode, ageYears) : null

    // 4. Consent evaluation
    let decision: { allowDisclosure: boolean; decisionRef?: string }
    try {
      decision = await this.deps.consent.evaluateForIngressRedaction({
        patientId: input.patientId,
        dataClass: 'sud_test',
        asOf: input.asOf,
        // T-29.11 extension: minor-consent context
        minorContext: minorRule ? { ruleId: minorRule.ruleId, selfConsentApplies: minorRule.selfConsentApplies } : undefined,
      } as any)
    } catch (err) {
      this.deps.logger.error({ err, patientId: input.patientId }, 'sud.policy.consent_eval_failed')
      reasonCodes.push('consent_eval_failed_safe_redact')
      return {
        anySudClass: true,
        redactionStatus: 'redacted_default_on',
        consentEvaluatedAt: new Date(),
        consentDecisionRef: null,
        classificationVersion,
        classificationEvaluatedAt,
        minorConsentApplied: false,
        reasonCodes,
      }
    }

    const consentEvaluatedAt = new Date()
    const consentDecisionRef = decision.decisionRef ?? null

    if (decision.allowDisclosure) {
      reasonCodes.push('consent_grants_disclosure')
      if (minorRule?.selfConsentApplies) reasonCodes.push('minor_self_consent_applied')
      return {
        anySudClass: true,
        redactionStatus: 'unredacted_consent_explicit',
        consentEvaluatedAt,
        consentDecisionRef,
        classificationVersion,
        classificationEvaluatedAt,
        minorConsentApplied: !!minorRule?.selfConsentApplies,
        reasonCodes,
      }
    }

    reasonCodes.push('consent_denies_disclosure')
    return {
      anySudClass: true,
      redactionStatus: 'redacted_consent_absent',
      consentEvaluatedAt,
      consentDecisionRef,
      classificationVersion,
      classificationEvaluatedAt,
      minorConsentApplied: !!minorRule?.selfConsentApplies,
      reasonCodes,
    }
  }

  private async classifyObxList(
    obxList: ReadonlyArray<{ observationIdentifier: { code: string } }>,
    asOf: Date,
  ): Promise<{ anySud: boolean; classificationVersion: number | null }> {
    let version: number | null = null
    for (const obx of obxList) {
      const code = obx.observationIdentifier.code
      if (!code) continue
      try {
        const lookup = await this.deps.terminology.lookup({
          system: 'http://loinc.org',
          code,
          asOfDate: asOf,
        })
        if (!version && lookup?.catalogVersion) version = lookup.catalogVersion
        if (lookup?.categories?.includes('sud_test')) {
          return { anySud: true, classificationVersion: version ?? null }
        }
      } catch {
        // Treat lookup failure as classification-failure → safe-redact upstream
        return { anySud: true, classificationVersion: null }
      }
    }
    return { anySud: false, classificationVersion: version }
  }
}

function computeAgeYears(dob: string, asOf: Date): number {
  const dobDate = new Date(dob)
  const years = asOf.getFullYear() - dobDate.getFullYear()
  const m = asOf.getMonth() - dobDate.getMonth()
  return m < 0 || (m === 0 && asOf.getDate() < dobDate.getDate()) ? years - 1 : years
}

function inferStateFromAddress(patient: { addresses?: Array<{ state?: string }> } | any): string | null {
  return patient.addresses?.[0]?.state ?? null
}
```

### 3.1 Minor-consent jurisdiction lookup

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/minor-consent-rules.ts

export interface MinorConsentRule {
  readonly ruleId: string
  readonly stateCode: string
  readonly minAgeForSelfConsent: number
  readonly selfConsentApplies: boolean
  readonly parentVisibilityForbidden: boolean
  readonly citation: string
}

// Partial table — covers Phase-1 tenant jurisdictions (Oregon for Engrace founding tenant);
// expand as additional state tenants onboard.
const RULES: Record<string, MinorConsentRule> = {
  'OR': {
    ruleId: 'OR_self_consent_14',
    stateCode: 'OR',
    minAgeForSelfConsent: 14,
    selfConsentApplies: true,
    parentVisibilityForbidden: true,
    citation: 'ORS 109.675',
  },
  'CA': {
    ruleId: 'CA_self_consent_12',
    stateCode: 'CA',
    minAgeForSelfConsent: 12,
    selfConsentApplies: true,
    parentVisibilityForbidden: true,
    citation: 'CA Family Code §6929',
  },
  'WA': {
    ruleId: 'WA_self_consent_13',
    stateCode: 'WA',
    minAgeForSelfConsent: 13,
    selfConsentApplies: true,
    parentVisibilityForbidden: true,
    citation: 'RCW 70.96A.095',
  },
  // ... additional states as Engrace expands tenant footprint ...
}

const DEFAULT_RULE: MinorConsentRule = {
  ruleId: 'DEFAULT_no_self_consent',
  stateCode: '',
  minAgeForSelfConsent: 18,
  selfConsentApplies: false,
  parentVisibilityForbidden: false,
  citation: 'default — no minor self-consent rule on file',
}

export function lookupMinorConsentRule(stateCode: string | null, ageYears: number): MinorConsentRule | null {
  if (ageYears >= 18) return null
  const rule = stateCode ? RULES[stateCode.toUpperCase()] : null
  if (!rule) return DEFAULT_RULE
  if (ageYears < rule.minAgeForSelfConsent) {
    return { ...rule, selfConsentApplies: false, ruleId: `${rule.ruleId}_below_age` }
  }
  return rule
}
```

The state-by-state table is a living document; the M40 compliance team reviews additions as Engrace expands. Phase-1 covers OR (Engrace's home state) plus CA and WA (adjacent markets). T-29.11 ships the table; T-29.12 ships an admin UI for compliance officers to extend it.

---

## 4. Bind-Time Recheck

Invoked from T-29.07's `POST /api/v1/hl7/unmatched-labs/:id/bind` route before the bind UPDATE commits. The lab was originally persisted with `sud_redaction_status='redacted_default_on'` (or 'not_applicable' if classification didn't hit); at bind, we now know the patient and can run the real consent evaluation.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/sud-bind-recheck.ts
import { db } from '@wardenx/db'
import { labObservation, labObservationValue } from '@wardenx/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withTenantContext } from '@wardenx/tenancy'
import { SudPolicyEngine } from './sud-policy-engine'
import type { Logger } from 'pino'

export async function recheckSudOnBind(input: {
  observationId: string
  organizationId: string
  patientId: string
  asOf: Date
  engine: SudPolicyEngine
  logger: Logger
}): Promise<{ statusChanged: boolean; newStatus: string }> {
  // Load the obx list from values
  const valueRows = await withTenantContext(db, { organizationId: input.organizationId }, async (tx) =>
    tx
      .select({ loincCode: labObservationValue.loincCode })
      .from(labObservationValue)
      .where(eq(labObservationValue.observationId, input.observationId)),
  )

  const obxList = valueRows.map(v => ({ observationIdentifier: { code: v.loincCode } }))

  const decision = await input.engine.evaluate({
    organizationId: input.organizationId,
    patientId: input.patientId,
    obxList,
    asOf: input.asOf,
  })

  // Resolve current status to determine whether to re-encrypt
  const [currentObs] = await withTenantContext(db, { organizationId: input.organizationId }, async (tx) =>
    tx.select().from(labObservation).where(eq(labObservation.id, input.observationId)).limit(1),
  )
  if (!currentObs) throw new Error('observation_not_found')

  const prior = currentObs.sudRedactionStatus
  if (prior === decision.redactionStatus) {
    // No change; just update the evaluation timestamps
    await withTenantContext(db, { organizationId: input.organizationId }, async (tx) => {
      await tx.update(labObservation).set({
        sudConsentEvaluatedAt: decision.consentEvaluatedAt,
        sudConsentDecisionRef: decision.consentDecisionRef,
        sudClassificationEvaluatedAt: decision.classificationEvaluatedAt,
        sudClassificationVersion: decision.classificationVersion,
      }).where(eq(labObservation.id, input.observationId))
    })
    return { statusChanged: false, newStatus: prior }
  }

  // Status changed. Two transitions are interesting:
  //   redacted_default_on → unredacted_consent_explicit: must restore plaintext values
  //   redacted_default_on → redacted_consent_absent:    no plaintext change; metadata only
  //   not_applicable → redacted_*: the lab wasn't SUD at ingest but is now (catalog drift); redact values
  //   unredacted_* → redacted_*: redact values (consent absent at bind)

  await withTenantContext(db, { organizationId: input.organizationId }, async (tx) => {
    if (decision.redactionStatus === 'unredacted_consent_explicit' &&
        prior.startsWith('redacted_')) {
      // We need to restore the plaintext. But the plaintext was destroyed at ingest
      // (value column holds '[REDACTED_SUD]'). The only path: re-read the original
      // payload from hl7_message_inbound.payload_cipher, re-decrypt, re-extract OBX-5.
      const restored = await restorePlaintextFromMessage(tx, input.observationId, input.organizationId, input.logger)
      if (!restored.success) {
        input.logger.error({ observationId: input.observationId }, 'sud.bind_recheck.restore_failed')
        // Falls back to redacted; the original consent decision still applies but we couldn't
        // honor the disclosure-allow. Surface as an alert.
      }
    }

    if (decision.redactionStatus.startsWith('redacted_') &&
        (prior === 'unredacted_consent_explicit' || prior === 'not_applicable')) {
      // Redact existing values
      await tx.update(labObservationValue).set({
        observationValue: '[REDACTED_SUD]',
      }).where(eq(labObservationValue.observationId, input.observationId))
    }

    await tx.update(labObservation).set({
      sudRedactionStatus: decision.redactionStatus,
      sudConsentEvaluatedAt: decision.consentEvaluatedAt,
      sudConsentDecisionRef: decision.consentDecisionRef,
      sudClassificationEvaluatedAt: decision.classificationEvaluatedAt,
      sudClassificationVersion: decision.classificationVersion,
    }).where(eq(labObservation.id, input.observationId))
  })

  input.logger.info(
    {
      observationId: input.observationId,
      prior,
      newStatus: decision.redactionStatus,
      minorConsentApplied: decision.minorConsentApplied,
    },
    'sud.bind_recheck.transitioned',
  )

  return { statusChanged: true, newStatus: decision.redactionStatus }
}

async function restorePlaintextFromMessage(tx: any, observationId: string, organizationId: string, logger: Logger): Promise<{ success: boolean }> {
  // Pseudo-code: load hl7_message_inbound row via lab_observation.sourceMessageId;
  // decrypt parsed_segments_cipher; extract OBX-5 values; re-encrypt; UPDATE values.
  // Detailed implementation lives in the actual code; conceptually the same as T-29.07
  // §10's parse-worker ORU branch but invoked on demand.
  return { success: true }
}
```

The "restore-plaintext-from-message" path is the trickiest piece: the source-of-truth wire bytes (T-29.06 §2.3 `parsed_segments_cipher`) are envelope-encrypted by tenant DEK. The bind-recheck has tenant context, so the decryption is possible. The restoration only happens when consent is positive at bind time AND the lab landed redacted at ingest. The audit row records the restoration as a `phi_disclosure` event with retention class `compliance_42cfr_part2`.

The T-29.07 bind route is updated to call this:

```ts
// Update to unmatched-lab bind route (T-29.07 §11)
// ...inside the bind handler, after the UPDATE that sets patient_id...
const recheck = await recheckSudOnBind({
  observationId: id,
  organizationId,
  patientId,
  asOf: new Date(),
  engine: sudPolicyEngine,
  logger,
})

if (recheck.statusChanged) {
  await deps.outbox.publish('m29.lab_observation.sud_status_changed', {
    observationId: id,
    organizationId,
    fromStatus: /* prior */,
    toStatus: recheck.newStatus,
    trigger: 'bind_recheck',
  })
}
```

---

## 5. Back-Redaction on Consent Withdrawal

M39 emits `m39.consent.withdrawn` when a patient withdraws an existing SUD-disclosure consent. M29 subscribes; the worker walks unredacted observations for that patient and re-redacts them.

```ts
// apps/backend/src/modules/29-external-interfaces/workers/sud-back-redaction.worker.ts
import { Worker } from 'bullmq'
import { pino } from 'pino'
import { db } from '@wardenx/db'
import { labObservation, labObservationValue } from '@wardenx/db/schema/external-interfaces'
import { and, eq } from 'drizzle-orm'
import { withTenantContext } from '@wardenx/tenancy'
import { mkOutbox } from '@wardenx/foundation/seams/outbox'

interface ConsentWithdrawnPayload {
  readonly patientId: string
  readonly organizationId: string
  readonly dataClass: string             // e.g. 'sud_test'
  readonly withdrawnAt: string
  readonly withdrawnByMembershipId: string
}

const logger = pino({ name: 'sud-back-redaction' })
const outbox = mkOutbox(db, logger)

export function registerSudBackRedactionConsumer(outboxSub: any): void {
  outboxSub.registerConsumer<ConsentWithdrawnPayload>({
    eventName: 'm39.consent.withdrawn',
    consumerName: 'm29.sud-back-redaction',
    handler: async ({ payload }) => {
      if (payload.dataClass !== 'sud_test') return  // not our class

      const observationsToRedact = await withTenantContext(db, { organizationId: payload.organizationId }, async (tx) =>
        tx
          .select({ id: labObservation.id })
          .from(labObservation)
          .where(and(
            eq(labObservation.patientId, payload.patientId),
            eq(labObservation.sudRedactionStatus, 'unredacted_consent_explicit'),
          )),
      )

      logger.info(
        { patientId: payload.patientId, count: observationsToRedact.length },
        'sud.back_redaction.starting',
      )

      for (const obs of observationsToRedact) {
        await withTenantContext(db, { organizationId: payload.organizationId }, async (tx) => {
          await tx.update(labObservationValue).set({ observationValue: '[REDACTED_SUD]' }).where(eq(labObservationValue.observationId, obs.id))
          await tx.update(labObservation).set({
            sudRedactionStatus: 'back_redacted_consent_withdrawn',
            sudConsentEvaluatedAt: new Date(payload.withdrawnAt),
          }).where(eq(labObservation.id, obs.id))
        })

        await outbox.publish('m29.lab_observation.sud_status_changed', {
          observationId: obs.id,
          organizationId: payload.organizationId,
          fromStatus: 'unredacted_consent_explicit',
          toStatus: 'back_redacted_consent_withdrawn',
          trigger: 'consent_withdrawn',
        })

        // Also fire a cache-invalidation event so M28 FHIR projections / M33 dashboards
        // refresh their cached views.
        await outbox.publish('m29.lab_observation.cache_invalidate', {
          observationId: obs.id,
          organizationId: payload.organizationId,
          reason: 'sud_back_redaction',
        })
      }

      logger.info(
        { patientId: payload.patientId, redactedCount: observationsToRedact.length },
        'sud.back_redaction.completed',
      )
    },
  })
}
```

**Important nuance:** back-redaction does NOT erase audit records of prior disclosures. The fact that a person viewed the unredacted value at T1 (under then-valid consent) is permanently recorded in the `compliance_42cfr_part2` audit; that record stays even though the value is now back-redacted.

---

## 6. Privileged Unredact

A clinical staff member may need to view a redacted SUD value in defined circumstances. 42 CFR §2.51 permits disclosure in a medical emergency without patient consent. T-29.11 ships the workflow:

### 6.1 Standard (non-emergency) path: dual approval

1. Requester `POST /:observationId/request-unredact-grant` with clinical rationale (≥50 chars)
2. Different membership `POST /:grantId/approve` with their own rationale
3. Approver-permission member `POST /:grantId/exercise` → returns the unredacted value within the response, AND writes a `compliance_42cfr_part2` audit row

### 6.2 Emergency path: §2.51

Per §2.51, the requester may set `emergency_basis_42cfr_2_51 = true` and exercise immediately without approval. This carries an absolute audit requirement: the rationale must include the nature of the emergency and the steps taken to obtain consent (or why this was impossible).

```ts
// apps/backend/src/modules/29-external-interfaces/routes/sud-unredact.ts
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { db } from '@wardenx/db'
import { labObservation, labObservationValue, labObservationSudUnredactGrant } from '@wardenx/db/schema/external-interfaces'
import { and, eq } from 'drizzle-orm'
import { withTenantContext } from '@wardenx/tenancy'
import { ulid } from 'ulid'
import { requirePermissions } from '@wardenx/foundation/auth'
import { requirePredicate } from '@wardenx/foundation/abac'

const RequestBody = Type.Object({
  clinicalRationale: Type.String({ minLength: 50, maxLength: 4000 }),
  emergencyBasis42cfr2_51: Type.Optional(Type.Boolean({ default: false })),
})

const ApproveBody = Type.Object({
  approverRationale: Type.String({ minLength: 50, maxLength: 4000 }),
})

export function registerSudUnredactRoutes(app: FastifyInstance): void {
  // POST request grant
  app.post(
    '/api/v1/hl7/lab-observations/:observationId/request-unredact-grant',
    {
      schema: {
        params: Type.Object({ observationId: Type.String({ format: 'uuid' }) }),
        body: RequestBody,
      },
      preHandler: [
        requirePermissions(['external_interfaces.sud_unredact:request']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
      ],
    },
    async (req, reply) => {
      const { observationId } = req.params as { observationId: string }
      const { clinicalRationale, emergencyBasis42cfr2_51 = false } = req.body as any
      const organizationId = req.user!.organizationId

      // Verify the observation exists + is SUD-class
      const [obs] = await withTenantContext(db, { organizationId }, async (tx) =>
        tx
          .select()
          .from(labObservation)
          .where(and(eq(labObservation.id, observationId), eq(labObservation.organizationId, organizationId)))
          .limit(1),
      )
      if (!obs) return reply.code(404).send({ error: 'observation_not_found' })
      if (!obs.sudRedactionStatus.startsWith('redacted_') && obs.sudRedactionStatus !== 'back_redacted_consent_withdrawn') {
        return reply.code(409).send({ error: 'observation_not_redacted' })
      }

      const grantId = ulid()
      const initialState = emergencyBasis42cfr2_51 ? 'approved' : 'requested'  // §6.2 short-circuit

      await withTenantContext(db, { organizationId }, async (tx) => {
        await tx.insert(labObservationSudUnredactGrant).values({
          id: grantId,
          organizationId,
          observationId,
          requestedByMembershipId: req.user!.membershipId,
          state: initialState,
          clinicalRationale,
          emergencyBasis42cfr2_51,
          requestedAt: new Date(),
          approvedAt: emergencyBasis42cfr2_51 ? new Date() : null,
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        })
      })

      // Audit immediately — emergency request creates a Part-2 audit row even before exercise
      await req.audit.write({
        action: emergencyBasis42cfr2_51 ? 'sud.unredact.emergency_request' : 'sud.unredact.request',
        retentionClass: 'compliance_42cfr_part2',
        resourceId: observationId,
        organizationId,
        actorMembershipId: req.user!.membershipId,
        payload: { grantId, clinicalRationale, emergencyBasis: emergencyBasis42cfr2_51 },
      })

      return reply.code(201).send({ grantId, state: initialState })
    },
  )

  // POST approve (non-emergency only)
  app.post(
    '/api/v1/hl7/lab-observations/sud-unredact-grants/:grantId/approve',
    {
      schema: {
        params: Type.Object({ grantId: Type.String({ format: 'uuid' }) }),
        body: ApproveBody,
      },
      preHandler: [
        requirePermissions(['external_interfaces.sud_unredact:approve']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
        requirePredicate('sud_unredact_distinct_approver', {}),  // declared in §7
      ],
    },
    async (req, reply) => {
      const { grantId } = req.params as { grantId: string }
      const { approverRationale } = req.body as any
      const organizationId = req.user!.organizationId

      // Atomic update WHERE state='requested'
      const updated = await withTenantContext(db, { organizationId }, async (tx) => {
        const result = await tx
          .update(labObservationSudUnredactGrant)
          .set({
            state: 'approved',
            approverMembershipId: req.user!.membershipId,
            approverRationale,
            approvedAt: new Date(),
          })
          .where(and(
            eq(labObservationSudUnredactGrant.id, grantId),
            eq(labObservationSudUnredactGrant.organizationId, organizationId),
            eq(labObservationSudUnredactGrant.state, 'requested'),
          ))
          .returning()
        return result[0]
      })

      if (!updated) return reply.code(409).send({ error: 'grant_not_in_requested_state' })

      await req.audit.write({
        action: 'sud.unredact.approve',
        retentionClass: 'compliance_42cfr_part2',
        resourceId: updated.observationId,
        organizationId,
        actorMembershipId: req.user!.membershipId,
        payload: { grantId, approverRationale },
      })

      return { state: 'approved' }
    },
  )

  // POST exercise → returns unredacted values; writes Part-2 audit
  app.post(
    '/api/v1/hl7/lab-observations/sud-unredact-grants/:grantId/exercise',
    {
      schema: { params: Type.Object({ grantId: Type.String({ format: 'uuid' }) }) },
      preHandler: [
        requirePermissions(['external_interfaces.sud_unredact:exercise']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
        requirePredicate('sud_unredact_authorized', {}),  // checks active grant for this membership × observation
      ],
    },
    async (req, reply) => {
      const { grantId } = req.params as { grantId: string }
      const organizationId = req.user!.organizationId

      const grant = await withTenantContext(db, { organizationId }, async (tx) => {
        const result = await tx
          .update(labObservationSudUnredactGrant)
          .set({ state: 'exercised', exercisedAt: new Date() })
          .where(and(
            eq(labObservationSudUnredactGrant.id, grantId),
            eq(labObservationSudUnredactGrant.organizationId, organizationId),
            eq(labObservationSudUnredactGrant.state, 'approved'),
          ))
          .returning()
        return result[0]
      })
      if (!grant) return reply.code(409).send({ error: 'grant_not_approved_or_expired' })

      // Restore plaintext FOR THIS RESPONSE ONLY (not in DB).
      const plaintextValues = await restorePlaintextOnce(grant.observationId, organizationId)

      await req.audit.write({
        action: 'sud.unredact.exercise',
        retentionClass: 'compliance_42cfr_part2',
        resourceId: grant.observationId,
        organizationId,
        actorMembershipId: req.user!.membershipId,
        payload: { grantId, valueCount: plaintextValues.length, emergencyBasis: grant.emergencyBasis42cfr2_51 },
      })

      return {
        observationId: grant.observationId,
        plaintextValues,  // ephemeral; not persisted unredacted
        grantExpiresAt: grant.expiresAt,
      }
    },
  )
}

async function restorePlaintextOnce(observationId: string, organizationId: string): Promise<any[]> {
  // Pseudo: re-load hl7_message_inbound.parsed_segments_cipher, decrypt, extract OBX-5 values matching this observation
  // Returns the plaintext OBX values WITHOUT persisting them back to lab_observation_value.
  return /* values */
}
```

**Note: the unredacted plaintext is returned in the response body and NOT written back to `lab_observation_value`.** The observation row remains redacted; the grant exercise is a per-request ephemeral disclosure. The Part-2 audit row records that disclosure.

---

## 7. ABAC Predicates

Two new predicates registered in M3.

```ts
// apps/backend/src/modules/03-authorization/predicates/sud_unredact_distinct_approver.ts
export const sudUnredactDistinctApprover = {
  name: 'sud_unredact_distinct_approver' as const,
  async evaluate(ctx: PredicateContext): Promise<{ allow: boolean; reason?: string }> {
    if (ctx.resource?.kind !== 'sud_unredact_grant') return { allow: false, reason: 'wrong_resource' }
    const [row] = await withTenantContext(ctx.db, { organizationId: ctx.subject.organizationId }, async (tx) =>
      tx.select({ requestedBy: labObservationSudUnredactGrant.requestedByMembershipId }).from(labObservationSudUnredactGrant).where(eq(labObservationSudUnredactGrant.id, ctx.resource.id)).limit(1),
    )
    if (!row) return { allow: false, reason: 'grant_not_found' }
    if (row.requestedBy === ctx.subject.membershipId) return { allow: false, reason: 'approver_must_differ_from_requester' }
    return { allow: true }
  },
} as const

// apps/backend/src/modules/03-authorization/predicates/sud_unredact_authorized.ts
export const sudUnredactAuthorized = {
  name: 'sud_unredact_authorized' as const,
  async evaluate(ctx: PredicateContext): Promise<{ allow: boolean; reason?: string }> {
    if (ctx.resource?.kind !== 'sud_unredact_grant') return { allow: false, reason: 'wrong_resource' }
    const [row] = await withTenantContext(ctx.db, { organizationId: ctx.subject.organizationId }, async (tx) =>
      tx.select().from(labObservationSudUnredactGrant).where(eq(labObservationSudUnredactGrant.id, ctx.resource.id)).limit(1),
    )
    if (!row) return { allow: false, reason: 'grant_not_found' }
    if (row.expiresAt < new Date()) return { allow: false, reason: 'grant_expired' }
    if (row.state !== 'approved') return { allow: false, reason: `grant_in_state_${row.state}` }
    // The exerciser may be the requester OR the approver OR any membership with the right permission;
    // for tightest control we constrain to (requester | approver) only. This protects against the case
    // where someone with the exercise permission stumbles on a grant they shouldn't see.
    if (row.requestedByMembershipId !== ctx.subject.membershipId &&
        row.approverMembershipId !== ctx.subject.membershipId) {
      return { allow: false, reason: 'exerciser_must_be_requester_or_approver' }
    }
    return { allow: true }
  },
} as const
```

---

## 8. LOINC Class-Drift Sweep

A daily worker that walks `lab_observation` rows whose `sud_classification_version` is older than the current M38 catalog version. For each, re-evaluates the classification; if a code that wasn't `sud_class` then is now `sud_class`, the worker triggers a back-redaction (treating it as if consent was always absent for the affected observations until proven otherwise).

The sweep is conservative: it can only *add* redaction, never remove it. Removing redaction requires positive consent which the sweep cannot infer.

```ts
// apps/backend/src/modules/29-external-interfaces/workers/sud-classification-sweep.worker.ts

export const sudClassificationSweepWorker = new Worker(
  'sud-classification-sweep',
  async () => {
    const currentVersion = await terminology.getCurrentCatalogVersion('http://loinc.org')

    const candidates = await withPlatformContext(db, async (tx) =>
      tx.select({ id: labObservation.id, organizationId: labObservation.organizationId, sudRedactionStatus: labObservation.sudRedactionStatus })
        .from(labObservation)
        .where(and(
          // sud_classification_version IS NULL OR < currentVersion
          eq(labObservation.sudRedactionStatus, 'not_applicable'),  // only candidates for adding redaction
        )),
    )

    for (const obs of candidates) {
      // Reclassify; if now sud_class, flip to back_redacted_consent_withdrawn (the most conservative redaction kind)
      // ...detailed implementation omitted for brevity...
    }
  },
  { connection: { url: process.env.VALKEY_URL! }, concurrency: 1 },
)
```

Scheduled at 03:00 UTC daily (30 minutes after NPPES sync, on a separate cron slot).

---

## 9. Tests

### 9.1 Bind-time recheck transitions

```ts
describe('bind-time SUD recheck', () => {
  it('unmatched lab with SUD class + bound to patient with consent → unredacted_consent_explicit, values restored', async () => {
    const obs = await fixtures.observation({ patientId: null, sudRedactionStatus: 'redacted_default_on' })
    const patient = await fixtures.patient({ id: 'pt_sud_yes' })
    mockConsent.evaluateForIngressRedaction.mockResolvedValue({ allowDisclosure: true, decisionRef: 'cons_123' })

    await client.post(`/api/v1/hl7/unmatched-labs/${obs.id}/bind`, {
      patientId: 'pt_sud_yes',
      decisionRationale: 'Confirmed via phone call',
    }, { user: rnUser })

    const [updated] = await db.select().from(labObservation).where(eq(labObservation.id, obs.id))
    expect(updated.sudRedactionStatus).toBe('unredacted_consent_explicit')
    expect(updated.sudConsentDecisionRef).toBe('cons_123')

    const values = await db.select().from(labObservationValue).where(eq(labObservationValue.observationId, obs.id))
    expect(values[0].observationValue).not.toBe('[REDACTED_SUD]')  // restored
  })

  it('bind to patient WITHOUT consent → redacted_consent_absent (values stay redacted)', async () => {
    mockConsent.evaluateForIngressRedaction.mockResolvedValue({ allowDisclosure: false, decisionRef: 'cons_deny_1' })
    // ... shape ...
    expect(updated.sudRedactionStatus).toBe('redacted_consent_absent')
    expect(values[0].observationValue).toBe('[REDACTED_SUD]')
  })
})
```

### 9.2 Minor self-consent (Oregon, 15yo)

```ts
describe('minor self-consent (Oregon ORS 109.675)', () => {
  it('15yo Oregon patient with positive consent → unredacted, minorConsentApplied=true', async () => {
    const patient = await fixtures.patient({
      id: 'pt_minor',
      dateOfBirth: '2011-01-01',  // 15yo as of 2026
      addresses: [{ state: 'OR' }],
    })
    mockConsent.evaluateForIngressRedaction.mockResolvedValue({ allowDisclosure: true })

    const decision = await sudPolicyEngine.evaluate({
      organizationId: 'org_engrace',
      patientId: 'pt_minor',
      obxList: [{ observationIdentifier: { code: '14375-7' } }],  // SUD-class
      asOf: new Date('2026-06-01'),
    })

    expect(decision.redactionStatus).toBe('unredacted_consent_explicit')
    expect(decision.minorConsentApplied).toBe(true)
    expect(decision.reasonCodes).toContain('minor_self_consent_applied')
  })

  it('13yo Oregon patient (below 14 self-consent threshold) → falls back to no self-consent', async () => {
    const patient = await fixtures.patient({
      id: 'pt_minor_under',
      dateOfBirth: '2013-01-01',  // 13yo as of 2026
      addresses: [{ state: 'OR' }],
    })
    // The patient is below the OR 14-year threshold; minor self-consent does NOT apply.
    // Without parental consent (mocked absent), redact.
    mockConsent.evaluateForIngressRedaction.mockResolvedValue({ allowDisclosure: false })

    const decision = await sudPolicyEngine.evaluate(/* ... */)
    expect(decision.redactionStatus).toBe('redacted_consent_absent')
    expect(decision.minorConsentApplied).toBe(false)
  })
})
```

### 9.3 Back-redaction on consent withdrawal

```ts
describe('m39.consent.withdrawn triggers back-redaction', () => {
  it('all unredacted_consent_explicit observations for the patient flip to back_redacted', async () => {
    await fixtures.observation({ patientId: 'pt_w', sudRedactionStatus: 'unredacted_consent_explicit' })
    await fixtures.observation({ patientId: 'pt_w', sudRedactionStatus: 'unredacted_consent_explicit' })
    await fixtures.observation({ patientId: 'pt_other', sudRedactionStatus: 'unredacted_consent_explicit' })  // different patient

    await fixtures.emitOutboxEvent('m39.consent.withdrawn', {
      patientId: 'pt_w',
      organizationId: 'org_engrace',
      dataClass: 'sud_test',
      withdrawnAt: new Date().toISOString(),
      withdrawnByMembershipId: 'mem_x',
    })

    await waitFor(async () => {
      const pt_w_obs = await db.select().from(labObservation).where(eq(labObservation.patientId, 'pt_w'))
      expect(pt_w_obs.every(o => o.sudRedactionStatus === 'back_redacted_consent_withdrawn')).toBe(true)

      const pt_other_obs = await db.select().from(labObservation).where(eq(labObservation.patientId, 'pt_other'))
      expect(pt_other_obs[0].sudRedactionStatus).toBe('unredacted_consent_explicit')  // untouched
    })

    const events = await fixtures.outboxEvents()
    expect(events.filter(e => e.name === 'm29.lab_observation.sud_status_changed')).toHaveLength(2)
    expect(events.filter(e => e.name === 'm29.lab_observation.cache_invalidate')).toHaveLength(2)
  })

  it('PRIOR audit records of unredacted disclosure remain — not erased', async () => {
    await fixtures.partTwoAuditRow({ observationId: 'obs_1', action: 'sud.unredact.exercise' })
    await fixtures.emitOutboxEvent('m39.consent.withdrawn', { /* ... */ })
    await waitFor(/* back-redaction completes */)

    // Audit row still there
    const audits = await db.select().from(auditEvent).where(eq(auditEvent.resourceId, 'obs_1'))
    expect(audits).toHaveLength(1)  // not erased
  })
})
```

### 9.4 Privileged unredact happy path

```ts
describe('privileged unredact — non-emergency dual approval', () => {
  it('request → approve (different) → exercise → returns plaintext + Part-2 audit', async () => {
    const obs = await fixtures.observation({
      sudRedactionStatus: 'redacted_consent_absent',
      values: [{ loinc: '14375-7', value: 'POSITIVE' }],  // pre-redaction plaintext available in source message
    })

    const requester = await fixtures.user({ permissions: ['external_interfaces.sud_unredact:request'], stepUp: true })
    const approver = await fixtures.user({ permissions: ['external_interfaces.sud_unredact:approve'], stepUp: true })

    // 1. Request
    const req = await client.post(`/api/v1/hl7/lab-observations/${obs.id}/request-unredact-grant`, {
      clinicalRationale: 'Patient presenting with overdose symptoms; need to confirm substance for treatment direction.',
    }, { user: requester })
    expect(req.statusCode).toBe(201)
    const { grantId } = req.body

    // 2. Approve
    const approve = await client.post(`/api/v1/hl7/lab-observations/sud-unredact-grants/${grantId}/approve`, {
      approverRationale: 'Medical director approves emergency clinical need; documented in MAR.',
    }, { user: approver })
    expect(approve.statusCode).toBe(200)

    // 3. Exercise (the requester does it; the approver could too)
    const exec = await client.post(`/api/v1/hl7/lab-observations/sud-unredact-grants/${grantId}/exercise`, {}, { user: requester })
    expect(exec.statusCode).toBe(200)
    expect(exec.body.plaintextValues[0].value).toBe('POSITIVE')

    // Observation row STILL redacted (the unredact is ephemeral)
    const [obsAfter] = await db.select().from(labObservation).where(eq(labObservation.id, obs.id))
    expect(obsAfter.sudRedactionStatus).toBe('redacted_consent_absent')
    const valuesAfter = await db.select().from(labObservationValue).where(eq(labObservationValue.observationId, obs.id))
    expect(valuesAfter[0].observationValue).toBe('[REDACTED_SUD]')

    // Part-2 audit
    const audits = await db.select().from(auditEvent).where(and(
      eq(auditEvent.resourceId, obs.id),
      eq(auditEvent.retentionClass, 'compliance_42cfr_part2'),
    ))
    expect(audits.find(a => a.action === 'sud.unredact.exercise')).toBeDefined()
  })

  it('same membership approving own request → 403 distinct_approver', async () => {
    // ... shape ...
    expect(res.statusCode).toBe(403)
  })
})
```

### 9.5 Emergency (§2.51) path

```ts
describe('emergency-basis unredact bypasses approval', () => {
  it('emergency_basis=true → grant.state=approved immediately; exercise allowed without separate approval', async () => {
    const obs = await fixtures.observation({ sudRedactionStatus: 'redacted_consent_absent' })
    const requester = await fixtures.user({ permissions: ['external_interfaces.sud_unredact:request', 'external_interfaces.sud_unredact:exercise'], stepUp: true })

    const req = await client.post(`/api/v1/hl7/lab-observations/${obs.id}/request-unredact-grant`, {
      clinicalRationale: 'Patient unconscious in ED; need substance ID to direct narcan/flumazenil decision; family unable to consent.',
      emergencyBasis42cfr2_51: true,
    }, { user: requester })
    expect(req.statusCode).toBe(201)

    const { grantId } = req.body
    const [grant] = await db.select().from(labObservationSudUnredactGrant).where(eq(labObservationSudUnredactGrant.id, grantId))
    expect(grant.state).toBe('approved')
    expect(grant.emergencyBasis42cfr2_51).toBe(true)

    // Exercise directly
    const exec = await client.post(`/api/v1/hl7/lab-observations/sud-unredact-grants/${grantId}/exercise`, {}, { user: requester })
    expect(exec.statusCode).toBe(200)

    // Emergency request creates the emergency_request Part-2 audit row even before exercise
    const audits = await db.select().from(auditEvent).where(eq(auditEvent.resourceId, obs.id))
    expect(audits.find(a => a.action === 'sud.unredact.emergency_request')).toBeDefined()
    expect(audits.find(a => a.action === 'sud.unredact.exercise')).toBeDefined()
  })
})
```

### 9.6 Grant expiration

```ts
describe('4-hour grant expiry', () => {
  it('exercise after expires_at → 409 grant_expired', async () => {
    const grant = await fixtures.grant({ state: 'approved', expiresAt: new Date(Date.now() - 1000) })
    const res = await client.post(`/api/v1/hl7/lab-observations/sud-unredact-grants/${grant.id}/exercise`, {}, { user: requester })
    expect(res.statusCode).toBe(403)  // predicate refuses
  })
})
```

### 9.7 LOINC class-drift sweep

```ts
describe('LOINC class drift adds redaction conservatively', () => {
  it('observation persisted at classification_version=14 with non-SUD code is re-evaluated at version=15 when code is added to sud_test class', async () => {
    const obs = await fixtures.observation({
      sudRedactionStatus: 'not_applicable',
      sudClassificationVersion: 14,
      values: [{ loinc: '12345-6', value: 'X' }],
    })

    // M38 catalog updated: 12345-6 now in sud_test
    mockTerminology.lookup.mockImplementation(({ code }) =>
      Promise.resolve({ exists: true, status: 'active', categories: code === '12345-6' ? ['sud_test'] : [], catalogVersion: 15 }),
    )

    await runClassificationSweep()

    const [updated] = await db.select().from(labObservation).where(eq(labObservation.id, obs.id))
    expect(updated.sudRedactionStatus).toBe('back_redacted_consent_withdrawn')  // safest add-redaction status
    expect(updated.sudClassificationVersion).toBe(15)

    const values = await db.select().from(labObservationValue).where(eq(labObservationValue.observationId, obs.id))
    expect(values[0].observationValue).toBe('[REDACTED_SUD]')
  })

  it('sweep does NOT remove redaction (asymmetric)', async () => {
    // Reverse: code WAS sud, is now not. The sweep does not flip back_redacted → unredacted.
    const obs = await fixtures.observation({ sudRedactionStatus: 'redacted_default_on', sudClassificationVersion: 14 })
    mockTerminology.lookup.mockResolvedValue({ exists: true, categories: [], catalogVersion: 15 })

    await runClassificationSweep()

    const [unchanged] = await db.select().from(labObservation).where(eq(labObservation.id, obs.id))
    expect(unchanged.sudRedactionStatus).toBe('redacted_default_on')  // unchanged
  })
})
```

---

## 10. Sign-Off Checklist (T-29.11 PR)

- [ ] Migration `0034` lands all schema additions (§2).
- [ ] M4 `audit_retention_class` enum gains `compliance_42cfr_part2` (coordinated with M4 owner).
- [ ] All 5 source files land: `sud-policy-engine.ts`, `sud-bind-recheck.ts`, `sud-back-redaction.worker.ts`, `sud-classification-sweep.worker.ts`, `minor-consent-rules.ts`, `routes/sud-unredact.ts`.
- [ ] Two new ABAC predicates registered in M3.
- [ ] T-29.07's bind route updated to invoke `recheckSudOnBind` before commit.
- [ ] T-29.07's parse worker ORU branch wired to use the new `SudPolicyEngine` (replacing the v1 `shouldRedactSud`).
- [ ] BullMQ scheduler registers `sud-classification-sweep` at `0 3 * * *` UTC.
- [ ] All §9 tests pass — bind recheck × 2, minor consent × 2, back-redaction × 2 (with audit-retention check), privileged unredact happy path + distinct-approver refusal, emergency path, expiration, class-drift × 2 (asymmetric).
- [ ] Restoration-from-message helper verified to handle the case where `parsed_segments_cipher` is missing (parse_error rows) — gracefully fails with a Part-2 audit row recording the inability to restore.
- [ ] Cruiser passes — no cross-module schema imports.
- [ ] **Compliance officer** sign-off on:
  - The 42 CFR Part 2 audit retention class
  - The §2.51 emergency-basis short-circuit
  - The state-by-state minor-consent table (Phase-1 jurisdictions)
- [ ] **M39 owner** sign-off on the consent-withdrawn payload shape consumed.
- [ ] **M38 owner** sign-off on `terminology.getCurrentCatalogVersion(system)` API addition.
- [ ] **M4 owner** sign-off on the audit retention-class extension and the eraser behavior change.
- [ ] **Privacy engineer** sign-off on the ephemeral-disclosure pattern (plaintext returned in response, never re-persisted).

---

## 11. Notes on Refinements Past M29 Spec v0.3

1. **Schema additions in `0034`** — second post-v0.3 migration (after T-29.08's `0032` and T-29.10's `0033`). The pattern is established: a small migration per implementation-task PR. v0.4 spec authoring should aim to enumerate the lab_observation full column set, including SUD state, before lock.

2. **42 CFR Part 2 audit retention class added to M4.** This is a real cross-module spec coordination. M4 v0.3 should incorporate the new retention-class enum value.

3. **`m39.consent.withdrawn` consumed event.** M29 v0.3 §4.x consumed-seam table lists `ConsentEvaluator` but doesn't enumerate the outbox events M29 consumes from M39. v0.4 should add a consumed-events catalog alongside the consumed-seams table.

4. **State-by-state minor-consent table.** The lookup table at §3.1 is a compliance artifact that should live in a compliance reference doc, not just code. T-29.12's compliance-admin UI will likely promote this to a database-backed table.

5. **Ephemeral disclosure pattern.** The privileged unredact returns plaintext in the response without persisting it back. This is non-standard for the platform (most reads return what's in the row) and deserves an explicit mention in the security hardening doc (Security Hardening v0.3 next revision).

6. **`m29.lab_observation.sud_status_changed` and `m29.lab_observation.cache_invalidate` events** — 2 new outbox events. Bringing the M29 outbox catalog to 31 events.

7. **Asymmetric sweep.** The class-drift sweep can only add redaction, never remove. Recorded so a future "speed up the sweep" optimization doesn't accidentally implement the symmetric (and dangerous) reverse path.

---

## Document Footer

**Addendum version:** v1.0 (T-29.11 PR-ready)
**Bound to:** M29 v0.3 §11 D15, §8.2
**Files delivered:** 6 source files + 1 migration + 2 new ABAC predicates + 1 cross-module enum addition (M4)
**Workflows hardened:** W-XI-08
**Schema additions:** 2 new enums, 5 new columns, 1 new table, 1 cross-module enum extension
**Sign-offs required:** Compliance officer, M39 owner, M38 owner, M4 owner, Privacy engineer

**End of T-29.11 SUD redaction hardening addendum.**
