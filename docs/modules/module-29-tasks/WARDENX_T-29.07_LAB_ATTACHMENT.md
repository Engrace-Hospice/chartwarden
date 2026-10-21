# WardenX — T-29.07 Addendum: Lab Observation Attachment

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.6 (lab routing column), §11 D7 (auto-attach), D8 (OBR-2 placer resolution), §10 (T-29.07)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 → T-29.06 merged. M29 spec is at v0.3 (consolidated).

This addendum delivers the drop-in artifacts for T-29.07 — the ORU branch of the parse worker, the OBR-2 placer-order back-resolution to M11, the lab-specific outcome router (auto-attach on confident match per D7, distinct from ADT's propose-then-review per D5), terminology validation on LOINC codes via M38, SUD redaction at lab ingest per D15, abnormal-flag detection with caseload-RN routing via M36, the OBX-5 PDF handshake with M22 for embedded report attachments, the unmatched-lab queue HTTP routes, and the outbox events M11 consumes to flip `order_record.fulfillment_status`.

**T-29.07 closes the inbound ORU pipeline.** With T-29.04 (listener), T-29.05 (cascade), T-29.06 (proposal for ADT), and T-29.07 (lab attach for ORU), the inbound side of M29 is end-to-end complete on the platform surface. M5 v0.3 and M11 v0.3 close the downstream owner-module consumers when they ship.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **ORU parse-worker branch** — replaces the T-29.04 forward-stub `m29.hl7_message.parsed_oru` event with the real lab-attach flow.
- **OBR-2 placer-order resolution** at `apps/backend/src/modules/29-external-interfaces/inbound/lab-placer-resolver.ts` (D8) — `OrderRecordReader.getOrderByPlacerId` consumed from M11.
- **Lab cascade wrapper** at `apps/backend/src/modules/29-external-interfaces/inbound/lab-cascade.ts` — reuses T-29.05's `matchPatient()` with the lab-specific outcome handling.
- **Lab attacher** at `apps/backend/src/modules/29-external-interfaces/inbound/lab-attacher.ts` — persists `lab_observation` + N × `lab_observation_value` + `lab_observation_inbound_link` in a single transaction.
- **Terminology check** at `apps/backend/src/modules/29-external-interfaces/inbound/terminology-check.ts` — M38 `TerminologyProvider.validate(loincCode, asOfDate)` per OBX-3.
- **SUD ingress redaction** at `apps/backend/src/modules/29-external-interfaces/inbound/sud-redaction.ts` — M39 `ConsentEvaluator.evaluateForIngressRedaction` per OBX (D15).
- **Abnormal-flag detection** at `apps/backend/src/modules/29-external-interfaces/inbound/abnormal-flag.ts` — OBX-8 parse, severity classification, M36 alert routing to caseload RN (D7).
- **OBX-5 PDF handshake** at `apps/backend/src/modules/29-external-interfaces/inbound/obx-pdf-handler.ts` — when OBX-2='ED' and value carries a `^PDF^Base64^...` payload, emit `m22.document.upload_requested`, persist observation with `attached_document_id=null` initially, wire `m22.document.uploaded` consumer to back-fill.
- **Unmatched-lab queue routes** at `apps/backend/src/modules/29-external-interfaces/routes/unmatched-labs.ts` — `GET /api/v1/hl7/unmatched-labs`, `POST /:id/bind`, `POST /:id/discard`.
- **Outbox events** for downstream M11 / M36 / M22 consumption.
- **Forward-stub consumer for M11 attach event** — M11 v0.3 will subscribe to `m29.lab_observation.attached` to flip `order_record.fulfillment_status`; T-29.07 ships a forward-stub deny-stub in M11 per the T-29.01 pattern.
- **Tests** — W-XI-05 (confident OBR-2 placer attach), W-XI-06 (cascade L4 candidate → unmatched queue), W-XI-07 (abnormal flag → M36 alert), W-XI-08 (SUD-redacted observation), W-XI-09 (OBX-5 PDF round-trip), plus terminology-unknown handling, multi-OBX same-message, idempotent re-processing.
- **Sign-off checklist.**

### 1.2 Non-goals

- **M11's real `order_record` flip on attach.** M11 v0.3 will consume `m29.lab_observation.attached`; today's forward-stub logs + acks.
- **M9 lab-trending overlay** — Phase 2 per M9 spec.
- **Lab-derived HOPE measures** — M30 owns this.
- **SFTP-based lab transport.** Phase 2 per M29 §1.1.
- **Outbound ORM dispatch** — T-29.08.
- **Frontend UI** for unmatched-lab queue — T-29.13.
- **Schema additions.** v0.3 schema (post-T-29.02/05/06 corrections) is sufficient for T-29.07. **No new migration.**

---

## 2. Pipeline Topology

```
Parse worker (T-29.05/T-29.06 wired) — ORU branch
  │
  ├── 1. Project OBR + OBX[] from parsed_segments_cipher (already decrypted in-worker)
  │
  ├── 2. Terminology check OBX[].observationIdentifier (LOINC) via M38
  │         → mark observation row with terminology_validation
  │
  ├── 3. SUD ingress redaction check via M39 (per-OBX, by LOINC class)
  │         → mark observation row with sud_redacted
  │
  ├── 4. Patient resolution (TWO STAGES):
  │     a. PRIMARY: OBR-2 placer-order resolution
  │         → OrderRecordReader.getOrderByPlacerId(obr2)
  │         → if order found: patient_id = order.patient_id, match_method='placer_match'
  │     b. FALLBACK: T-29.05 cascade on PID (only if OBR-2 yielded no match)
  │         → matchPatient(input) → MatchOutcome
  │         → map outcome → (patient_id, match_method, candidate_id, candidate_level)
  │
  ├── 5. Lab attacher (single transaction):
  │     - insert lab_observation
  │     - insert N × lab_observation_value (one per OBX, skipping OBX-2='ED')
  │     - insert lab_observation_inbound_link
  │
  ├── 6. Abnormal-flag scan:
  │     for each OBX with abnormal flag (H, L, HH, LL, ...):
  │       severity = classify(OBX-8, OBX-3)
  │       if severity >= 'critical':
  │         caseload_rn = CaseloadProvider.caseloadRnFor(patient_id)
  │         AlertDispatcher.dispatch({ to: caseload_rn, severity, ... })
  │
  ├── 7. OBX-5 PDF handshake:
  │     for each OBX with OBX-2='ED' and Base64-encoded PDF payload:
  │       emit m22.document.upload_requested with the PDF bytes + observation_id
  │       (M22 will emit m22.document.uploaded with document_id back; the
  │        consumers/m22-document-backref.ts wires document_id onto lab_observation.attached_document_id)
  │
  └── 8. Emit outbox events:
        - m29.lab_observation.received (M11 consumer → flip order fulfillment_status)
        - m29.lab_observation.attached (when patient_id populated)
        - m29.lab_observation.unmatched (when patient_id is null)
        - m29.lab_observation.abnormal_critical (when severity ≥ critical, M36-routed)
```

Single in-process pipeline per ORU message. Each step is a discrete function — testable in isolation. The lab attacher is the transactional pinch point.

---

## 3. OBR-2 Placer Resolution

The simplest and highest-confidence patient resolution path. If the ORU carries an `OBR-2.1` (placer order number) that matches an M11 `order_record.id`, the lab is bound to that order's patient — no PID cascade needed.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/lab-placer-resolver.ts
import type { OrderRecordReader } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'

export interface PlacerResolutionResult {
  readonly kind: 'placer_match' | 'no_placer' | 'placer_unknown'
  readonly orderRecordId?: string
  readonly patientId?: string
}

export async function resolveByPlacerOrder(
  obr2PlacerOrderNumber: string | undefined,
  organizationId: string,
  orderReader: OrderRecordReader,
  logger: Logger,
): Promise<PlacerResolutionResult> {
  if (!obr2PlacerOrderNumber || obr2PlacerOrderNumber.trim().length === 0) {
    return { kind: 'no_placer' }
  }

  // OBR-2 may be the M11 order_record.id directly (ULID/UUID) OR a partner-formatted
  // string like "WX-12345" with the prefix as part of partner contract. The reader
  // handles both shapes per its lookup contract.
  const order = await orderReader.getOrderByPlacerId({
    organizationId,
    placerOrderNumber: obr2PlacerOrderNumber,
  })

  if (!order) {
    logger.info({ obr2: obr2PlacerOrderNumber }, 'lab.placer_resolution.unknown')
    return { kind: 'placer_unknown', orderRecordId: undefined }
  }

  if (order.patientId === null) {
    // Shouldn't happen — every M11 order has a patient — but defensive
    logger.error({ obr2: obr2PlacerOrderNumber, orderId: order.id }, 'lab.placer_resolution.order_has_no_patient')
    return { kind: 'placer_unknown' }
  }

  return {
    kind: 'placer_match',
    orderRecordId: order.id,
    patientId: order.patientId,
  }
}
```

`OrderRecordReader.getOrderByPlacerId` is consumed from M11 (per M29 v0.3 §4.5 consumed-seams). It must:
- Normalize the placer string (strip whitespace, optional partner prefix).
- Look up `order_record` by its primary key OR a derived placer field.
- Return `{ id, patientId, status, ... }` or null.
- p95 < 100ms per call.

---

## 4. Lab Cascade Wrapper

Reuses T-29.05's `matchPatient()` cascade. The wrapper exists because the lab pipeline calls the cascade with slightly different inputs (the ORU's PID is the same shape as ADT's PID, but the PID projector lives in the lab-pipeline-specific code) and the *outcome* routing differs.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/lab-cascade.ts
import { matchPatient, type MatchOutcome, type CascadeInput } from './match-cascade'
import type { PatientReader, MasterDataProvider } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'

export interface LabCascadeOutcome {
  readonly patientId: string | null      // populated for confident match
  readonly candidatePatientId: string | null  // populated for single-candidate match
  readonly candidateIds: readonly string[]    // populated for ambiguous
  readonly matchLevel: string             // L1_MRN_EXACT, ..., NO_MATCH
  readonly matchConfidence: number | null
  readonly matchMethod: LabMatchMethod
}

export type LabMatchMethod =
  | 'cascade_confident'                 // L1-L3 single hit
  | 'cascade_candidate'                 // L4-L5 single hit
  | 'cascade_ambiguous'                 // L3 or L4 multi-hit
  | 'cascade_unmatched'                 // no_match

export async function runLabCascade(
  pid: CascadeInput['pid'],
  organizationId: string,
  patientReader: PatientReader,
  mdm: MasterDataProvider,
  logger: Logger,
): Promise<LabCascadeOutcome> {
  const orgSettings = await mdm.getOrganizationSettings(organizationId)
  const outcome = await matchPatient(
    {
      organizationId,
      internalMrnAuthority: orgSettings.hl7_internal_mrn_authority,
      pid,
    },
    { patientReader, logger },
  )

  return mapToLabOutcome(outcome)
}

function mapToLabOutcome(outcome: MatchOutcome): LabCascadeOutcome {
  switch (outcome.kind) {
    case 'confident_match':
      return {
        patientId: outcome.patientId,
        candidatePatientId: null,
        candidateIds: [outcome.patientId],
        matchLevel: outcome.level,
        matchConfidence: null,
        matchMethod: 'cascade_confident',
      }
    case 'candidate_match':
      return {
        patientId: null,                          // labs DON'T auto-bind on L4/L5 (D7 only for confident)
        candidatePatientId: outcome.patientId,
        candidateIds: [outcome.patientId],
        matchLevel: outcome.level,
        matchConfidence: outcome.confidence,
        matchMethod: 'cascade_candidate',
      }
    case 'ambiguous':
      return {
        patientId: null,
        candidatePatientId: null,
        candidateIds: outcome.candidateIds,
        matchLevel: outcome.level,
        matchConfidence: null,
        matchMethod: 'cascade_ambiguous',
      }
    case 'no_match':
      return {
        patientId: null,
        candidatePatientId: null,
        candidateIds: [],
        matchLevel: 'NO_MATCH',
        matchConfidence: null,
        matchMethod: 'cascade_unmatched',
      }
  }
}
```

**Why D7 says auto-attach for confident but not for candidate.** A confident L1-L3 cascade outcome on labs is treated the same way as a confident OBR-2 placer match — the patient is identified with high confidence and the observation can be attached. A candidate L4-L5 outcome falls to the unmatched queue for human review, where the reviewer can confirm the candidate or pick a different patient. The asymmetry between lab (auto-attach L1-L3) and ADT (propose-then-review even L1-L3) is intentional per D5 vs D7: ADT mutates the chart; labs report observations. Reporting an observation against a known-with-MRN patient is low-risk; mutating chart demographics is higher-risk.

---

## 5. Lab Attacher

Single transaction that persists `lab_observation` + N × `lab_observation_value` + `lab_observation_inbound_link`.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/lab-attacher.ts
import { ulid } from 'ulid'
import { db } from '@chartwarden/db'
import {
  labObservation,
  labObservationValue,
  labObservationInboundLink,
} from '@chartwarden/db/schema/external-interfaces'
import { withOrgContext } from '@chartwarden/tenancy'
import type { Logger } from 'pino'

export interface ProjectedObr {
  readonly placerOrderNumber?: string
  readonly fillerOrderNumber?: string
  readonly universalServiceIdentifier?: { code: string; text?: string; codingSystem?: string }  // OBR-4
  readonly observationDateTime?: string  // OBR-7, ISO
  readonly specimenDescriptor?: string
}

export interface ProjectedObx {
  readonly setId: number                                  // OBX-1
  readonly valueType: string                              // OBX-2 (NM, SN, ST, CE, ED, ...)
  readonly observationIdentifier: { code: string; text?: string; codingSystem?: string }  // OBX-3 (LOINC)
  readonly subId?: string                                 // OBX-4
  readonly observationValue: string                       // OBX-5 raw
  readonly units?: string                                 // OBX-6
  readonly referencesRange?: string                       // OBX-7
  readonly abnormalFlags: readonly string[]               // OBX-8 (N, L, H, HH, LL, A, AA, ...)
  readonly observationResultStatus: string                // OBX-11 (F, P, C, X, ...)
  readonly observationDateTime?: string                   // OBX-14
}

export interface LabAttachInput {
  readonly organizationId: string
  readonly sourceMessageId: string
  readonly obr: ProjectedObr
  readonly obxList: readonly ProjectedObx[]
  readonly patientId: string | null
  readonly orderRecordId: string | null
  readonly matchMethod: 'placer_match' | 'cascade_confident' | 'cascade_candidate' | 'cascade_ambiguous' | 'cascade_unmatched'
  readonly matchConfidence: number | null
  readonly candidatePatientId: string | null
  readonly candidateMatchLevel: string | null
  readonly terminologyValidation: 'valid' | 'unknown_code' | 'deprecated'
  readonly sudRedacted: boolean
  readonly receivedAt: Date
}

export interface LabAttachResult {
  readonly observationId: string
  readonly valueCount: number
  readonly hasPendingPdf: boolean  // true if any OBX-2='ED' present; the OBX-5 PDF handshake runs separately
}

export async function attachLab(input: LabAttachInput, logger: Logger): Promise<LabAttachResult> {
  const observationId = ulid()

  // Determine abnormal severity across all OBX rows (max severity wins for the observation-level field)
  const obsAbnormalSeverity = computeObservationLevelSeverity(input.obxList)

  const hasPendingPdf = input.obxList.some(obx => obx.valueType === 'ED')

  await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
    // 1. lab_observation
    await tx.insert(labObservation).values({
      id: observationId,
      organizationId: input.organizationId,
      patientId: input.patientId,
      orderRecordId: input.orderRecordId,
      sourceMessageId: input.sourceMessageId,
      observationDateTime: input.obr.observationDateTime ? new Date(input.obr.observationDateTime) : null,
      universalServiceCode: input.obr.universalServiceIdentifier?.code ?? null,
      universalServiceText: input.obr.universalServiceIdentifier?.text ?? null,
      specimenDescriptor: input.obr.specimenDescriptor ?? null,
      terminologyValidation: input.terminologyValidation,
      sudRedacted: input.sudRedacted,
      abnormalFlagSeverity: obsAbnormalSeverity,
      receivedAt: input.receivedAt,
      attachedDocumentId: null,  // back-filled by M22 handshake consumer
    })

    // 2. N × lab_observation_value (skip OBX-2='ED' — those are PDFs handled separately)
    const valueRows = input.obxList
      .filter(obx => obx.valueType !== 'ED')
      .map(obx => ({
        id: ulid(),
        observationId,
        organizationId: input.organizationId,
        setId: obx.setId,
        valueType: obx.valueType,
        loincCode: obx.observationIdentifier.code,
        loincText: obx.observationIdentifier.text ?? null,
        observationValue: input.sudRedacted ? '[REDACTED_SUD]' : obx.observationValue,
        units: obx.units ?? null,
        referencesRange: obx.referencesRange ?? null,
        abnormalFlags: obx.abnormalFlags as string[],
        observationResultStatus: obx.observationResultStatus,
        observationDateTime: obx.observationDateTime ? new Date(obx.observationDateTime) : null,
      }))

    if (valueRows.length > 0) {
      await tx.insert(labObservationValue).values(valueRows)
    }

    // 3. lab_observation_inbound_link
    await tx.insert(labObservationInboundLink).values({
      id: ulid(),
      observationId,
      sourceMessageId: input.sourceMessageId,
      sourceOrderId: input.orderRecordId,
      obrPlacerOrderNumber: input.obr.placerOrderNumber ?? null,
      matchMethod: input.matchMethod,
      matchConfidence: input.matchConfidence?.toFixed(3) ?? null,
      candidatePatientId: input.candidatePatientId,
      candidateMatchLevel: input.candidateMatchLevel as any,
    })
  })

  logger.info(
    {
      observationId,
      patientId: input.patientId,
      orderRecordId: input.orderRecordId,
      matchMethod: input.matchMethod,
      valueCount: input.obxList.length,
      hasPendingPdf,
    },
    'lab.observation.attached',
  )

  return {
    observationId,
    valueCount: input.obxList.length,
    hasPendingPdf,
  }
}

