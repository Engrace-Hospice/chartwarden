# M36 Secure Messaging & Alerts — STRIDE, DR tier & Integration inventory (M36-T10)

Captures the three non-code M36-T10 deliverables that have no gate of their own: the §4.10 STRIDE
threat model (SEC-007 / M36-F09), the disaster-recovery tier, and the integration inventory. The
authoritative text is the module spec (`docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md`);
this file is the in-repo pointer that travels with the code and names where each control lives.

## STRIDE threat model (spec §4.10)

M36 is the platform's realtime nervous system — it routes PHI-adjacent alerts, manages multi-tenant
channel membership, and exposes inbound vendor webhooks. Ten threats across S/T/R/I/D/E; each control
already lives in code or in a sibling task.

| # | Class | Threat | Control (where it lives) |
|---|---|---|---|
| S-1 | Spoofing | Forged Twilio/Postmark webhook | §4.9 replay window + signature/IP-allowlist — `packages/messaging/src/webhooks` (`assertReplayWindow`, `verifyTwilioSignature`, `verifyPostmarkWebhook`); enforced in `routes/webhook-routes.ts` before any handler logic |
| S-2 | Spoofing | Cross-tenant DM | `channel` RLS on `app.org_id` (migration 0017) + within-tenant DM validation in the route service |
| T-1 | Tampering | `body_cipher` replacement | `body_sha256` + `messaging.hash_verify` nightly job (`jobs/integrity-jobs.ts` `runHashVerifyForOrg`, scheduled by `jobs/integrity-workers.ts`); M4 write-audit trigger on `message` |
| T-2 | Tampering | `channel_member` tampering | M4 write-audit trigger (compliance-class) on `channel_member`; `canViewChannel` (active-membership check) at read time |
| T-3 | Tampering | Alert-rule loosening | `enforce_alert_routing_tighten_only` DB trigger (migration 0017); additive-only override columns |
| R-1 | Repudiation | Author denies send/delete | M4 write-audit trigger on `message` (sent/edited/tombstone); `body_sha256` anchors plaintext |
| I-1 | Info disclosure | PHI in out-of-band payload | `sanitizeForOutOfBand` is the only path out-of-band (`notification/`); §7.2 golden test; dependency-cruiser blocks direct vendor calls |
| I-2 | Info disclosure | Presence enumeration | `presence_self_or_coworker` RLS; Socket.IO rooms computed from `channel_member` at connect (`realtime/computeRoomSet`) |
| D-1 | DoS | Alert-suppression flood | API-gateway rate limit; separate BullMQ queues w/ fixed concurrency; `system_locked` SOS at `priority: 10` (`jobs` queue params) |
| D-2 | DoS | Webhook replay flood | Replay window + idempotency on `vendor_message_id`; webhook handler enqueues and returns 200 (`jobs`/webhook routes) |
| E-1 | EoP | Break out of `care_team` ABAC | The shared effective-access policy used by `listChannels` and `canViewChannel` (`messaging-route-service-db.ts`): active organization membership, an active `channel_member` row, plus — for a `care_team` channel and an `auto` member — a live `CareTeamProvider.careTeamMembers` roster check (GAP-104; `manual` admin-override members are authorized by the override itself). Channel detail/history/send routes compose `canViewChannel`; RLS remains the tenant backstop. There is NO direct M5 schema import and no M3 `evaluate('caseload_membership')` call. |
| E-2 | EoP | Disable a `system_locked` rule | `alert_rule_update` RLS `WITH CHECK (system_locked = false)` (migration 0017); §7.4 invariant test |

### SBAR messages (WP 3.3, ADR-0060)

The SBAR threats below are scoped to the `messaging.sbar` flow. The controls are in the files named, and they are
built on `feat/m36-wp33-sbar` and not yet merged.

