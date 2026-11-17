# M25 835 parser and payee identity (#671)

> Point-in-time integration record. Generated implementation reports under `audit/` remain authoritative. Index: [`README.md`](./README.md).

## Integrated behavior

- A single ISA may contain multiple HP GS/GE groups, and each group may contain multiple 835 ST/SE sets. GE01/GE02, IEA01/IEA02, SE01/SE02, transaction order, and group control numbers are checked before any set is returned. ST02 may repeat in a different GS scope; duplicates inside one group fail. Multiple ISA interchanges in one upload are explicitly refused.
- Mixed transaction types are refused by the 835 parser. No 277CA dispatcher or cross-module parsing path is added.
- `BPR16` is retained as the payment effective date, `DTM*405` as the adjudication cutoff date, and `GS04` as the functional-group creation date. They are separate parser and database fields. `production_date` remains a nullable compatibility field for historical reads; new writes put only BPR16 there, never DTM*405. Historical values are not backfilled because their source cannot be proven.
- The existing integer-cent checks remain: SVC02 charges sum to CLP03 where lines exist, each service and claim balance is checked, CLP05 matches PR adjustments, and BPR02 matches CLP04 less signed PLB amounts. AMT*I is validated as a number but is not separately reconciled against PLB L6. The behavior of AMT*I, L6, partial-line files, and zero-pay BPR combinations is not certified against real MAC guides.
- SVC01 qualifiers remain preserved. Current `#693` synthetic characterization samples remain intact; they prove behavior against generated fixtures only.

## Payee identity

- For an NPI payee (`N103=XX`), M25 compares N104 to the selected tenant/provider NPI, validates the NPI check digit, and, when `REF*TJ` is present, compares it through the established M2 sealed-TIN reader. A missing/decrypt-failed TIN, malformed identity, or mismatch is refused before storage/posting. Reasons and evidence do not include identifier values.
- A TIN-only payee (`N103=FI`) is rejected even when its TIN matches. The prior tenant + broad payer-kind environment switch was removed: it did not establish payer-program approval, provider-specific authorization, or an unambiguous payer/provider enrollment. No program is approved by this change.
- PTAN-only payees remain rejected. `REF*PQ` is preserved as payer-assigned evidence, not treated as a verified PTAN. Conflicting repeated payee `REF*TJ` or `REF*PQ` values fail parsing; identical repeats are retained without changing the selected value.
- Successful identity checks store method/scope/time metadata only. No plaintext TIN/NPI is written to the evidence JSON, error, log, or generic API response. Historical ambiguous control identities are held for review and are never auto-posted.

## Migration 1508

`1508_m25_835_group_identity_dates.sql` adds source-specific dates, group/interchange provenance, safe identity evidence, and group-scoped `NULLS NOT DISTINCT` uniqueness for both `remittance_advice` and Claim.MD staged components. It leaves historical date/provenance/evidence columns NULL and preserves existing financial rows. Migration 1475 is not ported: current `main` uses the original `mac_jurisdiction` enum through the M23 TypeScript alias, so the old enum repair is superseded. Historical 1494–1496 identifiers are already occupied by unrelated migrations on current `main`; the additive scoped change is assigned the next free ordinal.

The new envelope uniqueness target is incompatible with the old three-column `ON CONFLICT` target. Migration 1508 is therefore declared `contract`. See the coordinated procedure in [`m25-835-deployment.md`](../runbooks/m25-835-deployment.md). Application-only rollback after 1508 is unsafe; the deployment must stop/drain old writers first and recover by forward repair or a verified database/application restore plan.

## Claim.MD compatibility and limitations

Claim.MD staging, identity resolution, controlled review, and commercial payer review remain in place. Group provenance is threaded through staged duplicate identity, and a commercial staged post still requires its existing reviewed evidence and financial checks. This work does not enable polling, replay, ACK, or automatic commercial posting. The M25 parser's MAC-specific behavior is not certified against CGS J15, NGS J6/JK, or Palmetto JJ/JM files.

Follow-up work must provide authorized de-identified MAC 835s and the applicable companion-guide passages for financial/date validation; a governed provider-payer enrollment capability for PTAN evidence; and business confirmation before implementing multi-ISA or mixed-transaction dispatch. No PTAN schema or multi-ISA behavior is added here.

## Validation evidence

All evidence below uses synthetic fixtures and an isolated private PostgreSQL database. The migration output was executed by the maintainer from `fix/m25-671-final-integration` after verifying that branch and the migration test's 1508 references.

| Command / procedure | Result | Notes |
|---|---|---|
| `bun run vitest run apps/backend/src/modules/25-remittance/ingest/__tests__ packages/x12-835-client/__tests__` | PASS — 187/187 | Focused parser, payee identity, and M25 unit coverage. |
| `bun run test:db:migrate:live` | PASS — 14/14 | Private PostgreSQL: fresh full chain, migration 1508, historical M25 upgrade preserving financial rows and ambiguous legacy date provenance, idempotent rerun, checksum behavior, and migration-ledger compatibility. |
| `bash scripts/test-m25-835-ingestion-private.sh` | 40/42 PASS; 2 FAIL | Both failures are Claim.MD posting-plan assertions (`CLAIM_NOT_ELIGIBLE` masks the expected plan result / `POTENTIAL_CROSS_SOURCE_DUPLICATE`). The same two failures occurred on the exact integration-base `origin/main` checkout (39/41 there; this branch adds one passing test). Do not weaken posting eligibility to satisfy these expectations. |
| `BIL_TEST_ONLY=rls bash scripts/test-m25-835-ingestion-private.sh` | PASS — 22/22 | Uses the actual NOBYPASSRLS app role; covers M25 and Claim.MD tenant isolation. |
| `BIL_TEST_ONLY=claimmd-ops bash scripts/test-m25-835-ingestion-private.sh` | 1/4 PASS; 3 FAIL | Three central Claim.MD ops requests return HTTP 500 instead of 200; the same failures reproduce on the exact `origin/main` baseline. |
| `bun run status:matrix` | PASS | Regenerated implementation status; a subsequent run was current. |
| `bun run openapi:check` | PASS | Generated OpenAPI is current. |
| `bun run arch:inject-coverage` | PASS | Injection coverage report is current. |
| `bun run arch:migration-numbering` / `bun run arch:migration-compat` | PASS | Migration 1508 is uniquely numbered and contract-classified. |
| `git diff --check` and `git diff --cached --check` | PASS | No whitespace errors. |

`bun run build`, `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, and `bun run arch:fitness` also have failures reproduced on the same `origin/main` base. The TypeScript failures are in M23 billing code and fixtures; the lint failures are in an unchanged M23 live test. Architecture fitness additionally encounters missing `uv`, a Node heap failure in `arch:boundaries`, the existing UI parity drift, and the existing vulnerability advisory. The integration branch does not introduce a newly classified failure. These repository-level CI failures are not represented as green and require maintainer review before merge under repository policy.

Production migration-ledger preflight was **NOT RUN**. It is an operator-only check to be performed against production during the approved deployment process; this validation did not access production, staging, or shared databases. Migration 1508 changes a unique conflict target and old writers must be stopped/drained before it runs. Application-only rollback after the migration is unsafe; use forward repair or a verified database/application recovery plan, as detailed in [`m25-835-deployment.md`](../runbooks/m25-835-deployment.md).
