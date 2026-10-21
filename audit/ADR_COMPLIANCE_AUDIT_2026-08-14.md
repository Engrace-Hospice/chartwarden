# ADR Compliance Audit — 2026-08-14

Scope: all 44 ADRs in [`docs/adr/`](../docs/adr/) (0042–0044 were written *by* this audit),
verified against `main`. Method: four parallel code-grounded cluster audits, each verifying the
2–4 most testable Decision claims per ADR with doc+code citations; money findings re-verified by
hand. The contract: ADRs are immutable decision records — the question is whether **the code
honors each ratified Decision**, not whether the prose is fresh.

**Verdict: of the 41 pre-existing ADRs, 24 are cleanly honored, 5 are honored-with-caveats, 4 are
MIXED, and 8 carry outright violations — several at feature scale.** The corpus register itself is
sound (contiguous 0001…0044, index parity, gated by `arch:adr-docs`), and the biggest structural
gap — deliberate divergences never recorded — is now closed by ADR-0042/0043/0044.

---

## 1. Fixed in this merge (small, verified)

| ADR | Violation | Fix |
|---|---|---|
| 0008 D1 | M23's `evv_bracket_coherence` shipped `regulatoryRequired: true` justified by the Cures mandate — the exact "never a regulatory floor for Medicare" harm the ADR names | Rule is now operational (`regulatoryRequired: false`, tenant-configurable/overridable); only `unresolved_missing` (an open documentation gap) blocks; Cures justification removed (it is Medicaid-only). Floor-count tests updated (17 regulatory / 2 operational). |
| 0001 (partial) | `hipps_coding_correct` rule text still described the struck "days 1–7 vs 8+" split | Rule text/comments corrected to the day-60 tier model; the outstanding full HIPPS-construct removal is recorded in-file and in §3 below. |
| 0002 | Stale "Nov 1 – Oct 31" cap-year prose in three billing files (behavior was correct) | Comments corrected to Oct 1 – Sep 30 (ADR-0002). |
| 0031 (clause) | Workflow moved to v0.5.0 local-only (no push/PR) with no decision record | **ADR-0042** ratifies local-only output; ADR-0031's no-interactive-approve core stands. |
| 0007 | The manifest performed the edge inversion ADR-0007 rejected and cited ADR-0007 as its authority | **ADR-0043** ratifies the as-built edge sets (seam/outbox coupling per ADR-0005 D1), keeps the read-direction principle, and the manifest comment now attributes correctly. |
| 0008 D4 | Launch aggregator shipped as Sandata multi-state, not the decided OR-PTC/Oregon | **ADR-0044** ratifies Sandata behind the per-state adapter registry. |
| 0032 (gap) | "No `apps/web`→`apps/backend` import edge" was true but mechanically unenforceable (a module owns both sub-paths) | New dependency-cruiser rule `spa-never-imports-backend` (all three SPAs). |
| index | ADR-0032's row credited `@fastify/swagger` (which that ADR rejects and 0040 bans); stale Phase-0-only framing; conventions clause pointing at nonexistent changelog sections; a blank line splitting the table | All corrected in `docs/adr/README.md`. |
| 0035 (doc obligation) | The promised in-place architecture edits were never made (§4 tree + §Mobile still said TanStack/`apps/mobile`) | Made now in `CHARTWARDEN_ARCHITECTURE_v0_11.md`. |

## 2. The governance finding — ADR-0026 (needs a human decision)

ADR-0026 is the **only Proposed ADR in the corpus** ("requires Security-Owner sign-off") and it is
already load-bearing: merged M19 code cites it as governing. Worse, its M2 half was never built —
`session_class` still has exactly four values, so M19's `VENDOR_SESSION_CLASSES`
(`external_triage_vendor` / `external_triage_operator`) name classes M2 can never issue. The
vendor ABAC arm is **structurally unreachable** (fail-closed, so safe — every vendor-session check
denies). Resolution requires the Security-Owner sign-off the ADR demands, plus either building the
M2 session class or superseding the decision. Not self-serviceable by this audit.

## 3. Feature-scale violations — the remediation backlog (recorded, NOT patched)

Each of these needs real design/test work; hasty patches would be worse than the violation.
Ranked by exposure:

1. **ADR-0016 (Medicare claim math)** — wage index applied to the **whole** per-diem (no
   labor/non-labor split) and keyed **per CCN** in a unique constraint (`wage_index_factor_ccn_fy_uq`)
   — the two exact defects the ADR names. CHC is a flat per-diem (no 15-min units / 8-hr minimum);
   IRC has no day-6 RHC repricing; 837I value/occurrence-code rules absent; late NOE hard-blocks
   the claim instead of billing with provider-liable days (occurrence span 77). *Mitigation: the
   rate-table seam is production-unbound, so nothing has priced a live claim.*
