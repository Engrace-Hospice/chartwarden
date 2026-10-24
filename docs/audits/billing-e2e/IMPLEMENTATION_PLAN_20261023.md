# Billing end-to-end implementation plan

**Date:** 2026-10-23 · **Status:** proposal, nothing approved or built · **Companion:** [`SCENARIO_COVERAGE_MATRIX_20261023.md`](./SCENARIO_COVERAGE_MATRIX_20261023.md)
· **Issues:** [`ISSUES_20261023.md`](./ISSUES_20261023.md)

Authority: [ADR-0053](../../adr/ADR-0053-clearinghouse-transport-port.md) (one `ClearinghouseTransport` port, conformance is
the definition of done), [ADR-0052](../../adr/ADR-0052-dde-work-queue.md) (NOE timeliness is judged on payer acceptance),
and [`../clearinghouse-integration/ADAPTER_EXPANSION_PLAN_20261011.md`](../clearinghouse-integration/ADAPTER_EXPANSION_PLAN_20261011.md)
(tracks A and B). This plan does not replace them; it orders the remaining work by what the scenario matrix shows is untested.
Where they disagree, they win.

## 1. Where we are

- The claim cycle already has substantial code and live suites for M23, M24 and M25. Six of fourteen end-to-end scenarios
  are covered by tests, six are partial and two have no test (matrix).
- **The central gap is wiring, not features.** `bindPlatformClearinghouse` builds the Stedi transport at boot
  (`apps/backend/src/index.ts`, ~3503) and only logs it (~12426). The M23 workers submit through the legacy launch
  gateway (`X12ClientPort` plus `MacPortalPort`, sidecar outside the repo). The adapter's strong idempotency and UNKNOWN
  handling therefore protect no production path yet.
- `direct_mac` is an accepted `CLEARINGHOUSE_VENDOR` value with no adapter; setting it fails the boot.
- Medicaid electronic submission exists for Oregon only; commercial has a remittance discriminator but no claim lane.

## 2. Principles

1. Prove the Medicare vertical slice end to end before widening payers or states.
2. Reuse the port and conformance suite; no new framework. A second adapter must pass the same cases unchanged.
3. Fail closed. An unsupported payer, state or transaction refuses to send and says why. No silent fallback between
   clearinghouses.
4. Bound is not computing: every wiring change greps `index.ts` for the factory and ships a test that a consumer
   actually receives the dependency.
5. Synthetic data only until BAA, enrollment and payer testing gates pass. Live suites run on a private
   `pgvector/pgvector:pg18` container, never the shared cluster.
6. Batch pushes to `main`. Each live suite needs a `package.json` script and a `ci.yml` job row. Run `/ecc:code-review`
   on the branch diff before every PR.

## 3. Work tracks

### Track 1 - Decide and consolidate the submission path (blocks everything else)
| Step | Output | Gate |
|---|---|---|
| 1.1 Decision | ADR-0053 amended: Path B (the transport) becomes the only submission path; status moves from Proposed once the first adapter passes | `arch:adr-docs` |
| 1.2 `direct_mac` transport | Existing gateway wrapped as a transport so the port is proven against a non-Stedi implementation (plan item B1) | conformance suite green, `transport-registry.test` |
| 1.3 Inject the binding | M23 submit, retry and ack workers receive the binding behind one switch (default: legacy path); a test asserts the worker calls the injected transport | live suite, `m23-clearinghouse-binding.test` extended |
| 1.4 Retire the legacy path | Removed only after one pilot billing cycle on the transport | pilot sign-off |

### Track 2 - Close the scenario gaps (can start in parallel, uses fakes)
| Scenario | Work |
|---|---|
| S01 | One live suite chaining claim, submit through the in-memory clearinghouse, 277CA, 835, posting |
| S05 | Worker killed before send, after send before response, after response before commit; expect UNKNOWN and reconciliation, no blind resend |
| S07 | Golden 835 with CAS reasons, partial pay and recoupment; assert ledger balances |
| S09 | Supplemental 835 after a won appeal updates the financial position |
| S11 | Runtime refusal for non-Oregon Medicaid with a user-facing alternative; confirm what `trading-partner` and credential tables already record before adding any capability table |
| S12 | Live 835 test with `payerKind: "commercial"` and no candidate provider: lands in manual review, never auto-posts |
| S13 | Claim straddling 1 October; FY2027 rate reconciliation against CMS source tables |
| S14 | Credential rejected or expired at runtime: degraded result, alert, nothing sensitive in logs |
| S02 | Confirm missing-election and missing-coverage rules block, with tests |

### Track 3 - Remittance feed
Bind the transport's `fetchRemittances` to the M25 835 intake (plan item A5). Relates to open issue #253 (blocked on
real payer/SFTP infrastructure) and #671 (payee TIN/PTAN comparison). Keep the in-process TypeScript parser (ADR-0037).

### Track 4 - Second clearinghouse adapter (Claim.MD, or another candidate)
Requested 2026-10-23: an alternative to Stedi. ADR-0053 and plan items B3/B4 already provide the route; build it only
after Track 1 step 1.2 so the port is not fitted to Stedi alone.

