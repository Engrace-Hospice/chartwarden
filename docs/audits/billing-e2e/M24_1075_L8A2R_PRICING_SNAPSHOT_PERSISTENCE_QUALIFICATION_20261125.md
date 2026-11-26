# M24-1075-L8A.2R — Immutable Pricing Snapshot & RHC Persistence Recovery

Date: 2026-11-25
Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
Starting HEAD: `4644bf54fc8ca1ca945c7adb3e9107ad64eab9ac`

## Result

`M24_1075_L8A2R_COMPLETE` — the narrow synthetic daily-RHC persistence slice is implemented and qualified. This does not complete the broader L8A.2 clinical scope, qualify EOCCO pricing or authorize Medicaid transmission.

## Implemented vertical slice

M24 now has an append-only, scoped billing-evidence profile for Oregon managed-care daily RHC. It records organization/provider, patient/admission and admission version, canonical payer/program, service period, locality source/version, quality-reporting applicability/source/version, daily quantity ownership, local code profile, billed-charge source/version, verification metadata and supersession. The application reader selects one effective verified evidence head for the exact scope; absent, stale, conflicting, foreign-provider or foreign-tenant evidence remains unresolved.

The new `1551_m24_immutable_hospice_pricing_snapshots.sql` migration adds `medicaid_hospice_billing_evidence` and `medicaid_claim_line_pricing_snapshot`, plus `payer_rate_policy_id_snapshot` on claim lines. It is forward-only and classified `contract`. The migration does not rewrite historical claim lines or snapshots. New non-R&B lines identify exactly one legacy schedule or payer-rate source; payer-rate lines have a source-linked immutable snapshot. Both new tables use organization RLS with FORCE RLS, scoped foreign keys/indexes, audit triggers, insert guards and append-only update/delete triggers. A deferred claim-line constraint requires a pricing snapshot after both INSERT and UPDATE, closing the legacy-line pricing-source-switch gap; the claim-line range and amount checks remain enforced. No fake state-rate-schedule row is created.

The single RHC pricing resolver is used by assembly preview, transactional assembly and snapshot revalidation. It resolves M6's current admission and LOC versions, reads M5's primary residence history on the same organization-scoped transaction, requires exactly one stable home address covering the complete inclusive service window for the supported local Q5001 profile, counts daily units only from active RHC LOC calendar days, and splits a continuous LOC span at effective payer-rate boundaries. Missing, changing, overlapping, or facility residence evidence is unresolved or unsupported. The M5 seam returns only address-row identity, residence kind, facility identity and effective dates; its transaction reader checks tenant scope and holds matching rows against concurrent closure through commit. Each persisted line has a matching immutable snapshot with payer/program, rate/evidence identities and versions, service-location identity/window, locality/quality/quantity/coding/charge provenance, inclusive service dates, method/version, reimbursement estimate, billed charge, applied ceiling details, fingerprint and `postingAuthorized: false`.

The synthetic private-PostgreSQL scenario persisted two line segments within one RHC LOC period. The first used a 12,000-cent/day synthetic rate and the second 13,000 cents/day; each two-day line stored a distinct 30,000-cent billed charge. Snapshot reimbursement estimates were 24,000 and 26,000 cents. The test demonstrates that the provider charge and reimbursement estimate remain separate. These values and payer records exist only in the disposable qualification database.

## Readiness and revalidation

Manual and background validation call the same snapshot revalidator. It re-reads M40 payer classification, M24 assignment, current M6 LOC/admission versions, rate lineage, billing-evidence head and stored snapshot identity/fingerprint/arithmetic. A corrected source makes existing snapshots stale; validation records a failure and does not rewrite them.

The existing non-overridable `medicaid_payer_rate_policy_snapshot_verified` subcondition passes for the current synthetic snapshot. A separate non-overridable `medicaid_hospice_institutional_format_qualified` platform rule was added, with rule-set version 7, because `local_draft_only` is not a qualified 837I profile and `READY` enables the submit action in M24. Manual and background runs therefore keep this claim in `FAILED_VALIDATION` even while pricing evidence itself is current. No submission row or ready/submission event is created. `submissionAvailable` and electronic-submission availability remain false.

