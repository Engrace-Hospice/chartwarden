# ADR-0035 — Mobile delivery via Capacitor wrap of `apps/web`; capability-port split of `packages/ui`

- **Status:** **Accepted** — ratified 2026-06-20 by the Frontend/Architecture Owner (per ADR-0030 line 40
  human ratification clause). **Open question resolved: the intra-package carve** (no new
  `packages/ui-core` leaf). Authorizes the `packages/ui` `core`/`web` reorganization + the
  `ui-core-renderer-free` dependency-cruiser rule; Capacitor scaffolding remains a later, separate PR.
- **Date:** 2026-06-20
- **Phase:** pre-build governance (affects every module that ships `apps/web` screens; precedes the first
  Capacitor build and the `packages/ui` reorganization).
- **Confirms (does not introduce):** native iOS/Android delivery was already resolved —
  - `WARDENX_ARCHITECTURE_v0_11.md` §"Mobile (clinical and field roles — `apps/mobile/`)": *"Capacitor
    6.x wrapping … frontend for native iOS and Android delivery"* + the closed mobile-strategy decision
    (ADR-008-era) that removed "Native mobile applications" from Non-goals.
  - [ADR-0030](ADR-0030-core-frontend-app-ownership.md) §"Surfaces & mobile": *"Capacitor 'mobile
    variants' wrap the `apps/web` build (one app, a native shell) rather than a separate `apps/mobile`."*
  - `WARDENX_SECURITY_HARDENING_v0_2.md` §12 "Mobile Device Security (Capacitor)" — the full device-posture
    / SecureStore / `FLAG_SECURE` / jailbreak-detection / MDM spec, written for Capacitor.
- **Extends:** [ADR-0030](ADR-0030-core-frontend-app-ownership.md) (frontend home + screen registry),
  [ADR-0032](ADR-0032-frontend-api-transport-and-client.md) (Vite for `apps/web`; OpenAPI client in the
  `packages/ui` leaf), [ADR-0027](ADR-0027-phase-0-toolchain-and-scaffold.md) (toolchain).
- **Constrained by:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (adding a manifest **leaf**
  needs its own ADR; one owner per codePath; never reshape the manifest to fit code).

## Context

A request to deliver WardenX as **both** a web app and native iOS/Android apps prompted a check of whether
mobile is in the architecture. It is — **and the technology is already chosen: Capacitor, not React
Native.** Three authoritative places commit to it (see *Confirms* above), and §12 of the Security
Hardening doc is a complete Capacitor-specific mobile-security spec. So this ADR **records and sharpens an
existing decision; it does not add a new one.** Two gaps remain that block clean execution:

1. **Stack drift.** Architecture v0.11 describes the mobile target as *"Capacitor wrapping a **TanStack
   Start** frontend"* and the web stack as *TanStack Router/Query/Form/Table + React 19 + shadcn + Tailwind
   v4*. The **as-built** `apps/web` (ratified by ADR-0030/0032) is **Vite + React 18 + `react-router-dom` +
   `openapi-fetch`**. ADR-0032 already adopted Vite for `apps/web`. The mobile decision must be re-stated
   against the app that actually exists, not the stale stack text.

2. **The "share logic across web and mobile" instinct, applied to the wrong rendering model.** Sharing a
   *headless logic layer between two view layers* is the React Native pattern (two renderers). **Capacitor
   has one renderer** — the native app is the *same* `apps/web` React-DOM build running in a WebView, plus
   a native-plugin bridge. So there is no second view layer to feed. What Capacitor *does* need is a way
   for the **one** web build to reach native capabilities (Geolocation for M18 EVV, Camera for DocLens
   wound photos, BiometricAuth, PushNotifications, SecureStore, Filesystem for offline drafts) **without**
   `apps/web` compile-importing `@capacitor/*` — otherwise the plain-web/PWA build breaks and the
   import-boundary discipline is violated.

Today `packages/ui` already mixes the two concerns this surfaces: platform-neutral logic (`src/api/` —
the `openapi-fetch` client, `src/hooks/*`, `src/theme/colors.ts` tokens) sits beside DOM-only rendering
(`src/components/`, `src/layouts/`, `src/providers/*` using `react-dom`). Native capability access has no
home at all.

## Decision

**1 — Mobile is Capacitor wrapping the as-built `apps/web` (Vite + React 18). No separate `apps/mobile`
app, no React Native, no second view layer.** This restates ADR-0030's "Surfaces & mobile" against the
real stack and supersedes architecture v0.11's "TanStack Start" wording (recorded as an in-place
Remediation Changelog edit to v0.11 on ratification). React Native was evaluated and **rejected** for this
product (see *Why not React Native*).