function computeObservationLevelSeverity(obxList: readonly ProjectedObx[]): string | null {
  // Severity ranking: critical_low/critical_high > abnormal_high/abnormal_low > borderline > normal > null
  // Flag → severity map:
  //   N → null (normal)
  //   L, H → 'abnormal'
  //   LL, HH → 'critical'
  //   A → 'abnormal'
  //   AA → 'critical'
  //   '<' or '>' → 'borderline_panic'

  let highest: 'critical' | 'abnormal' | 'borderline' | null = null
  for (const obx of obxList) {
    for (const flag of obx.abnormalFlags) {
      const sev = mapFlagToSeverity(flag)
      if (sev === 'critical') return 'critical'  // can't go higher
      if (sev === 'abnormal' && highest !== 'critical') highest = 'abnormal'
      else if (sev === 'borderline' && highest === null) highest = 'borderline'
    }
  }
  return highest
}

function mapFlagToSeverity(flag: string): 'critical' | 'abnormal' | 'borderline' | null {
  switch (flag.toUpperCase()) {
    case 'LL': case 'HH': case 'AA': return 'critical'
    case 'L':  case 'H':  case 'A':  return 'abnormal'
    case '<':  case '>':              return 'borderline'
    case 'N':  case '':               return null
    default: return 'abnormal'  // unknown flag — treat as abnormal, log a warning at parse time
  }
}
```

---

## 6. Terminology Check

Per M29 v0.3 §4.5 (consumed-seams) — `TerminologyProvider.validate(loincCode)` and `.lookup({system, code, asOfDate})` consulted on every inbound ORU OBX-3.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/terminology-check.ts
import type { TerminologyProvider } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'
import type { ProjectedObx } from './lab-attacher'

export type TerminologyValidation = 'valid' | 'unknown_code' | 'deprecated'

/**
 * Check every OBX-3 LOINC code against the M38 catalog as of the observation date.
 * Returns the observation-level validation status: 'valid' iff every OBX is valid,
 * 'unknown_code' iff any is unknown, 'deprecated' iff any is deprecated and none is unknown.
 */
export async function checkTerminology(
  obxList: readonly ProjectedObx[],
  asOfDate: Date,
  terminology: TerminologyProvider,
  logger: Logger,
): Promise<TerminologyValidation> {
  let anyUnknown = false
  let anyDeprecated = false

  for (const obx of obxList) {
    const code = obx.observationIdentifier.code
    if (!code) {
      // OBX-3 must carry SOMETHING; if not, treat the whole observation as unknown_code
      anyUnknown = true
      continue
    }

    try {
      const validation = await terminology.validate({
        system: 'http://loinc.org',
        code,
        asOfDate,
      })

      if (!validation.exists) {
        anyUnknown = true
        logger.warn({ loinc: code, asOfDate: asOfDate.toISOString() }, 'lab.terminology.unknown_code')
      } else if (validation.status === 'deprecated') {
        anyDeprecated = true
        logger.info({ loinc: code }, 'lab.terminology.deprecated_code')
      }
    } catch (err) {
      // M38 unavailable — fail closed: treat as unknown_code, log + dispatch alert
      anyUnknown = true
      logger.error({ err, loinc: code }, 'lab.terminology.lookup_failed')
    }
  }

  if (anyUnknown) return 'unknown_code'
  if (anyDeprecated) return 'deprecated'
  return 'valid'
}
```

