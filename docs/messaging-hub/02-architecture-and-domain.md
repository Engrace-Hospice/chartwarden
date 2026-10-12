# 02 — Architecture & Domain Design

> Part of the [Messaging Hub plan](./README.md). Everything here is a **proposal** to be ratified by Phase 0 and the ADRs in §8.
> Table/column names are working names; the final Drizzle schema follows the three-column rule
> (`organization_id`, RLS keyed on `app.org_id`, FORCE) and ships with write-audit triggers.

## 1. Invariants (carry into every work package)

1. Every durable row belongs to exactly one tenant; authorization is server-side, never from a client-supplied org id.
2. Patient context is **read through seams from the owning module** (M5/M6/M7/M11/M13/M14/M17/M22). M36 stores *links*, not copies.
3. Messages are append-oriented: an edit creates a revision, a delete is a tombstone, a redaction is a separate audited act.
4. Every clinical escalation has persistent state, an accountable recipient, a deadline and a fallback path.
5. Orders, chart notes and care-plan changes happen only in their owning module's authenticated workflow.
6. **Delivery ≠ push-sent ≠ read ≠ acknowledged.** Four distinct records; the UI and reports never conflate them.
7. External services and AI receive only explicitly authorized data, through the existing PHI sanitiser / M32 gateway.
8. Every consumer is idempotent and tolerates out-of-order events; replay creates no duplicate message, task or escalation.
9. Messaging is never the sole emergency path; critical symptoms follow the agency's telephone/emergency procedure.

## 2. Bounded contexts and ownership

| Context | Owner module | Owns | Does **not** own |
|---|---|---|---|
| Conversations | **M36** | channels, members, messages, revisions, reactions, pins, drafts, attachment *references* | patient demographics, document bytes |
| Clinical context | **M36 (links) / source modules (truth)** | `clinical_link` rows | any clinical source record |
| Care coordination | **M36** | handoffs, communication tasks, chart-promotion *requests* | orders (M11), notes (M8), care plans (M7), IDG meeting state (M14) |
| Escalation | **M36 (request + ack state) / M19 (who/when, tiers, roster)** | acknowledgment requests, ack events | on-call schedule, triage protocol, tier definitions |
| Notifications | **M36** (existing) | preferences, endpoints, deliveries, rules | message content as source of truth |
| Governance | **M4 (audit, holds) / M36 (message hooks)** | export jobs, redaction records, break-glass grants (via M3/M4) | general chart |
| Collaboration | **M36** | templates, saved replies, polls, announcements | care-plan approval |
| Intelligence | **M32 (platform) / M36 (flag + UI)** | AI interaction log for messaging | models, prompts, cost |

**Anti-duplication rules** (reviewers enforce):

- No second on-call table or schedule. Use `OnCallProvider` / M19 roster. If M36 needs a missing field, change M19 through its seam.
- No second action-item system. Phase 0 compares `communication_task` with M14 `action_item`; default is a thin M36 task row that
  **references** its source record and, when the source is an IDG item, delegates lifecycle to M14.
- No second document store. Files are M22 documents; M36 holds `documentRef`.
- No second fan-out. Urgent delivery uses the existing alert dispatch (catalog-validated, sanitised).

## 3. Target topology

```
Web / Mobile (PWA)
  Inbox · Conversation · Patient Context · Handoffs · Safety Queue
        │  REST (/api/v1/messaging/*)            ▲ realtime (authorised rooms)
        ▼                                         │
Fastify: auth → requirePermission → requireAbac → TypeBox → handler
        │
 ┌──────┴──────────────────────────────────────────────────────────────┐
 │ M36 services                                                        │
 │  conversation · message · attachment-ref · search · draft/schedule  │
 │  clinical-link · handoff · comm-task · promotion · ack-request      │
 └──────┬──────────────────────────────────────────────────────────────┘
        │ one tx: row + audit + outbox event
        ▼
 PostgreSQL (RLS) ── outbox relay ── BullMQ (Valkey) workers
                                         ├─ alert fan-out → in-app/push/SMS/email/voice (existing)
                                         ├─ ack-deadline timers → EscalationRouter seam → M19
                                         ├─ scheduled-send, retention, hash-verify (existing/extended)
                                         └─ search indexer
 seams ⇄ M5 · M6 · M7 · M8 · M11 · M13 · M14 · M17 · M19 · M22 · M32 · M39
```

## 4. Proposed schema additions (by phase)

All tables: `organization_id NOT NULL`, RLS + FORCE (`app.org_id`), PHI write-audit trigger, org-composite indexes, FKs index-covered
(`test:fk-indexes:live`). Bodies that may contain PHI are envelope-encrypted like `message.body_cipher`.

