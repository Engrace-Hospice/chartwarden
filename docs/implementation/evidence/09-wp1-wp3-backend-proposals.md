# Workflow 09 — backend proposals found by WP1 and WP3 (not implemented)

Written 2026-11-20 while delivering WP1 and WP3, which stayed frontend-only. Each section is a proposal for a separate, explicitly approved change with its own tests; nothing here has been built. Parent evidence: [`09-clinical-visits-documentation-current-state.md`](./09-clinical-visits-documentation-current-state.md) §15.

## Proposal (WP3, not implemented): a read-only gate preview, and `check` in the failure details

Status: PROPOSAL ONLY. WP3 is frontend-only and ships without it. Needs explicit approval (new route, error-contract change).

### Problem
`POST /encounters/:id/finalize` is the only server check of a note, and it MUTATES on pass: status `finalized`, narrative pinned and
frozen, vocabulary pin written, `m8.encounter.finalized` emitted. A clinician who wants to know "what is still between me and
finalize" can only learn it by finalizing. So the blocker panel can say "Not checked yet" and, after a refusal, "what the server named",
but never "what blocks me now" before committing. The panel therefore must not (and does not) claim "ready", and the composer's
client-side "needs attention" count can only advise on check 1 (required sections); it cannot know checks 2, 3, 6, 13.

### Evidence (HEAD e7588e836)
- No pure GET returns a verdict: `/tmp/wf09-wp0/a-backend.md` section 2.1 (route-by-route grep of encounters-routes, draft-section-routes,
  closure-routes, findings-routes; `EncounterViewResponseSchema` has no gate field).
- The gate is already a pure function over resolved facts: `gate/gate.ts:153` `runEncounterComplianceGate(facts)`; the facts resolver is
  `gateEncounter` (`encounters-route-service-db.ts:807-856`), which ends in `assertGatePassed(verdict, at)` (throws). It evaluates every
  check in one pass with no short circuit (`gate.ts:153-234`: one `remediation` array, no early return), so a preview lists every
  failure it can find.
- The `check` id is dropped on the wire: `gate.ts:283-288` maps `remediation` to `{field?, code, message}`; `ErrorDetail`
  (`packages/types/src/errors.ts:13-30`) has no `check`. The web derives the check from `code` (mirror in `review/gate-register.ts`).
- Generated client types `details` as `Record<string, never>[]` (`packages/ui/src/core/api/schema.ts:31910-31925`).