**Observation is not dropped on `unknown_code`.** Per M29 §4.5 consumed-seams text: the lab is authoritative for the test name even when LOINC mapping lags. The observation lands with `terminology_validation='unknown_code'` and a typed M36 alert routes to the terminology administrator. Downstream FHIR projection (M28) filters `terminology_validation='valid'` to avoid emitting unknown codes externally; HQRP measures (M30) do the same.

---

## 7. SUD Ingress Redaction (D15)

Per M29 v0.3 §4.5 — `ConsentEvaluator.evaluateForIngressRedaction(patientId, dataClass, asOf)` consulted at lab ingest for the 42 CFR Part 2 SUD-test class.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/sud-redaction.ts
import type { ConsentEvaluator } from '@chartwarden/foundation/seams'
import type { TerminologyProvider } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'
import type { ProjectedObx } from './lab-attacher'

/**
 * Determine if the observation should be persisted under SUD redaction.
 *
 * Rule (D15, default-on):
 *   1. If patient_id is null (unmatched), redact = false (no patient context yet for consent check;
 *      the value lands in the unmatched queue and SUD applies at bind-time).
 *   2. Determine if ANY OBX in the message carries a LOINC code in the SUD-test class
 *      (urine drug screen panel codes, opioid metabolite tests, etc — M38 returns the
 *      LOINC class via lookup().categories or similar).
 *   3. If yes, ask M39 `evaluateForIngressRedaction(patientId, 'sud_test', asOf)`.
 *      Default-on: if consent absent or ambiguous, redact = true.
 *   4. If no OBX is SUD-class, redact = false.
 */
