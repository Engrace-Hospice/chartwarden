# Brief: name the M19 owner for the `EscalationRouter` seam (ADR-0057)

**Audience:** whoever owns M19 (on-call, tiers, triage escalation) · **Needs from you:** a name, a date, four answers · **Blocks:** WP 4.3 only.

## What M36 needs from M19

M36 (messaging) will own acknowledgment requests and their timers (ADR-0056). It must not own on-call. When a request
goes unacknowledged, M36 asks M19 one question through one seam:

> "At tier N, as of now, who is accountable for this role (and patient), and is there a next tier?"

The contract now exists (WP 4.3, `packages/types/src/messaging-escalation.ts`; M36 ships a deny-stub that answers `unavailable`
until you bind a real router):

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

1. **Owner:** one named person (and a backup).
2. **Delivery date** for the seam in M19. M36 builds against a deny-stub until then.
3. **Role-level lookup:** can tier-to-recipient resolution work with no triage call and no `patientId` (role only)?
4. **Fallback recipient** when the seam is down: which role, and platform-fixed or tenant-configured?
5. **Watchdog:** should `failed_unreachable` feed M19's coverage-gap watchdog? (Small, but it touches Tier-1 behaviour.)

## What happens with the answers

Recorded in ADR-0057 (status moves from Proposed to Accepted once the owner confirms or amends the contract). The contract and deny-stub
are already in `packages/types` and the registry (WP 4.3); you register the real router over the stub. Until the date in item 2 passes,
nothing in M19 is touched.

References: `docs/adr/ADR-0057-escalation-ownership-m19-m36.md`, `docs/adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md`.
