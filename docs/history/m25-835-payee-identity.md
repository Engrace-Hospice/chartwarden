# M25 835 payee identity and parser follow-ups (#671)

> Follow-up to #659/#660. Point-in-time narrative; generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

## Payee identity

- **TIN compare.** M25 never reads `provider_entity`. The composition root (`apps/backend/src/index.ts`, `m25PayeeTinDeps`) reads the sealed EIN through M1's published `FoundationSiteReader.providerEntityBillingFacts` inside the tenant's org tx and opens it with M2's `createTaxIdCipher`, then injects it as `M25IngestDrizzleDeps.payeeTin`. When bound, a payee REF*TJ that is present must equal the provider entity's TIN even when NPI matched. The comparison accepts nine digits, canonical EIN (`NN-NNNNNNN`) or canonical SSN (`NNN-NN-NNNN`); arbitrary punctuation/text is refused. A decrypt failure, missing secure seam, or unknown entity refuses the file. Reasons and identity evidence never include either identifier.
- **Tax-id-only payee (N103=FI).** Default is still REFUSE. `M25_PAYEE_TIN_POLICY={"<orgId>":["medicaid","commercial"]}` (env, parsed by `ingest/payee-tin-policy.ts`) lets that tenant's files for those payer programs pass on an exact TIN match. Env rather than a table: operator-owned, tenant-scoped, no tenant-writable surface that could widen acceptance, no migration. A malformed value throws at boot; unset = refuse everything.
- **PTAN: decision, no storage added.** No coherent owner: `provider_entity` is M1's tenancy spine row, and a PTAN is per payer/MAC enrolment (one provider has several), so a single column would be wrong. A `REF*PQ` value remains opaque payer-assigned payee data; M25 does not treat it as PTAN or match on it. A payee with no verified XX/NPI or specifically authorized FI/TIN is refused.
- **NPI and provider context.** M25 verifies both received and stored NPI with the existing CMS check-digit validator before exact string comparison. The lookup is called with the authenticated organization and the selected provider entity; M25 never discovers a provider by globally searching NPI/TIN. Provider ambiguity therefore fails at the upstream authorized provider selection boundary rather than selecting an arbitrary TIN match.
- **Policy evidence.** FI-only acceptance still requires an explicit organization + `payerKind` entry in operator-owned `M25_PAYEE_TIN_POLICY`; unset means deny. The advice row stores a non-sensitive `payee_identity_evidence` record with method, organization/provider scope, program, verification time, TIN-check status and (for FI) policy source. It does not store the NPI/TIN or an approval rationale. The policy entry itself remains the operational authorization record; deployments should retain reviewed configuration/change-control evidence alongside it.

## Parser

- SVC01 qualifier kept as `ParsedServiceLine.serviceIdQualifier`.
- Date fields are distinct: BPR16 → payment effective date, DTM*405 → adjudication cutoff, GS04 → functional-group creation date. DTM*405 is never substituted for BPR16. Historical `production_date` is retained because its source cannot be recovered with certainty; new rows populate it only from BPR16.
- BPR02=0 with CHK/ACH remains accepted when the rest of the transaction balances; no bank payment is created by this parser or claim posting path. BPR01 H is constrained to zero BPR02 and BPR04 NON. MAC-specific zero-payment combinations remain unverified.
- `receiveAdvice` parses and payee-checks every ST/SE before one tenant-scoped DB transaction inserts the advice rows and outbox events. The in-process parser tokenizes one time per file. Clients without `parse835All` retain the compatibility fallback by ST02; an ambiguous repeated ST02 fails closed.
- Multi-GS support: one ISA/IEA with multiple HP GS/GE groups is parsed in a single pass. `parseX12835Grouped` exposes ISA → GS → ST explicitly; the backward-compatible `parseX12835AllSets` projection still carries every transaction's complete group provenance. GS04 and other GS metadata travel on each transaction, and GE01/IEA01 plus ST/SE counts and control pairs are checked. ST02 may repeat across groups but not within one group. Multiple ISA/IEA remain rejected.
- Mixed functional group types: M25 returns the structured `X12_835_UNSUPPORTED_ROUTING` refusal before any rows/events are written. There is no shared authorized dispatcher in the current M23/M25 receive architecture; M25 does not parse HN/277CA. M23 ownership remains as specified by ADR-0029.
- M25 envelope dedupe now includes tenant + provider + ISA sender/receiver + ISA13 + GS06 + ST02. Claim.MD staging keys also include the group context. Migration 1495 retains historical provenance as NULL, requires new provenance to be all present or all absent, and uses PostgreSQL `NULLS NOT DISTINCT` so NULL values do not bypass uniqueness. If an incoming file shares ISA13/ST02 with a historical row but has different bytes, M25 persists the new source as `held_duplicate` with `LEGACY_IDENTITY_AMBIGUOUS`; it is not automatically discarded or posted. Same-file redelivery remains an exact duplicate. Migration 1495 replaces the old unique index and is a coordinated contract deployment.
- `parse277ca` sidecar: ADR-0029 puts the 277CA with M23's client; the `parse277ca` here stays the fail-closed sidecar mapper and no port is wired. No code change.