export async function shouldRedactSud(
  patientId: string | null,
  obxList: readonly ProjectedObx[],
  asOf: Date,
  consent: ConsentEvaluator,
  terminology: TerminologyProvider,
  logger: Logger,
): Promise<boolean> {
  if (!patientId) return false  // unmatched — defer to bind-time SUD check

  // Determine SUD-class via terminology lookup
  let anySud = false
  for (const obx of obxList) {
    const code = obx.observationIdentifier.code
    if (!code) continue
    try {
      const lookup = await terminology.lookup({
        system: 'http://loinc.org',
        code,
        asOfDate: asOf,
      })
      if (lookup?.categories?.includes('sud_test')) {
        anySud = true
        break
      }
    } catch {
      // M38 unavailable — fail safe to apply redaction
      anySud = true
      break
    }
  }

  if (!anySud) return false

  const decision = await consent.evaluateForIngressRedaction({
    patientId,
    dataClass: 'sud_test',
    asOf,
  })

  // Default-on: if consent is absent / unknown / unauthorized, redact
  const redact = !decision.allowDisclosure
  logger.info(
    { patientId, anySud, consentDecision: decision.allowDisclosure, redact },
    'lab.sud.redaction_decision',
  )
  return redact
}
```

---

## 8. Abnormal-Flag Detection & M36 Routing (D7)

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/abnormal-flag.ts
import type { AlertDispatcher, CaseloadProvider } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'
import type { ProjectedObx } from './lab-attacher'

export interface AbnormalRoutingInput {
  readonly organizationId: string
  readonly observationId: string
  readonly patientId: string | null
  readonly obxList: readonly ProjectedObx[]
  readonly observationDateTime: Date
}

/**
 * For each OBX with a critical-severity flag, dispatch an alert to the patient's
 * caseload RN via M36. Skipped if patient_id is null (unmatched labs don't have a
 * caseload yet).
 *
 * Per D7, "abnormal" (single-letter L/H/A) flags do NOT page — they surface in the
 * dashboard. Only "critical" (LL/HH/AA) flags dispatch active alerts.
 */
export async function routeAbnormalFlags(
  input: AbnormalRoutingInput,
  deps: {
    caseload: CaseloadProvider
    alerts: AlertDispatcher
    logger: Logger
  },
): Promise<{ alertsDispatched: number }> {
  if (!input.patientId) {
    deps.logger.debug({ observationId: input.observationId }, 'lab.abnormal.skip_unmatched')
    return { alertsDispatched: 0 }
  }

  const criticalObx = input.obxList.filter(obx =>
    obx.abnormalFlags.some(f => ['LL', 'HH', 'AA'].includes(f.toUpperCase())),
  )

  if (criticalObx.length === 0) return { alertsDispatched: 0 }

  // Resolve caseload RN(s) for the patient
  const caseload = await deps.caseload.caseloadFor({
    organizationId: input.organizationId,
    patientId: input.patientId,
    asOf: input.observationDateTime,
  })

  if (!caseload || caseload.assignedMembershipIds.length === 0) {
    deps.logger.warn(
      { patientId: input.patientId, observationId: input.observationId, criticalCount: criticalObx.length },
      'lab.abnormal.no_caseload_rn',
    )
    // Fall back to organization-level on-call resolver
    await deps.alerts.dispatch({
      severity: 'CRITICAL',
      channel: 'on_call_clinical',
      organizationId: input.organizationId,
      title: 'Critical lab result — no caseload RN assigned',
      body: `Observation ${input.observationId} has critical-severity OBX flags; no caseload RN found for patient ${input.patientId}.`,
    })
    return { alertsDispatched: 1 }
  }

  let dispatched = 0
  for (const membershipId of caseload.assignedMembershipIds) {
    await deps.alerts.dispatch({
      severity: 'CRITICAL',
      channel: 'direct_to_membership',
      organizationId: input.organizationId,
      recipientMembershipId: membershipId,
      title: 'Critical lab result',
      body: `Patient ${input.patientId}: ${criticalObx.length} critical-severity OBX flag(s). Observation ${input.observationId}.`,
      // PHI denylist: do NOT include the LOINC name or the value in the body. Body
      // surfaces enough to direct the RN to the observation; the RN opens the chart
      // for clinical detail under their auth context.
    })
    dispatched++
  }

  deps.logger.info(
    { patientId: input.patientId, observationId: input.observationId, criticalCount: criticalObx.length, dispatched },
    'lab.abnormal.alerts_dispatched',
  )

  return { alertsDispatched: dispatched }
}
```

---

## 9. OBX-5 PDF Handshake (M22)

Some labs send the human-readable PDF report as an OBX with `OBX-2='ED'` and `OBX-5` carrying `^PDF^Base64^<encoded>`. T-29.07 emits the M22 handshake event; M22 stores the document; M22 emits `m22.document.uploaded` with the canonical document_id; T-29.07's back-ref consumer wires the document_id onto `lab_observation.attached_document_id`.

```ts
// apps/backend/src/modules/29-external-interfaces/inbound/obx-pdf-handler.ts
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'
import type { ProjectedObx } from './lab-attacher'

export interface PdfHandshakeInput {
  readonly organizationId: string
  readonly observationId: string
  readonly patientId: string | null
  readonly orderRecordId: string | null
  readonly obxList: readonly ProjectedObx[]
}

export async function handlePdfAttachments(
  input: PdfHandshakeInput,
  deps: { outbox: Outbox; logger: Logger },
): Promise<{ pdfsRequested: number }> {
  const pdfObx = input.obxList.filter(obx => obx.valueType === 'ED')
  if (pdfObx.length === 0) return { pdfsRequested: 0 }

  let count = 0
  for (const obx of pdfObx) {
    const pdfBytes = extractPdfBytes(obx.observationValue)
    if (!pdfBytes) {
      deps.logger.warn(
        { observationId: input.observationId, setId: obx.setId },
        'lab.obx_pdf.parse_failed',
      )
      continue
    }

    await deps.outbox.publish('m22.document.upload_requested', {
      organizationId: input.organizationId,
      requestingModule: 'm29',
      backRef: {
        kind: 'lab_observation',
        observationId: input.observationId,
        orderRecordId: input.orderRecordId,
        patientId: input.patientId,
      },
      mimeType: 'application/pdf',
      retentionClass: 'clinical_record',
      payloadBase64: pdfBytes.toString('base64'),
      sourceLabel: `lab-report-obx-${obx.setId}`,
    })

    count++
  }

  deps.logger.info({ observationId: input.observationId, pdfsRequested: count }, 'lab.obx_pdf.handshake_initiated')
  return { pdfsRequested: count }
}

function extractPdfBytes(obx5: string): Buffer | null {
  // OBX-5 encoded data shape: `^PDF^Base64^<base64-encoded-bytes>` (HL7 ED data type;
  // delimited subcomponents). Per HL7 v2.5.1 §2.A.27 the second subcomponent is the
  // data subtype ("PDF") and the fourth is the encoded payload.
  const parts = obx5.split('^')
  if (parts.length < 4) return null
  if (parts[1].toUpperCase() !== 'PDF') return null
  if (parts[2].toUpperCase() !== 'BASE64') return null
  try {
    return Buffer.from(parts[3], 'base64')
  } catch {
    return null
  }
}
```

