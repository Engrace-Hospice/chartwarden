# ADR-0006 — Resolve the manifest's own 22↔39 dependency cycle

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (manifest correction)
- **Resolves:** M22-DC1, M22-F01; X1; Build-Blocking #1
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md)
- **Changes:** `module-manifest.ts`, `module-manifest.cjs`, `WARDENX_ARCHITECTURE_v0_11.md` §20 (build-sequence M39 row + §20 note)

## Context

The manifest itself encoded a cycle: `M22 (Documents).dependsOn = [1, 5, 39]` **and**
`M39 (Consent).dependsOn = [1, 2, 3, 4, 5, 22]`. That is `22 → 39` and `39 → 22` — a direct
cycle that fails the `no-circular` fitness check by construction, and contradicts the §20 build
order, which places Module 39 **early** (right after Module 5) yet has it depend on Module 22,
which is built much later.

Both directions are real needs:
- **Documents → Consent:** M22 must evaluate consent before releasing/disclosing a document.
- **Consent → Documents:** signed consent-form PDFs are stored/rendered by M22.

The M22 audit confirms the right break: M39 should consume M22 via a **forward seam only**
(deny-stub until M22 registers it), removing the `39 → 22` import edge.

## Decision

Apply [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) D1 to break the cycle:

- **Remove `22` from `M39.dependsOn`** → `M39.dependsOn = [1, 2, 3, 4, 5]`.
  Consent consumes Module 22 document rendering/storage via a **boot-registered forward seam**
  (`DocumentRenderer` / `DocumentStorageProvider`, deny/empty-stub default), whose interface type
  lives in `packages/types`. No import edge is required (D1).
- **Keep `39` in `M22.dependsOn`** (`[1, 5, 39]`): Documents legitimately imports the Consent
  evaluation surface to gate disclosure. (M22 may alternatively consume the `ConsentEvaluator`
  seam and drop the edge in its own re-lock; either is acyclic. The cycle is broken by removing
  the `39 → 22` edge regardless.)

Acyclicity check (post-edit): `22 → {1,5,39}`, `39 → {1,2,3,4,5}`, `5 → {2,3,4,36,38,40}`,
`{36,38,40} → {1,2,3,4}` — no path returns to 22. The direct 22↔39 cycle is eliminated.

## Consequences

- `module-manifest.ts` / `.cjs` M39 row becomes `dependsOn: [1, 2, 3, 4, 5]`.
- §20 build-sequence note is corrected: Module 39 no longer "lands after Module 22"; it lands
  after Module 5 and consumes Module 22 via a forward seam registered when M22 is built.
- Module 39's eventual re-lock (Phase 3/6) must publish `ConsentEvaluator` and consume the
  `DocumentRenderer` forward seam; Module 22's re-lock must register that seam. The transitive
  22→6→39→22 cycle that the M22 spec's *proposed* patch reintroduced is rejected (M22-F01);
  M6/M11/M29 interactions for M22 must be event-only or seam-only per ADR-0005 D1.
