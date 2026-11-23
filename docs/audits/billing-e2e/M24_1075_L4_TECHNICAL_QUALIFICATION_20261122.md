# M24-1075-L4 — Synthetic Medicaid ERA and Reconciliation Foundation

Status: offline, nonposting foundation only. This increment does not establish payer or customer qualification.

## Baseline and design

- Branch: `audit/m24-1075-oregon-eocco-readiness`; starting commit `b6529debd9e77de604ffb90198a3c28758df7694`.
- Reuse boundary: M25 and `@chartwarden/x12-835-client` remain the owners of X12 835 parsing, financial review, claim-match review and duplicate classification. This increment adds an M25-owned, pure adapter from the parser's parsed transaction to a transient M24-oriented observation. It adds no parser, ledger, route, database object, outbox event or production state transition.
- M24 still owns Medicaid claim state and responsibility snapshots. M25's existing Medicaid claim-facts seam is the production boundary for future tenant-scoped matching. L4 does not change or bypass that seam.
- The adapter always reports attribution as `unverified` and posting authorization as `false`. It does not turn payer/payee names, claim controls or patient controls into trusted tenant identity.

## Implemented

- `medicaid-era-observation.ts` maps transaction/group/interchange controls, trace, payment date/method/amount, payer/payee identifiers, claim controls, payer ICN, dates, charges, paid amounts, patient responsibility, service-line codes, units, references, claim/line adjustments and CARC/RARC codes into a transient observation. Remark narratives and member identifiers are not copied.
- The adapter delegates adjustment categorization, integer-cent conversion, claim classifications and BPR/CLP/PLB balance review to the existing M25 `projectEraFinancialReview` and `decimalDollarsToCents` functions. Missing values stay `null`; the parser rejects malformed wire amounts. Provider-level adjustments remain separately represented and receive a policy-review hold. No allowed amount is inferred.
- A payment reported as zero remains a zero-dollar observation. Denial classification depends on CLP02 denial status, not the amount alone. Production-facing observations report positive amounts as partial or payment-reported; only the test-only evaluator can label a fully balanced synthetic fixture `fully_paid_synthetic_review`, which is not a production adjudication or posting decision.
- The existing `classifyClaimMdEraCrossSourceDuplicate` is exercised for exact and possible duplicate cases. Possible duplicates remain held for review; the adapter does not discard or post either case.
- A test-only synthetic evaluator exercises scoped organization, provider, payer/program, account, submission, PCN and service-period matching outcomes, ambiguity, duplicate/review holds, denial, partial payment, balanced full-amount payment and no-posting behavior. It lives under `__tests__`; no production code can import a synthetic attribution as trusted source evidence.
- `medicaid-era-offline-contracts.ts` creates inert retrieval reference plans only. Stedi requires test application mode and a transaction UUID; Claim.MD requires a `synthetic:` account reference and models the `eralist` cursor followed by an `era835` detail reference. Neither helper carries credentials, accepts a transport, or performs network I/O.

## Identity, matching and financial limits

The production observation adapter intentionally does not match claims. The isolated synthetic evaluator demonstrates matching and refusal behavior against synthetic-only facts, but is not a production matcher. A production match still requires server-derived clearinghouse account attribution, canonical payer/program and payee/provider identity, organization and provider-entity scope, M24 submission provenance, service-period consistency, correction lineage and duplicate checks. A test control number or synthetic submission is not production send evidence. The current M25 identity review remains an input contract; it is not an automatic match based on claim ID alone.

The financial projection retains claim-level and line-level adjustments, patient responsibility, provider-level adjustments, reversals and unresolved balance conditions. Existing M25 review semantics distinguish denied, reversal, zero payment, partial payment, payment reported and insufficient data. They do not establish payer-specific adjudication or accounting policy. In particular, a positive amount is not proof of full settlement; PLB adjustments are not allocated to individual claims; and no payment is posted.

### Existing M24 `decimalToCents()` reachability review

M24's live consumer still maps absent/invalid decimal strings to zero. In the inspected M25 producer path, the `claim_paid` and `claim_denied` TypeBox event schemas require `paidAmount` to be a string, and both event producers format parser-derived amounts with `toFixed(2)`. The X12 parser has already validated those wire amounts into cents before producer formatting. I found no reachable path from an actual M25 event producer that emits a missing or malformed `paidAmount`; therefore this increment does not change the production consumer or previously posted history. A separately corrupted or hand-injected outbox payload is outside the producer contract and remains a hardening question before expanding posting semantics.

## Offline vendor contract evidence

