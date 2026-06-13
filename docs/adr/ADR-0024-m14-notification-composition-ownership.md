# ADR-0024 — Notification composition & recipient resolution for cross-module events belongs to M36, not M14

- **Status:** Proposed (recommendation — requires architecture-owner ratification)
- **Date:** 2026-06-13
- **Phase:** dispute resolution (post June-13 re-audit)
- **Resolves:** M14-F04 (DISPUTED); `audit/TRIAGE_RESULTS.md` §Batch-3
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md)
- **Changes (on acceptance):** `WARDENX_MODULE_14_IDG_SPEC_v0_4.md` (D14/D15/D16, §1.1, §3.5, §4.11, owned-table count), `WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md` (recipient resolvers + payload catalog), `WARDENX_MODULE_06/11/22` consumer declarations. No `module-manifest.ts` change.

## Context

The architecture (**SD-017**) assigns alert **rule lookup, recipient resolution, and
preference-aware routing** to the **Module 36 Alert Engine**. M36's locked spec implements exactly
this: dynamic recipient resolution at emit time via a `RecipientResolver` registry
(`care_team`, `on_call`, `discipline`, `tenant_admins`, role-set, user-list — M36 §"Recipient
resolution is dynamic at emit time"), the per-tenant `alert_rule` routing layer, and the
`alert_payload_catalog` that every dispatch validates against (M36 D10).

M14 v0.3 (decisions **D14/D15/D16**) ratified — at the **module-spec** level — a *secondary*
**"notification-composition layer"** in M14 for selected non-IDG events: it composes the typed
payload and **resolves recipients** for `m6.referral.{received,accepted,declined,withdrawn}`,
`m22.document.rendered_critical_results`, and `m11.order.transmission_terminal_failed`, then calls
`M36.dispatch(...)`. It adds a platform-global **`notification_template`** catalog owned by the IDG
module (M14 §3.5), citing M6 v0.2 §4.4, which already named M14 as the consumer for the
`m6.referral.*` events.

**The conflict.** Recipient resolution + routing is M36's by SD-017; M14's D15/D16 relocates
recipient resolution and template ownership for these events into M14. Per the corpus authority
rule, **architecture (SD-017) wins over a module spec (D15/D16)** unless an ADR ratifies the
exception. The concrete harm the audit identifies: two of these paths are **CRITICAL clinical
alerts** (critical lab results; lab-transmission failure to the ordering provider). Routing their
recipient resolution/composition through the IDG module makes a **Tier-2 clinical-urgent alert path
depend on IDG-module availability** — an availability coupling between subsystems that have no
clinical relationship.

Both needs are real: referral-notification audiences (admissions/intake-supervisor) are
IDG-adjacent; but the *mechanism* (recipient resolution + template) is generic alert-engine work
M36 already owns.

## Decision (recommended)

**Notification composition and recipient resolution for cross-module events move to M36; M14 retains
only IDG-meeting notifications.** Concretely:

- The **producing modules** (M6, M11, M22) emit their typed outbox events (they already do).
- **M36** resolves recipients via its `RecipientResolver` registry and routes per `alert_rule`; the
  message templates live in M36's `alert_payload_catalog` (already the dispatch-validation surface),
  not in an M14-owned `notification_template` table.
- **M14 drops** the `notification_template` / `tenant_notification_template_overlay` tables, the
  three cross-module composers (§4.11), and D15/D16's "platform notification-composition layer"
  role. M14 keeps composing **only its own IDG-meeting** notifications ("packet ready",
  "non-quorate meeting", "carry-forward overdue").
- M6/M11/M22 change their declared consumer for these events from "M14 composes" to "M36 resolves +
  dispatches" (M36 is already in their dependency set as the alert engine).

This removes the IDG-availability coupling from the critical-results and transmission-failure paths
and restores SD-017's single-owner model for recipient resolution.

## Alternatives considered

- **B — Ratify M14's cross-cutting role (keep D15/D16).** Accept M14 as the composition layer for
  these events, with this ADR explicitly blessing the SD-017 exception. *Rejected:* it preserves the
  Tier-2-alert-on-IDG-availability coupling and creates a second recipient-resolution home,
  contradicting SD-017 with no architectural benefit over M36 doing it.
- **C — Surgical split (pragmatic minimum).** Move only the two **CRITICAL** paths
  (`m22.document.rendered_critical_results`, `m11.order.transmission_terminal_failed`) to M36;
  let M14 keep the **referral** notifications (lower criticality, IDG-adjacent audience).
  *Acceptable fallback* if the owner wants to honor M6 v0.2's existing M14-consumer declaration —
  it removes the critical-path coupling (the actual harm) while minimizing cross-module churn. If
  chosen, M14's `notification_template` catalog is retained for referral templates only and this ADR
  is recorded as ratifying that narrowed cross-cutting role.

## Consequences (on acceptance)

- **M14 spec:** retract D15/D16's platform-composition role (or narrow to referrals under Option C);
  remove the two `notification_template` tables (owned-table count 11→9, or keep under Option C);
  delete the critical-results and transmission-failure composers; update §1.1/§3.5/§4.11. Closes
  M14-F04.
- **M36 spec:** confirm `RecipientResolver` entries for "ordering provider" and the admissions/
  intake-supervisor role-sets; register the corresponding payload types in `alert_payload_catalog`.
- **M6/M11/M22 specs:** update the consumer declaration for the moved events to M36.
- **No manifest change** — M14 already lists 36; the producing modules already list 36.
- **Authority note:** until ratified, SD-017 governs and M14-F04 stands OPEN; D15/D16 do not override
  the architecture.
