# ADR-0107 — Group tags in messages: `@role`, `@care-team` and `@on-call` resolved to people at send, inside the channel

- **Status:** **Proposed** (2026-11-01)
- **Date:** 2026-11-01
- **Related:** ADR-0106 (emergency message, step C of its epic), ADR-0080/0081 (on-call directory and role send, the `EscalationRouter` seam), ADR-0057 (EscalationRouter, M19), WP 2.1/2.3 (rich body, mentions).

## Context

A clinician wants to write `@on-call` or `@Registered Nurse` the way they write `@Jane`. Today a mention is `staff` or `patient`, in three places that
must agree: the closed rich-body schema (`packages/types`), the `message_entity_reference.reference_kind` CHECK, and the route/typebox/OpenAPI schemas.
Each staff mention produces one `m36.message.mentioned` event and one in-app notification. What already exists and is reused (nothing new is invented):

- **Roles:** `role` + `membership_role` (active membership, grant not expired).
- **Care team:** a `care_team` channel is auto-synced to the patient's care team; its active members are the team.
- **On-call:** M19 owns the roster; M36 reaches it only through the guarded `EscalationRouter` seam (ADR-0081). It answers per **patient** and per role
  (`rn`, `physician`) and returns an explicit gap or `unavailable` instead of guessing. There is no org-wide roster to read directly.

## Decision

- **D1. Three new reference kinds** beside `staff` and `patient`: `role`, `team`, `on_call`. A tag is a mention node with an `entityId` (a uuid, so the
  closed schema keeps its shape) and a label that must equal the server's canonical label.
  - `role`: `entityId` = `role.id`; label = `role.name`; the people are active channel members who hold that role.
  - `team`: `entityId` = the channel's own id; label `Care team`; allowed only in a `care_team` channel; the people are the active channel members.
  - `on_call`: `entityId` = a fixed well-known uuid per `OnCallDirectoryRole` (`rn`, `physician`); labels `On-call RN` / `On-call physician`; allowed only in
    a `care_team` channel (the router needs the patient).
- **D2. The on-call rule (deterministic, no new source of truth).** `@on-call` means the people the M19 router returns for **tier 1, now** (`asOf` = the
  send instant, the sender's server clock), for the channel's patient and the named role, primaries and backups of that tier together, intersected with the
  channel's active members. A coverage gap, an unconnected roster (`unavailable`), or a router failure is a typed 422/5xx and the send is refused. There
  is never a fall-back to another tier, another role or a guessed person. The sender sees the refusal text and uses the agency telephone procedure
  (ADR-0081).
- **D3. Snapshot at send.** Resolution happens inside the sending transaction (the router answer is read just before it and used as-is). The resolved
  people are written to `message_group_tag_recipient` (insert-only, never updated or deleted), one row per (reference, person). History therefore shows
  who a tag meant at that moment, even after the roster, a role grant or the channel membership changes. A tag edited out of a message later does not
  rewrite the snapshot (edits already never emit new mention alerts).
- **D4. Channel membership is required.** Every resolved person must be an active member of the channel, an active user with an active membership. A role
  holder or on-call nurse who is not in the channel is dropped, never added and never notified: a tag cannot leak a message to a non-member. Delivery
  re-checks `canViewChannel` (the existing mention consumer), so a member who loses access before delivery is skipped.
- **D5. Size limits.** At most 50 people per tag and 3 tags per message; more is a 422, never a silent truncation. A tag that resolves to nobody is a
  422 (`GROUP_TAG_EMPTY`), so the sender is never told a team was notified when nobody was.
- **D6. Who may use group tags.** Same as sending: `messaging.send` and being an active channel member; no new permission. The tenant flag
  `messaging.group_tags` (absent = off) gates it at send (the kinds are refused with a 422 while off) and in the candidate list (group candidates are
  omitted). Bodies already stored keep rendering when the flag is later turned off. The flag is independent of `messaging.role_send` and
  `messaging.oncall_directory`.
- **D7. Notification.** One `m36.message.mentioned` event per resolved person (deduplicated with a personal mention of the same person, and the author is
  skipped), through the unchanged consumer: same in-app notification, same wording, same severity as a normal mention. A tag is **not** louder than a
  mention and does not use the emergency alarm. If the message is also declared an emergency (ADR-0106), the emergency audience is, as before, the
  channel's active members; tags neither widen nor narrow it.
- **D8. Privacy of the roster.** The wire message carries the tag's label and range only, never the resolved list. The snapshot table has no read route
  in this change and is org-isolated by RLS; it holds ids and instants (no names, no text) and is audited like the other M36 PHI-adjacent tables.
  The candidate list shows labels and a kind, not who is behind them, and only roles that at least one channel member holds.
- **D9. Migration (1302, additive).** Widen the `message_entity_reference_kind_shape` CHECK to the five kinds (drop and re-add; every existing row
  satisfies the wider set) and create `message_group_tag_recipient`. No data is rewritten. The compat gate reads a widened CHECK as `contract` (migrations README), so the file declares that; it is backward compatible in fact. Rolling back the application leaves the wider CHECK harmlessly in place.

## Consequences

- The closed rich-body schema grows from two to five mention kinds (still a closed list, still exact keys). Older readers that only know `staff` and `patient`
  would reject a body with a group tag, so the flag stays off until clients ship; the server never writes a group node while the flag is off.
- `@on-call` exists only in patient care-team conversations, because that is the only place M19 can answer. A free-standing on-call channel tag is a later step.
- Two near-simultaneous sends can resolve different on-call people if the roster changes between them. That is the intent of a snapshot.
- ADRs are immutable once Accepted; this one stays Proposed until reviewed.
