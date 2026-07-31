export const meta = {
  name: 'm30-hvldl-family',
  description: 'HVLDL measure family: new M6 DeathDischargeReader seam (denominator) + additive evvBracketState on M8 SignedEncounterDigest (EVV-verified numerator) + M30 resolveHvldlMeasureInput orchestration.',
  phases: [
    { title: 'Contract', detail: 'DeathDischargeReader interface + M1 registry; augment SignedEncounterDigest with evvBracketState' },
    { title: 'Producer + consumer', detail: 'M6 Drizzle DeathDischargeReader; M8 populate evvBracketState; M30 resolveHvldlMeasureInput' },
    { title: 'Integrate', detail: 'composition-root getSeam binding into the M30 worker + gate green' },
  ],
}

const RULES = `
Branch feat/m30-hvldl-family. Building the HVLDL (Hospice Visits in Last Days of Life) measure-input
integration so M30's measure-recompute worker computes the 'hvldl' measure (today it falls into the
fail-closed default in resolveInput). The HOPE family (item 4, merged) is the pattern to mirror.

THE PURE CALCULATOR (packages/quality/src/measures/hvldl/index.ts — do NOT change it) takes:
ComputeHvldlInput extends ComputeMeasureInput = { decedents: HvldlDecedentInput[], nationalAvg, minQualifyingVisits? },
HvldlDecedentInput = { patientId, source:'internal_clinician_recorded'|'hl7_external', cosignStatus?:'cosigned'|'pending',
qualifyingDisciplineVisitsInLastDays: number }. numerator = decedents with >= minQualifyingVisits (default
HVLDL_MIN_QUALIFYING_VISITS=2); denominator = ALL decedents.

ESTABLISHED FACTS (from investigation — VERIFY paths before editing, do NOT re-derive):
- M6 discharge_event (packages/db/src/schema/admission/discharge-events.ts — FROZEN) has dischargeType='death',
  deathAt, admissionId (join admissions for patient_id). It has NO source / cosign columns — so the §4.11
  external-source breakdown is NOT modeled: the census returns source='internal_clinician_recorded' for ALL
  decedents (cosignStatus undefined). HVLDL still computes correctly (the external subset is empty, no risk
  flag) — DOCUMENT this as a known limitation, do NOT invent columns.
- M8 SignedEncountersReader (packages/types/src/encounter.ts, ALREADY a registered M1 seam) has
  signedEncountersForPatientSince(patientId, since) -> SignedEncounterDigest[]. SignedEncounterDigest has
  discipline + serviceDate + status but NOT evvBracketState. The encounter row (packages/db/src/schema/
  encounter/encounters.ts) HAS evvBracketState ('evv_present' | 'evv_missing_documented'). HVLDL counts only
  EVV-verified ('evv_present') qualifying-discipline signed visits — so ADD evvBracketState to
  SignedEncounterDigest (additive, backward-compatible) and populate it in M8's Drizzle reader.
- HVLDL_QUALIFYING_DISCIPLINES (packages/quality/src/measures/hvldl/qualifying_disciplines.ts): the qualifying
  disciplines (FY2025: rn, msw) + HVLDL_MIN_QUALIFYING_VISITS. The last-days window is 3 calendar days.
- nationalAvg = HCI_THRESHOLDS_v2025.hvldlNationalAvg (= 0.62) — packages/quality/src/measures/hci/thresholds.ts.
- HVLDL measure code = 'hvldl' (packages/quality/src/measures/registrations.ts / registry.ts; computeHvldl registered).
- M30 resolveInput: apps/backend/src/modules/30-quality/jobs/m30-jobs.ts (resolveHopeMeasureInput, wired at
  data.resolveInput; the 'hvldl' branch is missing — it hits the unboundWorkerPort default). The HOPE seam is
  composed at the composition root (apps/backend/src/index.ts m30HopeConsumer over getSeam) and passed into the
  worker deps; HVLDL's seams (DeathDischargeReader + SignedEncountersReader) bind the same way.

ARCHITECTURE / HARD RULES:
1. M30 may NOT query M8's encounter table or M6's discharge table directly (check-table-ownership forbids
   cross-module schema access). M30 reads M6 via the new DeathDischargeReader seam and M8 via the EXISTING
   SignedEncountersReader seam — both resolved through getSeam at the composition root.
2. DeathDischargeReader is M6-owned, leaf-typed: its interface lives in packages/types/src/admission.ts; the M1
   registry SeamContracts entry is the TYPED interface (NOT opaque unknown — it's a leaf type, like the other M6
   reader seams), with a concrete throwing deny-stub. The HopeOrgRollupProvider (#107 item 4) is the precedent
   for the registry add (SeamName + SeamContracts + REQUIRED_SEAMS + deny-stub + registerSeam in the module).
3. The M6 DeathDischargeReader Drizzle impl SELF-SCOPES each call in withOrgContext(db, {organizationId,
   userId:''}, tx => …) (it reads on a different connection than the M30 worker — the #107 item 4a lesson; the
   org-rollup-store is the precedent). Belt-and-suspenders WHERE organization_id = $org too. Aggregate-but-
   patient-linked WITHIN the org is fine (M30 computes its own org's measure; nothing crosses a tenant boundary).
4. Do NOT touch packages/db schema/migrations, the pure hvldl calculator, or git. Do NOT put the literal SQL
   current_setting('app.user_id'...) in any comment (check-tenancy string-scans it — use prose). noUncheckedIndexedAccess.
   Use single quotes for inline code in prose. Match surrounding idiom.
Return structured data.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['filesCreated', 'contractNotes', 'limitations', 'risks'],
  properties: {
    filesCreated: { type: 'array', items: { type: 'string' } },
    contractNotes: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
phase('Contract')

const contract = await agent(`${RULES}

