# M24-1075-L6A Implementation Qualification — Payer Classification and Submission Evidence

> **Renumbered on rebase (2026-11-22):** this report was written when the M40/M24 provenance migration was ordinal 1540. Main took 1540 for `1540_m8_encounter_discipline_plan_link`, so the migration is now `1541_m40_medicaid_payer_classification_and_m24_submission_provenance.sql`. Every "1540" below means that migration; the qualification ran on the pre-rebase chain and has not been re-run.

Date: 2026-11-22  
Branch: `audit/m24-1075-oregon-eocco-readiness`  
Starting HEAD: `3c59c667462bf39d36189cba8e60adb327397b13`  
Draft PR: #1088  
Disposition: **`M24_1075_L6A_COMPLETE`**

## Scope and result

L6A implements the two requested data foundations: M40 now owns a source-referenced, effective-dated Medicaid payer/program classification contract, and M24 exposes a scoped claim/submission/acknowledgment evidence projection through the existing M25 seam. The existing outbound submission refusal is unchanged. No classification rows are seeded, no historical attempt is promoted, and no live ERA path or posting behavior is connected.

Both foundations are qualified against fresh disposable PostgreSQL. The first attempt exposed leftover role-owned objects in a second disposable database created during this task; after removing that task-created database and running one suite/database at a time, the full migration chain applied through migration 1540 and both relevant live suites passed as the non-bypass application role. No repository migration guard was bypassed and the shared database was not used.

## M40 payer classification

Migration 1540 adds `mdm_medicaid_payer_program_classification`, owned by M40 and keyed to the canonical M40 payer. Rows carry state, one of `oregon_ffs`, `medicaid_cco`, `other_managed_care`, or `unsupported`, effective dates, verification status, source kind/reference, verifier metadata, and supersession reference. The table is append-only, audited, protected by RLS and FORCE RLS, readable by the application role, and writable only through the canonical M40 writer role. No payer classification is seeded by this change.

The M40 reader returns all matching source records for a canonical payer and state; M24 applies interval and compatibility rules. M24 verification and current claim assembly require exactly one verified classification that covers the full service window and matches the selected payer, service state, and requested program kind. Missing, unverified, expired, overlapping/conflicting, unsupported, wrong-state, and FFS/CCO-contradictory evidence is refused with stable reason codes. M24 stores the classification record ID on a newly verified assignment. Existing assignments and claim snapshots are not backfilled or silently promoted.

Because the catalog is intentionally empty absent source review, current classifications remain unresolved until an authorized M40 catalog process records evidence from an authoritative source. Public listings, names, ZIP codes, MCO-null values, vendor payer IDs, or synthetic fixtures do not qualify a payer.

## M24 submission evidence and M25 seam

Migration 1540 adds nullable source account, test/production environment, payer/program/classification and assignment snapshots, submitted claim version, and provenance disposition to M24 submission attempts. Existing rows remain `unverified`; there is no historical backfill. A partial unique index scopes future vendor transaction identities by organization, provider entity, vendor, source account and environment. An application-role trigger prevents `chartwarden_app` from setting provenance to verified. The fields do not add an outbound submission path or certify vendor acceptance.

`MedicaidClaimMatchProvider.submissionEvidenceForLine` is implemented in the M24-owned seam and exposed through M25's Medicaid claim-facts module as `medicaidSubmissionEvidence`; that wrapper has no production caller yet, so no M25 request path reads the seam today. It scopes by organization, provider entity, and claim control number; joins the M24 claim, assignment, attempts, and linked acknowledgments; returns only non-patient identity and provenance fields; and never queries M24 storage from M25. A claim ID is exposed as `SUBMISSION_EVIDENCE` only for exactly one production attempt with verified source provenance and matching account/vendor transaction, payer/program/classification/assignment snapshots, exact claim version, acceptable persisted attempt result, and an active non-replaced/non-void claim. Otherwise the result is `SUBMISSION_UNVERIFIED` and the claim ID is null. Acknowledgment facts are returned without treating 999/277CA as adjudication.

No current production row can satisfy this contract: outbound Medicaid submission remains refused and no submission provenance is generated. The projection is a future authoritative read boundary, not evidence that a real claim was transmitted.

## Database and tenancy

Migration 1540 is append-only and contains no data rewrite or catalog seed. Classification identity is a logical M40 reference from M24; no cross-module FK is introduced. The classification table permits only application reads and canonical-writer inserts under FORCE RLS; updates/deletes are rejected by a trigger. M24 submission fields are nullable/default-unverified, and the unique transaction index is scoped and partial to complete source identities.

The qualification used a private disposable PostgreSQL container on its own port, not the shared development cluster. With only one test database present at a time, the full migration chain applied through migration 1540. The M40 RLS suite verified global classification reads and denied application-role inserts; the M24/M25 remittance feedback suite verified new submission-provenance refusal behavior and preserved claim-state boundaries. No production/shared database was modified. The disposable database/container is cleaned up after the qualification.

## Validation evidence

Passed:

