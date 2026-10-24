# 08 — Capability Register (88 capabilities)

> Part of the [Messaging Hub plan](./README.md). Columns: **Pri** (P0 foundational · P1 essential for mature launch · P2 later) ·
> **Ph** target phase · **Ctx** bounded context (CONV conversations · CLIN clinical context · COORD care coordination · ESC escalation ·
> NOTIF notifications · GOV governance · COLLAB collaboration · AI intelligence · UX client) · **WP** work package ·
> **Status** is the Phase 0 baseline: `have` (as built), `part` (partially/unverified), `new`.
> Priorities are from the product brief; phases adjust where a dependency forces earlier delivery (noted).

## Messaging essentials (14)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| ME-01 | Rich-text formatting | P1 | 2 | CONV | 2.1 | new (markdown kind exists) |
| ME-02 | File & image attachments | P0 | 1 | CONV | 1.5 | part (schema + M22 ref) |
| ME-03 | Voice notes | P2 | 6 | CONV | 6.3 | new |
| ME-04 | Reply to message / threads | P1 | 2 | CONV | 2.2 | part (columns; same-channel guard done) |
| ME-05 | Edit with history; controlled deletion | P1 | 1 | CONV | 1.3 | part (edit/tombstone, no revisions) |
| ME-06 | Reactions & emojis | P2 | 2 | COLLAB | 2.4 | new |
| ME-07 | @mentions | P1 | 2 | CONV | 2.3 | part (refs exist) |
| ME-08 | Pinned messages | P1 | 2 | CONV | 2.4 | new |
| ME-09 | Draft autosave | P1 | 2 | CONV | 2.5 | new |
| ME-10 | Scheduled messages | P2 | 2 | CONV | 2.6 | new |
| ME-11 | Delivery & read receipts | P1 | 1 | CONV | 1.6 | part (receipts) |
| ME-12 | Typing & online indicators | P2 | 2 | CONV | 2.12 | part (presence table) |
| ME-13 | Search inside conversation (+ global search, D3) | P1 | 2 | CONV | 2.7a, 2.7b | new |
| ME-14 | Keyboard shortcuts | P1 | 2 | UX | 2.1/2.11 | new |

## Clinical communication (12)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| CC-01 | Patient-linked conversations | P0 | — | CONV | — | have (`care_team`) |
| CC-02 | Structured patient context panel | P0 | 3 | CLIN | 3.1 | new |
| CC-03 | Urgent clinical message flag | P0 | 4 | ESC | 4.1 | new (alert severity exists, not message urgency) |
| CC-04 | Acknowledgment required | P0 | 4 | ESC | 4.2 | new (`ack` receipt ≠ clinical ack) |
| CC-05 | Escalation & backup routing | P0 | 4 | ESC | 4.3–4.4 | part (M19 tiers; no message link) |
| CC-06 | On-call schedule integration | P0 | 4 | ESC | 4.3 | part (`on_call` channel via M19) |
| CC-07 | Secure clinical handoffs | P1 | 3 | COORD | 3.5 | new |
| CC-08 | SBAR message templates | P1 | 3 | COLLAB | 3.3 | new |
| CC-09 | Medication/order context links | P1 | 3 | CLIN | 3.2, 3.10 | new |
| CC-10 | Convert message into task | P1 | 3 | COORD | 3.4 | new |
| CC-11 | IDG discussion & follow-up | P1 | 3 | COORD | 3.6 | new |
| CC-12 | Document clinically relevant communication | P0 | 3 | COORD | 3.7 | new (earlier than P3 only for design) |

## Team collaboration (10)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| TC-01 | Role-based care teams | P0 | — | CONV | 3.9 | have (auto membership) |
| TC-02 | Direct & group conversations | P0 | — | CONV | — | have (DM; group via manual — verify) |
| TC-03 | Team membership management | P0 | 1 | CONV | 1.4 | have (routes) / modify |
| TC-04 | Shift handover inbox | P1 | 3 | COORD | 3.5 | new |
| TC-05 | Assigned action items | P1 | 3 | COORD | 3.4 | new |
| TC-06 | Conversation owners | P1 | 2 | CONV | 2.9 | new |
| TC-07 | Department channels | P1 | 2 | CONV | 2.9 | part (`discipline`/`location`) |
| TC-08 | Announcements | P1 | — | COLLAB | 2.9 | have |
| TC-09 | Polls (non-clinical) | P2 | 2 | COLLAB | 2.10 | new |
| TC-10 | Saved replies & templates | P1 | 2 | COLLAB | 2.8 | new |

## Notifications & escalation (10)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| NE-01 | In-app notifications | P0 | — | NOTIF | — | have |
| NE-02 | Push notifications | P1 | 4 | NOTIF | 4.8 | have (web-push) / modify |
| NE-03 | Urgency-based notification policies | P0 | 4 | NOTIF | 4.6 | part (alert severity rules) |
| NE-04 | Quiet hours & shift awareness | P1 | 4 | NOTIF | 4.6 | part (quiet hours yes; shift awareness new) |
| NE-05 | Escalation timer & fallback | P0 | 4 | ESC | 4.4 | new |
| NE-06 | Unread digest | P2 | 4 | NOTIF | 4.10 | new |
| NE-07 | Reminder & snooze | P1 | 4 | NOTIF | 4.10 | new |
| NE-08 | Delivery failure handling | P0 | 4 | NOTIF | 4.5 | part (sweep/reconcile exist) |
| NE-09 | Notification preferences | P1 | — | NOTIF | — | have |
| NE-10 | No PHI in lock-screen previews | P0 | 4 | NOTIF | 4.7 | have (sanitiser) / prove |

