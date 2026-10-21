// @chartwarden/bereavement — Module 16 (Bereavement) feature package.
//
// M16-T01 lands the §3.1 domain layout + the pure-data policy every later M16 task builds on:
//   · `policy.ts`  — the D4 13-month death-anchored window + its 30-day `due_at` grace, the D7 early-close
//                    cosign set and reason floor, the D9 90-day self-service opt-out rescind window, the
//                    §2.3 3-strikes unreachable threshold, and the D6 close-as-declined guard;
//   · `outreach-kinds.ts` — the D15 M8-encounter boundary (only `in_person_visit` is an encounter), the D14
//                    M22 artifact-render set, and the D4 modality ladder tenant tightening is measured on;
//   · `cadence/`   — the D4 per-tier platform-floor cadence (cumulative across tiers) + the tenant-tighten
//                    validator that proves a tenant policy only added, moved earlier, or converted upward;
//   · `risk/`      — the D3 factor weights + tier cutoffs and the D17 `unknown`-aware deterministic scorer
//                    with its completeness / confidence bands, plus the D8 grief-screen tier promotion;
//                    M16-T04 adds the reproducible DERIVATION of that vector from M15 MSW findings / the M9
//                    PPS trajectory / the M16 roster (`evidence.ts`), and the `ai.full` Layer-2 eligibility
//                    ladder whose merge structurally forbids the M32 narrative from moving the tier
//                    (`layer2.ts`);
//   · `gate/`      — the D18 external-source first-contact gate + the cosign-receipt applier.
//
// The cross-module enum / seam / outbox / alert CONTRACTS — the §3.2 enum mirrors, the §3.3 owned-table
// names + D11 audit denylists, the §4.4 `m16.bereavement.*` event names and payloads, the §4.10 M36 alert
// union, and the §4.6 published-seam interfaces + read DTOs — live in the leaf `@chartwarden/types`
// (`bereavement.ts`) per ADR-0005 D1/D2, so M22/M28/M30/M31/M32/M33/M36 import them with no `dependsOn`
// edge. The spec's §3.1 layout writes this package as `packages/domain/bereavement`; the repo's convention
// (`@chartwarden/discipline-plans`, `@chartwarden/idg`, `@chartwarden/orders`) is a top-level feature package, and
// architecture wins over the spec's proposed path.
//
// Still to land: the §4.6 seam impls (M16-T05), the §4.1 routes with the §4.7 permission keys + §4.8 ABAC
// predicates (M16-T06), and the §5 screens (M16-T07).
//
// PURE — no IO, `@chartwarden/types`-only.

export * from "./policy";
export * from "./outreach-kinds";
export * from "./cadence";
export * from "./risk";
export * from "./gate";