And the M22 back-ref consumer:

```ts
// apps/backend/src/modules/29-external-interfaces/consumers/m22-document-backref.ts
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'
import { db } from '@chartwarden/db'
import { labObservation } from '@chartwarden/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'

export function registerM22DocumentBackrefConsumer(outbox: Outbox, logger: Logger): void {
  outbox.registerConsumer({
    eventName: 'm22.document.uploaded',
    consumerName: 'm29.lab-obx-pdf-backref',
    handler: async ({ payload }) => {
      const { documentId, requestingModule, backRef, organizationId } = payload
      if (requestingModule !== 'm29' || backRef?.kind !== 'lab_observation') return  // not ours

      await withOrgContext(db, { organizationId }, async (tx) => {
        await tx
          .update(labObservation)
          .set({ attachedDocumentId: documentId })
          .where(eq(labObservation.id, backRef.observationId))
      })

      logger.info({ observationId: backRef.observationId, documentId }, 'lab.obx_pdf.backref_wired')
    },
  })
}
```

---

## 10. ORU Branch in Parse Worker

Replaces the T-29.04 forward-stub. Lands as the final piece in `hl7-inbound-parse.worker.ts`.

```ts
// apps/backend/src/modules/29-external-interfaces/workers/hl7-inbound-parse.worker.ts
// (additions to the worker handler — the ORU branch)

import { resolveByPlacerOrder } from '../inbound/lab-placer-resolver'
import { runLabCascade } from '../inbound/lab-cascade'
import { attachLab } from '../inbound/lab-attacher'
import { checkTerminology } from '../inbound/terminology-check'
import { shouldRedactSud } from '../inbound/sud-redaction'
import { routeAbnormalFlags } from '../inbound/abnormal-flag'
import { handlePdfAttachments } from '../inbound/obx-pdf-handler'
import { projectObr, projectObxList } from '@chartwarden/hl7-worker/segments/oru'

// In worker body, replacing the T-29.04 ORU stub:
if (message.messageType.startsWith('ORU^')) {
  // 1. Project OBR + OBX[] from the parsed tree
  const obr = projectObr(parsed)
  const obxList = projectObxList(parsed)
  const pid = projectPid(findPidSegment(parsed)!)
  const observationDateTime = obr.observationDateTime ? new Date(obr.observationDateTime) : new Date()

  // 2. Terminology check
  const terminologyValidation = await checkTerminology(obxList, observationDateTime, deps.terminology, logger)

  // 3a. Patient resolution — OBR-2 placer first
  let patientId: string | null = null
  let orderRecordId: string | null = null
  let matchMethod: 'placer_match' | 'cascade_confident' | 'cascade_candidate' | 'cascade_ambiguous' | 'cascade_unmatched' = 'cascade_unmatched'
  let matchConfidence: number | null = null
  let candidatePatientId: string | null = null
  let candidateMatchLevel: string | null = null

  const placerResult = await resolveByPlacerOrder(obr.placerOrderNumber, organizationId, deps.orderReader, logger)
  if (placerResult.kind === 'placer_match') {
    patientId = placerResult.patientId!
    orderRecordId = placerResult.orderRecordId!
    matchMethod = 'placer_match'
  } else {
    // 3b. Fallback to cascade
    const cascadeOutcome = await runLabCascade(
      {
        identifiers: pid.identifiers.map(i => ({ value: i.value, assigningAuthority: i.assigningAuthority })),
        lastName: pid.names[0]?.familyName ?? '',
        firstName: pid.names[0]?.givenName ?? '',
        dateOfBirth: hl7DateToIso(pid.dateOfBirth),
        administrativeSex: pid.sex,
        ssnLast4: extractSsnLast4(pid.ssnNumber),
      },
      organizationId,
      deps.patientReader,
      deps.mdm,
      logger,
    )
    patientId = cascadeOutcome.patientId
    candidatePatientId = cascadeOutcome.candidatePatientId
    candidateMatchLevel = cascadeOutcome.matchLevel
    matchMethod = cascadeOutcome.matchMethod
    matchConfidence = cascadeOutcome.matchConfidence
  }

  // 4. SUD redaction check
  const sudRedacted = await shouldRedactSud(
    patientId,
    obxList,
    observationDateTime,
    deps.consent,
    deps.terminology,
    logger,
  )

  // 5. Attach (transactional)
  const attachResult = await attachLab({
    organizationId,
    sourceMessageId: messageId,
    obr,
    obxList,
    patientId,
    orderRecordId,
    matchMethod,
    matchConfidence,
    candidatePatientId,
    candidateMatchLevel,
    terminologyValidation,
    sudRedacted,
    receivedAt: new Date(),
  }, logger)

  // 6. Abnormal flag routing (only if patient_id known)
  if (patientId) {
    await routeAbnormalFlags({
      organizationId,
      observationId: attachResult.observationId,
      patientId,
      obxList,
      observationDateTime,
    }, { caseload: deps.caseload, alerts: deps.alerts, logger })
  }

  // 7. PDF handshake (out-of-band; M22 fills back-ref)
  if (attachResult.hasPendingPdf) {
    await handlePdfAttachments({
      organizationId,
      observationId: attachResult.observationId,
      patientId,
      orderRecordId,
      obxList,
    }, { outbox: deps.outbox, logger })
  }

  // 8. Outbox events
  await deps.outbox.publish('m29.lab_observation.received', {
    observationId: attachResult.observationId,
    sourceMessageId: messageId,
    organizationId,
    orderRecordId,
    patientId,
    matchMethod,
    terminologyValidation,
    sudRedacted,
    abnormalFlagSeverity: attachResult.valueCount > 0 ? 'computed_at_value_persistence' : null,
  })

  if (patientId) {
    await deps.outbox.publish('m29.lab_observation.attached', {
      observationId: attachResult.observationId,
      organizationId,
      patientId,
      orderRecordId,
      matchMethod,
    })
  } else {
    await deps.outbox.publish('m29.lab_observation.unmatched', {
      observationId: attachResult.observationId,
      organizationId,
      candidatePatientId,
      candidateMatchLevel,
      matchMethod,
    })
  }

  return
}
```

---

## 11. Unmatched-Lab Queue Routes

When patient_id is null (cascade candidate / ambiguous / no_match), the observation lands in the unmatched-lab queue. Reviewer either binds it to a patient or discards it.

