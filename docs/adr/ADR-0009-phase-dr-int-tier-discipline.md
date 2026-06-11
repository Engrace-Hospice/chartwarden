# ADR-0009 — §20.A phase / DR-tier / INT-tier discipline

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture correction)
- **Resolves:** phase-cut findings across M15/M17/M18/M19/M20/M21/M26/M27/M28/M30/M33/M37; Build-Blocking #8
- **Changes:** `WARDENX_ARCHITECTURE_v0_11.md` §20.A (Phase Cut Rationale)

## Context

Twelve specs ship Phase-2 or Phase-3 capabilities inside Phase 1 with no ADR, and several drag
other later-phase modules onto the Phase-1 critical path (e.g., M20 Field Safety → M19 On-Call
for after-hours SOS, when both are §20.A Phase 2). A module spec also "ratified" another module's
phase move by citing that module's changelog. Separately, DR tier and INT tier assignments
(normative in `WARDENX_DR_BCP` and `WARDENX_INTEGRATIONS`) are frequently undeclared per module.

## Decision

1. **A Phase-1 module ships only Phase-1 scope.** Early-building a later-phase capability is
   permitted **only** with (a) an ADR that moves the capability's phase, and (b) a feature flag
   that **defaults off** until its phase activates (ARCH-231). A module spec may **not** move its
   own — or another module's — phase by assertion or by citing a sibling's changelog.

2. **No cross-phase critical-path coupling without a fallback.** If a Phase-1 capability needs a
   capability owned by a later-phase module, either (a) an ADR moves the dependency (and the
   minimal surface it provides) into Phase 1, or (b) the Phase-1 capability declares a
   **documented degraded fallback** for when the later-phase module is absent (e.g., after-hours
   SOS falls back to supervisor subscriptions + the tenant emergency number when M19 is not yet
   built). "Required from day one" pulls the *whole* dependency forward only via (a).

3. **Every module spec declares its DR tier and its external surfaces.** The DR/BCP RTO/RPO tier
   (Tier 1–5) and degraded-mode behavior are declared per module per `WARDENX_DR_BCP`; every
   external touchpoint appears in the `WARDENX_INTEGRATIONS` inventory with matching
   protocol/auth/direction/PHI-flag/BAA status per INT-002. These are CI-gated template
   requirements (X11), not optional prose.

## Consequences

- The §20.A "Phase Cut Rationale" is extended with rules 1–3 above.
- The specific phase corrections (which module moves to which phase, or gets a flag/fallback) are
  **Phase-6 per-spec reconciliation** work; this ADR sets the governing rule so those corrections
  are consistent. Notably: M20↔M19 after-hours SOS, M18 aggregator stack, M28 R4-write, M30 CAHPS,
  and the M15/M17/M21/M26/M27/M33/M37 early-builds each need an ADR-or-flag-or-fallback resolution.
- No phase change is "ratified" by a sibling module's changelog; each requires its own ADR.
