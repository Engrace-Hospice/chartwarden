# ADR-0073 — Notification policy: urgent request alerts get out-of-band routes from a platform floor that quiet hours, preferences and tenant rules can only add to, never remove or delay

- **Status:** **Accepted** (2026-10-18; decisions closed in the WP 4.6 blueprint). **The per-class channel floor, the "no vacation forwarding" reading and the deferred SMS step are PROVISIONAL: no clinical-lead sign-off is recorded** (`docs/messaging-hub/brief-clinical-lead-signoff.md`, section 8). The out-of-band routes ship behind a new ops flag, `messaging.notification_policy` (default off for every tenant), and also need the flag of the event's own family. ADR-0057 (shift data) stays Proposed: no M19 owner is named.
- **Date:** 2026-10-18
- **Phase:** Messaging Hub Phase 4 (WP 4.6, Notification policy).
- **Implements:** `docs/messaging-hub/04-phases-4-to-6.md` WP 4.6 ("quiet hours can never suppress designated safety-critical routes (tighten-only, platform floor); per-user preferences otherwise honoured; shift awareness from M17/M19") and the brief's rule "quiet hours never delay Urgent or Critical".
- **Extends:** [ADR-0068](ADR-0068-messaging-urgency-model.md) (urgency classes), [ADR-0069](ADR-0069-messaging-acknowledgment-request-aggregate.md) (ack classes), [ADR-0071](ADR-0071-messaging-delivery-failure-handling.md) (this WP is the first thing that creates the out-of-band rows WP 4.5 waits for). Reuses the M20-era engine in `packages/messaging/src/resolution` (`isWithinQuietHours`, `planFanOut`) instead of a second one.
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0057](ADR-0057-escalation-ownership-m19-m36.md).

## Context

`docs/messaging-hub/04-phases-4-to-6.md` WP 4.6. What exists, checked in the code:

- The fan-out planner (`resolution/fan-out.ts`) plans an `in_app` row for every recipient (the floor) and one row per out-of-band channel from the rule's `channels_override` or the recipient's `routing_map`. A recipient's quiet hours (`user_notification_preferences.quiet_hours`, in their own IANA zone) skip an out-of-band row as `skipped_quiet_hours` unless the alert's severity reaches the recipient's own `severityOverride` (default `critical`).
- **Every request alert (`urgent_sent`, `ack.requested`, `.reassigned`, `.escalated`) is emitted at severity `warn` and seeded `channelsOverride: ["in_app"]`.** So today (a) no urgent alert has an out-of-band route, and (b) if one were added by data it would be skipped by quiet hours, because `warn` is below the default override. The recipient's own preference could also have removed it (an empty routing map).
- The dispatcher resolves the recipient's newest VERIFIED endpoint at send time and fails the row (`no_verified_endpoint`) if there is none; the WP 4.5 consumer would then treat that as a failed route and, with `messaging.escalation_timers` on, escalate or mark the request `failed_unreachable`. Planning a route that cannot be delivered would therefore manufacture failures.
- `delivery_endpoint` is user-owned (RLS on `app.user_id`); the planner runs in an outbox consumer with no acting user.
- The M19 `EscalationRouter` answers "who is on call for role R, patient P, tier n"; it does not answer "is user U on shift now", and in production it is a deny-stub that answers `unavailable`. M17 exposes no seam to M36.
- No vendor transport is configured in any environment (`transport_not_configured`); this WP invents none.

## Decision