**2 — Native capabilities are reached through a port/adapter seam, so `apps/web` stays a pure web build.**
- A small set of **capability ports** (TypeScript interfaces) is defined for each native capability the
  modules need: `GeolocationPort`, `CameraPort`, `BiometricPort`, `SecureStorePort`, `PushPort`,
  `FilesystemPort`, `NetworkStatusPort`. Screens and hooks depend **only** on these interfaces.
- **Two adapter sets** implement them:
  - a **web adapter** (browser APIs where they exist — `navigator.geolocation`, `<input capture>`,
    WebAuthn, `localStorage`/IndexedDB — else a graceful degraded/no-op, reusing the existing
    `degraded-banner` pattern), used by the plain-web/PWA build;
  - a **Capacitor adapter** (`@capacitor/geolocation`, `@capacitor/camera`, `@capacitor-community`
    biometric/securestore, `@capacitor/push-notifications`, …), used only in the native build.
- The active adapter is selected **at the app entrypoint** (web entry vs Capacitor entry) and injected via
  a provider, exactly as M1 injects backend seams at boot. **`apps/web/src/**` never imports `@capacitor/*`
  directly** — only the Capacitor entrypoint does. This keeps one codebase that ships as web, PWA, and
  native app, and keeps `@capacitor/*` out of the web bundle.

**3 — Carve `packages/ui` into a neutral core and a web-rendering layer.** Separate the two concerns
already tangled there:
- **neutral core** — `src/api/` (OpenAPI client), neutral `src/hooks/*`, `src/theme/colors.ts` tokens,
  and the **capability port interfaces** + the **web adapters**. Zero `react-dom` import.
- **web rendering** — `src/components/`, `src/layouts/`, `src/providers/*` (React DOM + Tailwind).

**The carve is intra-package (folders + an enforced internal boundary), not a new manifest leaf — unless
the ratifier prefers a leaf.** Rationale: ADR-0005 makes a new leaf a deliberate, ADR-gated cost, and
ADR-0032 *specifically* sited the generated client inside `packages/ui` to avoid adding one. With
Capacitor's single renderer there is no second app that needs to import a standalone `ui-core`, so a new
top-level package buys little. A `dependency-cruiser` rule enforces the one-way edge **`packages/ui/src/web`
→ `packages/ui/src/core`, never the reverse**, giving the same guarantee a leaf split would, at lower
governance cost — and keeping the door open to promoting `core` to a real leaf later (e.g. if React Native
is ever revisited) without rework. *(This is the one open choice flagged for the ratifier — see Open
question.)*

## Why not React Native

Evaluated against this product (a 40-module clinical EHR, web-primary, mobile a field companion, built
largely by one engineer):

- **Maintenance, decisively.** RN renders native components, so it needs a **second view layer** — every
  screen across 40 modules authored and maintained twice. Capacitor ships the existing `apps/web` screens
  as a native app — **one** view layer.
- **Workload fit.** The mobile surface is forms, lists, and event-based hardware (M18 EVV check-in/out,
  M20 field-safety location, wound photos, offline draft + sync per DR/BCP §11.1) — squarely inside
  Capacitor's range. RN's real edge (fluid native UX, continuous background GPS, CV-grade camera) doesn't
  pay for a 2× UI cost here.
- **Corpus alignment.** Capacitor is already ratified twice and §12 is written for it. RN would require a
  superseding ADR, a rewrite of §12, and revision of the architecture mobile section.

RN would be the call only if mobile became the primary, consumer-polish surface or needed continuous
background location tracking — neither is true today. **"Native iOS/Android apps" is still delivered:**
Capacitor produces real App Store / Play binaries with native plugins, biometric unlock, push, and offline
— it differs from RN only in *how the UI renders*, not in whether you ship native apps.

## Boundaries & enforcement

- **Import boundary (new `dependency-cruiser` rules):** `apps/web/src/**` and `packages/ui/src/**` may
  **not** import `@capacitor/*` — only the Capacitor entrypoint may. `packages/ui/src/web/**` →
  `packages/ui/src/core/**` is allowed; the reverse is forbidden (`core` stays renderer-agnostic and
  `react-dom`-free).
- **`arch:parity` / `arch:fitness`** stay green: the carve is intra-package (no manifest change) under the
  intra-package option; capability adapters live where their importer lives.
- **Native platform projects** (Capacitor-generated Xcode/Android Studio projects, `capacitor.config.*`)
  are **build artifacts**, not TypeScript packages — manifest-exempt, consistent with ADR-0028's
  "mobile-offline stays exempt." They attach to `apps/web` (Capacitor's default `ios/` + `android/` under
  the web app), reconciling architecture v0.11's standalone `apps/mobile/` workspace language toward
  ADR-0030's "no separate app."
- **§12 security spec governs unchanged** — SecureStore token storage, `FLAG_SECURE`/screenshot blocking,
  jailbreak/root detection, biometric re-auth, MDM distribution. The `SecureStorePort`/`BiometricPort`
  Capacitor adapters are the implementation surface for §12's storage and unlock controls.

