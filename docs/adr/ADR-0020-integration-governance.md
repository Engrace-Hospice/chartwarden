# ADR-0020 — Integration governance: INT-002 mandatory, INT-014 BAA hard gate, SEC-099 vendor review

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 5 (integration governance)
- **Resolves:** X8, H5; M18-F01, M21 (DME/pharmacy), M22 (print/mail + fax/email ingest), M19
  (triage vendor), M02-F10 (HIBP), M11 (outbound ORM), M12 (DoseSpot webhook types), M30 (CAHPS)
- **Changes:** `CHARTWARDEN_INTEGRATIONS_v0_1.md` (§2 inventory + §5 BAA register + §8 degraded-mode);
  M18/M21/M22/M19/M02/M11/M12/M30 (remediation banners)

## Context

INT-007 requires that any external connection complete the **INT-002 five-step addition** *before*
the adapter is built. Across the corpus, multiple external surfaces were shipped (often as a
Phase-1 "done" gate) **without** being catalogued — several carrying PHI with **no BAA analysis**,
violating the INT-014 hard gate. The Integration Catalog is the single source of truth for external
surfaces (the analogue of the module manifest); a surface that is not in it is not approved.

## Decision

### D1 — INT-002 five-step addition is mandatory before an adapter merges

No external adapter is built or merged until its surface has all five:

1. an **Integration-Inventory row** (`CHARTWARDEN_INTEGRATIONS §2`) — direction, protocol, PHI flag,
   BAA-required flag, credential scope, owning module(s), adapter package, DR tier;
2. a **§6 per-integration contract** (auth, endpoints, idempotency, retry/backoff, error mapping);
3. a **§5 BAA-register entry** (vendor, PHI?, BAA status, signer, date);
4. a **§8 degraded-mode matrix row** (what happens when the surface is down);
5. a **module cross-reference** in the owning module spec.

### D2 — INT-014 BAA execution is a HARD gate before production PHI flows

A surface that carries PHI **may not flow production PHI until the BAA (or trading-partner
agreement, or — for 42 CFR Part 2 SUD data — a QSOA) is EXECUTED**, not merely "in negotiation."
The adapter refuses to start against production credentials when its BAA-register status is not
`executed`. A Phase-1 "done" gate may **not** be conditioned on an un-executed-BAA PHI surface.
(This mirrors ADR-0012 D4 for the Anthropic cloud-AI BAA.)

### D3 — SEC-099 vendor review + degraded mode

Each new PHI vendor passes the **SEC-099 10-step vendor security review** (Security-Owner +
Compliance sign-off) before approval, and declares **degraded-mode** behavior (circuit breaker +
`DegradedError`; what the dependent workflow does when the surface is unavailable — queue, fall back
to paper, or block with a clear operator message).

### D4 — The catalogued surfaces

The following surfaces were uncatalogued and are added to `CHARTWARDEN_INTEGRATIONS §2` (inventory
26–33) with BAA-register entries:

| Surface | Module | PHI | BAA / agreement |
|---|---|---|---|
| EVV state aggregators (OR-PTC DCI launch / Sandata-class) | M18 | Yes | trading-partner agreement / BAA — **required** |
| DME vendors | M21 | Yes (name, address, items) | BAA — **required** |
| Partner pharmacy (comfort-kit fulfillment) | M21 | Yes | BAA — **required** |
| Print/mail vendor (statements/letters) | M22 | Yes (name, address, doc content) | BAA — **required** |
| Fax/email document ingest | M22 | Yes (inbound) | BAA (vendor) — **required** |
| External triage vendor (after-hours) | M19 | Yes (clinical; SUD ⇒ **QSOA**) | BAA + QSOA-for-Part-2 — **required** |
| HaveIBeenPwned (HIBP) | M02 | **No** (SHA-1 prefix, k-anonymity) | **none** |
| Outbound HL7 ORM (lab orders) | M11/M29 | Yes | BAA / trading-partner — **required** |

DoseSpot webhook event types (M12) are an addition to the **already-catalogued** DoseSpot surface
(§7 webhook catalog), not a new inventory row.

## Consequences

- `CHARTWARDEN_INTEGRATIONS` gains inventory rows 26–33, BAA-register entries, and degraded-mode rows.
- M18/M21/M22 Phase-1 "done" gates are **no longer conditioned on un-executed-BAA PHI surfaces** —
  for Engrace go-live (Oregon), the EVV-aggregator path is only required where Oregon Medicaid
  mandates EVV (ADR-0008), and its BAA must be executed first.
- HIBP needs no BAA (no PHI) but still gets an inventory row + circuit breaker + degraded behavior
  (accept password, async re-check).