YOUR TASK — the SHARED CONTRACT both producers and the consumer bind to. Make it compile.
1. packages/types/src/admission.ts — add:
   - export interface DeathDischargeRow { patientId: PatientId; admissionId: AdmissionId; deathAt: IsoInstant;
     source: 'internal_clinician_recorded' | 'hl7_external'; cosignStatus?: 'cosigned' | 'pending'; }
   - export interface DeathDischargeReader {
       listDeathDischargesInPeriod(organizationId: string, period: { from: string; to: string }):
         Promise<ReadonlyArray<DeathDischargeRow>>; }
   (the HVLDL denominator + the §4.11 source/cosign fields — even though the schema can't populate source today,
   keep them in the contract so the impl can fill them when M6 models external-source deaths.)
2. packages/types/src/seams.ts — add 'DeathDischargeReader' to the SeamName union (beside the other M6 reader
   seams) and DeathDischargeReader: DeathDischargeReader to SeamContracts (TYPED leaf, import the type — NOT
   opaque unknown; mirror the other M6 reader seams like AdmissionCensusReader).
3. apps/backend/src/bootstrap/seams/registry.ts — REQUIRED_SEAMS entry { key:'DeathDischargeReader',
   ownerModule:6, phi:true, denyStub: deathDischargeReaderDenyStub }.
4. apps/backend/src/bootstrap/seams/providers.ts — deathDischargeReaderDenyStub: a concrete typed deny-stub
   whose listDeathDischargesInPeriod throws NotImplementedError (mirror the other M6 leaf-typed deny-stubs like
   admissionCensusReaderDenyStub).
5. packages/types/src/encounter.ts — ADD a field to SignedEncounterDigest: readonly evvBracketState:
   EvvBracketState; (additive — import/use the existing EvvBracketState type). This lets HVLDL filter EVV-verified.