## Consequences

- **No architecture *decision* changes; two corpus texts get reconciled.** On ratification: an in-place
  Remediation Changelog edit to `WARDENX_ARCHITECTURE_v0_11.md` (mobile target = Capacitor wrap of the
  **Vite/React 18 `apps/web`**, not TanStack Start; `apps/mobile/` workspace language → "Capacitor
  projects under `apps/web`") citing this ADR. §12 needs no change.
- **`packages/ui` reorganization is a follow-up PR** (gated on this ADR): move neutral code to
  `src/core/*`, leave rendering in `src/web/*`, add the capability ports + web adapters, add the
  `dependency-cruiser` rules. Behavior-preserving; the gate (build + `arch:fitness` + test) must stay green.
- **Capacitor scaffolding is a later, separate PR** — add Capacitor to `apps/web`, the Capacitor
  entrypoint + native adapters, and the `ios/`/`android/` projects. Out of scope until the first module
  actually needs a field-mobile screen (likely M18 EVV).
- **PWA falls out for free.** Because the web adapters degrade gracefully, `apps/web` is installable as a
  PWA with no extra view work — a useful intermediate before native store distribution.

## Open question (for the ratifier) — RESOLVED 2026-06-20: intra-package carve

**Intra-package carve (chosen) vs a new `packages/ui-core` leaf.** The decision body recommends the
intra-package carve (no new leaf, per ADR-0005 friction and ADR-0032 precedent), and the ratifier adopted
it. The leaf remains a cheap future promotion (see *Future path*). Choose the leaf only if a
future second consumer (e.g. a revisited React Native app, or a non-`apps/web` surface) is expected soon
enough to justify the ADR-0005 leaf cost now. Either way the `core`↔`web` boundary is enforced identically.

## Future path (recorded for reference)

### Standing up the iOS/Android apps is mechanical
Once the `packages/ui` carve and the capability ports/adapters are in place, producing native binaries is
straightforward — Capacitor wraps the existing Vite build, it does not require a rewrite:
1. add Capacitor to `apps/web` (`@capacitor/core` + `@capacitor/cli`, `capacitor.config.ts`);
2. `cap add ios` / `cap add android` to generate the native projects (build artifacts, manifest-exempt per
   *Boundaries & enforcement*);
3. `cap sync` copies each `vite build` output into the native shells;
4. wire the Capacitor capability adapters at the native entrypoint and add the per-capability plugins
   (Geolocation / Camera / Biometric / SecureStore / Push / Filesystem / Network).

The work that is **not** mechanical — and the only real effort in shipping mobile — is the §12 hardening
(SecureStore token storage, `FLAG_SECURE`, jailbreak/root detection, biometric re-auth) and distribution
setup (Apple Developer + Play Console, MDM). The native toolchains are required to build (Xcode for iOS on
a Mac, Android Studio for Android), and store accounts to distribute. None of this changes `apps/web`'s
application code — the same React build runs as web, PWA, and native app.

### Promotion: intra-package carve → `packages/ui-core` leaf (if ever needed)
This ADR adopts the intra-package carve, but the design is deliberately **forward-compatible with a leaf**.
If a genuine second consumer later appears — a revisited React Native app, a separate marketing site, a CLI
reusing the OpenAPI client — promotion is low-cost, because the hard part (a `react-dom`-free `core` with an
enforced one-way boundary) is already done by the carve. Promotion steps:
1. create `packages/ui-core` (own `package.json` / `tsconfig`); move `packages/ui/src/core/*` into it;
2. add the leaf to `architecture/module-manifest.ts` (+ the `.cjs` mirror) — LEAF set + codePaths;
   `bun run scaffold`; re-verify `arch:parity`;
3. repoint `packages/ui` (web layer) and the new consumer at `@wardenx/ui-core`; the folder-level
   `dependency-cruiser` rule (`web → core`) becomes a package-direction edge with the same guarantee.

Per ADR-0005, adding the leaf needs its **own** ADR — and that ADR records the second consumer that
justifies the cost. No re-separation of concerns is required; the carve is the down-payment on this path,
not a dead end.

## References

- [ADR-0030](ADR-0030-core-frontend-app-ownership.md) §"Surfaces & mobile" (Capacitor wraps `apps/web`)
- [ADR-0032](ADR-0032-frontend-api-transport-and-client.md) (Vite for `apps/web`; client in `packages/ui`)
- [ADR-0028](ADR-0028-adapter-package-codepaths.md) (mobile-offline manifest exemption precedent)
- `WARDENX_ARCHITECTURE_v0_11.md` §"Mobile (clinical and field roles — `apps/mobile/`)"
- `WARDENX_SECURITY_HARDENING_v0_2.md` §12 "Mobile Device Security (Capacitor)"
- Field/mobile modules: M18 EVV, M20 Field Safety; DR/BCP §11.1 degraded-mode offline drafting