| # | Class | Threat | Control (where it lives) |
|---|---|---|---|
| I-3 | Info disclosure | PHI in SBAR sections leaks beyond the message (previews, search, notifications, logs, audit) | The `sbar` node lives inside the encrypted rich body (`body_cipher`, `body_sha256`), so there is no new column or PHI store. Previews, search and notifications see only the fixed plain-text projection (`SBAR_SECTION_LABELS`), which is the same exposure as an ordinary body. Audit and error responses carry field and code only: `SBAR_INVALID` never echoes section text. Structure is checked by the sanitiser in `packages/types/src/messaging-rich-body.ts` and lengths by `validateSbar` in `packages/types/src/messaging-sbar.ts`. |
| T-4 | Tampering | Hint text injection: a tenant or a crafted hint carries markup, a fake instruction, or an emergency-looking claim into the composer | Tenant hint text is plain text only. It is linted with `lintTemplateText` on save and on read, and falls back to the platform hint when the lint fails. The hint is never projected into the body, so it cannot become part of the stored message. The static fallback is the platform hint text, which is fixed. |
| E-3 | EoP | Tenant loosening: a tenant lowers a section minimum or disables SBAR to weaken a clinical structure | `tenant_sbar_policy` is tighten-only. The DB CHECK sets the platform floor (`situation_min_chars BETWEEN 1 AND 500`, and the same for each section). `effectiveSbarPolicy(stored)` takes the larger minimum and ORs the booleans on every read, so a stored lower value cannot win. A write below the floor returns `422 SBAR_POLICY_FLOOR_VIOLATION`. There is no disable column, and the ops flag `messaging.sbar` is the only off switch. Policy edits require `messaging.template.manage`. Live proof: a raised floor beats a stored lower value (`m36-sbar.live.test.ts`). |
| E-4 | EoP | Urgency mistaken for escalation: a sender marks `urgent` and believes that someone is paged, or a reader treats the label as an alarm | `urgencyHint` is a sender-marked label only. It has no column, alert, notification, acknowledgment or event. The form always shows that messaging is not the emergency path, and it adds that marking urgent does not page or escalate anyone. The static test `m36-sbar-no-escalation.test.ts` fails the build if any M36 code outside the codec and validator reads `urgencyHint`. Mapping urgency to escalation is Phase 4 work under ADR-0057. |

### Communication tasks (WP 3.4, ADR-0061)

The task threats below are scoped to the `messaging.tasks` flow. The controls are designed in ADR-0061 and are being
built on `feat/m36-wp34-tasks`; the live suite (`m36-tasks.live.test.ts`) passes on a private container.

