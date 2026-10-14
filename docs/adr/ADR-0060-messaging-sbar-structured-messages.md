# ADR-0060 — SBAR messages are a closed structured node in the encrypted body, with a tighten-only tenant policy and a sender-marked urgency hint

- **Status:** **Accepted** (2026-10-14; the decisions are closed in the WP 3.3 blueprint. No clinical-lead or privacy sign-off is recorded.)
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.3, SBAR and clinical templates).
- **Extends:** [ADR-0059](ADR-0059-messaging-clinical-links-read-through.md) (the closed rich-body node pattern and the one-way rollback door), [ADR-0055](ADR-0055-message-revisions-and-redaction.md) (revisions and redaction apply to the SBAR body unchanged), [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (shared types live in `packages/types`), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (tenancy rule for the new table), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access).
- **Related:** ADR-0056 and ADR-0057 (acknowledgment and escalation are separate aggregates; this ADR adds no escalation path), ADR-0058 (search sees only the projection).

## Context

The hub plan (`03-phases-0-to-3.md`, WP 3.3) wants a structured SBAR form (Situation, Background, Assessment, Recommendation). The rendered message must carry machine-readable sections, the form must refuse an empty section, and the template must be tenant-tightenable. The plan also says urgency preselect only suggests: nothing escalates until Phase 4.

Four facts shape the design:

- WP 2.8 shipped `message_template` and `tenant_message_template_overlay` (migration 1086). Its category CHECK excludes clinical categories on purpose, and it only overlays text. Widening it would blur a working table, so SBAR gets its own small policy table.
- A message body is already envelope-encrypted under the tenant DEK (`body_cipher` and `body_sha256`, ADR-0058 P1). Putting SBAR structure inside that body means no new column and no new PHI store.
- The rich-body sanitiser runs on every stored body on every read. A length rule inside it would blank old messages whenever a minimum is raised, so lengths belong on write only.
- A tenant that needs stricter SBAR content must not be able to weaken the platform floor, and the urgency field must not become an alarm that nobody is watching.

## Decision

1. **SBAR is a closed `sbar` block node inside the rich body.** `RichSbar` is `{type:"sbar", urgencyHint, situation, background, assessment, recommendation}`, where each section is a list of the existing paragraph and list nodes. The node is a member of `RichBlock`. The sanitiser is **structural only**: exact keys, all four sections present with at least one visible character, an `sbar` block as the document's only top-level block, no nested `sbar`, and inline content limited to the existing node set (text, mention, clinicalLink, hardBreak). The sanitiser never measures length.
2. **Storage and exposure.** The node rides inside `body_cipher` and `body_sha256`, so there is no new column. The schema stays v1, and the node is written only while the tenant-level ops flag `messaging.sbar` is on. The plain-text projection is fixed: `SBAR`, then `Situation:`, `Background:`, `Assessment:`, `Recommendation:` labels from the constant `SBAR_SECTION_LABELS`, then the section text. `urgencyHint` and tenant hint text are **never** projected. Previews, search and notifications see exactly that projection, which is the same exposure as an ordinary body. Clinical-link walks and mention offsets traverse the section content.
3. **Lengths are checked on write, by one pure function.** `validateSbar(body, effectivePolicy)` in `packages/types/src/messaging-sbar.ts` is shared by the web form and the server. It measures each section's trimmed projected text against `minChars` and `SBAR_MAX_SECTION_CHARS` (2000). The platform floor is `minChars = 1` per section. The whole body stays inside the existing 10k character and 64 KB budget. The server is authoritative: the check runs inside the `sendMessage` and `editMessage` transaction, after the channel lookup. A refusal rolls back the whole send.
4. **Tenant policy is a separate tighten-only table, `tenant_sbar_policy`.** It is keyed by `organization_id` as a singleton, with `situation_min_chars` (and the same column for each section), `require_patient_channel`, nullable per-section hint text, and `configured_by_user_id`. The table has FORCEd RLS on `app.org_id` and no patient column, so it follows the organization-configuration precedent (`notification_template`) rather than the three-column rule. The floor is applied on every read, not only on save: `effectiveSbarPolicy(floor, row)` takes the larger minimum and ORs the booleans. The table carries a CHECK at the platform floor, so a row below the floor cannot be stored.
5. **Tenants can tighten but cannot disable.** A tenant may raise any section's minimum length, require a care-team channel with a patient, or re-word the per-section hint. Hint text passes the existing `lintTemplateText` on save and on read, and falls back to the platform hint when it fails. A tenant may not go below the floor (`422 SBAR_POLICY_FLOOR_VIOLATION`), and may not switch SBAR off. The ops flag `messaging.sbar` is the only off switch. The policy is edited through the existing `messaging.template.manage` permission, so no new permission is added.
6. **Urgency is a sender-marked label, not an alarm.** The form offers `routine`, `important` and `urgent`, with the default `important` in `on_call` channels and `routine` elsewhere. The value is stored only as `urgencyHint` and displayed as "Sender marked: urgent". It has no column, does not change an alert, notification, acknowledgment or event, and is not read by any M36 code outside the codec and validator. The form always shows: "Messaging is not the emergency path. For critical symptoms follow the agency telephone/emergency procedure." When the sender chooses `urgent`, it also shows "Marking urgent does not page or escalate anyone." A static test (`m36-sbar-no-escalation.test.ts`) fails the build if anything else in M36 reads `urgencyHint`. Mapping urgency to escalation is Phase 4 work under ADR-0057.
7. **Channel and scheduled-send floor.** SBAR is refused in `announcement` and `bereavement` channels. A scheduled message stays plain text, so it can never carry SBAR. SBAR works in any other allowed channel. The tenant may require a `care_team` channel (subject is the patient). Recipients are the existing @mentions only. Qualified recipient selection is Phase 4.1.
8. **Errors.** Failed lengths return `422 SBAR_INVALID` with `details` of `{field:"sbar.<section>", code:"REQUIRED"|"TOO_SHORT"|"TOO_LONG", message}`. The text is never echoed. Malformed structure returns the existing `INVALID_RICH_BODY`. A disallowed channel returns `422 SBAR_NOT_ALLOWED_IN_CHANNEL`. With the flag off the route returns `422 SBAR_NOT_AVAILABLE`, checked in the route before the service, the same way `validateRichBodyLinks` runs.