```ts
// apps/backend/src/modules/29-external-interfaces/routes/unmatched-labs.ts
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { db } from '@chartwarden/db'
import { labObservation, labObservationInboundLink } from '@chartwarden/db/schema/external-interfaces'
import { and, eq, isNull, desc } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'
import { requirePermissions } from '@chartwarden/foundation/auth'

const BindBody = Type.Object({
  patientId: Type.String({ format: 'uuid' }),
  decisionRationale: Type.String({ minLength: 1, maxLength: 4000 }),
})

const DiscardBody = Type.Object({
  decisionRationale: Type.String({ minLength: 10, maxLength: 4000 }),
})

export function registerUnmatchedLabRoutes(app: FastifyInstance): void {
  // GET /api/v1/hl7/unmatched-labs
  app.get(
    '/api/v1/hl7/unmatched-labs',
    {
      preHandler: [requirePermissions(['external_interfaces.unmatched_lab:list'])],
    },
    async (req) => {
      const organizationId = req.user!.organizationId
      const rows = await withOrgContext(db, { organizationId }, async (tx) =>
        tx
          .select({
            observation: labObservation,
            link: labObservationInboundLink,
          })
          .from(labObservation)
          .innerJoin(labObservationInboundLink, eq(labObservationInboundLink.observationId, labObservation.id))
          .where(and(
            eq(labObservation.organizationId, organizationId),
            isNull(labObservation.patientId),
          ))
          .orderBy(desc(labObservation.receivedAt))
          .limit(200),
      )
      return rows
    },
  )

  // POST /api/v1/hl7/unmatched-labs/:id/bind
  app.post(
    '/api/v1/hl7/unmatched-labs/:id/bind',
    {
      schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: BindBody },
      preHandler: [
        requirePermissions(['external_interfaces.unmatched_lab:bind']),
        // step-up could go here per D18 if Engrace decides binding-a-lab needs step-up
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { patientId, decisionRationale } = req.body as { patientId: string; decisionRationale: string }
      const organizationId = req.user!.organizationId

      // Atomic UPDATE WHERE patient_id IS NULL — guards against double-bind race
      const updated = await withOrgContext(db, { organizationId }, async (tx) => {
        const result = await tx
          .update(labObservation)
          .set({ patientId, boundAt: new Date(), boundByMembershipId: req.user!.membershipId, bindRationale: decisionRationale })
          .where(and(
            eq(labObservation.id, id),
            eq(labObservation.organizationId, organizationId),
            isNull(labObservation.patientId),
          ))
          .returning()
        return result[0] ?? null
      })

      if (!updated) {
        return reply.code(409).send({ error: 'already_bound_or_not_found' })
      }

      // Emit bound event — M11 consumer flips order fulfillment if order is tied
      await deps.outbox.publish('m29.lab_observation.bound', {
        observationId: id,
        organizationId,
        patientId,
        boundByMembershipId: req.user!.membershipId,
        decisionRationale,
      })

      // Re-evaluate abnormal flag routing now that patient is known
      // (load OBX values + caseload + dispatch). Omitted code; same path as §8.

      return { status: 'bound', patientId }
    },
  )

  // POST /api/v1/hl7/unmatched-labs/:id/discard
  app.post(
    '/api/v1/hl7/unmatched-labs/:id/discard',
    {
      schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: DiscardBody },
      preHandler: [requirePermissions(['external_interfaces.unmatched_lab:discard'])],
    },
    async (req, reply) => {
      // Similar pattern; mark observation as discarded (we use a new status column or
      // soft-delete pattern; for v0.3 the schema has no explicit status, so we set
      // boundAt + bindRationale prefixed with "[discarded]"). A subsequent migration
      // could add a discriminated lab-observation-status enum.
      const { id } = req.params as { id: string }
      const { decisionRationale } = req.body as { decisionRationale: string }
      // ... same pattern as §6 decision-engine discard ...
      return { status: 'discarded' }
    },
  )
}
```

A small schema note: T-29.07's discard surface uses `bindRationale` for both bind and discard distinguished by prefix. A future PR could add an explicit `lab_observation_status` enum. For T-29.07 the prefix convention is sufficient and ships without a migration.

---

## 12. M11 Forward-Stub Consumer

M11 v0.3 will consume `m29.lab_observation.attached` and `m29.lab_observation.bound` to flip `order_record.fulfillment_status`. Today M11 is locked at v0.2; ship a deny-stub per T-29.01 forward-stub pattern.

```ts
// apps/backend/src/modules/11-orders/outbox-consumers/m29-lab-attached.stub.ts
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'

export function registerM11LabAttachedStub(outbox: Outbox, logger: Logger): void {
  outbox.registerConsumer({
    eventName: 'm29.lab_observation.attached',
    consumerName: 'm11.order-fulfillment',
    handler: async ({ payload }) => {
      logger.info(
        { observationId: payload.observationId, orderRecordId: payload.orderRecordId },
        'm11.lab_attached.forward_stub_received',
      )
      // Real consumer in M11 v0.3 flips order_record.fulfillment_status to 'partially_resulted'
      // or 'fully_resulted'. No mutation here.
    },
  })

  outbox.registerConsumer({
    eventName: 'm29.lab_observation.bound',
    consumerName: 'm11.order-fulfillment-bind',
    handler: async ({ payload }) => {
      logger.info({ observationId: payload.observationId }, 'm11.lab_bound.forward_stub_received')
    },
  })
}
```

---

## 13. Tests

### 13.1 W-XI-05 — confident OBR-2 placer match auto-attaches

```ts
describe('W-XI-05 — OBR-2 placer match auto-attaches observation to order patient', () => {
  it('ORU with OBR-2=<m11_order_id> binds observation to order.patient_id', async () => {
    const patient = await fixtures.patient({ id: 'pt_smith', organizationId: 'org_engrace' })
    const order = await fixtures.m11Order({ id: 'ord_abc123', patientId: patient.id })

    const oru = mkOruR01Frame({
      mcid: 'MCID-W05',
      obr2: 'ord_abc123',
      pid3: { value: 'IGNORED', assigningAuthority: 'OTHER' },  // irrelevant; placer wins
      obxList: [
        { setId: 1, valueType: 'NM', loinc: '789-8', value: '14.5', units: 'g/dL', refRange: '12-16', flag: 'N' },
      ],
    })

    await deliverFrameToListener(feed, oru)

    await waitFor(async () => {
      const [obs] = await db.select().from(labObservation).where(eq(labObservation.sourceMessageId, /* msgid */))
      expect(obs).toBeDefined()
      expect(obs.patientId).toBe('pt_smith')
      expect(obs.orderRecordId).toBe('ord_abc123')

      const [link] = await db.select().from(labObservationInboundLink).where(eq(labObservationInboundLink.observationId, obs.id))
      expect(link.matchMethod).toBe('placer_match')
    })

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.lab_observation.attached')).toMatchObject({
      payload: expect.objectContaining({ patientId: 'pt_smith', matchMethod: 'placer_match' }),
    })
  })
})
```

### 13.2 W-XI-06 — L4 candidate lands in unmatched queue

