# M24-1075-L8A.2C3 — Election History, Rate Buckets and IRC Continuity

Date: 2026-11-26
Disposition: `M24_1075_L8A2C3_COMPLETE`

## Scope and baseline

This increment implements two local-only daily pricing profiles on top of the previously qualified RHC
v1/v2 and CHC preparation paths. The actual local branch baseline was `abb8dfaadf140364450ac93d4c4c9140cd70362d`; the
prompt's `374c8b3110f35e6859afb599bfe9ec7f08087a41` was stale. At inspection, origin's feature ref also
pointed to `abb8dfaadf140364450ac93d4c4c9140cd70362d`.

GitHub PR #1115 was already merged before this lot began (merge commit `639deac2201b6800c92f6bc3a683d414f7e3ea6d`).
It therefore could not remain Draft or receive this work as a PR update. No merge, deployment or change to
`main` was performed by this lot. The L7 aggregate/release qualification remains separate and outstanding.

## Checkpoint A — RHC election history

M6 now owns an append-only, admission/provider/election-scoped completeness evidence contract and a bounded,
transaction-bound reader. The reader locks the current admission, election periods/statements, transfers,
revocations and completed discharges; caps every history query at 101 rows and marks a result truncated when
the 100-row bound is exceeded. The completeness evidence is separate from the signed election and does not
copy clinical narrative. Scope, source versions, correction lineage and four-eyes verification are checked
before the M24 resolver can use it.

M24's `resolveRhcElectionDayRange()` is deliberately limited to the explicit synthetic
`current_signed_election_calendar_days_v1` managed-care method and one continuous first election. It derives
the calendar day from the signed election effective date, not admission, claim, month or benefit sequence.
It refuses missing/partial/truncated/contradictory history, unknown prior hospice, transfer-in/out,
interruption, revocation, discharge or subsequent-election semantics. The resolver supplies source-bound day
evidence to the existing `assessHospicePricing()` engine and daily planner; it does not implement a second
rate calculation.

In the live synthetic fixture, one claim for 2026-02-27 through 2026-03-05 resolved election days 58–64.
It persisted two draft lines and snapshot-v3 rows:

| Service dates | Election days | Rate bucket | Reimbursement estimate | Independent billed charge |
| --- | ---: | --- | ---: | ---: |
| 2026-02-27–2026-03-01 | 58–60 | 1–60 | 36,000 cents | 45,000 cents |
| 2026-03-02–2026-03-05 | 61–64 | 61+ | 56,000 cents | 60,000 cents |

Both bucket rows and all provider, payer, locality, quality-applicability, coding and charge records were
fictional rows in the private disposable qualification database. The actual M6 reader, pricing planner,
claim assembly transaction, snapshot writer and source-grounded validation were used. Manual and background
`medicaid_payer_rate_policy_snapshot_verified` passed while the non-overridable institutional-format rule
failed. After an incomplete, pending correction superseded the election-history evidence, validation failed
the stored pricing snapshot without rewriting it.

## Checkpoint B — IRC episode continuity

M37 now exposes a narrow transaction-bound reader over its actual `irc_episode`, arranged `ipu_admission`
and `ipu_remote_inpatient_episode` rows, joined and scoped to the M6 LOC. The projection preserves episode,
admission, remote-stay, facility and source versions; it uses the existing M37 organization-local service-day
convention and refuses multiple candidates, facility mismatch, transfer transitions, unsupported carryover,
incomplete stay coverage and stale evidence. M40's locked facility-kind reader must identify the same active
hospital.

The IRC planner accepts only the synthetic managed-care daily local profile with complete episode, facility,
LOC, rate, quality-applicability and independent charge evidence. It calculates consecutive episode days
from the real episode start, not from the claim or month, and retains the existing conservative five-day
refusal. No cap override, resumption, GIP, own-IPU Q5006, or payer-specific coding is qualified.

The actual M24 assembly service persisted a local draft for 2026-11-01 through 2026-11-03 from the synthetic
episode beginning 2026-10-30 and the actual synthetic stay through 2026-11-04. Its one line and snapshot-v4
record preserve episode days 3–5, three daily units, 54,000 cents of estimated reimbursement and 66,000 cents
of separately evidenced charges. Manual and background snapshot verification passed. Institutional-format
qualification failed and no submission attempt was created.

## Persistence, snapshot compatibility and operator preview

Forward-only migration `1558_m24_election_history_bucket_pricing.sql` adds the append-only M6 evidence table,
RLS/FORCE RLS, audit and identity guards, the bounded reader function, qualified election-bucket evidence,
the RHC v3 shape and the narrowly validated IRC v4 shape. The existing RHC v1 home/Q5001 and v2
assisted-living/Q5002 paths remain intact. Existing snapshot rows and financial facts are not rewritten.
The migration remains `contract`-held; this run applied it only in the fresh private disposable database.