2. **ADR-0013 (§164.528 accounting)** — `recordDisclosure` and the M4 disclosure sink **do not
   exist** (no table in M4's ownedTables); the query layer substitutes the read-audit stream the
   ADR explicitly disqualifies; M28's code admits "no served-read disclosure log table yet".
3. **ADR-0015 (election/certification)** — `election_addendum` in neither manifest nor schema;
   `election_statement_period_idx` enforces exactly the per-benefit-period cardinality the ADR
   bans; the struck agency F2F override is still live (`checkF2fOverride` + `f2f.window_overridden`);
   no 15-day early-recert bound; discharge rows carry no physician-order/NOMNC fields; transfer
   rows no patient-signed statement.
4. **ADR-0019 (controlled substances)** — the Phase-1 lawful non-EPCS path doesn't exist:
   `signControlled` requires EPCS certification while `dosespot.epcs` is OFF everywhere, so **no
   Schedule II–V medication can be signed at all** — the go-live blocker the ADR was ratified to
   remove. D4: eMAR still mandates a second witness for routine *administration* (the ADR scopes
   witness to waste/disposal + inpatient).
5. **ADR-0018 D4 (IPU fail modes)** — IRC day-6 **blocks** billing instead of repricing to RHC;
   the RN-coverage gate hard-blocks GIP/IRC admissions (412) where the ADR requires
   flag-don't-block (break-glass exists but is an override, not fail-open). D3: the IDG discipline
   union only offers `md_np`, so the MD/DO-only seat is not structurally enforceable. iQIES
   *inactivation* (M10-F06) is half-built (correction exists, withdraw doesn't).
6. **ADR-0017 (Medicaid)** — no 95%-NF-floor computation, no patient-liability/share-of-cost, no
   TPL/crossover/retro/timely-filing; the inpatient-cap denominator aliases all-LOC days as
   "Medicare days". (D4 — Medicaid excluded from the Medicare cap — is honored.)
7. **ADR-0012 D4 (AI BAA gate)** — the 8-gate invocation sequence has no platform BAA gate and no
   `baa_not_executed` refusal; only ZDR hard-refuses. Consumers (M8/M16) honor a gate M32 never
   enforces. (D1 drift-sweep is a *declared* deferral pinned by a test — legal.)
8. **ADR-0020 D2 (BAA start-refusal)** — implemented for M19/M22, **absent for the M18 EVV
   aggregator** (PHI + BAA-required by the catalog); also noted in ADR-0044. HIBP shipped without
   the promised circuit breaker/degraded path.
9. **ADR-0001 residue** — the HIPPS construct (table, `hipps_code`, rule key) still exists (the
   code is an internal placeholder, never on the wire); the SIA calculator has no RHC-day gate
   (a CHC day can earn SIA), no G0299/G0155, no 15-minute units (4-hr cap is honored). The
   `rhc_rate_tier_coherence` replacement rule is unwritten.
10. **ADR-0003** — M23's revenue-code enum still lists `0294` and cannot express `0658` (latent:
    M24 owns the R&B write path and bills 0658 correctly; fixing M23's enum needs an
    `ALTER TYPE … ADD VALUE` migration).
11. **ADR-0029** — the M25 package ships an exported 277CA mapper/`parse277ca` client op that the
    ADR reserves to M23. Not the "unconsumed file" it first appears: it is part of the shared
    client interface M23's submit worker stubs in tests — resolving it means a deliberate
    interface split, not a deletion.
12. **ADR-0021 / ADR-0009** — both claim their template requirements are "CI-gated"; no such gate
    exists (`arch:fitness` has no template-completeness or DR/INT-declaration check; 16/40 modules
    carry DR/INT inventories). Decide: build the lint or supersede the CI-gating claim.
13. **ADR-0011 D2** — `withPlatformContext`'s org-predicate requirement lives in a checker regex,
    not the function signature. **ADR-0010 D4** — the mixed-session-variable test exists in 2 of
    ~17 RLS suites. **ADR-0004** — destruction anchoring to last-patient-contact+7y unbuilt
    (declared deferral); `state_retention_override` is written but read by nothing.

## 4. Clean bill

Honored with evidence, no action: 0005, 0006, 0010, 0011, 0014 (Part 2 — all four decisions,
fail-closed), 0022, 0023, 0024, 0025, 0027, 0028, 0030, 0033, 0034, 0035 (Capacitor ban legally
deferred), 0036–0041 (ratified against as-built today, each re-verified), plus 0002's behavior
and 0018 D1/D2 (D1 fixed earlier today).

## 5. Enforcement added

`scripts/check-adr-docs.ts` (`arch:adr-docs`, in `arch:fitness`): contiguous unique numbering,
index parity, Status-line discipline, index↔file status agreement, citation/link integrity.
Code-vs-decision compliance remains this audit layer — rerun it when the backlog above moves.