Run 'bun run build' and fix compile errors in files you touched (the SignedEncounterDigest change will break
its constructor sites in M8 — note them for the producer phase but make the TYPES compile). Report the exact
signatures (contractNotes).`,
  { label: 'contract', phase: 'Contract', schema: SCHEMA })

const c1 = `Contract: ${(contract?.contractNotes ?? []).join(' | ')}. SignedEncounterDigest now carries
evvBracketState. Notes: ${(contract?.risks ?? []).join(' | ') || 'none'}.`

// ---------------------------------------------------------------------------
phase('Producer + consumer')

const [m6, m8, m30] = await parallel([
  () => agent(`${RULES}\n\n${c1}

YOUR TASK — M6 PRODUCER: implement + register the DeathDischargeReader.
1. A Drizzle impl (apps/backend/src/modules/06-admission/seams/death-discharge-reader.ts or beside the other M6
   readers): createDeathDischargeReader(db) returning DeathDischargeReader. listDeathDischargesInPeriod
   self-scopes in withOrgContext(db, {organizationId, userId:''}, tx => …): SELECT a.patient_id, d.admission_id,
   d.death_at FROM discharge_event d JOIN admission a ON d.admission_id = a.id WHERE d.organization_id = $org AND
   d.discharge_type = 'death' AND d.death_at >= $from AND d.death_at < $to. Map to DeathDischargeRow with
   source = 'internal_clinician_recorded' (constant — the schema does not model external-source; DOCUMENT this
   §4.11 limitation in a comment) and cosignStatus undefined. Confirm the exact admission table import name
   (schema.admissions) + the discharge enum value 'death'.
2. Register it in M6's registerAdmissionSeams (apps/backend/src/modules/06-admission/index.ts or seams/index.ts)
   via registerSeam('DeathDischargeReader', createDeathDischargeReader(db)) when a db is present (mirror how M6
   registers its other reader seams + the M10 registerHopeSeams precedent).
3. Test (apps/backend/__tests__/death-discharge-reader.test.ts): a fake scoped db (transaction → tx with the
   select chain) returns seeded death rows; assert it opens withOrgContext + maps to DeathDischargeRow.`,
    { label: 'm6-producer', phase: 'Producer + consumer', schema: SCHEMA }),

  () => agent(`${RULES}\n\n${c1}

YOUR TASK — M8: populate the new evvBracketState on SignedEncounterDigest. The contract phase added the field
to the interface; now fill it everywhere a SignedEncounterDigest is CONSTRUCTED so the project compiles + the
real reader carries it:
1. Find M8's SignedEncountersReader Drizzle impl (apps/backend/src/modules/08-encounters/** or packages/encounter/**
   — search for signedEncountersForPatientSince + the SignedEncounterDigest projection). Add evvBracketState to
   the SELECT projection (it is a column on the encounter row) so the digest carries the real bracket state.
2. Fix EVERY other SignedEncounterDigest construction site (in-memory seam doubles, test fixtures, any other
   reader) to include evvBracketState — search the repo for SignedEncounterDigest literals / the digest builder.
   Use the encounter's real evvBracketState; for fixtures default to 'evv_present'.
3. Run 'bun run build' for the M8 surface; report any digest construction site you could not resolve (risks).`,
    { label: 'm8-digest', phase: 'Producer + consumer', schema: SCHEMA }),

  () => agent(`${RULES}\n\n${c1}

