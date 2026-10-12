# 01 — Baseline & Gap Matrix (Keep / Modify / Consolidate / Replace / Deprecate)

> Part of the [Messaging Hub plan](./README.md). The "As built" column is verified against the spec and file tree on
> 2026-10-11; rows marked **⚑ verify** are claims Phase 0 must confirm in code before any work package is cut.

## 1. Disposition legend

| Verb | Meaning |
|---|---|
| **Keep** | Correct and sufficient; extend only by adding alongside it |
| **Modify** | Right idea, needs schema/API/UX change (migration or contract version) |
| **Consolidate** | Two mechanisms do one job; merge behind one contract |
| **Replace** | Wrong shape for the target; build the new one, migrate, retire the old |
| **Deprecate** | Stop using; keep readable until retention allows removal |

## 2. Component map

| # | Component | As built | Disposition | Target / note |
|---|---|---|---|---|
| 1 | `channel` / `channel_member` | 7 kinds, auto membership via seams | **Keep + Modify** | Add `status` lifecycle (open/restricted/archived), `owner_user_id`, `sensitivity`; keep `kind` immutable. Add handoff + department kinds only via ADR (kind drives retention) |
| 2 | `message` (cipher + sha256) | Envelope-encrypted, hash-verified | **Keep** | Do not weaken. New fields are additive (`urgency`, `client_message_id`, `scheduled_for`) |
| 3 | Edit / delete | 5-min edit, tombstone, cipher retained | **Modify** | Add `message_revision` rows so edits keep history (today the old body is only recoverable from audit). Redaction is a separate, policy-gated action, never "delete" |
| 4 | `message_receipt` (`delivered/read/ack`) | Per recipient | **Modify** | Keep `delivered`/`read`. **`ack` on a message ≠ clinical acknowledgment**: clinical acknowledgment moves to the new `message_acknowledgment` (see 02 §4). Leave `ack` for non-clinical "got it" or deprecate after audit |
| 5 | Attachments | `message_attachment.documentRef` → M22 | **Modify** | Add scan state + access events via M22; ⚑ verify whether upload UI exists. No bytes in M36 |
| 6 | Threads | `parent_message_id` / `quoted_message_id` columns | **Modify** | ⚑ verify route + UI use. Add reply count + thread view; enforce same-channel on write (CHECK/FK) |
| 7 | Mentions / refs | `message_entity_reference` (staff, patient) | **Keep + extend** | Widen `reference_kind` for clinical links (medication, order, care_plan, visit, document) in Phase 3 — the shape CHECK needs a migration |
| 8 | Idempotent send | ⚑ verify | **Modify** | Add `client_message_id` unique per (org, sender) → one message per key |
| 9 | Search | None found | **New** | Authorized search (see 02 §6); body is encrypted → search needs a design decision (ADR-M36-search) |
| 10 | Drafts | None found; web holds draft in component state | **New** | Server-side `message_draft` (encrypted) + local offline copy |
| 11 | Realtime | Event/room **contracts** in `packages/messaging/src/realtime`; no server; client polls | **Replace (poll → push)** | Phase 1 WP-1.1. Polling stays as fallback/reconnect reconciler |
| 12 | Presence / typing | `presence` table; no live transport | **Keep (defer)** | P2; ephemeral, never persisted beyond `presence` |
| 13 | Alert engine | Typed catalog, rules, fan-out, quiet hours, vacation, voice SOS | **Keep** | The escalation engine *builds on* this (delivery + retry). Do not fork a second fan-out |
| 14 | Notification channels | in-app/push/SMS/email/voice dispatchers, sanitiser | **Keep + Modify** | Add lock-screen-safe push template tests; delivery-failure → escalation hook |
| 15 | On-call + escalation tiers | **M19** (`triage_escalation`, `on_call_shift`) | **Keep — do not duplicate** | M36 *requests* escalation via a seam; M19 owns who and when |
| 16 | IDG | **M14** | **Keep — link, don't copy** | IDG-linked discussion references M14 meeting/patient; never marks a meeting complete |
| 17 | Orders / meds | **M11/M12/M13** | **Keep — link only** | Chat can *link* a medication/order; never create or alter one |
| 18 | Documents | **M22** | **Keep** | Attachments and chart-promotion artefacts live in M22 |
| 19 | Legal hold | ADR-0051 overlay pattern for audit | **Modify** | Messages need a hold mechanism that retention scan honours (spec says it skips holds — ⚑ verify implemented) |
| 20 | Offboarding | M2 identity sessions | **Modify** | M36 consumes a membership-ended event: revoke subscriptions/devices, reassign owned tasks/escalations |
| 21 | Break-glass | M3/M4 elevated-access pattern | **Keep + extend** | Reuse; add messaging scope + post-review queue |
| 22 | Web UI | 2-panel inbox + thread + dialogs; 852-line `conversation-thread.tsx` | **Replace shell, keep logic** | Three-panel workspace on the shared kit (06). Split oversized files while moving |
| 23 | Inbox summaries | Server-side, access-revalidated, batched | **Keep** | Extend with urgency/unacknowledged counts |
| 24 | Bereavement / announcement channels | Own lifecycles | **Keep** | Out of scope except accessibility and search permissions |