The assembly preview and wizard now show the evidence-based draft billed charge separately from estimated reimbursement and state that neither means allowed or paid. No rate-authoring, clinical-evidence authoring, or verification UI was added. Production evidence remains operationally held until those owner workflows exist.

## Focused qualification

The live PostgreSQL assembly test uses the actual M5 coverage reader, M6 transaction-bound admission/LOC reader, M40 canonical payer classification reader, M24 assignment and rate-lineage readers, M24 assembly transaction, and application role. It verifies:

- Missing billing evidence refuses assembly without leaving a claim or line.
- A concurrent pair of identical assemblies produces one persisted claim; the competing request receives `MEDICAID_HOSPICE_SERVICE_RANGE_ALREADY_CLAIMED` and leaves counts unchanged.
- Two payer-rate periods within one continuous RHC LOC persist as two lines and snapshots with exact inclusive dates, units and separate money fields.
- Snapshot identity, fingerprint, schema version and `postingAuthorized: false` are present.
- Each snapshot carries the M5 home-address row identity and effective interval; missing, facility, overlapping and incomplete residence spans are rejected by the shared qualification helper, and changed residence evidence is re-read during manual/background validation.
- Manual and background pricing-snapshot results pass for current evidence; both detect a superseding evidence correction without rewriting snapshots.
- The local draft-format gate remains a non-overridable failure; manual/background validation do not advance the claim to `READY`.
- The application role cannot update snapshot evidence; database append-only triggers reject administrative updates to snapshots and claim-line amounts.
- Under the non-bypass `chartwarden_app` role, an UPDATE converting a legacy schedule line to a payer-rate line without a snapshot fails at COMMIT with SQLSTATE `23514`; the original line remains unchanged.
- The evidence reader returns the same unresolved result for a wrong provider scope or wrong tenant scope.
- No submission row or ready/submission outbox event is produced.

A fresh focused security review found no remaining blocker. It caught two defects before completion: local Q5001 assembly did not require a patient home residence, and the first migration draft required snapshots only after INSERT. Both were corrected, covered by the live/unit tests above, and re-reviewed. Multi-span residence changes are conservatively refused for one claim window and require a separately assembled split.

The focused M24 PostgreSQL/RLS, FK-index, package test/typecheck and architecture/documentation outcomes are recorded below after execution. The live suite retains seven older skips, each with a separate reason:

1. September/October original-claim TOB cadence: the existing fixture lacks the new scoped payer assignment, evidence profile and rate lineage for those dates. Concurrent same-window duplicate refusal is newly exercised by the RHC fixture; cross-period TOB sequencing remains deferred.
2. Accepted 817 replacement before the next original: replacement pricing-lineage and format rules are not qualified.
3. Malformed predecessor control number: it belongs to the same unsupported replacement flow and still lacks its pricing fixture.
4. Missing state-adapter replacement support: no replacement/void pricing or output qualification is in this lot.
5. Assisted-living Q5002: the qualified slice is only daily home RHC/Q5001; residence-specific coding evidence is absent.
6. Own-IPU Q5006: IPU bed/location evidence and GIP coding remain unsupported.
7. Signed encounter linkage: the positive pricing path uses the owner seam with no encounter links; a qualified M8 signed-encounter reader is not included in this slice.

## Remaining clinical and external dependencies

The evidence table is an M24-owned contract and read seam, not an operational evidence-authoring UI. The synthetic locality and charge provenance do not qualify real service locations or customer charges. No Oregon FFS or EOCCO rate was loaded, approved or activated. This work does not resolve provider quality reporting beyond an explicit source-backed applicability record, CHC clinical minutes, RHC election-day rules, IRC day sequence, in-home respite, qualified institutional coding, payer authorization, 837I conformance, clearinghouse enrollment or production transport. No secondary Medicaid Room & Board path is changed.

CW-DS-01 remains open for patient-linked billing evidence and snapshots. The table contains scoped source references and minimal identifiers, not raw clinical notes or EDI. This change does not select a retention period, authorize deletion, or add an erasure path; the compliance owner must decide whether the existing billing-record destruction lifecycle covers these rows.

## Safety