- Stedi's published endpoint retrieves an 835 ERA report as JSON using a Stedi `transactionId`; transaction IDs are available through event destinations or transaction polling. The report includes claim/payment/remittance fields, but the API response is not raw X12 and must not be passed directly to the X12 parser. See the [Stedi 835 ERA report contract](https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-835).
- Claim.MD documents `eralist` with a retained `last_eraid` cursor and `era835` retrieval by returned ERA ID. Its documentation states that the integrator must match the remittance to its own claim; the API does not supply the application's Claim.MD claim identity. See the [Claim.MD API quickstart](https://docs.claim.md/docs/test-account-quickstart-guide).
- Claim.MD documents that API and SFTP may independently retrieve the same account's ERAs; this creates a cross-channel replay risk requiring account-scoped duplicate control. See [Claim.MD's same-account API/SFTP guidance](https://docs.claim.md/docs/using-sftp-and-api-integrations-on-the-same-claim-md-account).
- These are offline contract notes, not vendor sandbox results, enrollment evidence, or an EOCCO delivery qualification. No Claim.MD SFTP or Stedi API retrieval was implemented.

## Qualification

> **Paths updated (2026-11-22):** on rebase the Medicaid ERA observation test moved from `apps/backend/src/modules/25-remittance/domain/__tests__/` to `apps/backend/__tests__/m25-medicaid-era-observation.test.ts` (its cross-package fixture import fell outside the backend build's `rootDir`). The commands below name the current path; the recorded counts were produced at the old location.

Commands executed:

```text
bunx vitest run packages/x12-835-client/__tests__ apps/backend/src/modules/25-remittance/domain/__tests__ apps/backend/__tests__/m25-medicaid-era-observation.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-duplicate.test.ts
bunx tsc --noEmit --pretty false --target ES2022 --lib ES2023,DOM --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --noImplicitOverride --skipLibCheck --types node apps/backend/src/modules/25-remittance/domain/medicaid-era-observation.ts apps/backend/src/modules/25-remittance/domain/medicaid-era-offline-contracts.ts apps/backend/__tests__/m25-medicaid-era-observation.test.ts
bunx biome check apps/backend/src/modules/25-remittance/domain/medicaid-era-observation.ts apps/backend/src/modules/25-remittance/domain/medicaid-era-offline-contracts.ts apps/backend/__tests__/m25-medicaid-era-observation.test.ts
bun run harness:phi-scan apps/backend/src/modules/25-remittance/domain/medicaid-era-observation.ts apps/backend/src/modules/25-remittance/domain/medicaid-era-offline-contracts.ts apps/backend/__tests__/m25-medicaid-era-observation.test.ts docs/audits/billing-e2e/M24_1075_L4_TECHNICAL_QUALIFICATION_20261122.md
bun run arch:architecture-docs
bun run arch:module-docs
timeout 90s env NODE_OPTIONS=--max-old-space-size=1536 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false
timeout 90s env NODE_OPTIONS=--max-old-space-size=1536 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false --incremental false
bun run arch:boundaries
git diff --check
```

Results: **33 test files passed, 600 tests passed**. The new tests parse synthetic test-mode X12, adapt multiple claims and transaction sets, verify exact cents and PLB balance, preserve line codes/units/references/adjustments/remarks, preserve a denial with a zero-dollar remittance, assert unverified attribution and no posting authorization, exercise synthetic scoped-match outcomes, verify inert Stedi/Claim.MD retrieval plans and reuse M25 exact/possible duplicate decisions. The targeted strict TypeScript check, changed-file Biome, 4-file PHI scan, architecture-doc check, module-doc check and `git diff --check` passed.

No PostgreSQL/RLS suite was applicable because no database schema, persistent read path or authorization boundary changed. The command with `--incremental false` exited immediately with TS6379 because composite projects disallow that option. The full backend project typecheck then ran with a 1.5 GiB V8 heap limit and exited out-of-memory. The bounded targeted strict typecheck for the changed files passed. The full `arch:boundaries` dependency-cruiser run did not finish during two 30-second attempts; full architecture fitness was not run. No vendor sandbox test, provider/payer enrollment test, production match, live ingestion, full E2E from the L3 837I builder, or secret scan was run for L4. Local Gitleaks was unavailable. These are not counted as passing.

**Update 2026-11-22 (PR #1088 review-fix pass):** at `e91e0ec9b` the branch passes `bun run typecheck`, `bun run lint` and `bun run arch:fitness`; the out-of-memory and not-completed entries above describe the bounded local runs made at the time and are superseded for typecheck and architecture-fitness status. The M40/M24 provenance migration is ordinal 1541. This records the gate status for that commit; it is not a new qualification of this lot's behaviour, and full `bun run test` is not part of this update.

Independent fresh code and compliance reviews found no remaining CRITICAL/HIGH findings. The reviewers' initial line-detail and test-only matching completeness findings were addressed; the low-severity wording note was clarified. Reviewers did not independently execute tests or external vendor qualification.

## Explicitly unresolved

- No trusted source-account resolver binds an inbound 835 to an organization/provider entity/canonical payer for Oregon Medicaid. Existing Claim.MD attribution applies only to its current supported account workflows and is not EOCCO qualification.
- No L4 production matching, adjudication outcomes, corrected-claim lineage, cross-tenant/provider negative match matrix, delivery retry/recovery logic, or operator worklist was added.
- Full-paid versus adjusted/partially-paid accounting policy, allowed amount, CARC/RARC payer interpretation, supplemental remits and PLB allocation remain unqualified. No M24 partial/reversal/recoupment consumer was activated.
- Stedi payer-level 835 enrollment, EOCCO account and report identity, Claim.MD payer enrollment/ERA account, source account ownership, and Engrace provider/payee enrollment must be confirmed by the respective owners. Public vendor API docs do not establish EOCCO support for hospice.
- No vendor sandbox test, EOCCO certification, customer enrollment, production authorization or real ERA was obtained.

## Safety

Medicaid electronic submission remains disabled. No Stedi/Claim.MD API or SFTP call, payer transaction, real ERA retrieval, production claim update, outbox event, payment posting, migration or deployment occurred. Tests use only synthetic fixtures. No EOCCO amount, authorization, enrollment or payer-verified status was created. Secondary Medicaid Room & Board remains unsupported.

## Next

Before any activation lot, implement authoritative source-account attribution and server-side match resolution, complete safe partial/reversal/recoupment review semantics, prove cross-tenant and provider-entity isolation, add controlled operator review, and obtain Engrace/EOCCO/clearinghouse enrollment and test evidence. Keep an offline ERA processing path separate from live delivery and posting until those gates pass.