YOUR TASK — M30 CONSUMER: resolveHvldlMeasureInput + the 'hvldl' branch.
1. apps/backend/src/modules/30-quality/jobs/m30-jobs.ts — add an async resolveHvldlMeasureInput(request, seams)
   where seams = { deathDischargeReader: DeathDischargeReader; encounters: SignedEncountersReader }:
   - const deaths = await seams.deathDischargeReader.listDeathDischargesInPeriod(organizationId, {from:periodStart,
     to:periodEnd});
   - for each death: const digests = await seams.encounters.signedEncountersForPatientSince(death.patientId,
     <deathAt minus 3 calendar days as ISO>); count = digests.filter(e => QUALIFYING.has(e.discipline) &&
     e.serviceDate <= <deathAt date> && e.evvBracketState === 'evv_present').length. (QUALIFYING =
     HVLDL_QUALIFYING_DISCIPLINES for the period's FY.)
   - build HvldlDecedentInput[] (patientId, source, cosignStatus, qualifyingDisciplineVisitsInLastDays=count) →
     return { ...ComputeMeasureInput base, decedents, nationalAvg: HCI_THRESHOLDS_v2025.hvldlNationalAvg,
     minQualifyingVisits: HVLDL_MIN_QUALIFYING_VISITS }.
   Keep it pure-ish (port-injected seams); the per-decedent N calls are fine for a nightly job.
2. Wire data.resolveInput to dispatch registration.code === 'hvldl' → resolveHvldlMeasureInput with the new
   seams from the worker deps; non-HOPE/non-HVLDL codes stay fail-closed (the existing unboundWorkerPort default).
   Extend M30WorkerDeps + buildM30WorkerPorts to carry the two HVLDL seams (deathDischargeReader + encounters),
   defaulting each to a lazy unboundWorkerPort thunk when absent (the integrator binds them via getSeam).
3. Test (apps/backend/__tests__/m30-hvldl-resolveinput.test.ts): fake deathDischargeReader (2 decedents) + fake
   SignedEncountersReader (one decedent with >=2 evv_present qualifying visits, one with 0) → resolveHvldlMeasureInput
   builds the census; the real computeHvldl over it yields the expected numerator/denominator/rate. Assert only
   evv_present + qualifying-discipline + in-window visits count.`,
    { label: 'm30-consumer', phase: 'Producer + consumer', schema: SCHEMA }),
])

const c2 = `${c1}\nM6: ${(m6?.filesCreated ?? []).join(', ')}. M8: ${(m8?.filesCreated ?? []).join(', ')}.
M30: ${(m30?.filesCreated ?? []).join(', ')}. Limitations: ${[m6,m8,m30].filter(Boolean).flatMap(s=>s.limitations??[]).join(' | ') || 'none'}.
Notes: ${[m6,m8,m30].filter(Boolean).flatMap(s=>s.risks??[]).join(' | ') || 'none'}.`

// ---------------------------------------------------------------------------
phase('Integrate')

const allFiles = [contract,m6,m8,m30].filter(Boolean).flatMap(s=>s.filesCreated??[])
const allRisks = [contract,m6,m8,m30].filter(Boolean).flatMap(s=>s.risks??[])

const integration = await agent(`${RULES}\n\n${c2}

YOUR TASK — INTEGRATE + make the FULL GATE green.
Prior agents created: ${allFiles.join(', ')}. Risks: ${allRisks.join(' | ') || 'none'}.
1. apps/backend/src/index.ts — in the M30 worker-runner block, compose the two HVLDL consumed seams from the
   registry and pass them into buildM30WorkerDeps: deathDischargeReader = getSeam('DeathDischargeReader') (cast to
   the type), encounters = getSeam('SignedEncountersReader') (cast). Mirror how m30HopeConsumer is composed +
   passed. Ensure M6's registerAdmissionSeams binds the real DeathDischargeReader when dbHandle is present (it
   runs in wireModuleSeams — verify it now registers DeathDischargeReader).
2. Run 'bun run build' → fix every error. Then 'bun run arch:fitness' — the seam-registry sub-check
   (check-fitness-gaps) must pass with the new seam (58→59 registered); table-ownership must stay green (M30 must
   NOT directly import M6/M8 schema — only the seams); regenerate status-matrix if stale. Then 'bun run test' →
   all green incl. the new tests.
CRITICAL: only success if build + arch:fitness + test all exit 0. Put each final status in risks. List files
edited in filesCreated. Confirm HVLDL now resolves end-to-end (denominator from M6, EVV-verified numerator from M8).`,
  { label: 'integrate', phase: 'Integrate', schema: SCHEMA })

return { contract: !!contract, m6: !!m6, m8: !!m8, m30: !!m30,
  limitations: [contract,m6,m8,m30].filter(Boolean).flatMap(s=>s.limitations??[]), integration }
