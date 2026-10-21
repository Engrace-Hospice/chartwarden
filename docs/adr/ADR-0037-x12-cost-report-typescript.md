# ADR-0037 — X12 and cost-report processing are TypeScript packages, not Python sidecars

- **Status:** **Accepted** — ratifies the as-built state (2026-08-14, architecture-corpus
  remediation AR-03; see `audit/ARCHITECTURE_DOC_REMEDIATION_PLAN.md`).
- **Date:** 2026-08-14
- **Phase:** post-build divergence record (revenue-cycle wave R2 shipped this way).
- **Supersedes (wording):** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §12 (the Python sidecar service tier)
  and `CHARTWARDEN_SYSTEM_DESIGN_v0.3.md`'s sidecar topology — both sections are
  `STATUS: TARGET — NOT BUILT` in their entirety and banner-marked.
- **Related:** [ADR-0028](ADR-0028-adapter-package-codepaths.md) /
  [ADR-0029](ADR-0029-x12-worker-client-split.md) (the adapter-package layout that replaced the
  sidecar plan), ADR-0016/0017 (claim-correctness rules the TypeScript implementations encode).

## Context

The architecture corpus describes a Python sidecar tier (`services/`, `infra/`) for X12
837/835 EDI and CMS cost-report processing. What was actually built:

- **Zero `.py` files in the repo**; no `pyproject.toml`, no `services/`, no `infra/`.
- The work ships as TypeScript domain packages: `packages/x12-837-client` (claim generation),
  `packages/x12-835-client` (remittance ingestion, M25), `packages/cost-report` (CMS-1984-14,
  M27) — unit-tested in the same Vitest tier as every other domain package, built with the same
  `tsc -b` project references, gated by the same fitness rules.
- The **`X12_WORKER_NOT_WIRED` fail-closed port** fronts the *transport* step (submitting to a
  MAC). It exists because the sidecar it was specced to call was never built — the port's
  deny-by-default behavior is the correct seam shape either way (typed port + fail-closed vendor
  default), and a future transport binds behind it without touching the domain packages.

## Decision

1. **EDI/cost-report parsing, validation, and generation are TypeScript, in-monorepo, permanently.**
   The Python sidecar tier is cancelled as a *processing* layer — one language, one build, one
   test tier, one dependency-cruiser boundary graph. A polyglot sidecar would exempt the
   highest-compliance-weight money code from every fitness gate this repo runs.
2. **Transport remains a bound-later port.** Actually moving an 837 to a MAC (or ingesting an 835
   from one) is a vendor adapter behind the existing typed port; wiring it is integration work
   (see `CHARTWARDEN_INTEGRATIONS` wiring-status column), not a language decision.
3. If an isolated execution environment is ever genuinely required (e.g. a vendor SDK that only
   ships for another runtime), that is a *new* ADR with a concrete vendor in hand — not a
   standing sidecar tier waiting for a workload.

## Consequences

- §12's sidecar description stays in the doc as marked target-state history; new readers must not
  build against it.
- Ops docs must not describe deploying/monitoring a sidecar fleet.
- The revenue-cycle packages carry the full correctness burden in TypeScript — which is why the
  claim-validation framework and its live suites (M23/M25/M27) are load-bearing.