All fixtures are synthetic and confined to a private disposable PostgreSQL container. No vendor, payer or clearinghouse request occurred. No real rate, enrollment, patient evidence, authorization or claim was added. No payment, ledger, financial claim-state or financial outbox mutation occurred. Medicaid electronic submission remains disabled. No production/shared migration or deployment occurred.

## Verification record

### Passed

- `CHARTWARDEN_TEST_DATABASE_URL=postgresql://…@127.0.0.1:55433/postgres bun run test:m24:claim-line-assembly:live` — **28 passed, 7 skipped (35 total)** on the final L8A.2R code. This used the private disposable PostgreSQL container, real migrations through 1551, real M5 transaction-bound residence, M6/M40 readers, M24 assembly/revalidation services, and the non-bypass application role. It proved the persisted two-rate-segment RHC case, residence identity snapshots, snapshot reads and isolation, stale-source holds, append-only protections, UPDATE source-switch rejection, manual/background checks, and no submission/ready event.
- `CHARTWARDEN_TEST_DATABASE_URL=postgresql://…@127.0.0.1:55433/postgres bun run test:rls:live:m24` — **81 passed**. Includes the new billing-evidence RLS and append-only cases. The assembly suite separately proves tenant-scoped snapshot visibility.
- `bunx vitest run apps/backend/src/modules/24-billing-medicaid/pricing/rhc-pricing-snapshot.test.ts packages/medicaid-adapters/__tests__/rules.test.ts packages/medicaid-adapters/__tests__/hospice-pricing.test.ts apps/backend/__tests__/m24-rb-assembly-integrity.test.ts` — **66 passed**, covering home span completeness and missing/facility/ambiguous refusal plus the affected pricing and billing regressions.
- `bunx tsc -p packages/medicaid-adapters/tsconfig.json --noEmit --pretty false` and `bunx tsc -p packages/db/tsconfig.json --noEmit --pretty false` — passed.
- `bunx tsc -p apps/web/tsconfig.json --noEmit --pretty false` — passed.
- `bunx tsc -p packages/types/tsconfig.json --noEmit --pretty false` — passed for the updated M5 residence seam contract.
- `bunx biome check` on 27 changed TypeScript/TSX/CJS files — passed, no fixes applied.
- `bun run arch:ddl`, `bun run arch:tenancy`, `bun run arch:tables`, `bun run arch:migration-numbering`, `bun run arch:migration-compat`, `bun run arch:module-docs`, `bun run arch:compliance`, `bun run docs:ui`, and `bun run client:check` — passed. Migration numbering reports unique ordinals; migration compatibility reports the new migration's `contract` classification. Module-doc checks passed after this report was created. CW-PI-01 evidence references were refreshed with approval; its control status remains unchanged and the report explicitly does not present the local live suite as CI evidence.
- `bun run arch:test-typecheck` — passed; all 3,595 Vitest files remain in a typecheck program. The updated `@chartwarden/types` project check passed after making M5 residence-row identity explicit.
- Scoped PHI scan on the changed PHI-relevant files — passed (18 files clean). `git diff --check` — passed.

The live assembly run emitted an existing `pg` warning about `client.query()` while another query is executing; the suite completed successfully. The seven skips are individually listed above; none are required for the supported synthetic daily-RHC slice.

### Failed or incomplete qualification

- `bun run test:fk-indexes:live` — **3 passed, 1 failed**. The aggregate catalog check reports 17 FK-index findings on pre-existing tables from other modules (Claim.MD/Medicare/supporting paths); inspection found no FK-index finding for migration 1551 or the new M24 tables. This repository-wide live gate remains failed and is not represented as green.
- `NODE_OPTIONS=--max-old-space-size=2048 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — did not complete; V8 exhausted the 2 GiB heap. A bounded direct-file TypeScript check of the changed M24 backend entry files also exhausted its 1 GiB heap. Neither is a pass. Package DB/adapter and web project checks above passed.
- Local `gitleaks` is unavailable; no secret-scan pass is claimed. The scoped PHI scan did pass.

### Not run in this lot

Full monorepo tests, full repository typecheck, full architecture fitness/dependency-cruiser, release-image or production Compose qualification, and the historical L7 group campaign were not repeated. They are outside this lot's targeted scope. No migration was applied outside the private disposable database.
