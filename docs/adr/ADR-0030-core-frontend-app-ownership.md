# ADR-0030 — Owning app + module for core (app-shell) front-end screens

- **Status:** Accepted — ratified 2026-06-14 (Option 1: a core `apps/web`, carved by sub-path like
  `apps/backend`). Authorizes the manifest codePaths `apps/web/src/shell` → M1 and
  `apps/web/src/modules/02-identity` → M2 (applied via the manifest + `bun run scaffold`).
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
(`docs/design/screens/core/CHARTWARDEN_UI_AUTH.md`), i.e. the staff/clinician app-shell — **not** a patient or
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

**Adopt Option 1, refined: a single core staff web app `apps/web`, carved by sub-path exactly as
`apps/backend` already is.** (Drafted; awaiting ratification.)

### Why not the others
- **Option 3 (fold into `apps/admin`/M34) — rejected.** It conflates the *staff clinical* surface with
  the *SaaS tenant-operator* surface, and makes the foundational app shell owned by **M34**, a late-phase
  module that `dependsOn: [2, 3, 4, 36]`. Core auth UI owned by a leaf-of-leaves is a dependency inversion.
- **Option 2 (new "app-shell" module) — rejected.** It adds a 41st module to a fixed 40-module manifest
  (renumbering + governance churn) to do a job **M1 (Foundation) already does** — M1 owns `packages/ui`
  *and* `apps/backend/src/bootstrap`. Unnecessary indirection.
- **Option 4 (defer all core FE) — not chosen.** Only justified if Phase 1 were explicitly API-first; but
  the screens are specified and the M2 backend routes already exist. Deferring punts a question we can
  answer now.

### The decision
Reuse the **proven backend ownership pattern**. `apps/backend` is *not* single-owned —
`apps/backend/src/bootstrap` is M1's, each `apps/backend/src/modules/NN-*` is a feature module's, all
**disjoint** codePaths with `dependency-cruiser` boundaries between them. Apply the same carve to `apps/web`:

- **M1 (Foundation)** gains codePath **`apps/web/src/shell`** — the app shell: routing host, layout, the
  `packages/ui` mount, and a **screen registry** that lazily mounts each module's screens (the frontend
  analogue of M1's seam registry, so the shell never imports a feature module directly → no inversion).
- **M2 (Identity)** gains codePath **`apps/web/src/modules/02-identity`** — the core auth screens
  (sign-in, MFA, org-select, passkey enroll, invite-accept, member-management), consuming the M2 backend
  routes (M2-T05/T06) and `packages/ui` (M1-T11).
- **Every later module N** that ships core/app-shell screens gains **`apps/web/src/modules/NN-<name>`**,
  registered into M1's shell registry. This becomes the target for the reusable template's `N-T08` UI row
  (replacing the bare "screens per `docs/design`").

### Boundaries & enforcement
- One owner per codePath (ADR-0005) holds — the sub-paths are disjoint.
- `dependency-cruiser`: a module's `apps/web/src/modules/NN-*` may import `packages/ui`, `packages/types`,
  its own backend module's published surface, and `dependsOn` modules — **never** another module's screens
  or the shell internals. The shell may import `packages/ui` + the registry contract in `packages/types`,
  **never** a feature module.
- `arch:parity` stays 1:1 (tree scaffolds from the manifest); `docs:ui` screen specs map to
  `apps/web/src/shell` / `apps/web/src/modules/*`.

### Surfaces & mobile
`apps/portal` (M31, patient/family) and `apps/admin` (M34, SaaS tenant-operator) stay distinct from
`apps/web` (staff core). The M2-T09 **Capacitor "mobile variants" wrap the `apps/web` build** (one app, a
native shell) rather than a separate `apps/mobile` — no new app.

## Consequences

- **M2-T09 is unblocked but out of scope for PR #3.** It stays out of the M1+M2 *backend* slice (slice
  acceptance is backend-only). Once this ADR is ratified it is no longer "blocked" — it becomes a small
  **follow-up PR**: add `apps/web/src/shell` (M1) + `apps/web/src/modules/02-identity` (M2) consuming the
  M2 routes (T05/T06) + `packages/ui` (M1-T11).
- **On ratification** (the manifest change this ADR authorizes): add `apps/web/src/shell` to M1's
  `codePaths` and `apps/web/src/modules/02-identity` to M2's, in `architecture/module-manifest.ts` (+ the
  `.cjs` mirror); `bun run scaffold`; update M2-T09 and the reusable template's `N-T08` UI row to name
  `apps/web/src/modules/N-*`; confirm `arch:fitness` (parity + boundaries) green.
- **Process guardrail (applied now, independent of the decision):** `docs/plans/**` is read-only to
  automated runs — `arch:plan-integrity` (in `arch:fitness`) fails if a run modifies a plan. Plans are
  authority *inputs*; an agent that rewrites them to fit its output breaks determinism. Intentional
  human plan edits set `ALLOW_PLAN_EDITS=1`.

## References

- M01-M02 slice plan → M2-T09 (`docs/plans/M01-M02_VERTICAL_SLICE_PLAN.md`)
- Core auth UI spec (`docs/design/screens/core/CHARTWARDEN_UI_AUTH.md`)
- Manifest owners: M2 `id: 2`, M31 `id: 31` (`apps/portal`), M34 `id: 34` (`apps/admin`)
