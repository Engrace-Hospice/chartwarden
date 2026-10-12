# Brief: name the M19 owner for the `EscalationRouter` seam (ADR-0057)

**Audience:** whoever owns M19 (on-call, tiers, triage escalation) · **Needs from you:** a name, a date, four answers · **Blocks:** WP 4.3 only.

## What M36 needs from M19

M36 (messaging) will own acknowledgment requests and their timers (ADR-0056). It must not own on-call. When a request
goes unacknowledged, M36 asks M19 one question through one seam:

> "At tier N, as of now, who is accountable for this role (and patient), and is there a next tier?"

Proposed shape (working names; the final contract is WP 0.5, written together with you):

```ts
interface EscalationRouter {
  resolveTier(orgId, req: { patientId; requiredRole; tier: number; asOfIso }): Promise<EscalationTierResolution>;
}
type EscalationTierResolution =
  | { kind: "resolved"; actors: readonly OnCallActor[]; tierAckWindowMinutes: number | null; hasNextTier: boolean }
  | { kind: "coverage_gap"; tier: number; hasNextTier: boolean };   // a real answer; a store failure THROWS instead
```

Rules: pure read, no side effects in M19; evaluated in the schedule's time zone; positional `orgId` first, checked as an
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

Recorded in ADR-0057 (status moves from Proposed to Accepted once the owner confirms or amends the contract), then WP 0.5
writes the contract into `packages/types` with a deny-stub. Until the date in item 2 passes, nothing in M19 is touched.

References: `docs/adr/ADR-0057-escalation-ownership-m19-m36.md`, `docs/adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md`.
