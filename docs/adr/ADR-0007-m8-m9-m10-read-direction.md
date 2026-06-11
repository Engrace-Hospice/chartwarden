# ADR-0007 — M8 ↔ M9/M10 read direction: M9/M10 are downstream of M8; M8 consults completeness via boot-registered seams

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture / manifest correction)
- **Resolves:** M09-F02, M09-DC1, M10-F03; X10; Build-Blocking #6/#9
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md)
- **Changes:** `WARDENX_ARCHITECTURE_v0_11.md` §10.5.4 / §11 Module 8 note (no manifest edit)

## Context

The architecture is internally split on the M8 ↔ M9/M10 direction:

- §20 / the manifest encode **M9 → M8** (`M9.dependsOn=[8,38]`) and **M10 → M8**
  (`M10.dependsOn=[8,9,36,38]`): assessments and HOPE read encounter context from M8.
- §10.5.4 / §11-M8 (ARCH-109, ARCH-158) require M8's **signing-completeness gate** to consult
  "required assessment scales completed (Module 9)" and "required HOPE items captured (Module
  10)" — implying **M8 → M9/M10**.

Both module specs (M9, M10) read the §10.5.4 direction and **proposed manifest inversions** that
also require editing M8's already-encoded row — and self-locked before the decision. That is the
blocker (M09-F02/M10-F03), not the underlying need.

## Decision

**Do not invert the manifest.** The canonical data direction stands:

- **M9 and M10 are downstream of M8.** They read encounter/vitals context from M8 (via M8's
  exported reader or its outbox events). `M9.dependsOn=[8,38]` and `M10.dependsOn=[8,9,36,38]`
  are unchanged. (M10's M5/M6/M40 needs are handled in M10's own consolidated dependsOn ADR per
  ADR-0005 D5; per-table direct schema imports — M10-F01 — are replaced by readers/seams.)

- **M8's signing-completeness gate consults M9/M10 via boot-registered reader seams**, not an
  import edge (ADR-0005 D1). M9 publishes an **`AssessmentCompletenessProvider`** and M10 a
  **`HopeCompletenessProvider`**, each an interface in `packages/types`, registered at boot with
  a **deny/empty-stub default** and validated by `validateSeams()`. M8 stays
  `dependsOn=[6,7,36,38]` — no edge to 9/10, no cycle.

Rationale: a high-fan-in module (M8) consulting completeness of two later, lower-level modules is
exactly the case D1 was written for. Inverting the manifest would create the M8↔M9 and M8↔M10
edges (and the maintenance of M8's row against two not-yet-built modules) that the proposals
stumbled on; the seam keeps the manifest a DAG and the contract explicit + fail-loud.

## Consequences

- No `module-manifest.ts` change. M8/M9/M10 re-locks (Phase 6) define the two completeness seams
  in `packages/types`, implemented by M9/M10, consumed by M8's signing gate at runtime.
- The "vitals feed Module 9 trending" relationship is an **outbox event** (M8 → M9 payload type
  in `packages/types`), not an import edge.
- The §10.5.4 / §11-M8 text is annotated to state the gate consults M9/M10 **via registered
  completeness seams** (resolving DC-1) so no future reader infers an import inversion.
