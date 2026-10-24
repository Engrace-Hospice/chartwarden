# ADR-0100 — Messaging app lock (WP 5.11 client half): the server contract the mobile app consumes, and why nothing is built here yet

- **Status:** **Proposed** (2026-10-23). Nothing is built. No code, no migration, no flag. Every default below is a PROPOSED default awaiting the security owner (SEC); none is a decision.
- **Date:** 2026-10-23
- **Phase:** Messaging Hub Phase 5, WP 5.11 ("native push and app lock") and the app-lock remainder of WP 5.5.
- **Related:** [ADR-0072](ADR-0072-separate-react-native-expo-mobile-app.md) (decision 12: the lock is a convenience layer, the server session stays authoritative), [ADR-0083](ADR-0083-messaging-session-device-controls.md) (open question 3), [ADR-0074](ADR-0074-messaging-lock-screen-privacy.md) (no PHI on a lock screen).

## Context (facts read from the repo)

- There is no mobile app in this repo. `apps/` holds `admin`, `backend`, `portal`, `web`; no package depends on `expo` or `react-native`. The app is `Engrace-Hospice/chartwarden-mobile` (ADR-0072), so the biometric prompt, idle timer and lock screen can only be written there.
- The server half of native push is merged (migration 1153, WP 5.11 server-side note in `docs/messaging-hub/04-phases-4-to-6.md`).
- No app-lock policy exists anywhere: no table, column, route, setting or enum. `GET`/`DELETE /api/v1/devices` return label, last used, push flag and current marker only.
- ADR-0083 and the decision sheet ("app-lock and device policy (5.5, SEC)") leave the policy undecided; `briefs/brief-security.md` SE-4 states "not built; the work waits for you" and that the maximum idle minutes are "not chosen".
- The UI spec contradicts itself on the shape: section 5.5 says the tenant sets a **maximum** idle time, the mock beside it says "tenant minimum: 5 min". Which one is meant is itself an open SEC question.

## Why nothing is built in this repo

A tenant policy needs a stored value, and every field of it (the idle bound, whether the factor is biometric or device credential, whether it can be turned off, what the lock screen shows) is the unmade SEC decision. A column with a null default would be inert, would need a migration, manifest and mirror entries, a route and tenant-IDOR coverage, and would still encode a guess about the policy's shape. The server cannot enforce a device-local lock, so a stored value protects nothing until the app reads it. Build it once SEC answers SE-4, together with the app that consumes it.

## Proposed contract (for SEC to confirm; not built)

1. **Server is the policy source, the device is the enforcer.** Per-tenant `app_lock_max_idle_seconds` (null = none) and `app_lock_require_biometric_or_device_credential` (boolean), tighten-only: a device may choose a shorter idle, never a longer one or off when the tenant sets a bound. Proposed default: none, flag off.
2. **Read-only to the device**, delivered on an existing authenticated call (proposed: a field on `GET /api/v1/devices`, current-session scope), cached by the app, never writable by it.
3. **A device-reported lock state is never authorization.** The server ignores any such claim; there is no "locked/unlocked" endpoint and none is to be added.
4. **A revoked or expired session dies by the 401, not by the lock** (ADR-0072 decision 12, ADR-0083 revoke: already built and live-tested).
5. **The lock screen shows no PHI** (ADR-0074).

## Work that belongs to `chartwarden-mobile`

Foreground and idle timer; Expo local-authentication (or reviewed module) prompt with device-credential fallback; lock screen without PHI; honour the tenant bound once the field exists; clear in-memory decrypted data on lock; device evidence on real iOS and Android hardware (none exists).

## Open decisions (SEC)

SE-4: maximum vs minimum idle and its value in minutes; unlock factor and fallback; lock-screen content; whether an organisation may disable the lock; failed-attempt behaviour (local wipe or forced re-login). Also whether native-app device revoke needs anything beyond ADR-0083.

## Consequences

Docs only. Until SEC answers, a signed-in unlocked phone stays usable for the full session, as already recorded in the SE-4 brief.
