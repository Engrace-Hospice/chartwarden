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
| T-1 | Tampering | `body_cipher` replacement | `body_sha256` + `messaging.hash_verify` nightly job (`jobs/runHashVerify`); M4 write-audit trigger on `message` |
| T-2 | Tampering | `channel_member` tampering | M4 write-audit trigger (compliance-class) on `channel_member`; `canViewChannel` (active-membership check) at read time |
| T-3 | Tampering | Alert-rule loosening | `enforce_alert_routing_tighten_only` DB trigger (migration 0017); additive-only override columns |
| R-1 | Repudiation | Author denies send/delete | M4 write-audit trigger on `message` (sent/edited/tombstone); `body_sha256` anchors plaintext |
| I-1 | Info disclosure | PHI in out-of-band payload | `sanitizeForOutOfBand` is the only path out-of-band (`notification/`); §7.2 golden test; dependency-cruiser blocks direct vendor calls |
| I-2 | Info disclosure | Presence enumeration | `presence_self_or_coworker` RLS; Socket.IO rooms computed from `channel_member` at connect (`realtime/computeRoomSet`) |
| D-1 | DoS | Alert-suppression flood | API-gateway rate limit; separate BullMQ queues w/ fixed concurrency; `system_locked` SOS at `priority: 10` (`jobs` queue params) |
| D-2 | DoS | Webhook replay flood | Replay window + idempotency on `vendor_message_id`; webhook handler enqueues and returns 200 (`jobs`/webhook routes) |
| E-1 | EoP | Break out of `care_team` ABAC | `canViewChannel` (`messaging-route-service-db.ts`): active `channel_member` row, plus — for a `care_team` channel and an `auto` member — a live `CareTeamProvider.careTeamMembers` roster check (GAP-104; `manual` admin-override members are authorized by the override itself). There is NO `assertChannelVisible` and no M3 `evaluate('caseload_membership')` call. RLS + connect-path `channel_member` second gate |
| E-2 | EoP | Disable a `system_locked` rule | `alert_rule_update` RLS `WITH CHECK (system_locked = false)` (migration 0017); §7.4 invariant test |

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