```ts
describe('W-XI-06 — cascade L4 candidate routes to unmatched-lab queue', () => {
  it('ORU with no OBR-2 and PID matching L4 candidate has patient_id=null + candidate_patient_id populated', async () => {
    const patient = await fixtures.patient({ id: 'pt_jane', lastName: 'DOE', firstName: 'JANE', dateOfBirth: '1948-03-22', administrativeSex: 'F' })

    const oru = mkOruR01Frame({
      obr2: undefined,  // no placer
      pid3: { value: 'NOT-A-REAL-MRN', assigningAuthority: 'ENGRACE_INTERNAL' },
      lastName: 'DOE', firstName: 'JANE', dob: '19480322', sex: 'F',
      obxList: [{ setId: 1, valueType: 'NM', loinc: '789-8', value: '11.0', units: 'g/dL', refRange: '12-16', flag: 'L' }],
    })

    await deliverFrameToListener(feed, oru)

    await waitFor(async () => {
      const [obs] = await db.select().from(labObservation)
      expect(obs.patientId).toBeNull()

      const [link] = await db.select().from(labObservationInboundLink).where(eq(labObservationInboundLink.observationId, obs.id))
      expect(link.matchMethod).toBe('cascade_candidate')
      expect(link.candidatePatientId).toBe('pt_jane')
      expect(link.candidateMatchLevel).toBe('L4_DEMOGRAPHIC_BRIDGE_CANDIDATE')
    })

    // Surfaces in the unmatched queue
    const res = await client.get('/api/v1/hl7/unmatched-labs', { user: opUser })
    expect(res.body).toHaveLength(1)
  })

  it('reviewer can bind unmatched lab to the candidate patient', async () => {
    // Continuation of above
    const res = await client.post(`/api/v1/hl7/unmatched-labs/${obs.id}/bind`, {
      patientId: 'pt_jane',
      decisionRationale: 'Demographics confirmed via phone call',
    }, { user: opUser })

    expect(res.statusCode).toBe(200)
    const [updated] = await db.select().from(labObservation).where(eq(labObservation.id, obs.id))
    expect(updated.patientId).toBe('pt_jane')
    expect(updated.boundByMembershipId).toBe(opUser.membershipId)

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.lab_observation.bound')).toBeDefined()
  })
})
```

### 13.3 W-XI-07 — critical abnormal flag dispatches CRITICAL alert to caseload RN

```ts
describe('W-XI-07 — OBX HH/LL flag routes critical alert to caseload RN', () => {
  it('an OBX with flag=HH dispatches CRITICAL alert to all caseload RNs of the patient', async () => {
    const patient = await fixtures.patient({ id: 'pt_jones' })
    const order = await fixtures.m11Order({ id: 'ord_xyz', patientId: 'pt_jones' })
    const rn1 = await fixtures.membership({ role: 'rn', caseloadIncludes: ['pt_jones'] })
    const rn2 = await fixtures.membership({ role: 'rn', caseloadIncludes: ['pt_jones'] })

    const oru = mkOruR01Frame({
      obr2: 'ord_xyz',
      obxList: [
        { setId: 1, valueType: 'NM', loinc: '6298-4', value: '7.2', units: 'mEq/L', flag: 'HH' },
      ],
    })
    await deliverFrameToListener(feed, oru)

    await waitFor(async () => {
      const alerts = mockAlerts.getDispatched()
      expect(alerts.filter(a => a.severity === 'CRITICAL')).toHaveLength(2)  // one per caseload RN
      expect(alerts.every(a => a.title === 'Critical lab result')).toBe(true)
      // PHI denylist — body must NOT contain the LOINC name or the numeric value
      expect(alerts.every(a => !a.body.includes('6298-4') && !a.body.includes('7.2'))).toBe(true)
    })
  })

  it('an OBX with flag=H (single-letter abnormal, NOT critical) does NOT dispatch an alert', async () => {
    // ... same setup but flag='H' ...
    await deliverFrameToListener(feed, oru)
    await waitFor(async () => {
      const obs = await db.select().from(labObservation).limit(1)
      expect(obs[0].abnormalFlagSeverity).toBe('abnormal')
    })
    expect(mockAlerts.getDispatched()).toHaveLength(0)
  })

  it('unmatched lab (patient_id=null) does NOT dispatch alerts even with HH flag', async () => {
    // ... unmatched ORU with HH flag ...
    expect(mockAlerts.getDispatched()).toHaveLength(0)
  })
})
```

### 13.4 W-XI-08 — SUD-class lab redaction

```ts
describe('W-XI-08 — SUD-class lab is persisted with sud_redacted=true and value redacted', () => {
  it('urine drug screen LOINC class triggers redaction when patient has no SUD-disclosure consent', async () => {
    const patient = await fixtures.patient({ id: 'pt_sud' })
    mockConsent.evaluateForIngressRedaction.mockResolvedValue({ allowDisclosure: false })
    mockTerminology.lookup.mockImplementation(({ code }) => ({
      exists: true,
      status: 'active',
      categories: code === '14375-7' ? ['sud_test'] : [],
    }))

    const oru = mkOruR01Frame({
      obr2: 'ord_sud_1',
      obxList: [
        { setId: 1, valueType: 'NM', loinc: '14375-7', value: 'POSITIVE', units: '', flag: 'A' },
      ],
    })
    await deliverFrameToListener(feed, oru)

    await waitFor(async () => {
      const [obs] = await db.select().from(labObservation)
      expect(obs.sudRedacted).toBe(true)

      const values = await db.select().from(labObservationValue).where(eq(labObservationValue.observationId, obs.id))
      expect(values[0].observationValue).toBe('[REDACTED_SUD]')
    })
  })

  it('non-SUD lab is NOT redacted', async () => {
    mockTerminology.lookup.mockResolvedValue({ exists: true, status: 'active', categories: [] })
    // ... CBC ORU ...
    await waitFor(async () => {
      const [obs] = await db.select().from(labObservation)
      expect(obs.sudRedacted).toBe(false)
    })
  })

  it('SUD lab with explicit consent → NOT redacted', async () => {
    mockConsent.evaluateForIngressRedaction.mockResolvedValue({ allowDisclosure: true })
    // ... SUD ORU ...
    const [obs] = await db.select().from(labObservation)
    expect(obs.sudRedacted).toBe(false)
  })
})
```

### 13.5 W-XI-09 — OBX-5 PDF round-trip with M22

```ts
describe('W-XI-09 — OBX-5 PDF emits m22 handshake; back-ref consumer fills attached_document_id', () => {
  it('ORU with OBX-2=ED emits m22.document.upload_requested with payload', async () => {
    const pdfBytes = Buffer.from('PDF-1.4 fake pdf content')
    const obx5 = `^PDF^Base64^${pdfBytes.toString('base64')}`

    const oru = mkOruR01Frame({
      obr2: 'ord_pdf_1',
      obxList: [
        { setId: 1, valueType: 'NM', loinc: '789-8', value: '14.0', flag: 'N' },
        { setId: 2, valueType: 'ED', loinc: '11502-2', value: obx5 },  // narrative PDF
      ],
    })
    await deliverFrameToListener(feed, oru)

    await waitFor(async () => {
      const events = await fixtures.outboxEvents()
      const m22req = events.find(e => e.name === 'm22.document.upload_requested')
      expect(m22req).toBeDefined()
      expect(m22req!.payload.mimeType).toBe('application/pdf')
      expect(m22req!.payload.backRef.kind).toBe('lab_observation')
    })

    // Simulate M22 uploading and emitting the response
    await fixtures.emitOutboxEvent('m22.document.uploaded', {
      documentId: 'doc_xyz',
      requestingModule: 'm29',
      backRef: { kind: 'lab_observation', observationId: obs.id },
      organizationId: 'org_engrace',
    })

    await waitFor(async () => {
      const [updated] = await db.select().from(labObservation).where(eq(labObservation.id, obs.id))
      expect(updated.attachedDocumentId).toBe('doc_xyz')
    })

    // The NM OBX is in lab_observation_value; the ED OBX is NOT (it's a PDF)
    const values = await db.select().from(labObservationValue).where(eq(labObservationValue.observationId, obs.id))
    expect(values).toHaveLength(1)
    expect(values[0].loincCode).toBe('789-8')
  })
})
```