## Patient & EHR integration (10)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| PE-01 | Open patient chart in context | P0 | 3 | CLIN | 3.1 | part (patient shortcut) |
| PE-02 | Linked assessments & visits | P1 | 3 | CLIN | 3.2 | new |
| PE-03 | Linked care plans | P1 | 3 | CLIN | 3.2 | new |
| PE-04 | Linked medications & orders | P1 | 3 | CLIN | 3.2 | new |
| PE-05 | Linked documents | P1 | 3 | CLIN | 3.2 | new |
| PE-06 | Clinical task creation | P1 | 3 | COORD | 3.4 | new |
| PE-07 | Communication timeline | P0 | 3 | CLIN | 3.1 | new |
| PE-08 | Discharge/death lifecycle rules | P0 | 3 | COORD | 3.8 | part (auto-archive on discharge) |
| PE-09 | Role & assignment synchronization | P0 | 3 | CONV | 3.9 | part (channel_sync) |
| PE-10 | Structured audit export | P1 | 5 | GOV | 5.7 | new |

## Security & governance (12)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| SG-01 | Tenant & patient access controls | P0 | 1 | GOV | 1.7 | have / prove |
| SG-02 | Server-side authorization checks | P0 | 1 | GOV | 1.7 | have / prove |
| SG-03 | Audit logging | P0 | 1 | GOV | 1.8 | have; every table audited; read audit live-proven for the six listed content reads (WP 1.8); the care-team-channel POST read audit and admin/alert-deliveries are not live-proven |
| SG-04 | Encryption in transit & at rest | P0 | 1 | GOV | 1.8 | have (DEK envelope); parity audited (WP 1.8; plaintext endpoint/title exceptions recorded in 03) |
| SG-05 | Attachment malware scanning | P0 | 1 | GOV | 1.5 | new |
| SG-06 | Retention & legal hold | P0 | 5 | GOV | 5.6 | part (built (holds, overlay, scan, routes, screen, the destruction executor (off per tenant, dry run by default, never a held message), redaction (two-person mask), the thread and message legal-hold chip, staff names in 'placed by'); NOT built: attachment-object destruction on retention, the single-officer redaction fallback, a redaction web screen, compliance sign-off (ADR-0086, proposed); the scan stays plan-only) |
| SG-07 | Workforce offboarding | P0 | 1/5 | GOV | 1.4, 5.9 | built (WP 1.4 event-driven access cut and task/handoff sweeps; ADR-0084, proposed: officer preview and execute; on-call is advisory, second approver and auto-trigger open) |
| SG-08 | Break-glass access | P1 | 5 | GOV | 5.8 | part (platform pattern) |
| SG-09 | Secure file access & expiry | P0 | 1 | GOV | 1.5 | new |
| SG-10 | Data export restrictions | P1 | 5 | GOV | 5.7 | new |
| SG-11 | Message edit history | P0 | 1 | GOV | 1.3 | new |
| SG-12 | Session & device controls | P0 | 5 | GOV | 5.5 | built (ADR-0083, proposed; list/revoke, socket and endpoint kill; app lock and session policy open for SEC) |

## Mobile & accessibility (10)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| MA-01 | Responsive tablet/mobile layout | P0 | 2/5 | UX | 2.11, 5.4 | part |
| MA-02 | Accessible keyboard navigation | P0 | 2 | UX | 2.11 | part |
| MA-03 | Screen-reader labels | P0 | 2 | UX | 2.11 | part |
| MA-04 | High contrast & scalable text | P0 | 5 | UX | 5.4 | part |
| MA-05 | Optimistic send with retry | P1 | 5 | UX | 5.1 | new |
| MA-06 | Offline drafts | P1 | 5 | UX | 5.1 | new |
| MA-07 | Network reconnect & sync | P0 | 1 | UX | 1.1, 5.2 | new (polling today) |
| MA-08 | Mobile push & deep links | P1 | 4 | UX | 4.8 | part |
| MA-09 | Camera attachment capture | P1 | 5 | UX | 5.3 | new |
| MA-10 | Touch-friendly interactions | P0 | 5 | UX | 5.4 | part |

## Advanced workflows (10)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| AW-01 | Smart work inbox | P1 | 6 (basic queue in 3/4) | COORD | 6.1 | new |
| AW-02 | Clinical handoff templates | P1 | 3 | COLLAB | 3.5 | new |
| AW-03 | Response-time analytics | P2 | 6 | AI | 6.2 | new |
| AW-04 | Unacknowledged urgent queue | P0 | 4 | ESC | 4.9 | new |
| AW-05 | Cross-discipline collaboration metrics | P2 | 6 | AI | 6.2 | new |
| AW-06 | AI thread summaries | P2 | 6 | AI | 6.5 | new |
| AW-07 | AI message drafting | P2 | 6 | AI | 6.5 | new |
| AW-08 | Multilingual UI & templates | P2 | 6 | UX | 6.4 | new |
| AW-09 | Voice dictation | P2 | 6 | UX | 6.3 | new |
| AW-10 | Approved external partners | P2 | 6 | GOV | 6.6 | new |

## Proposed beyond the 88 (not counted above)
| ID | Capability | Pri | Ph | Ctx | WP | Status |
|---|---|---|---|---|---|---|
| X-6.10 | Third-party alarm ingest as alerts (watch only; never a response request, escalation or page; not a nurse-call replacement) | P3 | 6 | NOTIF | 6.10 | built flag-off (ADR-0101, Proposed); no customer need recorded |

**Total: 88** (14 + 12 + 10 + 10 + 10 + 12 + 10 + 10). Items marked "have / prove" exist per the M36 spec; Phase 0 must verify them in code and
attach test evidence before they are counted as done. Add `owner`, `test_ids`, `evidence_links` columns as work packages are cut.
