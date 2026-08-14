# ADR-0041 — Telehealth video vendor: Daily.co default behind the `TelehealthProvider` port

- **Status:** **Accepted** — ratifies the as-built state (2026-08-14). Closes architecture §21
  open-decision register item **ADR-003** (telehealth video vendor), which M31 shipped against
  while the register still read "open".
- **Date:** 2026-08-14
- **Phase:** post-build decision record (M31 Portal/Telehealth is merged).
- **Related:** M31 spec D1 (the shipped decision this ADR ratifies);
  `WARDENX_INTEGRATIONS` §6.21 (contract section); ADR-0028 (adapter-package layout).

## Context

Architecture §21 carried "ADR-003 — Telehealth video vendor (Daily.co / Twilio Video / native
WebRTC)" as an open pre-build decision, needed before the Module 31 spec. M31 was specced, built,
and merged with the decision made in its D1 — but no four-digit ADR ever closed the register row,
leaving three documents disagreeing (M31: "closed"; ARCHITECTURE §21: open; INTEGRATIONS §6.21:
"pending ADR-003").

As built: `packages/telehealth-client` exposes a typed `TelehealthProvider` interface with a
**Daily.co adapter** (`src/daily-co-adapter.ts`) as the default implementation, a circuit breaker,
and interface-conformant scaffolds for the alternatives (`src/scaffold-adapters.ts`).

## Decision

1. **Daily.co is the default telehealth video vendor**, reached only through the
   `TelehealthProvider` port in `packages/telehealth-client` — vendor-pluggable by construction;
   Twilio Video / native WebRTC remain swappable scaffolds behind the same interface.
2. **No PHI in vendor payloads**: opaque room identifiers and short-lived per-visit tokens only
   (M31 D1's constraint, carried forward as binding).
3. **Operational preconditions stay open as onboarding gates, not vendor questions**: an executed
   Daily.co **BAA** before any production PHI video (INTEGRATIONS §5 row must read EXECUTED), and
   the platform-vs-per-tenant credential scope is finalized at tenant onboarding per the
   INTEGRATIONS §6.21 credential model.

## Consequences

- Architecture §21's ADR-003 row is **Resolved** (this ADR); INTEGRATIONS §6.21/§11 cite it
  instead of "pending ADR-003".
- Swapping or adding a vendor is an adapter behind the existing port plus a BAA — not a new
  architecture decision, unless the port shape itself must change.