1. **Designated routes are a platform constant, not data.** `DESIGNATED_EVENT_TYPES` in `packages/messaging/src/resolution/notification-policy.ts` is exactly the four alerts that tell an ASSIGNEE about an urgent or acknowledgment-bound request. No tenant row can add to it or remove from it (a backend test pins it to the event constants). The sender's reminder and the supervisors' `ladder_exhausted` / `failed_unreachable` alerts are not designated (WP 4.5 does not count them as routes either).
2. **The platform floor is a frozen table by class.** `PLATFORM_CHANNEL_FLOOR`: `important` = push, `urgent` = push, `critical` = push + SMS (PROVISIONAL, brief section 8). Voice stays SOS-only (the existing rule). The class comes from the event's `ackClass` (added to the three ack alert payloads; `urgent_sent` is `urgent`). A designated alert whose class is missing or unreadable takes `urgent` and records `class_unreadable_defaulted`; it is never downgraded to "not designated".
3. **Tighten-only, stated once.** For a designated route the result is `floor(class) ∩ verified endpoints`, plus anything the recipient's routing map or the rule's `channels_override` ADDS (also limited to verified endpoints). Nothing removes a floor channel and nothing delays it: quiet hours and shift state are evaluated only to RECORD `quiet_hours_bypassed` / `off_shift_bypassed` in the trail; every planned row is `pending` at once. Vacation forwarding does not apply: the named assignee is the only target (a backup cannot acknowledge for them; absence is handled by the escalation timer). Property-tested over classes × endpoint sets × overrides × quiet-hours configs × shift states × instants (including both DST transitions).
4. **Verified endpoints only.** A channel is planned only if the recipient has a verified endpoint on it (voice rides on `sms`). An unverified, pending or absent endpoint yields no row and an `omitted` trail entry, never a row that is planned to fail. In-app is always planned (the existing floor).
5. **Everything else is the existing engine.** For a non-designated alert `decideChannels` returns what `planFanOut` returned before: routing map or rule override, skipped inside the recipient's quiet hours below their `severityOverride`, voice SOS-only, vacation forwarding. Quiet hours use the existing `isWithinQuietHours` (recipient IANA zone, `Intl` for DST; start inclusive, end exclusive; the instant is an argument). One addition: a recipient KNOWN to be off shift is treated as inside quiet hours (same override). **Shift state is `unknown` unless a seam answers, and unknown never suppresses.** No seam can answer today, so the code path is built and tested but not wired (see Deferred).
6. **A suppression is explainable.** A suppressed row carries a policy reason code in `notification_delivery.fail_reason` (`quiet_hours` or `off_shift`). A designated alert carries `policyTrail` on `alert.payload`: per recipient and channel, `planned | omitted` with reason codes (`designated_floor`, `designated_added`, `quiet_hours_bypassed`, `off_shift_bypassed`, `no_verified_endpoint`, `class_unreadable_defaulted`). Ids and codes only; no name, patient, message, endpoint value or time.
7. **Flags.** A new ops flag `messaging.notification_policy` (default off, absent = off). The policy acts for an event only when it AND the event's family flag are on for the tenant: `messaging.urgent_clinical` for `urgent_sent`, `messaging.ack_requests` for `m36.ack.*`. A flag read that throws makes the emit throw (the outbox retries); it never silently downgrades a safety route. All messaging flags stay off for every tenant. Why a flag at all: without it, turning on `urgent_clinical` would start paging the moment a transport is configured, before the clinical lead has accepted the floor (the false-assurance hazard of ADR-0068).
8. **Migration 1123: one SECURITY DEFINER reader.** `delivery_endpoint_verified_channels_for_org_users(org, user_ids jsonb)` returns `(user_id, channel)` for users with an ACTIVE membership in THAT tenant and a verified endpoint. It returns channel names only (never an endpoint value), is owned by `wardenx_admin`, revoked from PUBLIC and granted to `wardenx_app` only (the 0194 / 0355 pattern). No table, column or enum changes.
9. **The seeded rules stay in-app only.** The out-of-band routes come from code, so a tenant editing an `alert_rule` row (which can only tighten a locked rule anyway) can neither add nor remove the floor.

## Data model

Migration `1123_m36_notification_policy_endpoint_reader.sql`: the reader function only. Persisted facts reuse `notification_delivery.fail_reason` (suppressed rows) and `alert.payload.policyTrail` (designated alerts). No new enum value: an off-shift skip reuses `skipped_quiet_hours` with `fail_reason = 'off_shift'`.

## Alternatives considered

