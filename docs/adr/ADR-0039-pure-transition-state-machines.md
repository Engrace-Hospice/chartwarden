# ADR-0039 — State machines are pure hand-rolled transition functions, not XState

- **Status:** **Accepted** — ratifies the as-built state (2026-08-14, architecture-corpus
  remediation AR-05; see `audit/ARCHITECTURE_DOC_REMEDIATION_PLAN.md`).
- **Date:** 2026-08-14
- **Phase:** post-build divergence record (the convention was set by the clinical-core lifecycle
  wave and held for all 40 modules).
- **Supersedes (wording):** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §25.1's XState mandate, and every
  module spec's "XState v5 machine" phrasing (module specs are proposals; several were already
  overridden in code with in-file architecture-over-spec notes).

## Context

The corpus mandates XState for lifecycle state machines. What was actually built:

- **`xstate` is not installed** in any workspace `package.json`.
- Every lifecycle in the repo — admissions (M6), care plans (M7), orders
  (`packages/orders/src/lifecycle/order-machine.ts`), prescriptions
  (`packages/dosespot/src/lifecycle`), IDG meetings (M14), visits (M17), documents (M22),
  onboarding (M34) — is a **pure transition table + interpreter**: declarative states,
  per-state transitions, guard predicates, and an effect list returned to the caller, with no
  IO inside the machine.
- The divergence is *documented at the point of divergence*:
  `packages/saas-tenant-platform/src/onboarding/machine.ts` carries an explicit
  "ARCHITECTURE-OVER-SPEC NOTE" — XState is not a repo dependency, the manifest gives the package
  a single dependency edge, and the M8/M11/M12 machines set the hand-rolled convention — while
  shipping "the SAME shape XState v5 expresses".

## Decision

1. **Lifecycle logic is a pure, declarative transition structure + a pure interpreter** in the
   module's domain package: no IO, no timers, no actors inside the machine; effects are *returned*
   (as typed effect lists / emitted events) and executed by the adapter layer inside the
   RLS-scoped transaction.
2. **XState is not a dependency and must not be introduced module-locally.** The value XState
   provides (declarative charts, guards, testability) is already achieved; its costs — an npm
   edge on every domain package, an actor/interpreter runtime that invites IO into the machine,
   and drift from 40 modules of established convention — are not offset. If a future need
   (statechart visualization, hierarchical parallel states) justifies it, that is a repo-wide
   convention change requiring a new ADR, never a per-module choice.
3. Module specs saying "XState" are read as "a state machine of this shape" — the spec's *state
   graph* is normative, its *library* is not.

## Consequences

- Machines stay unit-testable with zero mocks (pure function in, states/effects out) — the
  property the live-lifecycle test tier depends on.
- Anyone adding a lifecycle copies the existing pattern (`order-machine.ts` is the reference);
  fitness gates continue to see plain TypeScript with manifest-declared dependency edges.
- The corpus's XState references are historical; the divergence banner points here.
