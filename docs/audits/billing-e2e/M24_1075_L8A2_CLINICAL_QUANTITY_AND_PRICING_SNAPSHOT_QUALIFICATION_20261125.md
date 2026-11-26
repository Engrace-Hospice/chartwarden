# M24-1075-L8A.2 — Clinical Quantities, LOC, Claim Segmentation & Pricing Snapshot Qualification

- Date: 2026-11-25
- Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
- Starting HEAD: `af3a2b7c1979c2896969bd6b782009dc336a0646`
- PR: [#1115](https://github.com/Engrace-Hospice/chartwarden/pull/1115), Draft; issue #1075 remains open.
- L7 group disposition remains `M24_1075_L7_GROUP_BLOCKED`; this lot does not repeat or change that qualification.

## Disposition

`M24_1075_L8A2_BLOCKED`

The targeted integrity fixes are implemented and qualified. A positive priced claim-line persistence path and immutable payer-rate snapshot are not available: the authoritative locality, payer quality status, election-day sequence, billable CHC minutes, provider billed charge and qualified institutional units/codes are not all supplied by existing owner seams. Persisting a priced line without those facts would invent evidence. Assembly therefore continues to refuse unresolved pricing, and no new claim-line pricing snapshot schema was added.

## Implemented

- **Rate correction lineage:** the read-only M24 preview now loads the complete in-scope rate history as of its assessment instant, within organization/provider/payer/program/state scope. The query deliberately retains effective-date successors even when their narrower `effective_to` does not overlap the whole claim window. The shared selector can then apply correction, revocation and supersession semantics without reviving a superseded open-ended predecessor. A 5,000-row cap fails closed instead of truncating history.
- **Transaction-bound LOC:** claim assembly now reads M6's LOC periods through `periodsForAdmissionInTransaction` on the same transaction that locks and checks the admission. It no longer uses a separate LOC read for assembly. Test-only cadence adapters bridge existing fixtures; production has no such fallback.
- **Line-span validation:** the stored-line validator accepts multiple contiguous daily segments inside one LOC period and verifies exact inclusive coverage, LOC/revenue-code agreement, line units and daily arithmetic. It rejects gaps, overlap, wrong LOC, missing period links, and historical `service_date_to IS NULL`; it is explicitly not a payer-rate snapshot attestation.
- **Readiness guard:** a new platform-required, non-overridable validation rule blocks hospice claims without a current immutable payer-specific pricing snapshot. Both manual validation and background revalidation set the snapshot evidence to false because no such stored snapshot/read contract exists. The rule set version is now `6`. This prevents legacy line amounts from becoming `READY` through either validation path or a stale override.

No payer rates, locality mappings, provider quality evidence, clinical quantities, provider charges or authorization facts were seeded or promoted. The change adds no migration and does not alter submission refusal. Existing migration 1550 remains classified `contract` under its existing operator hold; this lot applies no migration to a shared or production database.

## Evidence inventory and limits

| Input | Current owner/source | L8A.2 result |
|---|---|---|
| Admission identity and service jurisdiction | M6 admission/cadence reader | Read on the locked assembly transaction; state is available, but not a CBSA or payer locality. |
| LOC periods | M6 LOC reader | Read on the assembly transaction. It remains date-only and does not establish billable CHC minutes. |
| Election-day sequence | M6 election records | No qualified service-date election-day reader is bound to pricing. |
| CHC quantity | M6 clinical records; M8/M17 encounters and visits | Existing encounter/visit intervals do not prove payer-qualified CHC care minutes. Quantity remains unresolved. |
| In-home respite | M6 clinical service type | No compatible service type/quantity contract exists; it remains unsupported. |
| Locality/CBSA | M5 patient/service addresses and M6 service location | No qualified service-date-to-rate-locality resolver is available. The M23 CMS crosswalk is not reused for Medicaid. |
| Provider quality-reporting variant | M30 reporting outputs | No evidence contract binds the applicable provider quality status to this payer-rate assessment. |
| Provider billed charge | M24 provider-usual-charge evidence / M23 visit schedule | No authoritative actual institutional claim charge is available. The visit schedule is not a hospice per-diem usual-charge source. |
| Codes and units | M24 line builder / payer policy | Current LOC code support is not sufficient to qualify all payer institutional units. Unsupported service coding remains blocked. |

The L8A.1 pricing engine still distinguishes reimbursement estimate, provider billed charge, payer-allowed amount and payment. A reimbursement estimate is not a billed charge. No estimate is persisted as a claim charge.

## Tests and qualification

| Check | Result |
|---|---|
| Focused Vitest: Medicaid validation rules, rate policy, hospice pricing, and M24 line-snapshot integrity | 4 files passed; 80 tests passed. |
| Private disposable PostgreSQL M24 assembly suite on the pinned PostgreSQL 18 image | 27 passed; 7 pricing-dependent cases remain intentionally skipped. New cases exercised persisted rate-lineage reading and non-overridable validation hold. |
| `bunx tsc -b packages/medicaid-adapters --pretty false` | Passed. |
| `bun run arch:test-typecheck` | Passed: all 3,595 tests across the two Vitest projects are included in a typecheck program. This validates coverage, not a backend typecheck run. |
| Changed-file `bunx biome check` | Passed on all 11 changed TypeScript files; no changes required. |
| `bun run arch:module-docs` | Passed: 41 specs, 41/41 index parity, 891 ADR citations, and 204 relative links. |
| `bun run arch:architecture-docs` | Passed; three pre-existing warn-only missing `verified-against` stamps in unrelated M23/identity docs. |
| `bun run arch:compliance` | Passed: evidence references resolve, gaps are dated, and the agent harness is intact. |
| Scoped `bun run harness:phi-scan` | Passed: 16 changed files clean. |
| `git diff --check` | Passed after documentation updates. |
| Full backend TypeScript project check | Incomplete: the earlier attempt reached approximately 2.6 GiB RSS and was terminated before exhausting the runner. It is not reported as passed and was not repeated. |

The disposable database used only synthetic fixtures and was stopped/removed after the live suite. No shared or production database was modified.

The seven skipped tests are the existing pricing-dependent cases: concurrent original cadence; replacement before the next original; malformed predecessor control; missing state-adapter replacement support; Q5002 assisted-living coding; Q5006 own-IPU coding; and encounter linkage. They remain skipped because a qualified persisted pricing/claim-line assembly path does not exist. The test that legacy hospice lines cannot reach `READY` without pricing evidence is now active and passed.

The existing L8A.1 preview already shows pricing segments, missing inputs, and the distinction between reimbursement and billed/allowed/paid amounts. The existing validation worklist receives the new non-overridable reason through the established remediation summary. No UI code changed in this lot and no new visual/accessibility claim is made.

## Remaining work and dependencies

- M6 must define owner-backed election-day, CHC-minute and in-home-respite quantity contracts where clinically supported.
- M5/M6/M40 owners must provide a verified effective-dated service-locality reader; no ZIP, city or Medicare crosswalk inference is acceptable.
- The payer/operations owner must provide source-backed provider quality applicability and provider billed-charge evidence semantics.
- A payer-qualified service/code/unit contract and rate-source evidence are required before assembly can persist a priced segment. EOCCO rates remain external and unverified; no OHA FFS rate can price EOCCO.
- L8A.3 remains the planned authorization/timely-filing/policy-controls lot. L8B remains responsible for later institutional representation/conformance foundations. L8-V aggregate release and verification debt remains separate.

These are owner/data prerequisites that block particular priced scenarios and a positive persisted priced assembly path. They are not a reason to invent synthetic production facts. L8A.2 cannot be marked complete until the implementation can persist a fully evidenced synthetic local draft through the actual M24 path and revalidate its immutable pricing evidence.

## Safety

Medicaid electronic submission remains disabled. No payer/vendor request, live ERA retrieval, payment posting, financial ledger mutation, financial claim-state transition, or financial outbox publication occurred. No EOCCO/OHA rate or authorization was approved. No secondary Medicaid Room & Board route was enabled. No production/shared migration, credential change, deployment, merge or force-push occurred.