- **Add the channels to the seeded rules (`channelsOverride: ["in_app","push"]`).** Rejected: a rule is data (tenant-cloneable, and a locked rule can only be tightened by a tenant, but a cloned unlocked one can be replaced), quiet hours would still skip a `warn` push, and the preference could still drop it. The floor has to sit in code, below all three.
- **Raise the request alerts to `critical` so the recipient's `severityOverride` lets them through.** Rejected: severity is also the denormalized input of the voice SOS-only CHECK and the inbox ordering; and a recipient can set `severityOverride` to anything, so it is a preference, not a floor.
- **A tenant tightening table now.** Deferred (YAGNI until a tenant asks): the only tenant-writable input today is the rule's `channels_override`, and for a designated route it can only add.
- **Sequential fallback (push first, SMS after N minutes unopened).** Deferred: it needs a timer keyed on "unopened", and the brief's SMS step is a clinical decision still open. Today the floor is parallel, as ADR-0071 describes.
- **Plan the channel and let the dispatcher fail it when there is no endpoint.** Rejected: it would feed WP 4.5 false failures and, with the flag on, mark requests unreachable for people who simply never registered a phone.
- **Ask the router for shift state per user.** Rejected: the contract answers per (patient, role, tier), and widening M19's seam is the M19 owner's decision (ADR-0057).

## Consequences

- With the flags off (every tenant today) nothing changes; the in-app-only behaviour of ADR-0068..0071 is exactly as before.
- With a tenant's flags on and a recipient who registered a verified push endpoint, an urgent request now creates a `pending` push row. With **no vendor transport configured** (all environments today) the dispatcher settles it `failed` / `transport_not_configured`, and WP 4.5 (if `messaging.escalation_timers` is on) escalates or marks the request unreachable. That is the designed loud outcome, and the reason all three flags stay off until a real transport and the clinical sign-off exist.
- A recipient who registered nothing gets in-app only and an `omitted` trail entry: the policy cannot create a phone number.
- The trail on a designated alert is visible to the alert's recipient through the existing inbox payload; it holds their own id and codes only.

## Verification

Unit (`packages/messaging/__tests__/notification-policy.test.ts`): the acceptance (routine skipped with a reason, designated urgent delivered), the floor per class, additions only, no vacation forwarding, the enumerated tighten-only property (>10 000 combinations), the frozen table, class defaulting, unknown shift delivers, off-shift quiet, the recipient's severity override, the clock edges (midnight crossing, a zone that differs from UTC, spring-forward 2026-03-08 and fall-back 2026-11-01 in New York, both passes of the repeated hour) with fixed instants, the in-memory emitter wiring. Backend unit (`m36-notification-policy.test.ts`): designated set pinned to the event constants, seeded rules in-app only, flag gate, migration text. Live (`m36-notification-policy.live.test.ts`, `test:m36:notification-policy:live`, as `wardenx_app` NOBYPASSRLS on a private Postgres): flags per tenant, quiet-hours contrast, verified-only, class floor, tenant isolation of the endpoint reader, no endpoint value, PUBLIC cannot execute.

## Known ceilings

- **Parallel, not sequential.** The urgent floor is push only; the brief's "SMS after 5 minutes unopened" is not built. A recipient with only an SMS endpoint gets no out-of-band route for an urgent request (in-app only) until the clinical lead decides the step.
- **A forged `ackClass`** on a designated alert could pick a different floor, but the payload is built only by M36's own consumers from the request row/event, never from a client.
- **The wrap-around semantics of a single-day quiet window** (a `22:00-06:00` window listing only Friday also covers Friday 00:00-06:00, not Saturday morning) is the existing engine's reading and is not changed here; it only affects non-designated alerts. Raised to the owner of M20 preferences.
- Endpoint health (`consecutive_failures` quarantine) is not consulted at plan time; the dispatcher still records it.

## Deferred (built vs not)

Built: the pure policy, the platform floor, the verified-endpoint reader, the flag gate, the trail, the tests. **Not built:** a tenant tightening UI or table; a user-facing explanation screen or preference change in `apps/web` (the existing preferences screen is unchanged); shift data (M19 needs a "is user U on shift at T" answer or M17 a seam; the pure rule and the `shiftFor` input exist and nothing feeds them); the sequential SMS step; a real vendor transport; the unacknowledged queue (WP 4.9); PHI-free templates (WP 4.7, the sanitiser already sends content-free text).

## Open questions

- Clinical lead: the floor per class (is push alone right for urgent? SMS after how long?), no vacation forwarding for a designated route, whether a recipient with only an SMS endpoint should get SMS at once.
- M19 owner (ADR-0057): a seam answering shift state per user and time (the router answers per patient/role/tier), including who owns the zone.
- M17 owner: whether scheduling exposes on-shift state to M36 or M19 stays the single source.
- M20 preferences owner: the single-day wrap-around reading above.