| # | Class | Threat | Control (where it lives) |
|---|---|---|---|
| I-5 | Info disclosure | Assignment as a side door: a user assigns a task to someone who cannot read the message, or a task keeps showing a message after access is lost | The assignee must be an active user who passes `canViewChannel` (including the Part 2 gate) at create and at reassign, else the uniform `422 TASK_ASSIGNEE_INVALID`. Visibility is checked again on every read and action, and only the creator or assignee can see a task, including on a replay of a convert (anyone else gets a generic `409 TASK_ASSIGNEE_ALREADY_HAS_ACTIVE` with no body). Accepted: no per-user alert throttle on convert; a self-reassign still sends the generic alert; the list limit applies before the visibility filter; a participant removed from the channel other than by offboarding keeps an active task hidden from them. The row has no title and no text, so it holds no message content; the message is read through the conversation. The alert text is fixed and generic, and the consumer re-checks channel access before it emits. |
| I-6 | Info disclosure | The open-tasks tile or the list acts as an existence oracle: it shows that clinical concerns exist in conversations the viewer cannot read | The tile counts only the caller's own active tasks (assigned or created) on channels the caller can see, and is dropped when the flag is off. The patient-context guard is unchanged (`patient.read` plus caseload or scope, break-glass not honoured). Missing, not a participant, hidden channel and deleted message all return the same 404. |
| T-5 | Tampering | Dismissing a clinical concern: a task about a patient is closed without anyone acting on it | A patient task is always clinical (`patient_id` is server-derived and a CHECK ties it to `clinical_concern`). A clinical task cannot move to `done` or `cancelled` without a closing reason code (service check, `422 TASK_CLOSE_REASON_REQUIRED`, and a database CHECK that holds against raw SQL). The reason is recorded and audited. A reason such as `no_action_needed` is allowed and is not judged (accepted limit). |
| T-6 | Tampering | Rewriting task history or protected fields | `wardenx_app` has column-level UPDATE only on the changing columns, so `patient_id`, `created_by` and `message_id` cannot be rewritten. The event table is append-only (no UPDATE, no DELETE). No DELETE on either table for the app role. Write-audit triggers on both tables, with `patient_id` scrubbed. |
| R-2 | Repudiation | A duplicate or retried request creates two tasks, or a person denies having closed one | A partial unique index allows one active task per message and assignee, and a replay changes nothing and writes no event. Every move writes an event with the actor (a user, or the system actor for offboarding). A trigger refuses any update of a closed task, even via raw SQL. |
| D-3 | DoS / safety | An orphan task: the assignee is revoked or deactivated and an urgent item has no owner | The access-revocation consumer calls `reassignTasksForLeaver` on `m2.membership.revoked` and `m2.user.deactivated`. It picks the creator, then a care-team member, else flags `needs_owner` and alerts the creator. The realtime disconnect runs before, and even if, the reassignment fails (the failure is then rethrown for a retry and logged with ids only). It runs without the feature flag, converges on redelivery, and a failure on one task does not stop the others. Gap: if the creator and the assignee both lost access or left, the task stays flagged with no organisation-level view until the Phase 4 ownership model (ADR-0057). |
| E-5 | EoP | Tasks mistaken for escalation: a user believes an assignment pages someone, or an overdue task is treated as an alarm | There is no paging, timer, escalation or auto-close; overdue is a display state only. The convert dialog and the list always say that tasks do not page anyone and are not for emergencies. Mapping tasks to escalation is Phase 4 work under ADR-0057. |
| E-6 | EoP | A cross-module write: M36 task code reaches into M14 action items | A static test fails the build if code under `tasks/` imports `14-idg` or `@wardenx/idg` or names `idg_action_item`. Delegation to M14 is a reserved extension that needs a new M14 seam (ADR-0061, decision 2). |

**Sign-off gate (spec §4.10):** Security Officer (S-1, S-2, I-1, I-2, E-1, E-2); Compliance Officer
(T-1, T-2, R-1); Platform team (D-1, D-2) — a PR-merge gate on changes to `packages/messaging/`,
`packages/messaging/notification/`, or the M36 migrations.

## Disaster-recovery tier

**SOS field-safety voice escalation is the platform's single Tier-1 dependency** (architecture /
integrations §6.13; spec §7.7). Tier-1 = life-safety: the `messaging.send_voice` queue runs at
`priority: 10`, and on three failed voice attempts the `field_safety.escalated` system alert fires,
supervisor SMS+push are escalated explicitly, and WardenX ops are paged (spec §4.4 voice queue row).
The **in-app Socket.IO floor** is the always-available delivery path — no external vendor outage can
prevent an alert reaching a connected client (spec §2.4 invariant 1). All other channels (push, SMS,
email) are additive and degrade to `partial` outcomes without blocking the dispatch.

## Integration inventory (spec §4.9, INT-016 / SD-056; manifest `VENDOR_ADAPTERS`)

| Vendor | Use | BAA | Adapter (confined per manifest) | Inbound webhook security |
|---|---|---|---|---|
| Twilio SMS | out-of-band SMS alerts; STOP/START/HELP opt-out (M36-F07) | yes | `packages/messaging` | HMAC-SHA1 `X-Twilio-Signature` + 5-min replay window |
| Twilio Voice | SOS-only Tier-1 escalation | yes | `packages/messaging` | (outbound) idempotent on `notification_delivery.id` |
| Postmark | out-of-band email alerts | yes | `packages/messaging` | DNS IP-allowlist **and** bearer token (both required) + replay window |
| web-push (VAPID) | PWA push | n/a | `packages/messaging` | (outbound) prune endpoint on 404/410 |

The vendor SDKs are codePath-confined to `packages/messaging` (manifest `VENDOR_ADAPTERS`); a
dependency-cruiser rule (architecture §25.15) blocks any import of `twilio` / `postmark` / `web-push`
outside that package, and the §4.7 sanitizer is the only path that hands a payload to a dispatcher.
