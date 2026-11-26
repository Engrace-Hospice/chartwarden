# M24-1075-L8A.1 — Effective-Dated Oregon Medicaid Rate Policy and Pricing

- Date: 2026-11-25
- Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
- Starting HEAD: `0e6ce4e9f5fd4b295095716cd748aeddbcf42493`
- PR: [#1115](https://github.com/Engrace-Hospice/chartwarden/pull/1115), Draft; issue #1075 remains open.
- Prior group disposition remains `M24_1075_L7_GROUP_BLOCKED`; this incremental lot does not requalify L7.

## A. Implementation

L8A.1 extends the existing M24 payer-rate evidence and selector rather than adding a second rate catalog. The exact selector now resolves inclusive service-date spans by organization, provider entity, canonical payer/program, state, locality, service category, unit basis, RHC election-day bucket, quality-reporting applicability/status, source, methodology, verification provenance and assessment time. It splits at partial effective-period overlaps, preserves real ambiguity, excludes evidence recorded or verified after the assessment instant, and follows supersession/revocation lineage without reviving an earlier rate.

The new pure `packages/medicaid-adapters` pricing engine calculates deterministic integer-cent reimbursement estimates for explicit daily units or clinical minutes. It implements policy-defined prorating/rounding, minimum-duration requirements, and qualified service-day/segment ceiling rules. Synthetic tests cover daily and hourly arithmetic, 60/61-day buckets, quality variants, effective-date changes, charge ceilings, missing evidence, overflow and partial pricing. The engine never equates the estimate with provider billed charges, payer-allowed amounts or payment; those outputs remain `null`.

The existing M24 assembly preview reads `medicaid_payer_rate_policy` within organization context and explicitly filters provider, payer/program, state and overlapping service dates. It feeds the selected rows into the shared selector/engine and returns effective-dated segments, provenance and required inputs. It does not read the shared legacy state schedule. FFS rows require OHA FFS source/methodology; managed-care rows require payer/provider-specific contract evidence, with no FFS fallback.

## B. Evidence and remaining limits

The repository does not yet provide authoritative preview readers for CBSA/contract locality, provider quality-reporting status, election-day count, actual CHC minutes, provider usual charge, or the inpatient-respite episode sequence. The preview supplies these as unknown and therefore returns unresolved or partial spans rather than invented rates or zero amounts. The selector and calculation path can resolve explicitly complete synthetic fixtures; this proves arithmetic and representation only.

No rate authoring/verification operator route was found for `medicaid_payer_rate_policy`. Existing persistence provenance and distinct-recorder/verifier checks remain authoritative; this lot adds no verification bypass or public rate-activation API. A controlled rate-import/review workflow and source-document approval remain necessary before production rate evidence can be entered and verified. No OHA tariff or EOCCO contract price was loaded.

OHA's official FY2027 hospice memo says its FFS schedule applies to services from 2026-10-01 through 2027-09-30, describes CBSA-based rates, an RHC day-61 code distinction and quality-reporting treatment. The published schedule describes the FFS amounts and the usual-charge/CBSA basis. OHA's fee-schedule guidance says the listed rates apply to services billed FFS to OHA and directs providers to the CCO for CCO rates. The current Secretary of State Division 142 page was reopened during this lot. No numeric public rate was copied into code or fixtures. Sources: [OHA FY2027 hospice memo](https://www.oregon.gov/oha/HSD/OHP/Announcements/Hospice-Rates1026.pdf), [OHA FY2027 hospice schedule](https://www.oregon.gov/oha/HSD/OHP/Tools/Hospice-Rates100126.pdf), [OHA fee-schedule applicability](https://www.oregon.gov/oha/hsd/ohp/pages/fee-schedule.aspx), and [Oregon Division 142 rules](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729).

## C. Preview, UI and claim persistence boundary

The existing assembly preview now displays pricing status, payer/program, rate source and effective span when known, missing evidence, per-segment reimbursement estimates, and the overall estimated reimbursement only when every requested day and required input resolves. The English wizard explicitly states that an estimate is not the provider's billed charge, payer-allowed amount or payment. It states electronic submission remains unavailable. DOM tests cover resolved synthetic, incomplete and missing-amount cases.

L8A.1 does not persist pricing or create claim lines. `medicaid_claim_line.state_rate_schedule_id_snapshot` points to the legacy shared schedule and cannot safely hold a `medicaid_payer_rate_policy` ID. L8A.2 must add a source discriminator and immutable evidence ID/version, methodology version, inclusive service range, quantity/unit basis, calculation, ceiling and rounding snapshots; support multiple priced spans within one LOC period; preserve historical reproducibility; and revalidate the underlying facts before any future READY transition. Clinical quantity, LOC integration and this schema remain out of scope.

## D. Database

Migration `1550_m24_rate_policy_methodology_and_variants.sql` adds explicit methodology, conversion, minimum duration, rounding, charge-ceiling and quality-applicability columns with unqualified defaults. It supports an open-ended final election-day bucket, distinct quality-status rate variants and a `NOT VALID` complete-methodology check for verified rows. Historical evidence remains unqualified; no rows are promoted or rewritten. The rate identity constraint is rebuilt to include quality applicability/status and uses `UNIQUE NULLS NOT DISTINCT` semantics.

The migration is classified `contract` because it replaces constraints and must follow the repository's operator hold. It was applied only to a private disposable PostgreSQL 18 container for this qualification. No shared or production database was modified. No new table, cross-module FK or production claim snapshot was introduced.

## E. Targeted qualification

| Check | Result |
|---|---|
| Focused Vitest: payer-rate policy, hospice pricing, service segmentation, M24 preview route validation and assembly-wizard DOM tests | 5 files passed; 78 tests passed. The added narrowed-correction regression prevents a superseded open-ended predecessor from resurfacing. |
| `bunx tsc -b packages/medicaid-adapters --pretty false` | Passed. |
| `bunx tsc -b apps/web --pretty false` | Passed for the affected frontend project. |
| Changed-file `bunx biome check` over 15 implementation/test files | Passed; no formatting changes required. |
| Private disposable PostgreSQL M24 RLS suite, migrations through 1550 | 78 passed. Includes the verified methodology constraint and unsupported in-home respite refusal. |
| Private disposable PostgreSQL `bun run test:m24:claim-line-assembly:live` | 25 passed, 7 intentionally skipped. Skips are pricing-dependent legacy assembly assertions and remain gated while persisted pricing is intentionally unavailable. |
| `bun run openapi:emit`, `bun run client:gen`, `bun run openapi:check`, `bun run client:check` | Passed after regeneration; 2,154 routes enriched and generated client is current. |
| `bun run arch:ddl`, `bun run arch:tenancy`, `bun run arch:migration-numbering`, `bun run arch:migration-compat`, `bun run arch:openapi-provenance` | Passed. Migration numbering reported 807 unique ordinals; compat checked 197 migrations from 1288; OpenAPI provenance reported no duplicate aliases or route keys. |
| `bun run arch:module-docs` | Passed: 41 specs, 41/41 index parity and 203 relative links. |
| Scoped `bun run harness:phi-scan <changed-files>` | Passed: all 23 changed files clean. |
| Gitleaks | Not available in the local environment (`gitleaks` executable not installed); no secret-scan result is claimed. |
| `git diff --check` | Passed on the implementation and documentation diff. |

The RLS/assembly tests ran against `127.0.0.1:55433` in a private disposable container, not the shared `os-postgres-1` service on port 55432. The disposable container will be removed after the final checks. No full monorepo test/typecheck/lint, `arch:fitness`, production image build or Compose campaign was launched, per this lot's targeted-only verification scope. The L7-V deferred verification debt is unchanged.

## F. Outstanding work

- **L8A.2:** owner-backed locality, quality, election-day, CHC-minute and respite-sequence readers; authoritative M6 quantities/LOC segmentation; immutable payer-rate line snapshots and mutation-boundary revalidation.
- **L8A.3:** authorization, timely-filing, bill-type and liability policy.
- **Rate operations:** verified OHA source catalog evidence and an approved provider-specific rate import/review workflow. EOCCO still requires an actual provider contract and confirmed methodology/effective dates; public OHA rates cannot substitute.
- **L7/V release qualification:** aggregate branch gates and immutable production Compose/release-image qualification remain outstanding under `M24_1075_L7_GROUP_BLOCKED`.

No maintainer decision is needed to test this engine with synthetic facts. Before any production use, the owners must supply the authoritative locality and clinical facts, and a separately authorized rate-evidence verification path must exist.

## Safety confirmation

Medicaid submission remains disabled. No vendor or payer request, ERA retrieval, payment posting, ledger mutation, financial claim-state transition or financial outbox publication occurred. No EOCCO or OHA rate was loaded or approved. No secondary Medicaid Room & Board route was enabled. The migration ran only in disposable PostgreSQL; no production migration, credential change, deployment, merge, or force-push occurred.