## Still blocked on real MAC files / the companion guide

- Validate sum(SVC02)=CLP03 with partial lines, CLP05=sum(PR), and interest in CLP04 (AMT*I) vs PLB L6 against real CGS, NGS J6 and Palmetto hospice 835s.
- Confirm the BPR02=0 / BPR04 rule and the BPR16 vs DTM*405 semantics against the TR3 and real files.
- Which Medicaid/MCO programs actually send FI-only payees (decides who goes in `M25_PAYEE_TIN_POLICY`).
- Where a PTAN should live (payer-enrolment owner) and whether to compare it.
- Multiple GS/ISA per file, if any MAC or clearinghouse sends them.

## M25-671-A date and balancing hardening

- **Date provenance:** new nullable `payment_effective_date`, `adjudication_cutoff_date`, and `functional_group_creation_date` columns retain the source date independently. The additive migration does not backfill historical rows; `production_date` is nullable for new remittances that omit BPR16. Reports use BPR16 when known and the legacy value for old rows.
- **BPR:** BPR02 remains nonnegative and zero is valid. BPR01 H requires BPR02=0 and BPR04=NON; debit BPR03 and unsupported methods remain refused. TRN01 must be `1`. Zero-dollar CHK/ACH is accepted without a synthetic cash movement.
- **Claim balance:** calculations remain integer cents. CLP05 is checked against PR CAS but omitted from the independent balancing sum; CLP02=22 is exempt from the CLP05 comparison as directed by X12 RFI 2548. Service-line and claim charge/payment/CAS balances remain strict.
- **PLB and interest:** payment equation remains BPR02 = sum(CLP04) - sum(PLB); zero PLB amounts are refused. AMT*I total must equal the opposite-signed PLB L6 total, and zero net requires no L6. Test fixtures cover both directions.
- **Evidence:** [X12 RFI 2548](https://x12.org/resources/requests-for-interpretation/rfi-2548-clp05-has-different-value-sum-pr-cas-segments) (CLP05/PR and reversals), [X12 RFI 2123](https://x12.org/resources/requests-for-interpretation/rfi-2123-835-interest-reporting-reqquir) (interest and L6), [X12 RFI 2831](https://x12.org/resources/requests-for-interpretation/rfi-2831-bpr01-and-bpr02-requirements-835) (BPR01/BPR02). Scope is the generic 005010 X221/X221A1 transaction rules. Synthetic tests do not certify CGS, NGS or Palmetto companion-guide behavior.

## M25-671-B envelope support

- **Supported:** one ISA/IEA, one or more HP GS/GE groups, one or more 835 ST/SE sets per group. The parser validates nesting, counts, numeric control numbers and matching identifiers before returning any transaction.
- **Identity:** transaction identity is scoped to the tenant/provider and ISA13 + GS06 + ST02. A retransmission with reused transaction control identity resolves to the existing advice; the existing trace/content duplicate guard still protects payment posting when a clearinghouse changes envelope controls.
- **Mixed groups:** explicitly unsupported at the M25 receive boundary until an existing secure shared dispatcher can route each group to its owner. The API returns `unsupported` with `X12_835_UNSUPPORTED_ROUTING`; clearinghouse intake leaves its cursor pinned for operator action. No partial HP processing occurs for a mixed interchange.
- **Not supported:** multiple ISA/IEA interchanges in one submitted raw message. MAC-specific multi-group acceptance and payer control-number reuse conventions still require real companion-guide files.
- **Standards evidence:** [X12 RFI 1680](https://x12.org/resources/requests-for-interpretation/rfi-1680-277ca-and-835-combined) permits 835 and 277CA functional groups in one interchange; [X12 RFI 2607](https://x12.org/resources/requests-for-interpretation/rfi-2607-interpretation-st02-835) scopes ST02 reuse so it may repeat in another functional group. This implementation routes mixed groups to a structured unsupported result because M23/M25 lack a shared dispatcher; it does not treat 277CA as an 835.

## M25-671-C identity, idempotency and migration controls

### Payee identity decision table

| X12 payee data | Result | Authorization/evidence |
|---|---|---|
| `N103=XX`, valid NPI equal to this provider's tenant-scoped NPI | Continue | Existing NPI identity; store method `npi` |
| Same NPI plus `REF*TJ` | Continue only if secure provider TIN is readable and exact-match | M1 reader + M2 cipher; store TIN-checked flag, no TIN value |
| `N103=FI`, `N104` exact TIN | Deny by default | Allow only explicit organization + payer-kind policy; independently compare `REF*TJ` if present |
| `N103=FI` plus a conflicting/malformed `REF*TJ` | Refuse before persistence | No last-value-wins behavior |
| Other qualifier / `REF*PQ` only | Refuse for automatic identity | Preserve qualifier/value as source data; never infer PTAN |
| Repeated `REF*TJ` with same value | Preserve all references; compare the same value | Safe to process; repeated contradictory `TJ` is rejected |
| Repeated `REF*PQ` | Preserve all references; legacy scalar field keeps first value | No identity authorization or PTAN matching from `PQ` |

The TR3 lists the payee `REF` segment repeat as `>1` and identifies `TJ` as Federal Taxpayer's Identification Number and `PQ` as Payee Identification. It does not define repeated same-qualifier conflict resolution. M25's rule is therefore conservative: identical `TJ` repetitions do not change identity; conflicting `TJ` values fail closed; multiple `PQ` values remain opaque. See the [X12 005010X221/X221A1 consolidated guide, Loop 1000B REF](https://ecommerce.x12.org/assets/tr3/x221-005010-PDF.pdf). X12 RFI 2069 concerns another loop; its discussion of repeated qualifiers is not treated as a payer-specific authorization for Loop 1000B.

### Idempotency and recovery boundaries

- Same interchange redelivery: tenant/provider + ISA partner + ISA13 + GS06 + ST02 unique index, with `NULLS NOT DISTINCT` for historical all-NULL provenance. Different partners and groups may reuse transaction controls without colliding.
- Different-envelope resend: transaction-scoped advisory locks serialize payment trace decisions. At posting, the transaction lock rechecks prior posted effects by tenant/provider/payer/trace/amount; a possible collision is held instead of posted. Missing TRN/content identity is also held.
- Concurrent duplicate receive/post: application locks plus the database unique index serialize same-key contenders. The transaction and outbox event commit together. A committed posted state makes event redelivery a no-op; a pre-commit failure rolls back financial writes and leaves a replayable failure state.
- Legacy control collision: same raw file hash is a duplicate. Different raw file with the same old ISA13/ST02 but no group/sender provenance is persisted as `LEGACY_IDENTITY_AMBIGUOUS`, kept non-postable, and left visible in the tenant-scoped advice list. A live database race test has not been run; the precise lock/index behavior remains a verification gap.
- Acknowledgment/cursor: clearinghouse intake advances only after each remittance is queued, duplicate, or durably held. Unsupported/malformed content keeps the cursor pinned under the existing rules. The source retries after transient failures.

### Migration 1495 production procedure

Migration 1495 is `compat: contract`; it drops the old ISA13/ST02/provider index and creates a new group-aware unique index. The deployment migrator runs each migration inside one transaction. It is not safe to run old and new application versions concurrently: old binaries infer the removed conflict target, and new binaries require the new columns/index.

1. **Before the window:** confirm migration 1495 is not already recorded with checksum drift; verify the production engine is PostgreSQL 15+ (the pinned production image is PostgreSQL 18); measure `remittance_advice` and `claimmd_era_m25_stage` sizes; confirm backups and a tested restore point.
2. **Preflight:** verify there are no duplicate rows under the former `(interchange_control_number, transaction_set_control_number, provider_entity_id)` key; this should be enforced by the old unique index. Check pending remittance/outbox work and stop or drain receive/post workers.
3. **Apply:** enter a maintenance window for M25 writes, run the checksum-checked `bun run db:migrate:deploy` path, and do not run raw ad hoc SQL. Migration 1495's table alterations, constraint changes, and index DDL run in one transaction. `CREATE INDEX` blocks concurrent writes; the complete DDL transaction may also block reads and writes on affected tables depending on the acquired locks. Lock duration and availability impact have not been measured against PostgreSQL. No `CONCURRENTLY` is used because the repository migrator wraps each file in a transaction. Drain M25 writers and budget an operational window; rehearse against a representative disposable copy before production.
4. **Deploy and verify:** deploy only the new backend after migration success; resume workers; verify the ledger checksum, index definition (`pg_get_indexdef` must include `NULLS NOT DISTINCT` and all identity columns), no incomplete provenance rows, and a tenant-scoped test receive/replay in the designated disposable/staging environment.
5. **Failure/recovery:** SQL failure rolls the migration transaction back, retaining the old index and schema. Do not rewrite the migration file after it is recorded. Because new code depends on the new conflict target, do not let automatic deployment rollback run over this contract migration. If application rollout fails after commit, pause M25 writes and forward-fix/redeploy compatible code. Restoring the old index is only a controlled recovery option after proving no group-reused ST02 rows exist; otherwise it would reject valid data. Do not automatically deploy or mutate production for this PR.

Migration 1496 adds nullable, non-sensitive payee identity evidence; it is additive and can be applied before the code that writes it. Historical identity evidence remains NULL and is not reconstructed.

## M25-671-C verification and external evidence

- **Executed in this workspace:** parser hardening, payee TIN/NPI and migration-structure focused tests pass (48 tests); M25 parser/ingest suites and build/typecheck results from the previous batch are reported separately because this C change has not yet rerun every suite. Migration numbering and compatibility gates pass for the current branch state.
- **Not executed:** M25/PostgreSQL live integration, migration apply/rollback, real concurrency race, RLS role checks, and production-sized index timing. These require the repository's isolated disposable PostgreSQL container; do not use shared Docker, staging or production.
- **MAC certification matrix:**

| Profile | Payee NPI/TIN and extra IDs | Zero payment / reversals | CLP/CAS/SVC/PLB/interest | Multi-ST/GROUP | Evidence |
|---|---|---|---|---|---|
| CGS Home Health & Hospice | Not verified | Not verified | Not verified | Synthetic tests only | Await sanitized authentic companion-guide files |
| NGS J6 | Not verified | Not verified | Not verified | Synthetic tests only | Await sanitized authentic companion-guide files |
| Palmetto Home Health & Hospice | Not verified | Not verified | Not verified | Synthetic tests only | Await sanitized authentic companion-guide files |

The checked-in `packages/x12-835-client/samples/` are synthetic generated fixtures; no authentic sanitized MAC remittance was found during this audit. No certification claim is made.

## Draft follow-up issues (not created)

### PTAN enrollment and matching

**Title:** Model payer/MAC-scoped provider enrollment identifiers (PTAN) safely

**Context/scope:** `REF*PQ` is preserved as payer-assigned data but is not a verified PTAN. Design on the existing provider-payer enrollment abstraction where appropriate; do not add PTAN to `provider_entity` or authorize PTAN-only 835 payees until verified enrollment data and source provenance exist.

**Acceptance criteria:** identify owning module/table; represent provider, organization, payer/MAC, program/jurisdiction, identifier type/value, effective dates/status and verification source; enforce tenant isolation and history; define exact 835 qualifier-to-enrollment mapping from companion guides; add authorized read seam, audit evidence, duplicate/conflict and expiry tests; prohibit PTAN-only automatic posting until a verified enrollment uniquely matches.

**Relationship:** follow-up to #671; completes the explicitly deferred PTAN boundary.

### Authentic MAC 835 certification

**Title:** Certify M25 835 parsing and payee matching with sanitized MAC fixtures

**Context/scope:** obtain policy-approved, de-identified CGS, NGS J6 and Palmetto hospice 835 samples plus applicable companion-guide versions; retain no PHI/live TIN/bank details.

**Acceptance criteria:** maintain a source/version/jurisdiction manifest; cover payee NPI/TIN, repeated references, zero payment, reversal, adjustment balancing, PLB/interest and multi-ST/multi-GS; assert raw identity redaction and tenant-scoped processing; record verified behavior and payer-specific exceptions; do not call synthetic fixtures certification evidence.

**Relationship:** external evidence follow-up for #671; does not change M23 ownership or add mixed-type dispatch.

### Mixed 835/277CA routing

**Title:** Design a secure shared EDI dispatcher for mixed 835/277CA interchanges

**Context/scope:** X12 permits HP (835) and HN (277CA) groups in one ISA. M25 currently refuses the whole mixed interchange before persistence; ADR-0029 assigns 277CA ownership to M23. Inspect the existing transport capture, tenant authorization, encryption, cursor/lease, retry and acknowledgment contracts before designing routing. Do not add another poller or route 277CA through M25.

**Acceptance criteria:** route each validated functional group exactly once to its owning module; preserve ISA/GS/ST provenance and tenant authorization; fail closed on unknown groups; define all-or-nothing versus durable per-group processing; prove retry, acknowledgment and no partial-posting behavior with live integration tests.

**Relationship:** follow-up if supported transport contracts require mixed-type interchange acceptance. This is not a parser-only change.

### Multi-ISA ingestion

**Title:** Support multiple X12 ISA/IEA interchanges in one captured input

**Context/scope:** M25 accepts exactly one ISA/IEA per input and rejects concatenated interchanges; it must never silently parse only the first. Confirm that a production clearinghouse or payer transport actually concatenates envelopes and identify its framing, sender identity, retry and acknowledgment contract before implementation.

**Acceptance criteria:** tokenize the input once; validate each ISA/IEA independently and reject trailing/orphan content; preserve interchange→group→transaction provenance; scope dedupe by authorized sender/receiver and control numbers; prove structural rejection, retry and payment idempotence with isolated PostgreSQL.

**Relationship:** required only if an operational transport contract supplies multiple interchanges in one raw object. Until then, explicit rejection is safer than speculative acceptance. If #671 is narrowed, link this issue as deferred transport support.

## M25-671-V final verification and closure assessment

The results below supersede the earlier C verification note in this file, which recorded only the initial 48-test subset.

### Reproducible checks

| Check | Command | Result |
|---|---|---|
| Focused parser, ingest and migration-structure tests | bun run test -- packages/x12-835-client/__tests__ apps/backend/src/modules/25-remittance/ingest/__tests__ packages/db/migrations/__tests__/m25-835-group-identity-migration.test.ts | PASS, 196 tests / 20 files |
| Test typechecking | bun run typecheck:tests | PASS, exit 0; seven Node shards and one DOM shard |
| Workspace build | bun run build | PASS, exit 0; about 2m15s. apps/web was actively compiling before the final batch completed; earlier apparent stalls were not a deadlock or code error. Concurrent build/typecheck attempts added resource contention. |
| Migration ordinals | bun run arch:migration-numbering | PASS; 754 migrations, no new ordinal collision |
| Migration compatibility | bun run arch:migration-compat | PASS; 144 declarations valid |
| API schema | bun run openapi:check | PASS; 2092 routes enriched |
| Generated client | bun run client:check | PASS |
| Full architecture fitness | bun run arch:fitness | FAIL: arch:docling-lock (uv missing), arch:parity (two existing orphan directories), arch:boundaries (Node heap OOM). Other 47 gates passed. |
| PostgreSQL migration and ingestion suites before M23 prerequisite repair | FAIL during setup | Maintainer-run output below: full chain stopped at migration 1489; all 41 M25 ingestion tests were skipped. |
| Final whitespace check | git diff --check | PASS |

The isolated root build showed sustained CPU activity and rising memory while compiling apps/web, then completed. No environment-variable requirement or frontend diagnostic appeared. Do not treat the earlier interrupted attempts as a build defect.

### M25-671-DBV PostgreSQL execution audit

The repository has approved PostgreSQL live suites: `bun run test:db:migrate:live` and `bun run test:m25:835-ingestion:live`. CI and local verification use disposable PostgreSQL instances; the M25 live ingestion suite uses the application role for tenant-facing assertions. These suites are destructive at the database/cluster level: they reset `public` and drop/recreate roles, so `CHARTWARDEN_TEST_DATABASE_URL` must point only to a dedicated disposable instance, never a shared, staging, or production database. Run one suite at a time.

The supplied localhost URL was authenticated successfully with the repository's read-only `bun run db:wait` probe. The private `chartwarden-postgres:dev` PostgreSQL 18.6 container was then used for a maintainer-run live attempt. The old local image was reused because rebuilding stalled at the Wolfi APK index; its server version was checked as PostgreSQL 18.6. No production or shared database was used.

| Verification | Environment/baseline | Result | Evidence and limitation |
|---|---|---|---|
| Configured localhost PostgreSQL target | Private PostgreSQL 18.6 container on port 32856 | PASS | Authenticated connection check succeeded using the supplied test URL; no data-changing query was issued by the connectivity check. |
| Full migration chain after migration 1475 repair | Fresh PostgreSQL 18.6 test database | PASS, 13/13 | The supplied live output reports the full-chain apply, no-op rerun, lenient/strict checksum drift, and ledger compatibility tests passing. The custom runner applies SQL files lexically; the static order assertion places 1475 before 1489. |
| Migration 1495 historical upgrade | Representative pre-1495 schema with historical remittances | NOT RUN | The fresh-chain suite does not establish upgrade behavior against representative historical M25 rows. |
| Migration 1496 | After 1495 | PASS as part of full chain; historical evidence behavior NOT RUN | Fresh migration application succeeded; no representative legacy-row assertion was supplied. |
| Indexes, CHECK/FK constraints, `NULLS NOT DISTINCT`, ON CONFLICT | PostgreSQL | Partially verified | Fresh application of the chain passed. Dedicated NULL-provenance, group reuse, constraint introspection, and conflict-target behavior remain unverified. |
| Ingest/posting idempotence and concurrent duplicate workers | Existing M25 live receive/post suite | FAIL, 39 passed / 2 failed | The two failures came from hand-built Claim.MD test fixtures missing `paymentEffectiveDate` and the seeded `submissionEvidenceIds`. The fixtures are corrected in the worktree; the live suite must be rerun to verify the correction. |
| RLS and tenant isolation | `chartwarden_app` NOBYPASSRLS application role | PARTIAL PASS | Supplied output includes passing cross-tenant advice visibility and tenant-scoped pull-cursor cases; broader policy and financial isolation assertions remain unverified. |

The migration suite passed against the maintainer's disposable PostgreSQL run after 1475 was added. The subsequent M25 suite initialized successfully and executed all 41 tests; 39 passed and two test cases failed on incomplete synthetic fixtures. Those fixtures now include the payment effective date and exact immutable evidence id required by the current plan-selection contract. Their correction has passed `typecheck:tests` but has not yet been rerun against PostgreSQL. Continue using only the private disposable instance and run the M25 suite serially; do not use shared, staging, or production databases. The suite should still be supplemented with committed-database assertions for group-scoped repeated ST02, distinct partners/tenants, evidence persistence, concurrent receives, and financial event counts before treating all B/C guarantees as proven.

The `recorded as applied but its file no longer exists` warnings in the supplied migration output came from the strict-preflight test's temporary `/tmp/chartwarden-migrate-strict-*` directory, which intentionally contains only synthetic `9001`/`9002` files while reusing the live test database ledger. They are expected in that isolated subtest and do not indicate that migration 1475 (or the other listed repository files) is missing from the actual migration directory.

#### Maintainer-run live output received 2026-11-16, before migration 1475 was added

The maintainer ran the approved live commands against the disposable localhost PostgreSQL 18.6 container and supplied the output. `bun run test:db:migrate:live` reported 10 passing and 3 failing tests: the full-chain setup failed at `1489_m23_medicare_provider_routing.sql` with PostgreSQL error `type "m23_mac_jurisdiction" does not exist`; the three failures are the full-chain apply, repeat/no-op, and strict checksum tests, each blocked by that same setup error. The isolated ledger rename/compat-view tests passed. `bun run test:m25:835-ingestion:live` failed during setup at the same migration and all 41 ingestion tests were skipped. These results establish that the live migration baseline is currently broken, but do not exercise migrations 1495/1496 or M25 database posting.

Static source trace found the M23 mismatch: migration 0074 creates `public.mac_jurisdiction`; the TypeScript enum and migrations 1489/1490 use `m23_mac_jurisdiction`; the original chain did not create that type. Since 1489/1490 are deployed, their files and checksums stay unchanged. The new forward-only migration 1475 creates the enum before them on a fresh install and adds a label-preserving assignment cast from the legacy enum because migration 1489 backfills credential values between the two enum types. On a previously migrated database it validates the target enum labels and installs the cast if missing. Ordinal 1475 was free on `main` and is immediately before 1476 in lexical migration order. It uses the seven labels from the Drizzle enum and fails closed if an existing target enum has different labels. This repair has passed static checks only; the live migration and M25 suites must be rerun from a fresh disposable database.

After this new migration, the focused structural test passed (3/3), `bun run typecheck:tests` passed (seven Node shards and one DOM shard), `bun run arch:migration-numbering` passed (754 migrations), `bun run arch:migration-compat` passed (144 declarations), and `git diff --check` passed. The supplied PostgreSQL migration suite then passed 13/13, including the full chain and checksum behavior. The M25 live suite passed 39/41 before the fixture correction; rerun it after the correction before merge.

### Migration safety and rollout

Static review finds migration 1495 replaces the earlier unique key with a tenant/provider/ISA sender+receiver/ISA13/GS06/ST02 key, and adds all-null-or-all-present provenance checks. `NULLS NOT DISTINCT` is present in SQL for the new unique constraints. Migration 1496 only adds nullable non-sensitive identity evidence, with no historical backfill. These are source-level findings, not PostgreSQL execution results. The migration chain is transaction-wrapped; a failure within migration 1495 should roll back that migration transaction, but failure behavior was not exercised here. Before scheduling production, use a representative restored copy to check historical duplicate conflicts, actual lock duration, index validity, and conflict-target compatibility. Do not claim zero-downtime safety.

Recommended release sequence: (1) confirm backup/restore and migration checksums; (2) preflight duplicate rows under the intended key on an approved copy; (3) drain M25 ingestion/posting workers and source pollers so no old/new writer overlaps; (4) apply checksum-checked migrations 1495 and 1496 in the planned maintenance window; (5) verify constraints/index definitions and row counts in the approved release environment; (6) deploy the matching backend; (7) run a synthetic canary and verify advice/outbox/payment counts and retries; (8) resume pollers only after those checks. If a migration fails before commit, investigate and rerun after correction. After 1495 commits, prefer forward recovery; do not roll back to the old application/index until it is proven that doing so cannot collapse valid group-scoped identities.

### Architecture-gate follow-up

The last full `bun run arch:fitness` result remains 47/50: `arch:docling-lock` could not find `uv` in the local environment; `arch:parity` found only generated `dist/` and `.tsbuildinfo` in two untracked orphan directories (`packages/domain`, `packages/admin-ui-shell`); `arch:boundaries` terminated with Node heap OOM. These findings do not originate in the M25 diff, but they have not been compared against a clean `main` run. `uv` is an environment prerequisite that CI installs. The parity artifacts were preserved rather than deleted. The boundaries gate is unresolved and is part of the architecture gate; no source change or heap-limit bypass was made. Therefore the complete architecture fitness command is not green in this worktree.

### DBV merge and issue disposition

**Merge readiness: NOT READY TO MERGE.** The maintainer supplied a passing PostgreSQL migration suite (13/13), and the M25 live suite reached all 41 tests with 39 passing. The two failures were traced to manual synthetic fixtures that did not provide the payment date and exact send-evidence link required by current production validation; those fixtures are corrected and typechecked, but the live suite has not been rerun. Migration 1495 has not been tested against representative historical remittance rows or explicit `NULLS NOT DISTINCT`/group-reuse cases. The architecture suite also remains 47/50 locally. Rerun the M25 live suite after the fixture fix and complete the targeted historical/idempotency verification before merge.

**Issue closure: NOT READY TO CLOSE.** This is independent of merge readiness. #671 as currently written still includes PTAN matching and authentic MAC-file validation; those remain outstanding, and multi-ISA/mixed-type requirements need an explicit scope decision. Narrowing #671 and linking follow-up issues requires maintainer agreement; this verification neither creates nor closes issues.

### Closure matrix

| Original #671 requirement | Implementation status | Verification evidence | Remaining limitation | Follow-up issue required | Closure disposition |
|---|---|---|---|---|---|
| Compare NPI and sealed tenant TIN | Implemented | Focused payee tests; 196-test suite; tenant/provider-scoped lookup contract | No live database/RLS execution | No, unless live test finds a defect | Implemented; DB proof outstanding |
| Allow FI-only payee by payer program | Implemented, deny by default | Unit tests cover default-deny, tenant/program scope, matches and mismatches | Operational policy change control and live tenant tests unverified | No separate issue | Implemented; operational evidence outstanding |
| Compare PTAN-only payee using enrollment | Not implemented; REF*PQ stays opaque and is never inferred to be PTAN | Parser preserves references; docs specify no PTAN authorization | No verified enrollment owner/seam or companion-guide qualifier mapping | Yes: PTAN enrollment and matching draft above | Blocks closure unless #671 is formally narrowed and linked |
| Distinct BPR16, DTM*405 and GS04 semantics | Implemented | Parser/ingest tests, root build, migration ordinal/compat checks | Historical production_date source remains unknowable and is not backfilled | No | Implemented; historical ambiguity documented |
| Zero payment and financial balance rules | Implemented against generic 005010 rules | Parser/sample and ingestion focused suites | CGS/NGS/Palmetto exceptions not certified | Yes: authentic MAC certification draft | Blocks original real-file acceptance criterion |
| Multiple ST/SE in one group | Implemented | Focused parser/ingest tests | Live persistence/retry boundary not verified | No, unless DB tests expose an issue | Implemented; DB proof outstanding |
| Multiple GS/GE inside one ISA | Implemented | Parser group/control tests; typecheck/build | New unique index and persisted group isolation not executed on PostgreSQL | Live migration/integration gate required | Not merge-ready pending DB proof |
| Multiple ISA/IEA in one input | Explicitly unsupported | Parser rejects additional/nested envelopes; documented | Original issue called out this limitation; no evidence it is operationally unnecessary | Yes if transport requires it: multi-ISA draft above | Blocks closure unless #671 is formally narrowed and linked |
| Mixed 835/277CA groups | Safely rejected before M25 writes | Unsupported-routing parser/service tests; M23 ownership retained | No shared secure dispatcher | Yes if transport requires it: dispatcher draft above | Scope decision required |
| Idempotency, retries, tenant isolation and no duplicate posting | Implemented in code; this verification did not prove the DB path live | Focused/unit tests; arch:tenancy passed; existing live suite source reviewed | Actual DB concurrency, RLS, rollback and retry were not executed | Live regression gate required | Not merge-ready pending DB proof |

### PostgreSQL validation required before merge

Migration 1495 is marked compat: contract. It replaces the old unique index. Static inspection confirms NULLS NOT DISTINCT on the new advice index and stage constraint, plus checks requiring provenance columns to be either all absent (historical rows) or all present (new rows). Historical NULL provenance therefore cannot evade uniqueness for an otherwise equal key. PostgreSQL 15+ is required; production is pinned to PostgreSQL 18. This is a source-level assessment only: the migration has not been applied against the configured localhost test database in this verification.

The repository live suites destructively recreate public and drop cluster roles. Set `CHARTWARDEN_TEST_DATABASE_URL` only to an approved disposable localhost test database, ensure it contains no user or shared data, and run the commands serially:

    CHARTWARDEN_TEST_DATABASE_URL='<approved-localhost-test-database-url>' bun run test:db:migrate:live
    CHARTWARDEN_TEST_DATABASE_URL='<approved-localhost-test-database-url>' bun run test:m25:835-ingestion:live

Before calling database verification complete, extend/run live assertions for NULLS NOT DISTINCT, historical NULL provenance, equal ST02 in separate GS groups, distinct authorized senders, payee evidence persistence, and concurrent receiveAdvice results with committed row/outbox/payment counts. A green HTTP response alone is insufficient. Drain M25 writers before applying migration 1495; old/new backend versions must not overlap across this contract change. Do not use shared Docker/Postgres, staging or production for these tests.

### GitHub #671 disposition

The current issue remains OPEN and still requests TIN/PTAN comparison, real MAC-file validation, and support for multiple GS/groups and ISA envelopes. The implementation fulfills part of that scope, but PTAN enrollment, authentic MAC certification, multi-ISA support and mixed-type dispatch remain open. Do not close #671 as written. To close it later, first obtain maintainer agreement to narrow the issue explicitly, create/link the PTAN and MAC certification follow-ups, and decide whether real transport evidence warrants the mixed-dispatch and multi-ISA drafts. This verification does not create or close GitHub issues.

### Follow-up PostgreSQL verification — 2026-11-16

The earlier M25 fixture failures were corrected, and the approved private runner completed the M25 posting/integration batch against a fresh disposable PostgreSQL instance: ingestion 41/41, golden 21/21, M24 remittance feedback 7/7, CAP backfill 4/4, clearinghouse pull 24/24, M41 routes 16/16, and M23 overview 6/6. The separate `BIL_TEST_ONLY=claimmd-ops` run passed 4/4 central Claim.MD ops tests. The migration suite had already passed 13/13 on the same private-runner approach.

A direct `bun run test:m25:835-ingestion:live` attempt later failed before executing tests because its configured ephemeral port (`127.0.0.1:32856`) no longer had a PostgreSQL server; Vitest skipped all 41 tests. This was an unavailable test service, not a test pass or application regression. The private runner starts and removes its own PostgreSQL container and is the reproducible local path.

That Claim.MD ops run emitted a `pg` deprecation warning because `recoveryPreflight` issued multiple queries concurrently through one transaction client. The queries are now sequential on that client, preserving the transaction snapshot. The focused recovery unit tests pass 4/4, and the private Claim.MD ops suite was rerun after this change and passed 4/4. `git diff --check` also passes.

These live results raise the M25 ingestion and adjacent Claim.MD checks to PASS. They do not replace the still-missing dedicated PostgreSQL assertions for migration 1495 against representative historical remittances, `NULLS NOT DISTINCT`, repeated ST02 across GS groups, separate partner identities, and committed row/outbox/payment counts under concurrent receive/retry. The merge and issue-closure dispositions above remain unchanged until those database cases and the scope decisions are addressed.

### Final historical migration verification — 2026-11-16

The approved private PostgreSQL runner now has `BIL_TEST_ONLY=migrations` for the existing migration live suite. It uses the same private PostgreSQL image, random local port, isolated database and cleanup trap as the M25 runner; it does not reuse the shared local cluster. The historical upgrade test builds migrations through 0074, seeds the already-present M23 enum and assignment cast as deployed installations require, applies all migrations through 1494 while omitting 1475, and then applies pending 1475 after the later migration ledger rows exist. It inserts a synthetic historical remittance before applying 1495/1496.

The historical test verifies that 1475 validates the existing seven enum labels and leaves the migration chain usable; 1495/1496 preserve the old remittance and leave all unknown source provenance NULL; `production_date` remains unchanged; the new unique index is `NULLS NOT DISTINCT`; duplicate historical NULL-provenance identity is rejected; and identical ST02 values in distinct GS06 groups are accepted. It also confirms that the old release's three-column `ON CONFLICT` target fails with PostgreSQL `42P10` after 1495. This proves the need to stop old M25 writers before that contract migration. A deliberately failed migration body rolls back both its DDL and ledger row.

The environment is disposable and synthetic. It is not evidence about the exact filename/checksum ledger or contents of a production database. The repository has no local copy of a deployed ledger. Before rollout, an operator must query the production `_chartwarden_migration` for any existing `1475_*.sql` filename and inspect the existing `public.m23_mac_jurisdiction` labels and source/target cast. The current repository's migration-numbering gate passes with 1475 claimed once; that does not establish the state of every deployed ledger.

#### Production rollout runbook for contract migration 1495

1. Schedule and announce a short remittance-ingestion maintenance window. Confirm the release includes the matching M25 code and migrations 1494–1496, and verify backups/restore readiness.
2. Query the production migration ledger for an existing `1475_*.sql` row. Inspect the `m23_mac_jurisdiction` enum labels and whether the legacy assignment cast exists. Stop and resolve any conflicting ordinal or unexpected labels before migration.
3. Stop new remittance polling/intake and drain in-flight M25 API/worker transactions. The current `deploy.sh` does not automatically drain M25 writers for `compat: contract` migrations; stopping only the poller is insufficient if API or worker instances can still call the old `ON CONFLICT` target.
4. Stop all old API and worker writers, then run the normal strict deployment. The migration runner commits each migration and its ledger row atomically. 1494 and 1495 acquire table/index locks; allow them to finish before starting the new API/worker image.
5. Keep writers stopped until the new API/worker instances are healthy on the new schema. Run the M25 ingestion/readiness smoke checks, confirm durable intake and posting state, then resume polling.
6. If a migration statement fails, its current migration transaction and ledger row roll back; earlier migrations in the release may already be committed. Because 1495 is `compat: contract`, `deploy.sh` must hold for operator review and must not automatically restart the previous image. Inspect the ledger and schema, correct forward, and rerun the strict migration. Do not manually delete ledger rows or edit deployed migrations.
7. If the migration succeeds but the new application fails, keep old writers stopped. Roll forward with a fixed image unless an operator separately verifies that the old image is compatible with every applied migration; the live test demonstrates it is not compatible with 1495's changed conflict target.

This is an intentional maintenance-window rollout, not a zero-downtime guarantee. Migration locks and production table size still need to be assessed from production telemetry before choosing the window.

The current checkout passes `arch:migration-numbering`, `arch:migration-compat`, `arch:manifest-mirror` and `git diff --check`. Historical production ledger state and real MAC certification remain external evidence requirements. PTAN-only matching, multiple ISA support and shared 835/277CA dispatch remain deferred; issue #671 should stay open unless maintainers formally narrow its original acceptance criteria and link follow-up issues.