### Phase 1
| Table | Purpose | Key columns |
|---|---|---|
| `message` (alter) | idempotency, urgency, schedule | `client_message_id uuid`, `urgency` (`routine/important/urgent`), `scheduled_for`, unique `(organization_id, author_user_id, client_message_id)` |
| `message_revision` | edit history | `message_id`, `revision_no`, `body_cipher`, `body_sha256`, `edited_by`, `created_at` — append-only grants |
| `message_attachment` (alter) | scan + state | `scan_state` (`pending/clean/quarantined`), `scanned_at`; delivery blocked unless `clean` |
| `attachment_access_event` | who opened which file | `attachment_id`, `user_id`, `action`, `occurred_at` |
| membership history | revoke audit | reuse `channel_member.removed_at` unless Phase 0 finds a gap |

### Phase 2
`message_reaction`, `message_pin`, `message_draft` (encrypted, unique per user+channel), `message_template` (+ tenant overlay, as
`notification_template`), search structures (see §6), `channel_poll` / `poll_vote` (non-clinical only; blocked on patient channels).

### Phase 3
| Table | Purpose |
|---|---|
| `clinical_link` | `(message_id, link_kind, source_module, source_id)`; kinds: `medication`, `order`, `care_plan`, `assessment`, `visit`, `document`, `idg_meeting`. Read-through; opening re-checks source-module permission |
| `communication_task` (+ `_event`) | `message_id`, `patient_id`, `assignee_id`, `due_at`, `status` (`open/accepted/done/cancelled`), `closed_reason` |
| `clinical_handoff` + `clinical_handoff_item` | `from_user_id`, `to_user_id`, `shift_ref` (M17), `state` (`draft/offered/accepted/declined/expired`), `accepted_at`; items link patients + open work |
| `chart_promotion_request` | `message_id`, `target_module`, `target_kind`, `status` (`proposed/accepted/rejected/superseded`), `result_ref` (id in the owning module), `requested_by`, `decided_by` |

### Phase 4
| Table | Purpose |
|---|---|
| `message_acknowledgment_request` | one per ack-required message: `message_id`, `patient_id`, `assigned_user_id`, `required_role`, `deadline_at`, `status` (`pending/acknowledged/escalated/resolved/cancelled/failed_unreachable`), `current_tier`, `resolved_at`, `resolution_note_ref` |
| `message_acknowledgment_event` | append-only: `requested`, `delivered`, `opened`, `acknowledged`, `overdue`, `escalated(tier)`, `reassigned`, `resolved`, `delivery_failed` |

### Phase 5
`export_job` (scope, requester, approver, expiry, encrypted artefact ref), `message_redaction` (who/why/approval),
device-session link to `delivery_endpoint` (revocation), messaging break-glass grant (reuse the M3/M4 grant pattern if it fits).

### Phase 6
`message_translation`, `ai_interaction` (prompt hash, source message ids, output hash, reviewer action), `external_share` (partner, scope, expiry).

## 5. State machines

**Message:** `scheduled → queued → sent → edited* → (deleted | redacted)`. `failed` is client-visible only until a retry succeeds.
`sent` rows are immutable except via revision / tombstone / redaction.

**Acknowledgment request** (the safety-critical one)
```
pending ──ack by qualified recipient──► acknowledged ──resolve──► resolved
   │ deadline passes                          │
   ▼                                          └─ reassign ─► pending (new assignee, new deadline)
escalated(tier n) ──ack──► acknowledged
   │ no tier left / all channels failed
   ▼
failed_unreachable  ──► supervisor work item + ops page (never silent)
```
Opening/reading never acknowledges; only an authenticated action by a user whose role qualifies does. Timers are durable jobs keyed on
`(request_id, tier)` so a restart or duplicate job cannot create a second escalation.

**Handoff:** `draft → offered → accepted | declined | expired`. On `expired`/`declined` accountability stays with `from_user_id` and the
configured supervisor is alerted.

**Communication task:** `open → accepted → done | cancelled`; closing a clinical-concern task requires a reason.

## 6. Search design (ADR required)

Bodies are encrypted at rest under tenant DEKs, so a plain DB index would either leak plaintext or be useless.

| Option | Pros | Cons |
|---|---|---|
| A. Decrypt-and-filter in app over an authorized candidate set (channel/time-bounded) | No plaintext index; ACL always current | Slow at scale; fine for in-conversation search |
| B. Per-tenant encrypted index (blind tokens / HMAC trigram) | Server-side, fast | Leaks token frequency; complexity |
| C. Plaintext `tsvector` table under same RLS | Fast, simple | Plaintext PHI beyond the cipher column; wider blast radius |

**Decision (D3): global search is required; use option B.** Sequence: (1) ship **A** for in-conversation search first (Phase 2.7a);
(2) build **B** as work package 2.7b after a design review covering: HMAC key per tenant derived from the tenant DEK hierarchy and rotated
with it; tokenisation (word + prefix n-grams; no raw trigram of short strings); padding/bucketing to blunt frequency leakage; no
phrase/proximity ranking server-side (rank client-side after decrypt); index entries deleted on redaction and tenant erasure; index rebuilt
from ciphertext by a resumable job. Whatever is chosen: candidate ids from the index are **re-filtered by current membership/patient access**
at query time, bodies are decrypted only after that check, and every result page writes a read audit. Known limit: B supports whole-word and
prefix queries, not arbitrary substring — state this in the UI.