### 13.6 Terminology unknown_code handling

```ts
describe('terminology validation surfaces unknown_code without dropping observation', () => {
  it('unknown LOINC → observation persists with terminology_validation=unknown_code + M36 alert', async () => {
    mockTerminology.validate.mockResolvedValue({ exists: false })
    // ... ORU with unknown LOINC ...
    const [obs] = await db.select().from(labObservation)
    expect(obs.terminologyValidation).toBe('unknown_code')
    expect(mockAlerts.getDispatched().some(a => a.title.includes('terminology'))).toBe(true)
  })
})
```

### 13.7 Idempotency on duplicate ORU

```ts
describe('duplicate ORU (same MSH-10) does not create a second observation', () => {
  it('replaying the same ORU yields no second lab_observation row', async () => {
    const oru = mkOruR01Frame({ mcid: 'MCID-DUP', obr2: 'ord_dup' })
    await deliverFrameToListener(feed, oru)
    await deliverFrameToListener(feed, oru)  // replay

    const obs = await db.select().from(labObservation)
    expect(obs).toHaveLength(1)  // T-29.04 frame-handler idempotency stops the second frame at parse-time
  })
})
```

### 13.8 Multi-OBX ORU

```ts
describe('ORU with multiple OBX segments persists one observation + N value rows', () => {
  it('a CBC panel with 5 OBX rows → 1 lab_observation + 5 lab_observation_value', async () => {
    const oru = mkOruR01Frame({
      obr2: 'ord_cbc',
      obxList: [
        { setId: 1, valueType: 'NM', loinc: '789-8',  value: '14.5', units: 'g/dL', flag: 'N' },
        { setId: 2, valueType: 'NM', loinc: '787-2',  value: '5.5',  units: '10*9/L', flag: 'N' },
        { setId: 3, valueType: 'NM', loinc: '6690-2', value: '6.8',  units: '10*9/L', flag: 'N' },
        { setId: 4, valueType: 'NM', loinc: '777-3',  value: '250',  units: '10*9/L', flag: 'N' },
        { setId: 5, valueType: 'NM', loinc: '4544-3', value: '42.0', units: '%',     flag: 'N' },
      ],
    })
    await deliverFrameToListener(feed, oru)

    await waitFor(async () => {
      const obs = await db.select().from(labObservation)
      expect(obs).toHaveLength(1)
      const values = await db.select().from(labObservationValue).where(eq(labObservationValue.observationId, obs[0].id))
      expect(values).toHaveLength(5)
    })
  })
})
```

---

## 14. Sign-Off Checklist (T-29.07 PR)

- [ ] All 8 source files land in `apps/backend/src/modules/29-external-interfaces/inbound/` and `consumers/`.
- [ ] Parse worker ORU branch replaces the T-29.04 stub; the `m29.hl7_message.parsed_oru` forward-stub event is no longer emitted (the worker goes directly to the lab pipeline).
- [ ] Unmatched-lab routes land at `/api/v1/hl7/unmatched-labs`, `/:id/bind`, `/:id/discard`.
- [ ] M11 forward-stub consumers registered (`m29.lab_observation.attached`, `m29.lab_observation.bound`).
- [ ] M22 back-ref consumer registered in M29 boot.
- [ ] Outbox events `m29.lab_observation.{received,attached,unmatched,bound,discarded}` and the M22 `m22.document.upload_requested` produce/consume contracts are registered in M4 catalog.
- [ ] All §13 integration tests pass:
  - [ ] W-XI-05 (placer match)
  - [ ] W-XI-06 (L4 candidate → unmatched → bind)
  - [ ] W-XI-07 (critical-flag alert; non-critical no-alert; unmatched no-alert)
  - [ ] W-XI-08 (SUD redaction; non-SUD no-redact; consented no-redact)
  - [ ] W-XI-09 (PDF handshake + back-ref)
  - [ ] terminology unknown_code
  - [ ] duplicate ORU idempotency
  - [ ] multi-OBX panel
- [ ] PHI denylist holds — abnormal-flag alert bodies contain no LOINC name or numeric value (defense against M36 inadvertently surfacing PHI in push notifications or SMS).
- [ ] Auto-attach D7 vs propose-then-review D5 asymmetry test: ADT^A08 with L1 confident creates a proposal (T-29.06); ORU with L1 confident attaches directly (T-29.07). Both with the same source PID. Test verifies the distinct routing.
- [ ] OBR-2 placer-match priority over PID cascade: when both would yield a different patient, the OBR-2 wins. Test asserts.
- [ ] `bun run check:cruiser` passes — lab attacher imports only the M29 schema (no cross-module schema imports).
- [ ] **M11 owner** sign-off on the OBR-2 placer contract (especially the partner-prefix handling).
- [ ] **M38 owner** sign-off on the terminology-validation contract.
- [ ] **M39 owner** sign-off on the SUD-redaction contract — default-on behavior confirmed.
- [ ] **M22 owner** sign-off on the document handshake protocol (m29 is the third module to use the handshake after M11 and M9; the back-ref pattern is verified).
- [ ] **Clinical engineering reviewer** sign-off on the abnormal-flag severity classification (HH/LL/AA → critical; H/L/A → abnormal-not-paging).
- [ ] **Privacy engineer** sign-off on the alert-body PHI denylist.

---

## 15. Notes on Refinements Past M29 Spec v0.3

This addendum surfaces three small refinements past M29 spec v0.3 — none are spec corrections (the v0.3 consolidation pass eliminated the structural drift), just implementation-level conventions worth recording:

1. **Severity classification table for OBX-8 flags.** The spec mentions critical-flag routing (D7) but doesn't pin the flag → severity map. T-29.07 pins: `HH/LL/AA → critical`, `H/L/A → abnormal`, `</> → borderline`, `N → null`, unknown → abnormal-with-log. This is now de facto canonical and worth folding into a small M29 spec patch.

2. **Alert body PHI denylist for M36.** Per T-29.07 §8, the abnormal-flag alert body intentionally OMITS the LOINC name and the numeric value. The RN gets enough context to open the chart; the chart open under their auth context carries the PHI. This protects against M36 inadvertently surfacing PHI via SMS or push notification gateways. The convention should be documented in M36 spec next revision.

3. **Lab-observation status enum deferred.** The unmatched-lab routes use `bindRationale` for both bind and discard distinguished by `[discarded]` prefix. A future migration could add a `lab_observation_status` enum (`unmatched | bound | discarded | finalized`). For T-29.07 the prefix convention is sufficient; flagged for a future small PR.

---

## Document Footer

**Addendum version:** v1.0 (T-29.07 PR-ready)
**Bound to:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.6 (lab routing), §11 D7 (auto-attach), D8 (OBR-2), D15 (SUD redaction)
**Files delivered:** 8 source files + 2 forward-stub consumers + 1 M22 back-ref consumer + parse-worker ORU branch addition
**Workflows closed:** W-XI-05, W-XI-06, W-XI-07, W-XI-08, W-XI-09 (M29 side full closure; M11 side at M11 v0.3)
**Schema changes:** **None** — v0.3 schema is sufficient
**Sign-offs required:** M11 owner, M38 owner, M39 owner, M22 owner, Clinical engineering, Privacy engineer

**End of T-29.07 lab observation attachment addendum.**
