# ADR-0072 — Mobile is a separate React Native/Expo application consuming versioned ChartWarden APIs

- **Status:** **Proposed for formal architecture ratification.** The product direction was fixed on
  2026-10-16 for Mobile PR B, but the Frontend/Architecture Owner ratification required by ADR-0030 and
  ADR-0035 is not recorded here.
- **Date:** 2026-10-16
- **Supersedes on ratification:** [ADR-0035](ADR-0035-capacitor-mobile-wrap-and-ui-core-split.md), and
  ADR-0030's clause that mobile wraps `apps/web`. ADR-0035 remains immutable history.
- **Extends:** [ADR-0026](ADR-0026-m19-vendor-operator-auth-via-better-auth.md) (one Better Auth
  surface), [ADR-0032](ADR-0032-frontend-api-transport-and-client.md) (OpenAPI is the client contract),
  [ADR-0054](ADR-0054-realtime-transport-socketio-valkey.md) (Socket.IO hints are not state).
- **Constrained by:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md), the Authorization
  Contract, tenant RLS, session classes and Security Hardening.

## Context

ADR-0035 chose a Capacitor WebView around `apps/web` to avoid maintaining a second renderer. Product
direction now requires a native field experience in the separate `wardenx-mobile` repository, already
initialized with Expo SDK 57, React Native, Expo Router and NativeWind. The operational reasons are
native navigation and accessibility behavior, predictable foreground/background lifecycle, native
device capabilities and a UI that can be shaped for intermittent field work without carrying the DOM
application into a WebView.

This choice accepts the cost ADR-0035 avoided: every mobile screen has a second renderer and its own
device tests. It does not duplicate domain authority. Backend permissions, ABAC, RLS, workflow
transitions, validation, session state and auditing remain ChartWarden server responsibilities.

## Decision

1. `wardenx-mobile` is an autonomous repository and application. This repository continues to own
   `apps/backend`, `apps/web`, `apps/portal`, `apps/admin`, shared server packages, architecture and the
   API contract. It does not gain `apps/mobile`, native projects or React Native dependencies.
2. React DOM components and hooks coupled to DOM/browser globals are not shared. Reusable material is
   limited to renderer-free values and contracts: OpenAPI, plain TypeScript types, documented permission
   keys, design tokens and pure utilities that have no DOM, Node or server dependency.
3. `docs/api/openapi.json` is the versioned cross-repository contract. PR C pins a ChartWarden commit or
   release artifact and generates its Axios-facing types in `wardenx-mobile`; it does not import
   `packages/ui` or reach into this monorepo by relative/workspace path. Breaking API changes use the
   existing `/api/vN` policy. The mobile client sends its build/contract version for diagnostics only;
   it never changes authorization.
4. Better Auth remains the sole authentication surface and session store. The backend adds the official
   Expo server plugin to the existing `createIdentityAuth()` instance at `/api/auth/*`. Mobile stores
   Better Auth cookies through `@better-auth/expo/client` and SecureStore; there is no mobile JWT,
   bearer mint, proxy auth service or client-selected organization.
5. Browser origins and native callbacks are different configuration classes. `TRUSTED_ORIGINS`
   contains exact HTTP(S) browser origins used by CORS and WebAuthn. `MOBILE_AUTH_TRUSTED_ORIGINS`
   contains exact custom schemes such as `chartwarden://` and is consumed only by Better Auth. Wildcards,
   `Origin: null`, `exp://` and implicit production localhost values are forbidden. Universal/App Links
   are HTTPS and therefore use the reviewed web-origin list.
6. ChartWarden's cookie-authenticated `/api/v1/*` mutations keep the double-submit CSRF control. A native
   client obtains the nonce from authenticated `GET /api/v1/auth/csrf`, then sends the Better Auth
   cookie plus `chartwarden_csrf=<nonce>` in `Cookie` and the same nonce in `X-CSRF-Token`. No native
   marker, User-Agent or absent Origin bypass exists.
7. Passkeys remain the existing browser WebAuthn ceremony until native enrollment/assertion is proven
   on iOS and Android with associated domains. Native PR C must support the server's TOTP and backup-code
   fallback and must not report native passkeys as available from backend tests alone.
8. Socket.IO accepts a native handshake with an absent Origin only after validating the same Better
   Auth session. User, organization and rooms remain server derived. Reconnect reloads session/context
   and REST state; events remain PHI-free invalidation hints.

## Security-control disposition

The move to Expo changes the implementation owner, not the requirement. A control is complete only with
device evidence; PR B provides backend contracts and marks the rest accurately.

| Prior Capacitor control | Expo/RN disposition | PR B status |
|---|---|---|
| Better Auth session in platform secure storage | `@better-auth/expo/client` with Expo SecureStore; purge on logout/revocation | Server contract built; device proof in PR C |
| App foreground lock and biometric unlock | Expo local-authentication or reviewed native module; backend timeout remains authoritative | Deferred to PR C/device tests |
| Android screenshot blocking / iOS capture response | Reviewed native configuration/plugin per PHI screen | Deferred; no claim of implementation |
| Root/jailbreak and emulator posture | Managed native attestation/integrity adapter with a documented failure policy | Deferred; server flag remains off |
| Device attestation | Existing ChartWarden challenge/verification routes plus a supported iOS/Android provider | Deferred to dedicated lot |
| Certificate pinning | Native network-security configuration with a rotation and emergency-unpin runbook | Decision and device proof required |
| Encrypted offline drafts/cache | Reviewed encrypted SQLite/file store, user+org binding, TTL, backup exclusion and purge | Deferred; PHI in AsyncStorage forbidden |
| MDM distribution/configuration | EAS/native builds distributed by the selected MDM with managed config | Operational lot |
| Native push | FCM/APNs installation-token lifecycle with PHI-free payloads | Dedicated later lot |

## Consequences

- Two renderers increase design, accessibility and regression cost. Feature parity is measured through
  explicit mobile routes/capabilities, not by copying web components.
- ChartWarden keeps one authorization and tenancy implementation. Mobile roles may choose shortcuts, but
  effective permissions come from `/api/v1/auth/context` and every action is rechecked server side.
- `architecture/module-manifest.ts` and its CJS mirror do not change: the separate repository is an API
  consumer, not a ChartWarden codePath. A future published shared package would require its own ownership
  decision and manifest change.
- Device behavior, associated domains and release signing cannot be certified in this backend PR.

## Ratification items

The Frontend/Architecture Owner must ratify this supersession. Product/security owners must also choose
the production scheme and associated domains, decide the native passkey posture, and approve the
pinning/root-jailbreak/MDM implementations before claiming those controls are live.