## 7. API additions (prefix `/api/v1/messaging`; idempotency + audit + TypeBox on all)

| Phase | Route | Notes |
|---|---|---|
| 1 | `POST /channels/:id/messages` (extend) | `clientMessageId` required; replay returns the original message |
| 1 | `POST /attachments/uploads`, `POST /attachments/:id/complete` | delegates to M22; scan before visibility |
| 1 | `GET /channels/:id/messages?after=` | reconnect reconciliation by cursor |
| 2 | `PUT /drafts/:channelId` · `GET /search` · `POST /messages/:id/{reactions,pins}` · `PATCH /messages/:id` (revision) | |
| 3 | `POST /messages/:id/links` · `POST /messages/:id/tasks` · `POST /handoffs` · `POST /handoffs/:id/{accept,decline}` · `POST /messages/:id/chart-promotions` · `GET /patients/:id/context` | context is a **projection** assembled via seams |
| 4 | `POST /escalations` · `POST /escalations/:id/{acknowledge,reassign,resolve}` · `GET /escalations/unacknowledged` | |
| 5 | `POST /exports` · `POST /messages/:id/redact` · `POST /break-glass` · `GET/DELETE /devices` | |

Each new route registers a permission key in M3, gets OpenAPI enrichment, and passes `arch:error-envelope`, `arch:route-reachability`,
`arch:abac-predicates` / `arch:abac-composed`, `arch:openapi-coverage` and `client:check`.

## 8. ADRs to write before the phases that need them

| Proposed ADR | Decides | Needed before |
|---|---|---|
| Realtime transport ([ADR-0054](../adr/ADR-0054-realtime-transport-socketio-valkey.md), Accepted) | Socket.IO vs native WS/SSE; auth handshake; room recompute on `permissions.changed`; reconnect protocol; scale-out via Valkey | Phase 1 |
| Message revisions & redaction ([ADR-0055](../adr/ADR-0055-message-revisions-and-redaction.md), Proposed) | Revision table, who may redact, interaction with retained cipher and legal hold | Phase 1 |
| Clinical acknowledgment vs receipts ([ADR-0056](../adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md), Proposed) | New `message_acknowledgment_*` aggregate; fate of `message_receipt.ack` | Phase 4 (draft in Phase 0) |
| Escalation ownership (M36↔M19) ([ADR-0057](../adr/ADR-0057-escalation-ownership-m19-m36.md), Proposed) | `EscalationRouter` seam; tiers/rosters stay in M19; M36 holds request/ack state | Phase 4 |
| Messaging search ([ADR-0058](../adr/ADR-0058-messaging-global-search-blind-token-index.md), Proposed) | §6 | Phase 2 |
| Chart promotion | Per-target contracts (M8 note, M7 proposal, M14 item); never orders | Phase 3 |
| Messaging legal hold & retention | Overlay pattern (ADR-0051) applied to `message`; retention-scan behaviour | Phase 5 (earlier if the scan is live) |
| AI in messaging | Allowed M32 capabilities, human-in-the-loop rules, PHI boundary | Phase 6 |

Take the next free ordinals on `main` when writing (last is ADR-0058 on this branch; ADR-0054…0058 are the five above); `check-adr-docs` enforces index parity.

## 9. Events (outbox, catalog-registered, `m36.` prefix, idempotent consumers)

`m36.message.sent.v1`, `m36.message.revised.v1`, `m36.attachment.cleared.v1`, `m36.attachment.quarantined.v1`,
`m36.ack_request.created.v1`, `.acknowledged.v1`, `.overdue.v1`, `.failed_unreachable.v1`, `m36.handoff.offered.v1`,
`m36.handoff.accepted.v1`, `m36.task.created.v1`, `m36.promotion.requested.v1`, `m36.membership.revoked.v1`.

**Inbound** (bind, then prove with `arch:outbox-bindings` **and** a grep of `apps/backend/src/index.ts` for the factory — bound is not
computing): patient discharge/death (M5/M6), care-team change (M5/M17), on-call roster change (M19), employment ended / role change
(M2/M3), order/medication state change (M11/M13, for link freshness), IDG meeting lifecycle (M14).

Envelope: `event_id, event_type, schema_version, organization_id, aggregate_id, aggregate_version, occurred_at, correlation_id, payload`.
The WebSocket is a *delivery mechanism*; the DB + outbox are the source of truth, and reconnect always reconciles from a DB cursor.

## 10. Authorization model

RBAC keys (M3) + ABAC predicates, composed per route. Administrators get **no implicit** access to patient conversations. Full matrix in
[`05`](./05-clinical-workflows-and-safety.md#2-authorization-matrix). A new predicate must be *composed* by a `requireAbac` or listed (with
a reason) in `scripts/abac-uncomposed-allowlist.ts` — never register a control that exists on paper only.
