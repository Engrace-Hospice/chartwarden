# Brief: name the M19 owner for the `EscalationRouter` seam (ADR-0057)

**Audience:** whoever owns M19 (on-call, tiers, triage escalation) · **Needs from you:** a name, a date, four answers · **Blocks:** nothing in the build now; it blocks turning the router on for a real tenant and any tier above 1.

> **Status (2026-10-19):** a tier-1-only router is built in M19 (`19-oncall/seams/escalation-router.ts`, ADR-0057 item 12) and is **unbound by default**; it answers only for organizations listed in `ESCALATION_ROUTER_ORGS`. **Owner: the product owner is the INTERIM M19 owner (decided 2026-10-19, E1); backup not named, first-tenant date not named; handover to a permanent owner is open.** Tiers 2 and above answer `tier_not_configured` until an owner defines the `escalation_tiers` shape (decision 3 below stays relevant). Decisions 3 and 5 each have a proposal in ADR-0057 item 12; neither is decided. Decision 4 (fallback recipient) is decided as an explicit ordered, sender-confirmed ladder (confirmed on-call, a per-tenant named role with unset = off, a fixed per-tenant emergency number such as the `emergency_contact_e164` idea below), recorded 2026-10-19 as the product owner's decision as interim M19 owner; clinical-lead concurrence is not separately recorded and none of it is built (ADR-0082 decision 9, Proposed).

## What M36 needs from M19

M36 (messaging) will own acknowledgment requests and their timers (ADR-0056). It must not own on-call. When a request
goes unacknowledged, M36 asks M19 one question through one seam:

> "At tier N, as of now, who is accountable for this role (and patient), and is there a next tier?"

The contract exists (WP 4.3, `packages/types/src/messaging-escalation.ts`). M36 ships a deny-stub that answers `unavailable`
for every organization not on the router allowlist; a tier-1 router now exists for allowlisted organizations only:

```ts
interface EscalationRouter {
  resolveTier(orgId: string, req: { patientId: string; requiredRole: string; tier: number; asOf: string }): Promise<EscalationRouteAnswer>;
}
type EscalationRouteAnswer =   // every variant also carries { tier, asOf, source: "m19" | "deny_stub" | "in_memory_fake" }
  | { kind: "resolved"; userIds: readonly string[]; nextTier: number | null; timeZone: string }      // ids only; zone = the schedule's
  | { kind: "coverage_gap"; nextTier: number | null; timeZone: string }                              // a real answer
  | { kind: "unavailable"; reason: "router_not_bound" | "no_route_configured" };                     // cannot route
// A store failure THROWS; it is never mapped to coverage_gap or unavailable.
```

**Fields M19 must supply per (org, role, tier):** the user ids covering `asOf`; whether tier n+1 exists; the IANA zone of the schedule
the shift was read in. Shift windows must follow the tested rules in ADR-0057 item 11 (`packages/messaging/src/escalation/shift-window.ts`).

Rules: pure read, no side effects in M19; evaluated in the schedule's time zone, never the server's; positional `orgId` first, checked as an
assertion (`assertCallerOrg`). M19 keeps rosters, tiers, recipient resolution, per-tier timing, coverage-gap detection and
triage-call lifecycle. **Nothing changes in M19's triage behaviour** (decision D6: triage SLAs untouched; where both clocks
apply, the stricter one wins).

## Decisions requested

1. **Owner:** one named person (and a backup). *Decided 2026-10-19: the product owner, interim. Backup: not named. Handover to a permanent owner is open.*
2. **Delivery date** *(not given)* for tiers 2 and above and for turning the tier-1 router on per tenant. Until then M36 runs against the deny-stub (or the tier-1 router for an allowlisted org).
3. **Role-level lookup:** can tier-to-recipient resolution work with no triage call and no `patientId` (role only)? *Built answer for tier 1: it needs a patient (to find the provider entity). Tiers 2+ are undefined.*
4. **Fallback recipient** when the seam is down: which role, and platform-fixed or tenant-configured? *Decided 2026-10-19: an ordered ladder, each step visible to and confirmed by the sender (confirmed on-call; a named role configured per tenant, unset = off; a fixed per-tenant emergency number). Not built.* *Proposal, not built: `tenant_oncall_policy.emergency_contact_e164`, platform-fixed.*
5. **Watchdog:** should `failed_unreachable` feed M19's coverage-gap watchdog? (Small, but it touches Tier-1 behaviour.) *Proposal: yes, read-only, separate change. Not built.*

## What happens with the answers

Recorded in ADR-0057 (status moves from Proposed to Accepted once the owner confirms or amends the contract). The contract and deny-stub
are already in `packages/types` and the registry (WP 4.3); the tier-1 router is registered over the stub only for allowlisted organizations. Nothing in M19's triage behaviour is touched.

References: `docs/adr/ADR-0057-escalation-ownership-m19-m36.md`, `docs/adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md`.
