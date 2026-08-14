# ADR-0043 — M9/M10 manifest edges on M8 removed: completeness travels by seam, the read-direction principle stands

- **Status:** **Accepted** — ratifies the as-built manifest (2026-08-14; the edges were dropped
  during the M9/M10 locks, recorded only as task-id comments until now).
- **Date:** 2026-08-14
- **Supersedes (clause):** ADR-0007's edge prescription ("`M9.dependsOn=[8,38]` and
  `M10.dependsOn=[8,9,36,38]` are unchanged; no `module-manifest.ts` change"). ADR-0007's
  *principle* — M9/M10 are logically downstream of M8, and M8 consults completeness via
  boot-registered seams, never by importing M9/M10 — stands unchanged.
- **Related:** [ADR-0007](ADR-0007-m8-m9-m10-read-direction.md),
  [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (D1: seam/outbox consumption needs no
  edge; D5: dependsOn deltas need a consolidated ADR — this is that ADR, late).

## Context

ADR-0007 resolved the M8↔M9/M10 read-direction dispute and prescribed keeping the manifest edges.
The build then dropped the M8 edge from both rows — live manifest: M9 `dependsOn: [1, 38]`, M10
`dependsOn: [1, 9, 36, 38]` — because under ADR-0005 D1 the actual couplings are edge-free: M9/M10
consume M8's `encounter.signed` outbox events and the `SignedEncountersReader`-style seams, and M8
was to consult completeness through boot-registered seams. The manifest's header comment
mis-attributed this inversion *to* ADR-0007 (which rejected it), and no consolidated ADR was
written — the exact ADR-0005 D5 gap the 2026-08-14 compliance audit flagged.

## Decision

1. **The live manifest edge sets are ratified**: M9 `[1, 38]`, M10 `[1, 9, 36, 38]` — no `dependsOn`
   edge on M8 in either direction. Cross-module coupling is outbox events + registered seams only.
2. **ADR-0007's read-direction principle is unchanged**: M8 never imports M9/M10; if M8's signing
   gate needs assessment/HOPE completeness, it consults `AssessmentCompletenessProvider` /
   `HopeCompletenessProvider` seams registered at boot. **Those providers remain unbuilt** — a
   recorded deferral, not a claim; M8's signing gate currently performs no completeness
   consultation.
3. The manifest comment now attributes the inversion here, not to ADR-0007.

## Consequences

- The dependency graph stays acyclic with fewer edges; `arch:parity`/`arch:boundaries` enforce it.
- Building the completeness consultation later is wiring work behind already-named seams, not an
  edge change.