## 3. Known gaps vs. the proposed capability set (headline)

| Gap | Impact | Phase |
|---|---|---|
| No clinical urgency / acknowledgment model | A "critical" message is indistinguishable from chat | 4 |
| No communication-task or handoff aggregate | Nurses duplicate work in notes | 3 |
| No server push; polling only | Misses the p95 < 2 s delivery target; battery/data cost on mobile | 1 |
| No revision history, redaction workflow, or hold-aware retention for messages | Integrity/legal exposure | 1, 5 |
| No chart-promotion workflow | Clinically relevant decisions stay buried in chat | 3 |
| No empty-vs-error-vs-forbidden thread states (screenshot: "No messages yet" on an active-looking thread) | Staff cannot tell a failure from an empty conversation | 2 (quick win: pull into Phase 1) |
| No offline/optimistic send | Field staff lose messages on poor networks | 5 |

## 4. Phase 0 audit checklist (produces the real Keep/Modify map)

Deliverable: `docs/messaging-hub/audit/PHASE_0_AUDIT.md` + the register in [`08`](./08-capability-register.md) with every
**⚑ verify** resolved.

1. **Routes** — enumerate `messaging-routes.ts`; for each: permission key, ABAC predicate, audit event, idempotency, test.
2. **Authorization** — trace `messaging.read/send` ABAC (`caseload_membership`) through `part2-channel-gate.ts`; list every path that
   can read a message *without* channel membership (search, summaries, alert deep links, exports).
3. **Tenancy** — confirm RLS + FORCE on every M36 table (`arch:tenancy` replay) and that `message_entity_reference` and any future table
   follow the three-column rule.
4. **Attachments** — does any route accept `attachments[]` (typebox allows ≤ 10)? Who validates `documentRef` ownership/scan state?
5. **Retention & holds** — does `messaging.retention_scan` exist as code or only as spec? Does it consult a legal hold?
6. **Realtime** — confirm no Socket.IO server; list consumers of `realtime/events.ts` and `rooms.ts`.
7. **Receipts** — who writes `ack`? Anything that treats `ack` as clinical acknowledgment must be found.
8. **Threads** — is `parentMessageId` accepted, validated same-channel, rendered?
9. **Web** — files over 800 lines (`conversation-thread.tsx`, `staff-messaging.css`), states handled (loading/empty/error/forbidden),
   a11y gaps (focus order, live regions), kit usage vs inline styles.
10. **Seams** — inventory `CareTeamProvider`, `OnCallProvider`, alert emitters; which M19/M14/M17 events M36 already consumes
    (`arch:outbox-bindings` + `scripts/outbox-deferred-consumers.ts`).
11. **Data** — row counts and size of `message`, `channel`, `message_receipt` on demo/prod. Prod is demo data, so any bad
    row is fixed by reseeding, not by a remediation script.
12. **Threat model** — extend `apps/backend/src/modules/36-messaging/THREAT_MODEL.md` (STRIDE) with: search leakage, websocket
    subscription after revoke, attachment IDOR, escalation spoofing, AI prompt leakage.

**Exit criteria:** every component in §2 has a final disposition; no unresolved high-severity design risk; ADRs in
[`02` §8](./02-architecture-and-domain.md#8-adrs-to-write-before-the-phases-that-need-them) drafted; owners named for each bounded context.
