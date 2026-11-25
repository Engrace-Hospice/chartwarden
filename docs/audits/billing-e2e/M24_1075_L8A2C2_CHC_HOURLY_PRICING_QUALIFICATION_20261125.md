# M24-1075-L8A.2C2 — CHC Hourly Local Pricing Qualification

**Date:** 2026-11-25

**Branch:** `audit/m24-1075-oregon-eocco-readiness-r2`

**Starting HEAD:** `ef891dfade65db748588521fced0ea6382ccee4e`
**Disposition:** `M24_1075_L8A2C2_COMPLETE`

## Scope and representation

This increment adds one supported synthetic home-CHC daily pricing path. It does not create an
institutional claim line. The durable object is the M24-owned, append-only
`medicaid_chc_pricing_preparation`, a patient/admission/service-date scoped local pricing preparation
whose schema and snapshot explicitly state that institutional units are unqualified, institutional
format is not qualified, and posting is unauthorized. It cannot enter the claim READY or submission
state machine. Existing RHC pricing snapshot v1 and v2 representations are unchanged.

The ordinary M24 preparation API accepts only patient, admission, provider and service date selectors.
It does not accept client-authored rates, charges, minutes, synthetic/verified flags, or clinical
eligibility. The server resolves all current evidence and the API applies permission, provider-entity,
patient-caseload, AI-principal and idempotency protections. A scoped GET returns financial details only
after revalidation confirms current source evidence.

## Evidence owners and clinical quantity

- **M6:** the transaction-bound LOC reader supplies the effective CHC LOC period, version, status,
  assignment reason and assigning actor. The supported synthetic clinical indication is the explicit
  `symptom_crisis` LOC reason; M24 does not author or change LOC records.
- **M8:** the signed-interval reader returns persisted organization/provider/patient/admission,
  encounter id/version, discipline, sign/co-sign state and times, actual start/end, time source, void
  state, location id, and M1-owned service-site facts. M8's database query includes carry-in candidates;
  M24 clips them to the exact local day and refuses invalid, future-signed, voided, duplicate or
  overlapping sources. `cosigned` requires a final co-sign timestamp. Scheduled duration is never used.
- **M1:** the existing `FoundationSiteReader` now exposes locked location owner/state/timezone facts to
  the M8 reader. M8 no longer queries the M1 location table directly. Provider/location rows remain
  locked in the assessment transaction. The service timezone comes from the encounter's service
  location; absent, conflicting or invalid zones hold.
- **M24/M40:** verified payer-program assignment and canonical managed-care classification, rate,
  locality/quality and independent billed-charge evidence are re-read for the selected date. A synthetic
  verified hourly method is an isolated qualification fixture only; it is not an Oregon or EOCCO policy.

Observed minutes remain a distinct M8-derived result with payer eligibility unresolved and institutional
units unqualified. A separate qualification function requires the M6 crisis LOC, signed RN actual-time
sources and the explicit verified method. One home service day and whole-hour local quantity are the
only persisted CHC profile. The existing exact pricing engine is also tested with non-whole-hour
quantities; fractional local persistence is not enabled.

## Calculation and persistence

The live synthetic scenario observed and qualified 540 actual minutes (including a carry-in interval
clipped at the authoritative local-day boundary). The shared `assessHospicePricing()` engine applied a
fictional 5,000-cent hourly rate to nine hours for a 45,000-cent estimated reimbursement. Independent
synthetic provider-charge evidence supplied 7,000 cents/hour, so billed charges were 63,000 cents.
These are test values, not Oregon, OHA, EOCCO, Medicare or customer rates.

The versioned snapshot preserves admission/LOC identity and versions, date/timezone, encounter ids and
versions, eligibility-method evidence, payer classification and assignment provenance, rate/billing
evidence versions, locality/quality and local coding evidence, observed and qualified minutes, hourly
conversion and rounding, ceilings, estimate, independently sourced charge and fingerprint. It contains
no raw note text or demographics. Reimbursement is not substituted for the billed charge.

Migration `1557_m24_chc_local_pricing_preparations.sql` is forward-only and `contract`. It adds an
explicit CHC maximum-minute bound (a per-hour rate only, at most the pricing engine's 1,440-minute day, never
below its minimum), expands only the bounded CHC local evidence profile, and creates the append-only
preparation table with organization/provider scope, RLS and FORCE RLS, audit insertion, and application
SELECT/INSERT grants only. Its insert guard refuses a snapshot that omits a fact or carries a malformed
number (a 23514 refusal, never a cast error), a rate or evidence row that has a successor, a rate without a
cap, a rate and evidence that disagree on locality or quality variant, an assessment time in the future or
before the sources were recorded, and a version that is not the next one of its service day. Every CHECK that
could evaluate to NULL is wrapped in `IS TRUE`. The fingerprint is bound to the snapshot's own copy and is not
recomputed in SQL, and row triggers do not fire on TRUNCATE (the same limits as migration 1551). UPDATE and DELETE are not
granted and are rejected by the database. No historical RHC snapshot or financial row is rewritten.
The migration remains subject to the repository's contract hold; it was applied only in the private
disposable qualification database. Preparation rows add patient-linked financial evidence. CW-DS-01
remains open; this lot sets no retention duration and adds no destruction capability.