## Alternatives considered

- **Widen `message_template` or its overlay for SBAR.** WP 2.8 excludes clinical categories on purpose and only overlays text. Widening it would weaken a working table and mix a clinical structure into a text catalogue. Rejected.
- **A separate `sbar_message` table with its own body column.** It would be a second PHI store with its own encryption and retention path, and it would break the single body envelope. Rejected; the structure rides inside the existing encrypted body.
- **Length rules in the sanitiser.** Every stored body is re-sanitised on read, so raising a floor would blank old messages. Rejected; lengths are checked on write only.
- **Store `urgency` as a column that drives alerts.** This would make the sender's label an escalation path before the on-call and acknowledgment design (ADR-0056, ADR-0057) exists. Rejected until Phase 4.1.
- **Let the tenant disable SBAR through its policy row.** A tenant could then switch off a structure that the platform relies on for handover. The ops flag is the single off switch, so the tenant can only tighten. Rejected.
- **Server-side draft of the SBAR form.** Deferred. Form state lives in the thread component, keyed by channel, and is lost on reload. The server draft is a follow-up.

## Consequences

- **New flag `messaging.sbar`, default off.** It gates writes and the policy routes, following the `messaging.clinical_links` pattern in `clinical-link/binding.ts`.
- **Rollback is a one-way door, as in ADR-0059.** The `sbar` node is added to rich-body schema v1 without a version bump. An older build rejects a stored body that carries it and shows it empty in previews. Keep the flag off until every instance runs the build that knows the node, and do not roll the build back once SBAR messages exist.
- **Migration `1099_m36_sbar_policy.sql`** creates `tenant_sbar_policy`. Its check is `arch:migration-numbering` against `main`, which ends at 1098. The table has FORCED RLS on `app.org_id`, `wardenx_app` holds SELECT, INSERT, UPDATE and DELETE, and `wardenx_destruction` holds SELECT and DELETE under the same org policy. The PHI write-audit trigger scrubs the four `*_hint` columns, and the messaging eraser removes the tenant's row.
- **OpenAPI and client.** The policy routes are added to the generated OpenAPI document and typed client.
- **Known limits (accepted).**
  - There is no server draft. Form state is held by the client and is lost on reload.
  - Recipient role selection and any urgency column, alert or acknowledgment mapping are deferred to Phase 4.1.
  - Rollback is one-way once SBAR messages exist, as above.
  - SBAR is not in scheduled send.
  - A tenant can tighten the policy but cannot disable SBAR.
  - Message previews, search and notifications expose the labelled projection, including the section text, to the same audience as an ordinary message body.
- **Edits and redactions** follow ADR-0055. A revision holds the whole SBAR body, and redaction masks the whole message.

## Migration / rollout

1. Land the `sbar` node and `validateSbar` in `packages/types` with the sanitiser, projection and link-walk tests.
2. Land migration `1099`, the manifest entries in both `.ts` and `.cjs`, the write-time checks, and the policy routes behind `messaging.sbar`, default off.
3. Land the web form and the admin policy panel, hidden when the flag is off or the channel forbids SBAR.

## Verification

- Sanitiser: accept and reject cases (missing section, extra keys, `sbar` beside another block, nested `sbar`), projection, mention offsets, link walk, and idempotence.
- Route tests: each `422` (`SBAR_INVALID`, `SBAR_NOT_ALLOWED_IN_CHANNEL`, `SBAR_NOT_AVAILABLE`, `SBAR_POLICY_FLOOR_VIOLATION`), `403` for a caller without `messaging.template.manage`, and `404` with the flag off.
- Static test `m36-sbar-no-escalation.test.ts`: no M36 code outside the codec and validator reads `urgencyHint`.
- Live suite `test:m36:sbar:live` as the real `wardenx_app` role on a private container: FORCE RLS across two orgs, the audit trigger with hints scrubbed, a raised floor beating a stored lower value, and the destruction role.
- Fitness: `arch:tenancy`, `arch:manifest-mirror`, `arch:migration-numbering`, `arch:route-reachability`, `arch:error-envelope`, `arch:live-suites`, `arch:openapi-coverage`, `arch:adr-docs`, `arch:fitness`.

## Open questions

None gating. Left for Phase 4.1: whether `urgencyHint` maps to a queue, an acknowledgment deadline or nothing, and the recipient-role rules.
