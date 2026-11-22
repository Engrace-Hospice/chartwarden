# M24-1075-L6 Engineering Disposition — Medicaid ERA Review Integration

Date: 2026-11-22
Branch: `audit/m24-1075-oregon-eocco-readiness`
Starting HEAD: `c53034b928fb30e79d3ed5ad4869c8bd37cc6896`
Develop base: `425a1f12717ca5c960efeaff3de6b03e8a1f7bbc`

## Decision

**`M24_1075_ENGINEERING_BLOCKED`**

The current branch provides an offline 835 observation and a fail-closed nonposting evaluator, but no production Medicaid ERA source is safely attributable to a tenant/provider and no M24 submission evidence chain can prove a real outbound transaction. Connecting the existing M25 Claim.MD review routes would incorrectly inherit M23/M41 source-ownership assumptions and would expose existing posting-plan operations. No new API, worklist, persistence, migration, or production reader was added in L6.

The blocker is both an engineering integration gap and a real external-evidence gap. External enrollment evidence alone cannot fix missing persisted submission identity and unbound reader seams. Conversely, engineering must keep unverified/unowned artifacts outside tenant worklists even if inbound test or vendor files become available.

## Verified architecture and available facts

| Flow component | Existing evidence | L6 disposition |
|---|---|---|
| Authenticated ERA staging | M25 has protected Claim.MD capture/inbox, account-scoped staging, ownership resolution, duplicate classification and tenant-stage history. Its ownership resolver currently proves the supported M23/M41 claim-source contracts. No compatible Medicaid-owned stage resolver was found. Stedi test-report retrieval remains inert documentation; no Stedi Medicaid staging reader exists. | Do not treat Claim.MD M23/M41 ownership as Medicaid ownership. No Medicaid artifact is exposed; an absent/unverified artifact must remain unavailable or held. |
| Payer/enrollment evidence | M24 has effective-dated payer/program and enrollment-evidence models, including an 835 ERA enrollment category. No verified production Medicaid ERA source-account association was found. A payer route or configured credential alone is not source-account or ERA enrollment proof. | No account evidence is marked verified and no M24 record is transformed into a vendor account qualification. |
| Shared parser and assessment | M25's `@chartwarden/x12-835-client` parser and the L5 pure observation/evaluator are available. L5 verifies digest and scope when supplied server-owned reader facts. | Reuse remains valid for offline evaluation; there is no production reader composition. |
| M24 claim read seam | `MedicaidClaimMatchProvider.candidatesForLine` returns only claim ID, control number and service dates. It does not return payer/program, version/state/lineage, submissions, acknowledgments, vendor/account identity, or transaction provenance. | No direct M25 database access is permitted. Existing seam cannot support the L5 production match contract. |
| M24 submission facts | `medicaid_submission` stores adapter/channel, result, vendor transaction ID and submitted timestamp; `medicaid_acknowledgment` stores payer claim control number and acknowledgment kind/outcome. Neither durably binds the submission to a vendor source account and test/production usage. The acknowledgment is not itself a Medicaid ERA delivery/account identity. | Claim/submission linkage remains `SUBMISSION_UNVERIFIED` for ERA review until the full source and submission chain exists. No historical backfill is safe. |
| Current outbound behavior | The M24 `submitClaim` path calls `electronicSubmissionRefusal` before creating a submission, changing claim state, or emitting its submit-requested outbox event. Current Medicaid submission remains disabled. | Local `DRAFT`/`READY` or synthetic 837I documents cannot be treated as external submission provenance. |
| Review API/history | M25 Claim.MD API offers scoped review and history, but also has Claim.MD-specific ownership and separate posting-plan routes. Its stage identity is not a Medicaid source contract. | Do not expose those routes as a shortcut. No Medicaid review decisions are persisted or shown to tenant users. |

## Selected safe flow

The intended future flow remains:

```text
Authenticated vendor artifact with qualified account identity
  -> Medicaid-specific M25 stage/ownership reader
  -> shared X12 835 parser
  -> M24 seam for effective claim, submission, acknowledgment and lineage facts
  -> L5 trust, duplicate, matching and nonposting assessment
  -> durable M25 nonposting review record/history
  -> permission-checked M25 review API and worklist
```

Only the shared parser and pure L5 evaluator are implemented in this flow today. Existing Claim.MD staging is not sufficient without a Medicaid ownership resolver; Stedi staging is not implemented. Existing M24 claim facts are available only through a narrower seam, and actual qualified Medicaid submissions are impossible while the submit guard remains in force. No claim can be promoted from local or synthetic state.

