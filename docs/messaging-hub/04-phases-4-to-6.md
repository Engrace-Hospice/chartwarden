# 04 — Phases 4–6: Escalation → Mobile & Governance → Advanced

> Part of the [Messaging Hub plan](./README.md). Phase 4 is the safety core: no clinical go-live without it.

---

## Phase 4 — Urgency, on-call & notification reliability (4–6 weeks)

**Reuse, don't rebuild.** Delivery (in-app / push / SMS / email / voice), quiet hours, vacation forwarding, retry sweeps and the PHI sanitiser
already exist in M36. On-call rosters, tiers and `triage_escalation` live in **M19**. Phase 4 adds the *acknowledgment-request aggregate* and
wires the two together through seams.

| WP | Scope | Acceptance |
|---|---|---|
| **4.1 Urgency model** | `routine / important / urgent` on `message`; "Urgent clinical" is a distinct composer mode requiring patient link + SBAR + selected qualified recipient (or role); copy states it is **not** the emergency path | Urgent send without recipient/patient rejected; UI shows the agency emergency-procedure notice |
| **4.2 Ack-request aggregate** | `message_acknowledgment_request` + events (see [`02` §4–5](./02-architecture-and-domain.md#5-state-machines)); `POST /escalations`, `/acknowledge`, `/reassign`, `/resolve`; acknowledgment requires an explicit authenticated action by a qualified role (aide = receipt only) | Open/read never acknowledges; unqualified user cannot acknowledge; every transition audited with actor |
| **4.3 EscalationRouter seam (M36→M19)** | M36 asks M19 "who is on call for role R at time T for patient P and what is tier n+1?"; M19 answers from roster/tier config; M36 owns timers + state. If M19 lacks a field, extend M19's seam (ADR) — no parallel roster | Shift-boundary and time-zone cases correct (evaluated with the schedule's zone, not server zone) |
| **4.4 Durable timers & backup routing** | BullMQ job per `(request_id, tier)` with deduplication; on deadline → mark overdue → route to next tier → new delivery; restart-safe; DLQ audited | Kill worker mid-timer → exactly one escalation after recovery; duplicate job → no duplicate incident |
| **4.5 Delivery-failure handling** | Subscribe to `m36.delivery_failed`; failed primary route triggers next channel immediately (not only at deadline); all-routes-failed → `failed_unreachable` → supervisor work item + ops page | Simulated push+SMS outage produces an actionable supervisor item within the configured window |
| **4.6 Notification policy** | Urgency-based channel policy; quiet hours can **never** suppress designated safety-critical routes (tighten-only, platform floor); per-user preferences otherwise honoured; shift awareness from M17/M19 | Quiet-hours test: routine suppressed, designated urgent still delivered |
| **4.7 Lock-screen privacy** | Push/SMS/email templates carry no patient identifiers or PHI; deep link requires authenticated session; template tests | Snapshot test over every template: no name/MRN/diagnosis/free text |
| **4.8 Web/PWA push + deep links** | Existing VAPID web-push; deep link `/messages/:channel?m=:id` opens the right thread/ack card after auth; native FCM/APNs stays a later dispatcher | Cold-start deep link lands on the ack card |
| **4.9 Unacknowledged-urgent queue** | `GET /escalations/unacknowledged` + supervisor screen; ops dashboard/alerts on overdue count and ack latency | Supervisor sees every pending/overdue item in their scope; none hidden by filters |
| **4.10 Reminders & snooze** | Snooze non-urgent only; urgent cannot be snoozed past deadline; unread digest (P2) | Snooze on urgent rejected |
| **4.11 Fallback runbook + drills** | `docs/runbooks/messaging-escalation-fallback.md`: telephone tree, who calls whom when push fails; quarterly drill checklist | Tabletop + live drill recorded as evidence |

### Acknowledgment deadline policy (decision D4)

Per-urgency defaults; each tenant may **shorten** any value but never exceed the platform maximum (same tighten-only rule as alert routing,
enforced by DB trigger, every change audited). Tier timing is read from M19's escalation configuration where it defines one — M36 does not keep a
second copy. **These numbers are proposed defaults; the clinical lead must sign them off before Phase 4 ships.**

| Urgency | Initial ack deadline (default) | Platform max | Next tiers | First delivery |
|---|---|---|---|---|
| Important | 60 min | 120 min | each tier gets half the previous window (30, 15 …), floor 5 min | in-app + push |
| Urgent | 15 min | 30 min | 7 → 5 → 5 min (floor 5) | in-app + push, SMS (no PHI) after 5 min with no open |
| Critical symptom | 5 min | 10 min | 3 → 2 → 2 min | all configured channels **at once**, voice allowed per M36 rule, supervisor copied at tier 2 |

Rules: quiet hours never delay Urgent/Critical; a reassign restarts the window for the new assignee but keeps the original `requested_at` for
reporting; a tenant cannot disable Critical escalation; `failed_unreachable` fires when tiers are exhausted or every route to the current tier
failed. Acknowledge-eligible roles follow the matrix in [`05`](./05-clinical-workflows-and-safety.md#2-authorization-matrix) (aide = receipt only).

**Phase 4 gate:** all six acceptance tests from the source spec (ack ≠ open, overdue→backup w/o duplicates, quiet-hours can't suppress safety
routes, no PHI on lock screen, unreachable→fallback event, shift/time-zone correctness) plus a chaos run (queue, push vendor, DB failover).

---

## Phase 5 — Mobile, lifecycle & governance (4–6 weeks)

| WP | Scope | Acceptance |
|---|---|---|
| **5.1 Offline drafts & optimistic send** | IndexedDB encrypted-at-rest-by-session queue; states `draft → sending → sent | failed(retry)`; reuse `client_message_id`; **never** show offline as delivered | Airplane-mode send shows "Not sent", retries on reconnect, no duplicate |
| **5.2 Reconnect sync** | Cursor-based delta on resume; reconcile read state, drafts, pending ack cards | Soak test with flapping network: no gaps/duplicates |
| **5.3 Camera attachment** | `<input capture>` / media capture → same scan pipeline; EXIF stripped; size limits | Photo from phone passes scan, appears only after `clean` |
| **5.4 Responsive/touch & accessibility** | Tablet/phone layouts; slide-over context; 44 px targets; WCAG 2.2 AA (keyboard, SR labels, focus order, contrast, 200% text) | axe + manual SR script + keyboard script recorded as evidence |
| **5.5 Session & device controls** | List/revoke devices; push endpoint ↔ session link; revoke kills socket and endpoint | Revoked session: next REST 401, socket closed, push endpoint expired |
| **5.6 Retention & legal hold for messages** | ADR; overlay table (ADR-0051 pattern); retention scan honours holds; destruction certificates via M4 | Held message survives scan; release restores eligibility; audit shows both |
| **5.7 Export (restricted)** | `export_job`: scoped, approver required, encrypted artefact, expiring link, audited; default role set cannot export | Unapproved export blocked; artefact auto-expires |
| **5.8 Break-glass** | Justification + time limit + automatic post-review queue for compliance; scope = a channel/patient | Grant expires; every read under grant audited and queued |
| **5.9 Workforce offboarding (full)** | Reassign owned tasks/escalations/handoffs, expire devices, keep attribution | Workflow F in [`05`](./05-clinical-workflows-and-safety.md) passes end-to-end |
| **5.10 Recovery rehearsal** | Restore DB + object store into a private cluster; reconcile message ↔ attachment ↔ audit | Documented RPO/RTO met; mismatches reported |

**Phase 5 gate:** offline-never-falsely-delivered, session-revocation, legal-hold, export-authorized, accessibility and offboarding tests pass.

---

## Phase 6 — Advanced capabilities (5–8 weeks, optional, per-tenant flags)

| WP | Scope | Guardrails |
|---|---|---|
| **6.1 Smart work inbox** | Unified queue: unacknowledged urgent, assigned tasks, handoffs awaiting me, mentions, unread care-team | Ranking is deterministic and explainable (no ML needed); urgent never buried |
| **6.2 Response analytics** | Ack latency, escalation rate, handoff acceptance time, per-discipline response (cross-discipline metrics) via M33 | Aggregates only; no content; access-controlled; not used for individual discipline without HR/compliance review |
| **6.3 Voice notes + dictation** | Recording as an attachment (same scan/retention/audit); dictation via M32/browser speech with PHI boundary decided in ADR | Voice follows clinical-attachment rules; transcripts are drafts the user must send |
| **6.4 Multilingual UI & templates** | i18n keys for UI, template translations reviewed by a clinician; no machine translation of clinical content without flag | Missing translation falls back to English visibly |
| **6.5 AI summaries & drafting (M32)** | Thread summary with source-message citations and uncertainty; draft reply proposals | **AI cannot send, create an order, or write a chart record**; human must act; input limited to authorized thread; every call in `ai_interaction`; per-tenant flag; BAA-covered environment only |
| **6.6 External partners** | `external_share`: explicit, expiring, single-conversation scope for e.g. pharmacy/DME; partner identity via M31/M29 patterns; no PHI over out-of-band | Partner sees only shared conversations/resources; revocable instantly |

**Phase 6 gate:** the AI, partner-scope and voice-retention acceptance tests from the source spec, plus a clinical/compliance review of every AI capability.
