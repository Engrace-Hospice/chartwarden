# Module-Spec Corpus Consistency Audit — 2026-08-14

Scope: all 40 specs in [`docs/modules/`](../docs/modules/) (+ `module-29-tasks/`), audited against
`main`. Method: four parallel code-grounded cluster audits (M01–10, M11–22, M23–33, M34–40), each
required to cite doc line + code evidence and to verify before asserting; the highest-stakes
findings were re-verified by hand. Companion to the architecture-corpus audit
(`ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`) — this is "the same, for docs/modules."

**The contract differs from the architecture corpus and that changes the verdict.** Module specs
are **implementation proposals** (repo authority rule): "the spec describes something never built"
is a *legal* state here, not drift. What is NOT legal, and what this audit hunted, is a spec
**asserting something as real** — a decision "closed and recorded under `<path>`", a manifest edge
set "confirmed", an event name "published" — that is false against the repo, or a spec
contradicting a **ratified ADR**.

**Verdict: the corpus is structurally sound as a proposal record, but it carried (a) two latent
CODE defects violating ratified ADRs, (b) a systematic false-record pattern (phantom
`/architecture/adrs/` files, "confirmed" manifest claims that are stale, event names asserted as
canonical that no producer registers), and (c) index/version drift on 26 of 40 modules. All
severity-A items and the assertion-of-record B items are fixed as of this audit's merge; the rest
is recorded below and mitigated corpus-wide by the new authority banner + `arch:module-docs` gate.**

---

## 1. Code findings (not doc issues) — both FIXED in this merge

The audits' most valuable output, mirroring the architecture audit's §1: places where the *spec
was right and the code was wrong* against a ratified ADR.

### 1.1 M10 — SFV 2-day clock anchored to `signed_at`, violating ADR-0018 D1 — FIXED

`packages/hope/src/sfv/sfv.ts` computed `due_at` from the triggering assessment's **signature**
timestamp, with in-file comments asserting that as "the D3 anchor". Ratified ADR-0018 D1 is
explicit: the clock anchors to the **visit/assessment date, never the signature** — anchoring to
signature lets delayed signing extend a federal HQRP deadline, silently under-reporting
non-compliance (4-point APU exposure). The spec (M10 §1.1 et al.) had it right.

**Fix:** `planSfvCreation` now takes `assessmentDate` (the assessment row's `target_date`) as the
due-date anchor; `signed_at` remains only `triggered_at`. Both call sites (Drizzle service +
in-memory service) updated; a new unit test pins the "late signature does not move the deadline"
property. (`BUSINESS_LOGIC.md`'s SFV sentence describes the pre-fix behavior and needs a
one-line update when that doc lands.)

### 1.2 M23 — RHC tier boundary at day 7, violating ADR-0001 — FIXED

`packages/billing/src/hipps/calculator.ts` implemented the **"days 1–7 vs days 8+"** RHC rate
split that ratified ADR-0001 struck down (the boundary is **day 60**; "first 7 days" conflated
RHC tiering with the unrelated SIA window — 80 FR 47142). The spec's §1.1 carried the same stale
model even though its own header cites ADR-0001.

**Mitigating fact:** the `BillingReferenceDataReader` seam is a deny-stub in every production
boot, so this calculator has never priced a real claim — the defect was latent, not active.

**Fix:** boundary moved to day 60 (`RHC_HIGH_TIER_LAST_DAY = 60`), bucket/field/column names
renamed to the day-60 model (`days_1_60`/`days_61_plus`; migration `0212` renames the two
`hipps_calculation` count columns), tests rewritten around the day-60/61 boundary, spec §1.1
corrected. **Recorded limitation (not silent):** ADR-0001's day counter is the beneficiary's
*cumulative* election count across stays/hospices with a >60-day-gap reset; the calculator
anchors to the current election's admission date until a beneficiary-election-history seam
exists — the calculator header documents this and the correct future wiring point.

Also fixed in this class: **M31/architecture disagreement on ADR-003** — M31 shipped the Daily.co
telehealth decision (`packages/telehealth-client/src/daily-co-adapter.ts` is real) while the §21
register and INTEGRATIONS still said "open". Resolved the right way per §21's own convention:
**ADR-0041** now ratifies the decision and all three documents cite it.

## 2. The systematic finding patterns

1. **Phantom decision-record files.** M17/M18/M19 asserted decisions "closed and recorded under
   `/architecture/adrs/00NN-*.md`" — a directory that never existed, with numbers that collide
   with unrelated ratified `docs/adr/` ADRs. All four sites now state the truth: the decisions
   are recorded in the specs' own decision tables, no ratified ADR exists. *(Same class:* M35/M39
   citing "ADR-0144"/"ADR-0251" — the 2026-06 audit era's own ADR numbering, never `docs/adr/`
   files; the gate exempts these when the paired `ARCH-nnn` finding id is present, and the
   modules-README note documents the namespace.)*
