# Module 40 (Master Data Management) — DR Tier + Integration Inventory

M40-T10 (spec §7.8, §8.1, §4.8). Companion to the module's seam/route/job code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md` and `WARDENX_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 4** (reference / directory data)

MDM is **directory-style reference data, not a patient record** (§8.3 — PHI-free by construction).
A degradation does not block patient care or billing:

- **What pauses on degradation:** canonical *writes* (NPPES sync, merge execution, provisional
  promotion) — none of which is on a care/billing critical path.
- **What keeps serving:** every `resolve*` read. The §4.8 resolved-entity cache (Valkey, 5-min TTL)
  and the merge-redirect (which is a pure function over the canonical row, T04) keep answering from
  last-known state, so a chart load / claim line / order never blocks on MDM being writable.
- **RTO/RPO:** no RTO pressure (reads degrade gracefully from cache); RPO is bounded by the NPPES
  sync cadence (≤24h), which is itself a *freshness* concern, not a data-loss one — canonical rows
  are reconstructible from NPPES, the authoritative public source.
- **Tenant data (overlay/provisional/baa)** rides the standard org-scoped backup/restore; it is the
  only M40 data subject to HIPAA retention + the D7 destruction path (§7.8, `mdm_tenant_overlays`).

## Integration inventory — external feeds

| # | Feed | Direction | PHI? | Cadence | Owner / creds | Adapter | Tier |
|---|---|---|---|---|---|---|---|
| 1 | **NPPES** (NPI registry) | inbound | no | nightly delta (fallback-only) + weekly full + on-demand | platform; public API (no auth) | NPPES fetch adapter (out of M40 codePath; bound at boot) | 4 |

Notes:
- NPPES is the **sole** external surface. Public, unauthenticated, no PHI — a directory lookup.
- The nightly delta (`mdm.nppes_nightly_delta`, M40-T08) is the **Phase-1 authoritative sync path**;
  it is fallback-only once M29 lands (fires only when M29's platform sync is > 25h stale, §4.3).
- The M29 NPPES-sync consumers (M40-T09) are Phase-1 deny-stubs; when M29 (Wave H) lands, the
  event-driven path supersedes the nightly job for freshness (W-M40-12 / W-M40-13).

## STRIDE highlights

- **Tampering / Elevation:** canonical writes are locked to the `mdm_canonical_writer` role
  (M40-T03) and the platform-only `mdm.canonical.write` / `mdm.merge.*` permission keys (M40-T07);
  no tenant role can write canonical, in depth (DB grant + route omission + permission key).
- **Information disclosure:** MDM is PHI-free; the only sensitive overlay field (`contract_terms`)
  is Pino-redacted (§8.3) and audit-scrubbed by the M4 trigger denylist (M40-T03).
- **Repudiation:** every canonical/overlay write flows through the M4 audit triggers; app-level
  events are catalogued under `m40.*` (§8.1.1).