- `bun run harness:phi-scan <changed-files>` — all 27 changed files scanned and clean.
- `bunx vitest run apps/backend/__tests__/m24-payer-classification.test.ts` — 1 file, 4 tests passed, including replacement supersession and Oregon-only FFS.
- `CHARTWARDEN_TEST_DATABASE_URL=postgres://…/chartwarden_l6a CHARTWARDEN_TEST_NO_PGVECTOR=1 bunx vitest run apps/backend/__tests__/f172-m24-remittance-feedback.live.test.ts` — 1 file, 8 tests passed on the private disposable PostgreSQL cluster; migration chain applied through 1540, suite uses the application role.
- `CHARTWARDEN_TEST_DATABASE_URL=postgres://…/chartwarden_l6a CHARTWARDEN_TEST_NO_PGVECTOR=1 bunx vitest run packages/db/migrations/__tests__/m40-rls-isolation.live.test.ts` — 1 file, 10 tests passed on a fresh database; includes M40 classification RLS/grant assertions.
- `NODE_OPTIONS=--max-old-space-size=2048 bunx tsc -b packages/mdm packages/db --pretty false` — passed.
- `bunx biome check <changed-files>` — 22 changed source/config files passed.
- `bun run arch:tables` — passed.
- `bun run arch:tenancy` — passed, including forced RLS check.
- `bun run arch:ddl` — passed.
- `bun run arch:migration-numbering` — passed; ordinal 1540 is unique.
- `bun run arch:migration-compat` — passed.
- `git diff --check` — passed.
- Independent read-only code/security review identified two medium findings (superseded classifications remained in the candidate set; Oregon FFS was not constrained to state OR). Both were fixed in the pure resolver and database/schema constraints; reviewer rechecked and confirmed both closed, with no new blocker.
- An initial live test attempt failed while dropping a role because another temporary database from this task still held objects. That task-created database was removed; the suites were rerun one database at a time and passed. The shared development cluster was not involved.

Live coverage by suite (private disposable PostgreSQL, application role). Only the two suites listed under "Passed" above were run for this report; the seam cases in the second bullet below were added afterwards, in the PR #1088 review-fix pass, and were not part of the L6A run:

- `packages/db/migrations/__tests__/m40-rls-isolation.live.test.ts` — the M40 classification table's RLS and grants.
- `apps/backend/__tests__/f172-m24-remittance-feedback.live.test.ts` — `submissionEvidenceForLine`: stored attempts project as `SUBMISSION_UNVERIFIED`, cross-tenant reads return nothing and the application role cannot promote provenance to verified (L6A run); a fully qualified production attempt projects as `SUBMISSION_EVIDENCE` with its claim ID, with one refusal per qualification predicate and a same-organization cross-provider case (review-fix pass).

Before the review-fix pass no live suite exercised the seam's proven (`SUBMISSION_EVIDENCE`) path.

Incomplete/blocked:

- `NODE_OPTIONS=--max-old-space-size=3072 bunx tsc -b apps/backend --pretty false` — backend project typecheck exhausted the configured 3 GiB V8 heap. This is not a pass. Package-level `mdm` and `db` typecheck did pass.
- Full `bun run typecheck`, `bun run arch:fitness`, and full `bun run test` were not completed; do not treat scoped checks or prior lot results as substitutes.
- Full architecture-boundary fitness and secret scanning were not completed. The changed-file PHI scan, focused architecture checks, and independent code/security review passed; the full compliance reviewer workflow was not run.

**Update 2026-11-22 (PR #1088 review-fix pass):** at `e91e0ec9b` the branch passes `bun run typecheck`, `bun run lint` and `bun run arch:fitness`; the out-of-memory and not-completed entries above describe the bounded local runs made at the time and are superseded for typecheck and architecture-fitness status. The M40/M24 provenance migration is ordinal 1541. This records the gate status for that commit; it is not a new qualification of this lot's behaviour, and full `bun run test` is not part of this update.

The migration-chain and targeted RLS qualification completed. The backend-wide typecheck OOM and full-repository gates remain review/CI limitations; no type diagnostic was returned before the process exhausted its heap.

## Remaining dependencies and boundaries

- No verified Oregon FFS, EOCCO, or other CCO classification is supplied or approved by this lot.
- No provider enrollment, 835 ERA enrollment, vendor source-account binding, payer-specific acknowledgment, or production submission evidence is created.
- No authenticated Medicaid ERA staging reader, L5 evaluator composition, durable review history, operator API/worklist, or financial posting integration is implemented here.
- No EOCCO payer-specific rule, rate, authorization, or route is qualified.

## Safety confirmation

Medicaid electronic submission remains disabled. No vendor or payer request occurred; no real ERA was retrieved; no payment was posted; no production claim state or financial outbox event was advanced; no legacy submission was marked verified; no EOCCO classification, enrollment, rate, or authorization was invented or approved; no secondary Medicaid Room & Board route was enabled; and no production migration or deployment occurred.

## Final disposition

**`M24_1075_L6A_COMPLETE`** — both data foundations are implemented and the complete migration chain through 1540 plus the focused NOBYPASSRLS suites qualified successfully. Full backend typecheck and full-repository `typecheck`/`arch:fitness`/test gates remain incomplete because backend TypeScript exhausted a bounded 3 GiB heap and this lot did not run the full suite. These limitations remain visible for the consolidated engineering review; they do not imply production or payer qualification.