2. **Event names asserted as canonical that no producer registers.** Severity-A instances fixed
   in place: M17 (`m17.visit.scheduled`/`.no_show`/`.in_progress` → real `published`/
   `no_show_detected`/`started`; `m18.evv.check_in`→`check_in_recorded`), M21
   (`m21.controlled_substance_discrepancy` → `m21.controlled_substance.discrepancy_detected` —
   a DEA-diversion alert subscription keyed on the old name would never fire), M25
   (`claim_adjusted` → `claim_recouped`; `appeal.decided` + `denial.aging_threshold_breached`
   marked TARGET), M26 (`.v1` suffixes are payload-schema versions, not registered names;
   `psr_imported`/`year_reopened` phantom events), M29 (`m29.nppes_sync_run.*` →
   `m29.nppes.sync_run.*`; `m29.adt.*` → `m29.hl7_inbound_proposal.*`), M02
   (`m2.organization.created` never cataloged), M06 (trigger names → `m6.*` as-built forms),
   M27/M33/M34/M40 (recorded; see §3). M36 is special: **no `events-by-m36.ts` exists at all**
   while M19/M20 already subscribe to `m36.notification.delivery_failed` — a subscription with
   no producer, now marked in the spec.
3. **Stale "manifest confirmed" claims.** Specs asserting the live manifest content got it wrong
   in both directions — M03 (claimed `[2]`; live `[1,2]`), M34 (claimed `[2,3,4,36]`; live
   `[1,2,3,4,36]`), M24/M30/M35/M40 (prose dependency inventories labeled "(manifest)" that are
   NOT edge sets), M06 ("ownedTables is empty" — populated long ago), M09/M10/M14 blocker
   checklists describing already-applied patches as pending. The load-bearing ones are fixed;
   the manifest remains the single source of truth and `election_addendum` (mandated by ADR-0015
   D1) is flagged as existing in **neither** manifest nor schema — a real open gap.
4. **`apps/frontend`** (pre-ADR-0030 naming) appeared ~80× across 23 files — globally corrected
   to `apps/web`.
5. **Re-lock-in-place version drift.** Specs re-lock in place (header bumps, filename pinned) —
   but the README index tracked filenames, sitting 1–2 re-locks stale for **26 of 40** modules
   (worst: M08 v0.2→v0.4, M21 v0.2→v0.4, M27 v0.2→v0.4). The index now tracks headers, the
   convention is documented, and `arch:module-docs` enforces it. M33 declared no version anywhere
   (now fixed); M19/M20/M29/M36/M40 carry internal header-vs-footer version disagreements
   (recorded, C-severity).

## 3. Findings recorded but deliberately NOT fixed in-place

C-severity and proposal-shaped items, mitigated by the per-spec authority banner (all 40 specs now
carry it) rather than edited line-by-line — the four agent reports carry full details with doc:line
and code evidence:

- Un-namespaced shorthand event tables where the spec elsewhere carries the correct catalog
  (M04 `m4.destruction_cert.signed`, M08's 26 shorthand uses vs its exact §catalog, M28's
  `mdm.physician_deactivated`, M38's §8.1 table vs `packages/audit/src/actions/m38.ts`, M40's
  §8.1 15-event table vs the real 2-event catalog).
- Planned-file citations in task plans (M22 `packages/types/events/m22.ts`,
  `scripts/m22-post-recovery-check.ts`, M14 `docs/architecture-graph.svg`, M28's manifest-patch
  path, module-29-tasks' `packages/foundation` seam homes / `check-manifest.ts`).
- Spec-vs-code proposal divergences that are legal under the authority rule (M39's 11-vs-7
  registered ABAC predicates, M34's §4.9 12-of-19 unregistered events, M37's 7-of-41, M32's
  `ai_drift_event`/token-budget events, M30's HVLDL file-vs-directory, M27's rule counts,
  M12/M13 XState & screen-table drift covered by ADR-0039/0030).

## 4. Enforcement added (the structural fix)

`scripts/check-module-docs.ts` → **`arch:module-docs`**, in `arch:fitness` (24th gate). Enforces:
index parity (40 rows ↔ 40 files, labels = targets), header-version discipline under the
re-lock-in-place convention (README tracks headers), four-digit ADR-citation resolution (audit-era
`ADR-NNNN / ARCH-nnn` composites exempt as a documented historical namespace), relative-link
integrity, and the "implementation proposal" authority banner on every spec. Deliberately **no
cited-path rule** — proposals legitimately cite planned paths; asserting a planned path as
*existing* is what the audit (human/agent) layer catches.

Current state: `OK module-docs: 40 specs · index parity 40/40 · 809 ADR citations (8 audit-era
exempt) · 177 relative links`.