## Revalidation and refusal behavior

The same source-grounded verifier is used for immediate/manual reads and the background M24 revalidation
job. The job takes the admission and the rate-policy scopes of a patient's preparations together with the
claims' own, in the one fixed order the claim paths use (admission row, then rate-policy and evidence
locks), before it verifies anything; each verification runs in its own savepoint and reads the clock after
its locks. The job only logs a preparation that is no longer current (ids and a reason code) and writes
nothing: no verdict is stored, so a read always recomputes it. It re-reads M5/M6/M8/M1/M40/M24 evidence and recomputes the clinical quantity, hourly estimate,
independent charge and canonical fingerprint. It does not trust a stored hash alone or rewrite an old
snapshot. A changed billing-evidence version produces a stale result; a correctly fingerprinted but
arithmetically altered snapshot is not returned as a trusted financial observation. Evidence or
identity gaps fail closed. The non-overridable M24 pricing and institutional-format readiness rules stay
in force; a local CHC preparation cannot satisfy institutional format.

## Targeted qualification

| Check | Result |
| --- | --- |
| Private PostgreSQL `test:m24:claim-line-assembly:live` | Passed on the final tree (see the PR for the counts; 4 tests are skipped, as before). Fresh schema applied the full migration chain through 1557. The positive path used the actual M5/M6/M8/M1/M40/M24 readers, existing pricing engine and preparation service. |
| CHC live positive | Passed: persisted version 1; 540 observed/qualified minutes; 45,000-cent estimate; 63,000-cent independent billed charge; current manual and background revalidation; institutional qualification false. Concurrent identical preparation deduplicated to one record. |
| CHC live negative/integrity | Passed: scope, date, admission and membership refusals with their stable codes; an uppercase id resolved to the same preparation; a changed M8 encounter source version; a corrected billing-evidence row that makes the current version stale (it verified as current immediately before); a corrected rate whose superseded predecessor sorts first (the head is selected); RLS/provider ABAC denial; SQL update refusal; a privileged stale-hash tamper followed by a new immutable version (without rewriting the prior row); and a correctly re-fingerprinted version whose only change from the current one is its amounts, withheld by source-grounded verification. The job waits at the claim rows, holding neither the admission row nor an advisory lock, while another transaction holds a claim. No claim, submission, READY event or financial outbox was created. The guard's own refusals are pinned in the `m24-rls-isolation` live suite. |
| Focused Vitest (M1 site reader, quantity, qualification, M24 ABAC, the preparation route, shared pricing) and the web DOM tests for the preparation panel | Passed on the final tree (see the PR for the counts). The panel's tests pin the amounts-only-when-current rule, the refusal wording, a response that arrives after the preview changed, and the add-on gate. |
| Hourly exact-arithmetic coverage | Passed in the shared pricing suite, including a one-minute fractional hourly quantity and explicit rounding behavior. Fractional local persistence remains disabled. |
| `bunx tsc -b packages/types packages/db packages/medicaid-adapters --pretty false` | Passed. |
| Bounded backend source TypeScript | Passed with `NODE_OPTIONS=--max-old-space-size=2048` against a temporary project containing 12 directly changed M24/M6/M8/M1 files. The earlier 1 GiB attempt ran out of memory and is not counted as a pass. Full backend typecheck was not run. |
| Migration numbering, migration compatibility, DDL legality, tenancy, manifest mirror, ABAC predicates/composition, route reachability, table ownership | Passed for the relevant scoped gates. The first ownership run identified a direct M8→M1 location-table join; it was replaced with M1's locked `FoundationSiteReader` contract and the table-ownership gate then passed. |
| OpenAPI/client | `openapi:emit`, `client:gen`, and `client:check` passed; generated schema reflects the two preparation endpoints. |
| Changed-file Biome | Passed: all 40 changed TypeScript, TSX and JSON files. |
| Module docs, compliance register | Passed: M6/M8/M24 module documentation validation and `arch:compliance`. The M24 pricing control row (CW-PI-06) evidence links and gap text were updated; its status is unchanged and the register change needs the owner's approval. |
| Scoped PHI scan | Passed: 50 changed paths clean. |
| Secret scan | Gitleaks is not installed locally; no secret-scan pass is claimed. |
| `git diff --check` | Passed. |

The live suite retains four unrelated skips: three replacement/void cases requiring qualified outbound
lineage and the own-IPU Q5006/GIP case. They are outside this lot. No replacement, GIP, IRC, in-home
respite, RHC election history or payer-certified coding behavior was added.

## Limitations and safety

The verified inputs used above exist only in the private disposable database. They do not establish an
Engrace customer evidence-authoring process, EOCCO enrollment, an EOCCO clinical threshold, contractual
rates, payer acceptance of codes/units, institutional-format qualification or production authorization.
There is no production price or claim line from this preparation. The full monorepo tests, full backend
typecheck, full architecture fitness, dependency-cruiser, release-image qualification and L7 aggregate
qualification remain previously tracked work and were not restarted here.

No live payer/vendor request, electronic submission, ERA retrieval, payment, ledger mutation, financial
outbox event, production/shared migration, deployment, credential change, retention exception or merge
occurred. Synthetic evidence was not promoted into production.