## Smallest safe next engineering action

1. Define and implement a Medicaid-specific authenticated stage reader for a vendor/account source that has genuinely qualified 835 enrollment. Keep unsupported vendors unavailable and test/production environments distinct.
2. Extend the approved M24 read seam with persisted claim/version/lineage, submission attempt, linked acknowledgment and source-account identity. Add an append-only nullable source-account/environment relation to future attempt records only if architecture review confirms this is the right persistence point. Do not backfill historical attempts.
3. Bind the L5 evaluator to those readers and to existing M25 duplicate identity logic. Require exact tenant/provider/payer/program and submission identity before returning financial observations.
4. Add durable, versioned, nonposting review history and a permission-checked API. Keep the Medicaid route surface separate from Claim.MD posting plans; add no posting action, claim transition, or financial outbox binding.
5. Add isolated PostgreSQL/NOBYPASSRLS coverage for the new persistence and API boundaries before describing the flow as operational.

Until the required source evidence exists, return `SOURCE_ARTIFACT_UNAVAILABLE`, `SOURCE_UNVERIFIED`, or `SUBMISSION_UNVERIFIED` as appropriate and show no financial details to an unowned tenant. Do not invent account mappings or vendor qualification to make the worklist nonempty.

## Consolidated qualification performed for L6

Focused cross-lot run:

```text
bun test \
  apps/backend/src/modules/24-billing-medicaid/routes/program-responsibility.test.ts \
  apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-resolution.test.ts \
  apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts \
  apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-duplicate.test.ts \
  apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts \
  apps/backend/src/modules/25-remittance/domain/__tests__/medicaid-era-observation.test.ts \
  apps/backend/src/modules/25-remittance/domain/__tests__/medicaid-era-trusted-review.test.ts \
  packages/medicaid-adapters/__tests__/m24-institutional-837i.synthetic.test.ts \
  packages/x12-837-client/src/claims/build-837i-claim.test.ts
```

Result: 9 files, 122 tests passed, 0 failed. These are focused unit/synthetic regressions, not one live end-to-end campaign and not vendor/payer qualification.

- GitHub PR #1088 reported no checks and no review comments at inspection time.
- No L6 database objects or reads were added, so no new PostgreSQL/RLS suite was run. Prior L2B isolated PostgreSQL results remain historical evidence, not an L6 persistence qualification.
- Full backend typecheck remains not completed because of the recorded 1.5 GiB heap OOM. Architecture-boundary analysis remains not completed after exceeding the bounded resource run. Gitleaks remains unavailable locally. These are not passes.
- Prior L5 strict targeted TypeScript, Biome, PHI and docs checks are recorded in the L5 report; they do not qualify a new production integration.

## Merge readiness

PR #1088 is **not merge-qualified** by this L6 review. The required operational review integration, source-account readers, M24 submission-evidence seam, durable nonposting review history/API, isolated persistence/RLS qualification and required full CI/architecture gates remain incomplete. No individual synthetic test or previous L0–L5 test campaign substitutes for these missing gates.

## Independent review findings

- **Blocking for this L6 objective:** the L5 evaluator has no production callers or concrete readers; no Medicaid review persistence, route, or worklist is bound. This is an integration omission, not evidence of an unsafe active payment path. The safe next step is the staged implementation listed above.
- **Medium, unresolved from L1:** the program-assignment verifier confirms that the canonical payer is active Medicaid in the same state, but M40 currently has no FFS-versus-CCO subtype for the server to compare with `programKind`. Reviewer separation and source documents do not substitute for a machine-verifiable identity relationship. Do not claim verified FFS/managed-care classification from that check alone; add an authoritative catalog/evidence contract before relying on it.
- The fresh code and security reviews found no confirmed critical/high vulnerability in the reviewed PR diff. They confirmed that the M24 submission refusal occurs before submission-row/state/outbox mutation and that shared X12 defaults preserve the Medicare path. This does not satisfy the missing operational integration or the medium program-identity limitation.

No EOCCO production qualification is claimed. Customer/Engrace 835 enrollment, EOCCO/OHA payer identity and acknowledgment semantics, vendor account-to-provider binding, and selected clearinghouse certification remain external prerequisites for any future activation proposal.

## Safety

L6 made no code or database mutation. No vendor or payer API/SFTP request occurred; no real ERA was retrieved; no payment was posted; no M24 state or financial outbox event changed; no Medicaid submission, production migration, or deployment occurred. Existing Medicaid submission refusal remains in force. No unverified evidence, EOCCO rate, authorization, or secondary Medicaid Room & Board path was enabled.
