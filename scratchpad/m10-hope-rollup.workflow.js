export const meta = {
  name: 'm10-org-hope-rollup',
  description: 'Item 4: new HopeOrgRollupProvider seam (M1 registry) + M10 Drizzle aggregate store + bind M30 resolveInput for the 4 HOPE-family measures (tfp_pi, tfp_npsi, hope_sfv_on_time_rate, hope_submission_acceptance_rate).',
  phases: [
    { title: 'Seam contract', detail: 'HopeOrgRollupProvider interface + M1 registry (SeamName/SeamContracts/REQUIRED_SEAMS/deny-stub) + align QualityHopeConsumer' },
    { title: 'Producer + consumer', detail: 'M10 Drizzle aggregate store + provider; M30 resolveInput for the 4 HOPE measures' },
    { title: 'Integrate', detail: 'composition-root binding (M10 registers real provider, M30 consumes) + gate green' },
  ],
}

const RULES = `
Branch feat/m10-org-hope-rollup. Building item 4 (#107): an ORG-LEVEL HOPE rollup so M30's measure-recompute
worker can compute the 4 HOPE-family measures. M10 today only publishes PER-ENTITY HOPE readers; this adds a
new org-scoped seam + a Drizzle aggregate store.

ESTABLISHED FACTS (from investigation — do NOT re-derive, but VERIFY file paths before editing):
- M10 owns the HOPE tables in packages/db/src/schema/hope/ (FROZEN — do NOT edit schema/migrations):
  * hope_assessments (PARTITIONED by target_date; cols: organizationId, providerEntityId, patientId,
    admissionId, status, signedAt, targetDate, j2051MaxSeverity, j2051TriggerFired, and a jsonb 'data' column
    holding Section J at data.J.J2051.entries = [{ symptomCode, severity }]).
  * hope_submissions (organizationId, providerEntityId, submissionPeriod, status, itemCount, acceptedCount,
    rejectedCount, transmittedAt, acceptedAt).
  * symptom_follow_up_visit (organizationId, providerEntityId, triggeringAssessmentId, completingAssessmentId,
    triggeredAt, dueAt, status (open/completed/overdue/missed), completedAt). One SFV per trigger-fired assessment.
  * hope_timepoint_schedule (organizationId, providerEntityId, status (open/completed/expired/skipped),
    lateDeadlineAt, completedByAssessmentId).
- PAIN vs NON-PAIN: the J2051 evaluator (packages/hope/src/triggers/j2051.ts) treats symptomCode as an opaque
  label; PAIN is the symptomCode "pain", NON-PAIN is any other code (anxiety / shortness_of_breath /
  nausea_vomiting / …). The trigger threshold is severity >= "moderate" (moderate|severe). The per-symptom
  readings ARE persisted in hope_assessment.data.J.J2051.entries. Define a documented constant
  HOPE_J2051_PAIN_SYMPTOM_CODE = "pain" and FLAG it as the single correctness assumption.
- M10's HOPE seams currently run on an IN-MEMORY stub (no Drizzle store). So build a DEDICATED Drizzle aggregate
  reader for the new org-rollup provider — do NOT rewrite M10's existing per-entity store.
- M30 consumes via packages/quality/src/seams/consumed/m10-hope.ts (QualityHopeConsumer) → the worker's
  resolveInput (packages/quality/src/workers/measure-recompute.ts + apps/backend/src/modules/30-quality/jobs/
  m30-jobs.ts). The HOPE-derived calculators (packages/quality/src/measures/hope_derived/* + operational/
  hope_sfv_on_time_rate.ts + hope_submission_acceptance_rate.ts) define the input shapes each measure needs.

REFERENCE PATTERNS: M10 seam registration apps/backend/src/modules/10-hope/seams/{index,providers,store}.ts;
existing seam in M1 registry — packages/types/src/seams.ts (HopeTimepointProvider line ~143) +
apps/backend/src/bootstrap/seams/{registry.ts REQUIRED_SEAMS, providers.ts deny-stubs}.

HARD RULES:
1. The new seam HopeOrgRollupProvider is M10-owned (ownerModule 10, phi: true). Its interface lives in
   packages/types/src/hope.ts (a leaf both M10 and the registry import). It is AGGREGATE-ONLY: returns COUNTS,
   never patient rows (D6). Org scope is an explicit organizationId param; the Drizzle reader runs under the
   caller's RLS (withOrgContext at the worker) — belt-and-suspenders WHERE organization_id = $org too.
2. Do NOT edit packages/db schema or migrations, or any module other than M10 (apps/backend/src/modules/10-hope,
   packages/hope), M30 (apps/backend/src/modules/30-quality, packages/quality), and the M1 seam registry
   (packages/types/src/seams.ts + hope.ts, apps/backend/src/bootstrap/seams/*). Do NOT touch git.
3. noUncheckedIndexedAccess + strict TS. Use single quotes for inline code in prose. Match surrounding idiom.
Return structured data (your text is data, not a human message).`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['filesCreated', 'contractNotes', 'assumptions', 'risks'],
  properties: {
    filesCreated: { type: 'array', items: { type: 'string' } },
    contractNotes: { type: 'array', items: { type: 'string' }, description: 'exact exported symbols/signatures the other phases bind to' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'domain assumptions made (esp. the pain-code + threshold sources)' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
phase('Seam contract')

const contract = await agent(`${RULES}

YOUR TASK — define the SHARED CONTRACT both M10 (producer) and M30 (consumer) bind to. Make it compile.
1. packages/types/src/hope.ts — add the HopeOrgRollupProvider interface (aggregate-only, typed returns):
   - timepointCompletionRollup(organizationId, period:{from,to}): Promise<{ onTime: number; late: number }>
   - submissionPostureRollup(organizationId, period:{from,to}): Promise<{ submissions: number; acceptedSubmissions: number }>
   - sfvTimelinessRollup(organizationId, period:{from,to}): Promise<{ sfvDue: number; sfvOnTime: number }>
   - j2051FollowUpRollup(organizationId, period:{from,to}): Promise<{ painTriggers: number; painFollowUpsInWindow: number; nonPainTriggers: number; nonPainFollowUpsInWindow: number }>
   - openSfvObligationCount(organizationId): Promise<number>
   Also export const HOPE_J2051_PAIN_SYMPTOM_CODE = 'pain' here (the documented pain/non-pain discriminator).
2. packages/types/src/seams.ts — add 'HopeOrgRollupProvider' to the SeamName union (beside the other Hope*
   entries ~line 143) and add HopeOrgRollupProvider: HopeOrgRollupProvider to the SeamContracts map (import the
   type at the top like the other hope seams).
3. apps/backend/src/bootstrap/seams/registry.ts — add the REQUIRED_SEAMS entry { key:'HopeOrgRollupProvider',
   ownerModule:10, phi:true, denyStub: hopeOrgRollupProviderDenyStub } mirroring the existing Hope* entries.
4. apps/backend/src/bootstrap/seams/providers.ts — add hopeOrgRollupProviderDenyStub (every method throws the
   same NotImplementedError the other hope deny-stubs use).
5. packages/quality/src/seams/consumed/m10-hope.ts — REPLACE QualityHopeConsumer so it matches exactly the 5
   HopeOrgRollupProvider methods above (same names + typed returns), so the composition root can bind
   m30HopeConsumer = getSeam('HopeOrgRollupProvider'). Update any importer in packages/quality (measure-recompute.ts)
   that referenced the old Record<string,number> shape.
Run 'bun run build' and fix compile errors in the files you touched. Report the EXACT interface signatures
(contractNotes) so the producer + consumer phases bind precisely.`,
  { label: 'seam-contract', phase: 'Seam contract', schema: SCHEMA })

const c1 = `Contract built. HopeOrgRollupProvider + QualityHopeConsumer signatures: ${(contract?.contractNotes ?? []).join(' | ')}.
HOPE_J2051_PAIN_SYMPTOM_CODE='pain' exported from @chartwarden/types. Assumptions: ${(contract?.assumptions ?? []).join(' | ') || 'none'}.`

// ---------------------------------------------------------------------------
phase('Producer + consumer')

const [m10, m30] = await parallel([
  () => agent(`${RULES}\n\n${c1}

YOUR TASK — M10 PRODUCER side. Build the Drizzle-backed org-rollup store + provider + register it.
1. A dedicated Drizzle aggregate reader (e.g. apps/backend/src/modules/10-hope/seams/org-rollup-store.ts or
   packages/hope/src/seams/org-rollup.ts) implementing the 5 HopeOrgRollupProvider methods over M10's tables
   (import { schema } from '@chartwarden/db'):
   - timepointCompletionRollup: count hope_timepoint_schedule rows status='completed' in period; on-time =
     completed by lateDeadlineAt (join hope_assessment.signedAt of completedByAssessmentId <= lateDeadlineAt),
     late = the rest. Pick a sensible period anchor (the schedule's window or the completing assessment's signedAt).
   - submissionPostureRollup: SUM(itemCount) as submissions, SUM(acceptedCount) as acceptedSubmissions over
     hope_submissions in period (filter status in accepted/rejected/partially_accepted; period by transmittedAt).
   - sfvTimelinessRollup: over symptom_follow_up_visit triggered in period with a terminal status: sfvDue =
     count due, sfvOnTime = count completedAt <= dueAt.
   - j2051FollowUpRollup: over hope_assessment with j2051TriggerFired=true signed in period — for each, inspect
     data.J.J2051.entries: painTrigger = any entry symptomCode = HOPE_J2051_PAIN_SYMPTOM_CODE with severity in
     ('moderate','severe'); nonPainTrigger = any entry symptomCode != pain with severity in ('moderate','severe').
     followUpInWindow = its symptom_follow_up_visit (join on triggeringAssessmentId) completedAt <= dueAt.
     Return painTriggers / painFollowUpsInWindow / nonPainTriggers / nonPainFollowUpsInWindow. You MAY fetch the
     trigger-fired rows' data.J + their SFV status and compute the pain/non-pain split in JS (bounded set, clearer
     + testable) rather than raw JSONB SQL — but keep ONLY counts crossing the seam boundary.
   - openSfvObligationCount: count symptom_follow_up_visit status in ('open','overdue') for the org.
2. createHopeOrgRollupProvider(store) returning HopeOrgRollupProvider; register it in registerHopeSeams
   (apps/backend/src/modules/10-hope/seams/index.ts) via registerSeam('HopeOrgRollupProvider', …) when a db/store
   is present, mirroring the existing Hope* registrations.
3. Tests (packages/hope/__tests__ or apps/backend/__tests__): drive the rollup logic — especially the pain vs
   non-pain split (an assessment with pain=severe + anxiety=mild → painTrigger only; pain=mild + anxiety=moderate
   → nonPain only; both moderate+ → both) and SFV in/out of window. Use seeded rows / an in-memory store double.`,
    { label: 'm10-producer', phase: 'Producer + consumer', schema: SCHEMA }),

  () => agent(`${RULES}\n\n${c1}

YOUR TASK — M30 CONSUMER side. Bind resolveInput for the 4 HOPE-family measures.
1. apps/backend/src/modules/30-quality/jobs/m30-jobs.ts — replace the lazy-unbound resolveInput thunk (~line
   207) with a real per-measure resolver that, for registration.code in {tfp_pi, tfp_npsi, hope_sfv_on_time_rate,
   hope_submission_acceptance_rate}, calls the seams.hope (QualityHopeConsumer) rollups and shapes the calculator
   input; for any OTHER measure code it stays fail-closed (throw the existing unboundWorkerPort error — the
   non-HOPE families are out of scope). Mapping:
   - tfp_pi: j2051FollowUpRollup → { qualifyingPainImpactTriggers: painTriggers, followUpVisitsWithinWindow:
     painFollowUpsInWindow, threshold } (+ the ComputeMeasureInput base: organizationId/providerEntityId/periodStart/periodEnd).
   - tfp_npsi: j2051FollowUpRollup → { qualifyingNonPainImpactTriggers: nonPainTriggers, followUpVisitsWithinWindow:
     nonPainFollowUpsInWindow, threshold }.
   - hope_sfv_on_time_rate: sfvTimelinessRollup → { sfvDue, sfvOnTime, threshold }.
   - hope_submission_acceptance_rate: submissionPostureRollup → { submissions, acceptedSubmissions, threshold }.
   The 'threshold' (ThresholdRule) per measure: source it from the measure registry/thresholds the same way the
   calculator expects it — read packages/quality/src/measures/hope_derived/* + operational/* + result.ts to find
   the ThresholdRule shape and where HOPE thresholds are defined; if none exists, define a documented per-measure
   default in a small map and FLAG it as an assumption.
2. Update any types so the worker's MeasureRecomputePorts.hope (QualityHopeConsumer) matches the new contract.
3. Tests (apps/backend/__tests__/m30-hope-resolveinput.test.ts): for each of the 4 measures, a fake
   QualityHopeConsumer returns seeded rollups and resolveInput produces the correct calculator input; the
   composed input runs through the real calculator to a sane rate/band. Assert a non-HOPE measure still fails closed.`,
    { label: 'm30-consumer', phase: 'Producer + consumer', schema: SCHEMA }),
])

const c2 = `${c1}\nM10 producer: ${(m10?.filesCreated ?? []).join(', ')}. M30 consumer: ${(m30?.filesCreated ?? []).join(', ')}.
Assumptions: ${[...(m10?.assumptions ?? []), ...(m30?.assumptions ?? [])].join(' | ') || 'none'}.
Notes: ${[...(m10?.risks ?? []), ...(m30?.risks ?? [])].join(' | ') || 'none'}.`

// ---------------------------------------------------------------------------
phase('Integrate')

const allFiles = [contract, m10, m30].filter(Boolean).flatMap((s) => s.filesCreated ?? [])
const allRisks = [contract, m10, m30].filter(Boolean).flatMap((s) => s.risks ?? [])

const integration = await agent(`${RULES}\n\n${c2}

YOUR TASK — INTEGRATE and make the FULL GATE green.
Prior agents created: ${allFiles.join(', ')}.  Risks: ${allRisks.join(' | ') || 'none'}.
1. apps/backend/src/index.ts — (a) ensure M10's registerHopeSeams binds the real HopeOrgRollupProvider over a
   Drizzle org-rollup store when dbHandle is present (wire the store created by the producer phase). (b) REPLACE
   the m30HopeConsumer stub (~lines 651-670, the three throwing 'org-wide rollup deferred' methods) with
   m30HopeConsumer = getSeam('HopeOrgRollupProvider') (cast to QualityHopeConsumer — the M22 getSeam(...) as Port
   precedent), so the live M10 rollup backs M30's worker. Keep the worker's withOrgContext(org) envelope intact.
2. Run 'bun run build' → fix every error. Then 'bun run arch:fitness' — the seam-registry sub-check
   (check-fitness-gaps) must still pass with the new seam (56→57 registered); regenerate status-matrix if stale.
   Then 'bun run test' → all green incl. the new M10 + M30 tests.
CRITICAL: only report success if build + arch:fitness + test all exit 0. Put each final status in risks. List
every file edited in filesCreated. Note which of the 4 HOPE measures now compute end-to-end vs any caveat.`,
  { label: 'integrate', phase: 'Integrate', schema: SCHEMA })

return {
  contract: !!contract,
  m10: !!m10, m30: !!m30,
  assumptions: [contract, m10, m30, integration].filter(Boolean).flatMap((s) => s.assumptions ?? []),
  integration,
}
