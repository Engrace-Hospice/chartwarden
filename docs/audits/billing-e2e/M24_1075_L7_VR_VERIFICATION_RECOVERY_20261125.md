# M24-1075-L7-VR — Verification Recovery & Qualification Reconciliation

- Date: 2026-11-25
- Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
- Starting remote PR head: `38bb3143a4dcf7e322aff1c6f5d58d2b303b4011`
- Previous qualification: `d9deb222d1b7f1ff91c69dd3652d19bf0e026fc4`
- Reconciled source head before this report: `5ace0dfa6812a5774d397a21f799ffcd2e327d4a`
- PR: [#1115](https://github.com/Engrace-Hospice/wardenx/pull/1115), Draft; issue #1075 remains open.

## Baseline reconciliation

Fetched the PR branch and `origin/main`. The branch had advanced from the previous qualification and contained the service consolidation, source/assessment integrity fixes, worklist changes, test fixes, and evaluator migrations. Main was then integrated with a normal merge commit (`91519d6a9`); no rebase, reset, force-push, or unpublished-work overwrite was used. The merge included main's object-store changes and generated coverage reports. Coverage reports were regenerated from the merged source. The controls register retained both the main object-store note and the existing M24/M25 data-erasure gap; CW-DS-01 remains `partial` with its existing owner and review date.

The PR's remote head at the time of reconciliation was `38bb3143`. Its recorded base was behind main and GitHub reported conflicts. The local merged tree now contains main at `3efb7fbba28f3cdf7555d0ab4de7e1f6b54fda03`. Migration files and journal did not change between remote PR head `38bb3143` and the reconciled tree. The PR description was not treated as execution evidence.

Relevant intervening PR commits include `24551a73` (one review service and evaluator/worklist/API corrections), `34c49ca8` (M24 enrollment/readiness corrections), `f5a45ae2` (ERA FK indexes, restricted function search paths, audit scrubbing and provider/location integrity), `1be8d6d3` (837I compatibility corrections), and `da261fe4` (review UI corrections). The latest PR-head correction `38bb3143` preserves adjustment observations on reassessment. These source changes explain why the earlier positive evaluator integration could not simply be reused.

## Evidence matrix

| Check | Source commit / result | Changes after that run | Applicability and recovery |
|---|---|---|---|
| PR image/deploy-path workflow | Exact remote PR head `38bb3143`; workflow run `45552682479`; all 5 jobs succeeded. | Main was subsequently merged locally; the workflow was not rerun on the merged head. | Evidence remains limited to the jobs actually in that run (container/image checks and deploy-script/Compose dry-run). It is not production Compose topology or full CI evidence. |
| Full lint, typecheck, architecture 50/50, full unit suite | PR description asserted these passed (including 3,037 files), but no corresponding workflow/check artifact for `38bb3143` was found. | Multiple commits and main integration followed. | Not independently evidenced and not counted. No full campaign was repeated under this recovery scope. The earlier L7-V run at `f9f36ae` recorded 3,025 files passing and 4 failures; that historical result is not silently replaced by the later PR-body assertion. |
| M25 live evaluator/API/PostgreSQL suite | `38bb3143`: 34/34 passed using private disposable PostgreSQL and the supported evaluator/API container harness. | Main integration changed backend/API runtime dependencies. | Requalified the actual positive path on the merged tree: `persists a synthetic Claim.MD 835 through the isolated evaluator runtime and restricted writer` passed (1 passed; 33 filtered), exercising the consolidated service, current evaluator communication, source reader, restricted writer, durable review/history and mounted route path. The 34/34 result remains historical for the other cases; they were not all rerun after main. |
| M24 RLS | `38bb3143`: 78/78 passed on private disposable PostgreSQL. | No M24 implementation change from main integration. | Reused; migration and M24 code were unchanged by the merge. |
| M40 RLS | `38bb3143`: 15/15 passed on private disposable PostgreSQL. | No M40 implementation change from main integration. | Reused; migration and M40 code were unchanged by the merge. |
| Migration runner/fresh and upgrade paths | `38bb3143`: `test:db:migrate:live` 29/29 passed on disposable PostgreSQL, including full chain, historical upgrade, rerun and contract-hold checks. | No migration or journal diff from `38bb3143` to the merged tree. | Applicable to current migration contents. Inventory is 1546 (main object-key rename), 1547 (isolated evaluator), 1548 (integrity/source reader), 1549 (point-in-time assessments); the journal names all three evaluator migrations once and numbering has no new collision. Contract migrations remain held. |
| Focused review/readiness/browser regressions | Merged-tree targeted suite: 337/337 passed across 14 focused files. | No later implementation changes after this suite; only this report/audit update follows. | Current source-level evidence for M24 readiness/evidence seams, M25 attribution/evaluation/workflow/routes, operator review UI, sentence-case guard and affected signer/Stripe tests. |
| Synthetic secret-fixture regressions | Commit `5793c839`: signer/Stripe affected tests, 53/53 passed. | Main merge did not alter these tests. | Applicable; static secret-shaped fixtures were replaced with a pinned digest of deterministic synthetic signer output and a runtime-generated test token. No real credential was found. |
| GNU/BSD `env` regression | Commit `5ace0dfa`: harness test 44 passed, 1 skipped. | No later code change. | Corrected platform detection: the BSD `-P` case runs only when the host supports it; parser coverage still runs. Linux skip is explicit, not a pass of BSD behavior. |
| `arch:parity` | Current reconciled source `5ace0dfa`, clean detached worktree: passed (47 packages + 4 apps). | Documentation-only changes follow. | Applicable. Main workspace still has ignored generated directories that make its direct parity run fail; no ignored data was removed. |
| Targeted architecture and migration gates | Current reconciled source: Compose policy, migration numbering, migration compatibility, DDL legality, compliance, merge-artifact checks all passed. | Documentation-only changes follow. | Applicable to current source. Numbering: 806 migrations with no new ordinal collision; compatibility: 196 checked from 1288; DDL has no reported legality errors; no conflict markers. |
| FK index live suite | Current disposable run: 3 passed, 1 failed; the failure reports 17 unindexed foreign keys. | Inspection traced all 17 to migrations already on `origin/main` (12 named constraints and 5 implicit declarations). | Confirmed baseline failure, not attributed to this PR. No unrelated main migration was changed. The result remains a repository-level qualification finding. |
| Gitleaks | Pinned Gitleaks 8.30.1, redacted scan of a clean tracked-source snapshot at `5ace0dfa` plus the updated audit/report documents: zero findings. Binary checksum verified against the official release checksum file. | Scan occurred after fixture corrections and main integration; only the final report wording follows. | Earlier findings were synthetic tests, not real credentials. The pre-correction scan also saw an ignored stale generated `dist` copy; it was not changed or removed. |
| Release Compose/runtime topology | At the prior preflight, pinned SeaweedFS pull timed out after 60 seconds; no immutable current API/web release images were available and the official web image dependency download did not complete. | Compose policy was rerun after main merge and passed; PR image workflow dry-run is not runtime topology. | Still not release-qualified. No repeated image pull/build was attempted. The exact missing prerequisite and smallest intervention are recorded below. |

## Recovered evaluator integration

The merged-tree positive test used the real isolated evaluator/API/PostgreSQL harness, not a handcrafted reader implementation. It drove the repository's Claim.MD protected staging, source-reader and L5 assessment path through the internal evaluator runtime, then the restricted writer and durable review/history tables. The test asserted its actual stored nonposting result and API/runtime wiring. The suite uses explicitly synthetic X12 data and disposable database rows. It did not contact Claim.MD, Stedi, or a payer; it did not create a production submission, payment, claim-state change, or financial outbox event.

The test fixture establishes that the corrected consolidated service works for the covered synthetic source and hold/assessment path. It does not establish a real provider enrollment, production account, EOCCO ERA route, or qualified M24 production submission. Where real submission evidence is absent, the assessment remains unresolved/nonposting.

## Secret scan and fixture disposition

The two prior findings were in deterministic test inputs: a valid, deterministic signer output and a Stripe-shaped fake value used to test redaction. They were not credentials. To preserve the signer regression without storing a token-shaped value, the test now pins the hash of the synthetic signer output. The redaction test generates its token-shaped input at runtime. The affected test files passed as part of the merged-tree focused suite (337/337 across 14 files). No allowlist or global scanner weakening was introduced, and no rotation or history rewrite was performed. The final clean-snapshot Gitleaks 8.30.1 scan reported zero findings.

## Release-image preflight

The bounded preflight found the registries reachable, adequate local disk and memory, but no locally available digest-pinned SeaweedFS image or current immutable API/web release images. One 60-second pull of the exact pinned `chrislusf/seaweedfs:4.52` digest did not finish; it was not retried. The official web image build also remained blocked while fetching its declared dependencies. No substitute image or dependency version was used. `arch:compose-policy` passes, and the GitHub dry-run passed at its tested head; neither proves that the production base plus evaluator overlay starts with the actual release images, restricted roles, secrets, and network policy.

Smallest intervention: restore reliable access to the exact pinned SeaweedFS digest and required build dependencies, build/publish digest-pinned API and web images from the candidate source, then run the disposable production Compose base/overlay qualification. Until then, release-topology qualification is blocked.

## CW-DS-01 owner decision record

Affected records include M24 `medicaid_program_assignment` and `medicaid_payer_authorization_event`, plus M25 `medicaid_era_review` and append-only `medicaid_era_review_history`; the review summary can contain claim/submission references and cents, and authorization evidence uses a protected reference. They are patient-linked financial/authorization data. The current register records no M24/M25 eraser; existing M36 retention/legal-hold mechanisms do not provide a deletion path for these records. Audit/history integrity and financial-record preservation must be retained.

No retention period or destruction authorization is inferred here. CW-DS-01 remains partial and requires the assigned privacy/compliance/finance owner to decide the rule and mechanism before the first applicable patient-erasure request is processed. Options for that owner to assess include a narrowly scoped, independently authorized destruction operation pinned to organization/patient and legal-hold state, or approved cryptographic erasure/de-identification of patient and claim references while preserving required financial/audit history. Neither option is implemented. This open control does not by itself prohibit synthetic, nonposting internal engineering qualification; it prevents claiming the erasure control is closed and leaves production handling of real patient erasure requests subject to the owner decision. No unrestricted deletion or self-approved exception was introduced.

## Remaining verification debt and disposition

| Item | Status | Required follow-up |
|---|---|---|
| Consolidated evaluator integration | Newly qualified for the synthetic case on merged source. | Keep production source/account and submission evidence fail-closed; qualify additional cases in the integrated release campaign. |
| Global lint/typecheck/full test/50-gate evidence | Not independently verified on the reconciled candidate; PR description assertions are not execution artifacts. | Attach or run the repository's required integrated CI on the final branch at the group qualification checkpoint. Do not count historical source-head claims. |
| 17 FK-index findings | Confirmed on `origin/main`, unrelated to this PR. | Main maintainers should track them in the owning database qualification process; do not modify them in this lot. |
| Immutable release Compose topology | Blocked by unavailable pinned image/build dependencies. | Restore exact registry/dependency availability and run the actual digest-pinned API/web/evaluator topology. |
| CW-DS-01 | Requires privacy/compliance/finance owner decision; control remains partial. | Owner to determine retention/preservation/destruction policy; no engineering agent should self-approve it. |
| EOCCO/customer/vendor qualification | External evidence absent. | Obtain authoritative enrollment, payer program, exact 837I/835 route, source account, payer policy/rates/authorization and production approvals in later controlled work. |

The PR's requested full lint/typecheck/50-gate/full-suite result was not supported by a GitHub check artifact on remote head `38bb3143`; the only workflow inspected on that head was the five-job image/deploy-path workflow. The current main `Release and deploy` run was still in progress during this recovery and is not a PR qualification result. Do not describe either as a passing full branch CI campaign.

**Disposition: `M24_1075_L7_GROUP_BLOCKED`.** The changed evaluator path is requalified and the corrected targeted checks pass, but the immutable release topology remains unqualified and the candidate does not have independently evidenced aggregate branch CI. The 17 mainline FK findings and CW-DS-01 are recorded separately with their actual ownership; neither is silently reclassified as fixed here.

**L8A may proceed as isolated, synthetic-only billing-policy development.** It must not depend on live ERA ingestion or activate payer routes, submission, posting, or real patient data. Group-level release qualification and external payer/customer approvals remain prerequisites for production activation.

## Safety confirmation

Medicaid submission remained disabled. No live payer/vendor request or ERA retrieval occurred. No payment, ledger entry, financial claim-state transition, or financial outbox event was created. No production migration, credential change, or deployment occurred. No synthetic evidence was promoted to production, no EOCCO rate or authorization was approved, and no unsupported secondary Room & Board path was activated.