| Step | Output |
|---|---|
| 4.1 Spike (written comparison) | First pass done: [`CLEARINGHOUSE_VENDOR_COMPARISON_20261023.md`](../clearinghouse-integration/CLEARINGHOUSE_VENDOR_COMPARISON_20261023.md) from vendor documentation; the written vendor answers it lists are still outstanding. Original scope: | Claim.MD vs Availity vs Office Ally vs Stedi on: hospice 837I, NOE (81A) and NOTR (81B) support; whether their route is an API or file-based; 999/277CA/835 return path; whether one platform account can serve many provider entities (Claim.MD's pages describe provider records on one account and a vendor-link setting, not a platform model; Stedi describes one integrated account per provider; both need written confirmation); BAA; sandbox; price at roughly 100-170 transactions a month per tenant. Facts from vendor documentation are unverified until the vendor confirms them |
| 4.2 Decision | Go or no-go recorded in an ADR amendment |
| 4.3 Adapter | `claimmd` factory in `buildClearinghouseFactories`, new `CLEARINGHOUSE_VENDOR` value, reusing `attempt-store` for durable idempotency |
| 4.4 Conformance | Passes every `CLEARINGHOUSE_CONFORMANCE_CASES` entry with the vendor stubbed; capability-tag any case the vendor cannot meet and record why |
| 4.5 Per-agency choice | Platform setting first; an agency-owned account can follow through the same port (ADR-0053 D3) |

Risks to settle in the spike: how the vendor returns payer-stage acknowledgments (D2 needs both stages), idempotency key
lifetime, whether a claim can be resubmitted safely after an ambiguous failure, and Medicare enrollment being per payer
and per provider regardless of vendor.

### Track 5 - Vendor and external prerequisites (not engineering)
Stedi answers on sandbox provisioning (Q14), Medicare Part A enrollment (Q16) and frequency 7/8 replacements (Q17)
([`STEDI_QUESTIONS_20261008.md`](../clearinghouse-integration/STEDI_QUESTIONS_20261008.md)). Sandbox contract run with
synthetic patients. Clinical-billing and compliance review before any live send.

## 4. Order

1. 1.1 decision, then 1.2 and 1.3 (one PR, tests first).
2. Track 2 in parallel from day one: S12, S11, S07 and S13 need no new wiring.
3. S01 and S05 once 1.3 lands.
4. Track 3 once 1.3 lands.
5. Track 4 spike can run now; build after 1.2.
6. Track 6.1 placement decision can run now; the build waits for it and for 1.3.
7. Sandbox contract run and pilot after Track 5 answers arrive.

Calendar estimates are deliberately omitted; re-plan after 1.3.

### Track 6 - Commercial claim lane (requested 2026-10-23)
**What exists.** Commercial is a payer kind in MDM (`mdm/payers.ts`) and in `m25_payer_kind`; patient payer ranking
already resolves "Medicare is not primary behind a commercial payer" (`m23-claim-assembly-seams.live`). **What does not.**
No commercial claim assembly or submission. M23 spec D15 rejects any claim whose primary payer is not Medicare FFS
(`NON_MEDICARE_PRIMARY_PAYER`) and points to "commercial billing (out of scope for Phase 1)"; M25 spec D9 defers commercial
835 to Phase 2. Those are module specs, so a decision here needs an ADR and the architecture document still wins.

| Step | Output |
|---|---|
| 6.1 Placement decision | New module (own `codePaths`, owned tables, manifest `.ts` and `.cjs`, scaffold) versus extending M23. Recommended: a new module so M23 stays Medicare-only and the D15 guard stays true; it reuses the M23 claim-assembly facts and the 837I builder through a seam rather than copying them. ADR records the choice and the D15/D9 amendments |
| 6.2 Payer and plan model | Commercial payer, plan, claim filing indicator, the payer id each clearinghouse routes on, contract and rate terms, authorization requirements. Reuse MDM payers; add only what is missing |
| 6.3 Claim assembly and validation | 837I for hospice with payer-specific edits, pre-authorization, coordination of benefits when Medicare or Medicaid is secondary, effective-dated rules. Hard blocks and audited overrides follow the M23 pattern |
| 6.4 Submission | Through the same `ClearinghouseTransport`; a payer the chosen clearinghouse does not route, or where the agency has no enrollment, refuses to send (fail closed) |
| 6.5 Eligibility | 270/271 per payer through `checkEligibility` |
| 6.6 Remittance matching | Commercial claim ownership and a payer-keyed candidate provider for M25, so commercial 835s can match; auto-post only when the match is certain, otherwise manual review (issue 6 first) |
| 6.7 UI | Payer-kind filters and commercial-specific panels in the existing billing screens, using the shared kit and the redesign style |
| 6.8 Scenarios | New scenarios S15-S19 below, each a live test |

Medicare Advantage needs a check before design: confirm with a billing expert how hospice for an MA enrollee is billed
(it is generally billed to the Medicare contractor, not the plan). Treat that as unverified until confirmed.

**New scenarios for the lane**
| # | Scenario | Expected |
|---|---|---|
| S15 | Valid commercial hospice claim | Correct 837I, accepted, 835 matched and posted |
| S16 | Commercial primary, Medicare secondary | Claim carries the COB data; Medicare claim is not wrongly billed as primary |
| S17 | Authorization missing or expired | Hard stop with an actionable message |
| S18 | Payer not routed by the clearinghouse or agency not enrolled | Refuses to send, says why |
| S19 | Commercial 835 matched to the wrong tenant or payer | Quarantined, nothing posts |

## 5. Out of scope here
Nationwide Medicaid beyond Oregon and a new payer-capability table. Each is a product decision (see `needs-decision` in
the issues) and depends on per-state enrollment; neither is a single milestone. The commercial lane (Track 6) is in scope
for planning, but its build is gated by the placement decision and by Track 1.

## 6. Exit criteria
- Every scenario in the matrix is Covered, or has a recorded reason it is not.
- A synthetic claim goes through the transport, is acknowledged at both stages, and its 835 posts exactly once.
- Unsupported payers and states refuse to send with a clear message.
- Two adapters pass the same conformance suite.
- Live sending stays off until trading-partner testing and clinical billing review pass.
