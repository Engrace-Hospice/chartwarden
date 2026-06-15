# ADR-0030 — Owning app + module for core (app-shell) front-end screens

- **Status:** Proposed (stub — opened 2026-06-14; decision pending)
- **Date:** 2026-06-14
- **Phase:** pre-build governance (blocks M2-T09; affects every module that ships core/app-shell UI)
- **Resolves:** the plan↔manifest conflict surfaced by the `wardenx-piv` M1+M2 slice run — the M2-T09
  "Frontend screens" task (login, MFA, passkey, invite, member-management) has **no legal home** under
  the current manifest.
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (codePaths define ownership;
  one owner per path; never reshape the manifest to fit code) and
  [ADR-0027](ADR-0027-phase-0-toolchain-and-scaffold.md) (tree is generated from the manifest;
  `arch:parity` keeps tree↔manifest 1:1).

## Context

The M2 (Identity) spec §5 and the M01-M02 slice plan's **M2-T09** call for *core identity* screens —
sign-in, MFA challenge, organization-select, passkey enrollment, invitation acceptance,
member-management. The authoritative UI spec places these in the **core** surface
(`docs/ui/screens/core/WARDENX_UI_AUTH.md`), i.e. the staff/clinician app-shell — **not** a patient or
tenant surface.

But the manifest leaves these screens homeless:

- **M2 owns no front-end codePath.** `id: 2` codePaths are `packages/auth/src/identity` +
  `apps/backend/src/modules/02-identity` — backend only.
- **The plan points them at the wrong apps.** M2-T09 names `apps/portal` and `apps/admin`:
  - `apps/portal` → manifest owner **M31** (Patient/Family Portal & Telehealth) — a *patient/family*
    surface.
  - `apps/admin` → manifest owner **M34** (SaaS Tenant Platform) — a *tenant-operator* surface.
  - Neither is the home for *core staff* auth UI. Building there would also break `arch:parity`
    (those paths belong to other modules).
- **No core front-end app exists.** `apps/` contains only `admin`, `backend`, `portal`. There is no
  `apps/web` / `apps/app` staff shell. M1-T11 delivers shared UI *components* (`packages/ui`) but no
  hosting app with routed pages.

Per the authority rule (architecture/manifest win over module specs), an implementer **cannot** resolve
this by editing the manifest or the plan. The slice run hit exactly this wall; the correct response is a
human architecture decision — this ADR — not a self-authorized deferral. (The run's harness also
self-edited the plan to manufacture a resolution; `arch:plan-integrity` now forbids that — see
Consequences.)

## Decision

**PENDING.** Options to evaluate (not yet chosen):

1. **New core staff app `apps/web` owned by M1 (Foundation).** Add `apps/web` to M1's `codePaths`;
   M1-T11's shared UI mounts here; M2 (and later modules) contribute routed feature screens via a
   per-module convention (mirroring `apps/backend/src/modules/NN-*`). Cleanest separation; expands M1.
2. **New core app owned by a dedicated "app-shell" module.** Introduce a thin module that owns the
   staff shell app + cross-module screen registry; M2+ contribute screens through it. More indirection;
   avoids overloading M1.
3. **Host core auth screens in an existing app.** e.g. fold the staff shell into `apps/admin` and
   re-scope M34. Least new structure; conflates staff-core with tenant-operator UI (likely rejected).
4. **Defer all core front-end to a later phase.** Phase 1 ships backend + API only; the staff SPA is a
   named later milestone. Honest, but leaves auth flows unusable until then.

Each option must specify: the new/edited `codePaths`, which module owns the app, the per-module screen
convention, and how `docs:ui` / `arch:parity` enforce it.

## Consequences

- **M2-T09 stays BLOCKED** until this ADR is Accepted. It is **out of scope** for the M1+M2 backend
  slice (slice acceptance is backend-only). The slice's M2 backend routes (T05/T06) and `packages/ui`
  (M1-T11) are the seams a future core app will consume.
- On acceptance: edit `architecture/module-manifest.ts` (+ `.cjs` mirror), `bun run scaffold`, update
  M2-T09 (and the reusable template's `N-T08` UI row) to name the chosen app, confirm `arch:fitness`
  green.
- **Process guardrail (applied now, independent of the decision):** `docs/plans/**` is read-only to
  automated runs — `arch:plan-integrity` (in `arch:fitness`) fails if a run modifies a plan. Plans are
  authority *inputs*; an agent that rewrites them to fit its output breaks determinism. Intentional
  human plan edits set `ALLOW_PLAN_EDITS=1`.

## References

- M01-M02 slice plan → M2-T09 (`docs/plans/M01-M02_VERTICAL_SLICE_PLAN.md`)
- Core auth UI spec (`docs/ui/screens/core/WARDENX_UI_AUTH.md`)
- Manifest owners: M2 `id: 2`, M31 `id: 31` (`apps/portal`), M34 `id: 34` (`apps/admin`)
