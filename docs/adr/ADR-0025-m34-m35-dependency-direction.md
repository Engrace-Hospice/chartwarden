# ADR-0025 — M34 ↔ M35 dependency direction: bidirectional seam relationship, no `dependsOn` edge either way

- **Status:** Accepted (2026-06-13 — architecture-owner ratified: remove the M35→M34 edge; seam both ways)
- **Date:** 2026-06-13
- **Phase:** dispute resolution (post June-13 re-audit)
- **Resolves:** M35-F02 (DISPUTED); `audit/TRIAGE_RESULTS.md` §Batch-3
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md); precedent [ADR-0006](ADR-0006-resolve-manifest-22-39-cycle.md), [ADR-0007](ADR-0007-m8-m9-m10-read-direction.md)
- **Changes (on acceptance):** `module-manifest.ts` / `.cjs` (M35 row), `CHARTWARDEN_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md` (D23/D24, §13), `CHARTWARDEN_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md` (D23, §13)

## Context

The authoritative manifest encodes **`M35 (Subscription Billing).dependsOn = [34]`**. M35's spec
(D23/D24) argues this is wrong: `[34]` was "build-sequence shorthand" (M35 ships after M34's tenant
infrastructure in Phase 2), **not** a code-level import. The spec asserts the real direction is the
reverse — **M34 consumes M35** (the tenant admin console reads M35's `SubscriptionStateProvider` /
`BillingStatusProvider`) — and that **M35 does not import M34**: it reads tenant identity from
**M2's `OrganizationReader`** and consumes M34's `OnboardingStatusProvider` only as a
**forward-seam deny-stub**. M34's own manifest entry carries `forwardSeamConsumers: [35]` (a seam
note, not an edge).

Evidence that there is no compile-time M35→M34 import:
- M35's owned tables (`subscription`, `invoice`, `payment_method`, …) FK to **`organization`
  (M2)**, not to M34's `tenant_account`.
- Both directions are **seam consumption**: M34→M35 via `SubscriptionStateProvider`/
  `BillingStatusProvider`; M35→M34 via `OnboardingStatusProvider`. Per **ADR-0005 D1**, seam/outbox
  consumption needs **no** `dependsOn` edge in either direction.

This is the same shape ADR-0006 (M22↔M39) and ADR-0007 (M8↔M9/M10) already settled: a bidirectional
or high-fan relationship realized as boot-registered seams, kept off the import graph. Unlike those,
M34↔M35 had **no ratifying ADR** — so the stale `[34]` edge stood and the spec's reversal was
unratified, leaving M35-F02 a genuine dispute.

## Decision (recommended)

**M34 ↔ M35 is a bidirectional seam relationship; neither direction is a `dependsOn` import edge.**

- **Remove `34` from `M35.dependsOn`.** M35 consumes M34's `OnboardingStatusProvider` via a
  boot-registered forward-seam deny-stub (interface in `packages/types`), and reads tenant identity
  via M2's `OrganizationReader`. No M35→M34 import edge (ADR-0005 D1).
- **M34 gains no `35` edge.** M34 consumes M35's `SubscriptionStateProvider` /
  `BillingStatusProvider` via boot-registered seams; `forwardSeamConsumers: [35]` is documentation,
  not an edge (and is itself a non-`ModuleDef` field already stripped per ARCH-146).
- **M35's remaining minimal edge set** (foundation + any genuine compile-time imports such as M2 if
  M35 imports M2's package directly) is finalized in M35's consolidated `dependsOn` pass per
  **ADR-0005 D5** and is **out of scope here** — the only ruling this ADR makes is that the set
  **does not include 34**.

Acyclicity: removing an edge cannot introduce a cycle; the graph stays a DAG.

## Alternatives considered

- **Keep `M35.dependsOn = [34]` (status quo).** *Rejected:* there is no compile-time M35→M34 import
  (M35 FKs M2's `organization`, not M34's `tenant_account`); the relationship is seam-based on both
  sides, which ADR-0005 D1 mandates as no-edge. Retaining `[34]` misrepresents a seam as an import.
- **Invert to `M34.dependsOn += 35`.** *Rejected:* M34 also consumes M35 only via seams; adding the
  edge would misrepresent that seam and risk a future M34↔M35 cycle once M35's real edges land.
  The seam-both-ways resolution (this ADR) is the ADR-0006/0007 precedent.

## Consequences (on acceptance)

- `module-manifest.ts` / `.cjs`: edit the M35 row to drop `34` (final set per the ADR-0005 D5 pass;
  not `[34]`).
- **M35 spec:** D24 stands (M34 consumes M35; M35 does not depend on M34) — now ADR-ratified; §13
  reflects the corrected edge set; the `OnboardingStatusProvider` forward-seam deny-stub is the
  documented M34 consumption path. Closes M35-F02.
- **M34 spec:** D23 confirmed — M34 consumes M35 via seam, no `35` edge; `forwardSeamConsumers`
  remains documentation only.
- Both re-locks define the seam interfaces in `packages/types` (M35: `SubscriptionStateProvider`,
  `BillingStatusProvider`; M34: `OnboardingStatusProvider`), registered at boot with deny-stub
  defaults and validated by `validateSeams()`.
- **Authority note:** until ratified, the authoritative manifest `[34]` governs and M35-F02 stands
  OPEN; the spec's D23/D24 reversal does not override the manifest without this ADR.