The assembly preview now returns only election day/bucket ranges and IRC episode start/day ranges for
resolved segments. The wizard explains why RHC segments split and that local IRC pricing is not an
institutional format qualification. It does not return raw source identifiers or snapshot JSON. Submission
availability remains false.

## Qualification evidence

- `PATH=/home/jacob/.bun/bin:$PATH CHARTWARDEN_TEST_DATABASE_URL=postgresql://…@127.0.0.1:55435/chartwarden_test bun run test:m24:claim-line-assembly:live` — **28 passed, 4 skipped, 0 failed**. The test harness applied the migration chain through 1558 on private disposable PostgreSQL. The four skips are three replacement/predecessor cases requiring their separate qualified workflow and the own-IPU Q5006/GIP case; they were not enabled or removed.
- `bunx vitest run apps/backend/src/modules/24-billing-medicaid/pricing/rhc-election-day.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/irc-pricing-snapshot.test.ts packages/medicaid-adapters/__tests__/hospice-pricing.test.ts apps/web/src/modules/24-billing-medicaid/claim-assembly-admission.dom.test.tsx` — **4 files, 100 passed**.
- A bounded no-emit TypeScript check over the changed M6/M24/M37 source graph passed before the final database-constraint regression was added. A final repeat using the same 2 GiB cap exited 134 with V8 heap exhaustion and no TypeScript diagnostics; this is an incomplete check, not a pass. The full backend project check was not run, and the temporary config is removed.
- A narrower 1.5 GiB `tsc --noEmit` check over the election-history, RHC/IRC snapshot, and M37 reader sources completed after the final correction. It found no diagnostics in changed files; its only diagnostic was TS2345 in unchanged `packages/x12-837-client/src/testing/local-fake-http-client.ts:82` (`Uint8Array<ArrayBufferLike>` vs `BodyInit`). That unrelated dependency diagnostic remains outside this lot. The changed M37 reader itself had initially exposed a stale `facilityKindSource` requirement; that owner-boundary mismatch was removed and the focused check then reported only the unchanged X12 diagnostic.
- `bun run openapi:emit`, `bun run client:gen`, `bun run openapi:check`, and `bun run client:check` — **passed**; the generated preview contract and client are in sync (2,158 routes enriched).
- Changed-file `bunx biome check` — **24 files passed**. `bun run harness:phi-scan <changed paths>` — **34 files clean**. `git diff --check` — **passed**.
- `bun run arch:migration-numbering`, `arch:migration-compat`, `arch:tenancy`, `arch:tables`, `arch:ddl`, `arch:manifest-mirror`, `arch:compliance`, and `arch:module-docs` — **passed**. Migration 1558 is unique and contract-held; table ownership, DDL legality, forced RLS, module manifests and documentation parity remain valid.
- Local Gitleaks is unavailable. No secret scan result is claimed. The broader full backend typecheck, full monorepo tests, full architecture fitness, dependency-cruiser and L7 release qualification were not rerun; they remain separate qualification debt.

## Focused integrity review

The final schema review found that a verified rate row could carry only an upper election-day bound while
retaining an unqualified election-day method. Migration 1558 now requires the qualified method whenever
either bucket bound is present. The live assembly suite attempts that malformed upper-bound-only row and
asserts the database rejects it with check-constraint SQLSTATE 23514.

The M37 IRC reader supplies episode, stay and facility identity; it does not certify facility kind. M24
therefore independently resolves the locked M40 facility-kind evidence and records that source in the
snapshot only after the identity check. The M37 projection no longer implies that it proved the facility
classification. This keeps episode continuity and facility classification under their respective owners.

## Limitations and safety

The synthetic managed-care methodology is not an EOCCO rule or rate. The five-day IRC hold remains
conservative; the L2 policy register links the current Oregon SOS rule set last rechecked on 2026-11-25,
but an attempt to re-fetch the official page during this lot failed because the network connection reset.
No over-limit exception was implemented. No transfer/reset day-count semantics are asserted. No operational
evidence-authoring UI or production catalog entry is added; unverified real cases continue to hold.

No live payer/vendor request, Medicaid electronic submission, ERA retrieval, payment posting, ledger change,
financial outbox event, production/shared migration, deployment, credential change, merge, or force-push
occurred. No production rate, history or coding evidence was fabricated. No secondary Medicaid R&B path was
enabled. CW-DS-01 retention ownership and the separate L7 integrated qualification remain open.