### Smallest change
1. `GET /api/v1/encounters/{encounterId}/gate-preview` (new, read-only):
   - Guards as `GET /encounters/:id` plus `is_author` (check 13 judges the viewer's own draft): `encounter.read` + scope (404 on deny) + author.
   - Draft only. Any other status answers 409 `ILLEGAL_TRANSITION` (nothing to preview).
   - Body: `loadEnc` WITHOUT `lock`, `noteDraft.read`, `gateEncounter`'s fact gathering, then `runEncounterComplianceGate` and return its
     result instead of throwing. No write, no event, no vocabulary/selection checks (those are not gate checks).
   - 200: `{ asOf: ISO, version: int, failures: [{check, code, field?, message}], applies: {vitals: bool, scales: bool, carePlan: bool, drafted: bool} }`.
     `applies` says which conditional checks had anything to judge, so the panel can show "not applicable" instead of silence.
   - Same 503 `COMPLIANCE_GATE_UNAVAILABLE` when a seam (M7/M9/draft) cannot answer. Never a pass.
   - Add it to the closure-gate allowlist (`bootstrap/note-closure-allowlist.ts`) and the web mirror (`shell/note-closure-screens.ts`
     reads are by screen, not route, but `note-closure-allowlist-mirror.test.ts` lists each screen's primary read).
2. Optional, separable: add `check` to `ErrorDetail` (or only to the gate's details) so finalize and sign 422s carry it.
   One line in `assertGatePassed`, plus the TypeBox `ErrorDetail`, plus `bun run client:check` regeneration.
3. Optional, separable: type `details` in the OpenAPI for finalize/sign so the web stops casting (`Record<string, never>[]`).

### Web follow-up if approved
`BlockerPanel` gains one more state source, "Checked at <time> (preview)", rendered from `failures` and `applies`, still never "ready":
the preview is not a promise, finalize re-runs everything and sign runs the gate again (`encounters-route-service-db.ts:2672,2754`).

### Tests
- Route: preview of a draft with a missing required section returns the same `{code, field}` list the finalize 422 returns for the same
  facts (parity), and the row is unchanged afterwards (`status` draft, `version` equal, no outbox row, no `encounter_vocab` pin).
- Check 13: author with an unresolved drafted section sees `DRAFT_SECTION_UNRESOLVED`; a non-author gets 403.
- 503 when the care-plan, scales or draft seam throws; the message carries no upstream text (see the 503 proposal).
- 409 for a finalized note; 404 outside caseload; tenant isolation live suite (private container only).
- Allowlist mirror test and `arch:fitness` pass; OpenAPI enrichment present; `compliance/controls.yaml` gets a row only if a control is added or changed (a read-only preview adds none).

### Out of scope
Attestation provenance (check 9 is still client-asserted and unrecorded) is a separate, approved safety fix, not part of this.

## Proposal (WP3, not implemented): keep upstream error text out of `COMPLIANCE_GATE_UNAVAILABLE`

Status: PROPOSAL ONLY (backend, small). WP3 never renders the server message of a 503, so the web is safe without it.

### Problem
Three `COMPLIANCE_GATE_UNAVAILABLE` (503) throws put the upstream error's own text into the response `message`:
- care-plan seam: `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:765-770`
- scales seam: `:794-799`
- cosigner seam: `:886-891`

each as `... is unreachable (${cause instanceof Error ? cause.message : String(cause)})`. The response then carries whatever the
M7/M9/M5 adapter threw (host names, SQL fragments, ids). Whether that can include PHI is unverified. The drafting path already does the
right thing: `EncounterStateError` keeps `cause` on the error for the server log and the response carries only the fixed `message`
(`lifecycle/errors.ts:140-152`, the constructor's `options.cause`).

### Smallest change
In the three throws, replace the interpolated sentence with a fixed one and pass the cause as `options.cause`:
`new EncounterStateError("COMPLIANCE_GATE_UNAVAILABLE", "the care-plan review check could not be decided: its source is unreachable", undefined, { cause })`
(and the same for scales and cosigner). The M1 handler already logs a 5xx at `warn` with its cause chain.

### Tests
- Unit (non-live): inject a seam that throws `new Error("ECONNREFUSED 10.0.0.5:5432 password=...")` through
  `createDbEncounterRouteService`-level test doubles (or the existing gate tests that build `gateEncounter`'s dependencies) and assert the
  503 body's `message` contains neither text; assert the code and status are unchanged.
- The existing `COMPLIANCE_GATE_UNAVAILABLE` assertions in `encounter-compliance-gate.test.ts` keep passing (they pin code and status, not text).

### Web
No change needed: `compose-feedback.ts` and `write-refusal.ts` already use fixed sentences for this code, and the WP3 blocker panel
renders a fixed sentence for any 5xx.

## Proposal (backend, NOT implemented): resolve a visit to its encounter exactly, and map the one-encounter-per-visit violation

Status: proposal only. WP1 stayed frontend-only; nothing here was changed. Evidence is read at HEAD `e7588e836` plus the WP1 working tree.

### Problem

1. No route resolves a visit to its encounter. `GET /api/v1/encounters` filters on `patientId, admissionId, authorId, status, lateEntryTier, from, to, cursor, limit`
   and nothing else (`apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts`, `EncounterListQuerySchema` ~:303-312; handler
   `routes/encounters-routes.ts` ~:410-428). The visit views carry no `encounterId`. Every visit entry point (My Visits, Visit Detail, Calendar panel)
   therefore reads a list and matches `visitId` in the browser (`apps/web/src/modules/17-scheduling/scheduling-workflow.tsx`, `findLinkedEncounter`).
2. The list is `serviceDate desc, id desc` sliced to `limit` (`encounters-route-service-db.ts` `listEncounters` ~:1691-1712), so a visit whose encounter is not
   in the newest `limit` rows of the patient/admission is reported as "Draft Encounter is created asynchronously" / "still being created", which is
   wrong and sends the clinician to refresh forever.
3. "Not seeded yet" and "will never be seeded" look identical to the UI. The seed consumer `m8.seed-visit-encounter` throws (event retried, then parked
   `failed`) on an illegal type x discipline pair or an inactive admission (`outbox-consumers/m17-visit-scheduled.ts` ~:154-167), so a visit can have no
   encounter for good.
4. `POST /api/v1/encounters` accepts an optional `visitId` that is not validated as a real visit (`encounters-typebox.ts:94`, handler
   `encounters-routes.ts` ~:351-374). If it names a visit that already has an encounter, the partial unique index `encounter_org_visit_unique`
   (`packages/db/migrations/0167_encounter_visit_seed_idempotency.sql`, `packages/db/src/schema/encounter/encounters.ts` ~:144-146) rejects it with
   Postgres 23505. That index has no `businessRule()` registration, so `error-handler.ts` (~:108-125, only registered constraints map to 409) answers
   500 INTERNAL_ERROR. Not reachable from today's UI (the web never sends `visitId`); it is what a "start documentation for this visit" button would hit.

### What WP1 did instead (frontend only, shipped)

`findLinkedEncounter` now asks for the visit's own service date first (`from=to=visit.serviceDate`, the seeded encounter carries the visit's date:
`m17-visit-scheduled.ts` ~:151) and falls back to the admission's newest 50 as before. That removes the "outside the newest 50" failure in practice
(a patient has a handful of encounters per day), but it is still a heuristic: one extra read when nothing matches, and it cannot tell "not yet" from "never".

### Smallest backend change

A. Add `visitId` (uuid, optional) to `EncounterListQuerySchema` and `listEncounters` (`eq(ENC.visitId, filters.visitId)`); pass it from the route. Same
   preHandler, same caseload narrowing (`listScopeOf`), same read audit. One exact read per visit entry; the web then drops the date window and the 50-row cap.
B. Register `encounter_org_visit_unique` with `businessRule()` beside its index (as `face-to-face-encounters` does for its own) so a duplicate is a 409
   CONFLICT with that meaning instead of a 500. Optional: reject a `POST` `visitId` that is not a visit of the same patient/admission (separate decision; it
   touches the M17 seam).
C. (Optional, larger) Return the seed state on the visit view (`encounterId` or a `documentationState`: pending | linked | failed) so the UI can say
   "will never be created, ask an administrator" instead of "refresh". Needs an M17<->M8 seam decision; not required for WP1.

### Tests

- Route inject test: `GET /encounters?visitId=<v>` returns only that visit's encounter; another tenant's visit id returns an empty list (RLS); a caseload-narrowed
  caller gets nothing for a visit outside their caseload; a malformed id is a 400 envelope.
- `listEncounters` service test: visitId combined with patientId/admissionId filters.
- Constraint test: two encounters with the same `(organization_id, visit_id)` raise a 409 with the registered meaning; two with `visit_id IS NULL` stay legal.
- Web: `findLinkedEncounter` sends `visitId` and makes one read; the date-window fallback test (`visit-workflow.dom.test.tsx`, "finds the Encounter inside the visit's own service date") is replaced.
- Regenerate the typed client (`bun run client:check`) and the OpenAPI coverage baseline.

### Not changed / out of scope

No schema or migration, no status, no authorization change. A `visitId` filter is a read narrowing on an already audited route.
