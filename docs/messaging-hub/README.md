# Clinical Communication & Care Coordination Hub — Implementation Plan

> **Status:** Proposal for approval · **Date:** 2026-10-11 · **Owner module:** M36 (Secure Messaging & Alerts)
> **Authority:** Architecture documents win on conflict ([`CLAUDE.md`](../../CLAUDE.md) authority rule). This plan
> extends [Module 36](../modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md); where it needs to change M36 or a
> neighbouring module's contract, it says so and names the ADR that must land first (see
> [`02-architecture-and-domain.md` §8](./02-architecture-and-domain.md#8-adrs-to-write-before-the-phases-that-need-them)).
> It is **not** under `docs/plans/**` on purpose: that tree is read-only to automation (`arch:plan-integrity`).

## 1. Goal

Move M36 from "internal chat + alert fan-out" to a **Clinical Communication & Care Coordination Hub**: a nurse can
raise a concern about a patient, reach the *right accountable clinician*, get a recorded acknowledgment, document
the outcome and move on — without duplicating work and without the chat becoming the legal record, an order, or the
only emergency path.

Design rule that governs every decision below:

> **Messaging supports clinical care. It does not silently become the medical record, an order-entry system, or a
> substitute for emergency escalation.** Promotion into the chart/orders/care plan is always an explicit,
> authenticated workflow owned by the module that owns that record.

## 2. What already exists (verified against `main`, 2026-10-11)

| Area | As built | Evidence |
|---|---|---|
| Conversations | 7 `channel_kind`s (`care_team`, `discipline`, `location`, `on_call`, `dm`, `announcement`, `bereavement`), auto-managed membership via `CareTeamProvider` / `OnCallProvider` seams | M36 spec §2.3, §3.3; `channel`, `channel_member` |
| Messages | Envelope-encrypted body (`body_cipher`), integrity hash + nightly verify, 5-min edit window, soft-delete tombstone with retained cipher, `parent_message_id` / `quoted_message_id` columns, `message_receipt` (`delivered`/`read`/`ack`) | spec §3.4; migrations 0016/0017 |
| References | Structured staff/patient mentions (`message_entity_reference`) | migration 1065 |
| Alerts | Typed catalog, per-tenant rules, tighten-only overrides, fan-out to in-app / web-push / SMS / email / voice (SOS only), quiet hours, vacation forwarding, delivery sweep + reconcile, PHI sanitiser for out-of-band | spec §3.6–3.13, §4.7; `packages/messaging`, `delivery/` |
| API | ~25 routes under `/api/v1/messaging`, `/notifications`, `/alerts`, `/alert-rules` | spec §4.1; `messaging-routes.ts` |
| Web | Inbox, thread, new-conversation dialog, notifications inbox; **client polls while visible** | `apps/web/src/modules/36-messaging`; spec §4.1 as-built note |
| On-call & escalation | **Owned by M19**: `on_call_shift`, `oncall_rotation_entry`, `triage_call`, `triage_escalation` (5 tiers) | M19 spec; manifest |
| Realtime | `packages/messaging/src/realtime` holds **event/room contracts only**; no `socket.io` dependency in backend or messaging package | `grep socket.io` |

**Consequence:** this is an *evolution* of M36, not a rebuild. The largest risks are duplicating M19 (on-call/escalation),
M14 (IDG), M11 (orders) or M22 (documents), and shipping features on top of a polling client that cannot meet
the 2-second delivery target.

## 3. Reading order

| # | File | Purpose |
|---|---|---|
| 1 | [`01-baseline-and-gap-matrix.md`](./01-baseline-and-gap-matrix.md) | Keep / Modify / Consolidate / Replace / Deprecate map + Phase 0 audit checklist |
| 2 | [`02-architecture-and-domain.md`](./02-architecture-and-domain.md) | Module boundaries, new tables, state machines, events, API additions, ADR list |
| 3 | [`03-phases-0-to-3.md`](./03-phases-0-to-3.md) | Audit → secure foundation → collaboration UX → clinical integration (work packages) |
| 4 | [`04-phases-4-to-6.md`](./04-phases-4-to-6.md) | Escalation/notifications → mobile/governance → advanced/AI (work packages) |
| 5 | [`05-clinical-workflows-and-safety.md`](./05-clinical-workflows-and-safety.md) | Workflows A–F, authorization matrix, hazard log seed, compliance evidence matrix |
| 6 | [`06-ux-design.md`](./06-ux-design.md) | Three-panel workspace, states, accessibility, kit reuse |
| 7 | [`07-testing-release-governance.md`](./07-testing-release-governance.md) | Test strategy, NFR targets, fitness gates, release gates, risks, open decisions |
| 8 | [`08-capability-register.md`](./08-capability-register.md) | All 88 capabilities → phase, owner, dependency, risk, status |
| 9 | [`09-ui-gap-register.md`](./09-ui-gap-register.md) | UI and screen gaps still to build (audit 2026-10-12), mapped to WPs or marked unscheduled |

## 4. Phase summary

| Phase | Name | Weeks (est.) | Exit outcome |
|---|---|---|---|
| 0 | Repository-grounded audit & safety architecture | 2–3 | Keep/Modify map approved; ADRs drafted; hazard log + threat model seeded |
| 1 | Secure messaging foundation | 4–6 | Realtime transport, idempotent send, attachments with scan, membership/offboarding safety, tenant/IDOR proof |
| 2 | Modern collaboration | 4–6 | Rich composer, threads, mentions, search, drafts, pins, reactions, scheduled send, three-panel UI |
| 3 | Clinical integration | 5–7 | Patient context, SBAR, clinical links, communication tasks, handoffs, IDG, chart promotion, lifecycle rules |
| 4 | Urgency, on-call & notifications | 4–6 | Acknowledgment-required messages, escalation to M19 tiers, push, quiet-hours-safe routing, failure fallbacks |
| 5 | Mobile & governance | 4–6 | Offline drafts, deep links, accessibility pass, retention/legal-hold/export/break-glass |
| 6 | Advanced (optional) | 5–8 | Smart inbox, analytics, voice, multilingual, AI assist (M32), approved external partners |

≈ 28–42 sequential engineer-weeks; parallelisable after Phase 1 (see dependency graph in
[`03-phases-0-to-3.md`](./03-phases-0-to-3.md#dependency-graph)). Estimates are planning figures, not commitments.

### Decisions (product owner, 2026-10-11)

| # | Decision | Consequence |
|---|---|---|
| D1 | Realtime transport = **Socket.IO** | Phase 1 opens with a 1-day spike (Fastify/Bun handshake via Better Auth session, room join, Valkey adapter across two instances, drop on revocation). Fallback if it fails: SSE + REST |
| D2 | Communication tasks = **thin new M36 table** | IDG-sourced items only *reference* M14 and delegate lifecycle there; Phase 0 re-checks that M14 `action_item` isn't already generic |
| D3 | Global search = **required**, **option B** (per-tenant encrypted blind-token index) | In-conversation search ships first (Phase 2.7a); global search is its own work package with a design review + ADR (2.7b) |
| D4 | Ack deadlines = **per-urgency defaults, tenant may only tighten** (options B + C) | Policy table in [`04`](./04-phases-4-to-6.md#acknowledgment-deadline-policy-decision-d4); clinical lead signs off the numbers |
| D5 | **ADR-0036**: additive pointer, status stays `Accepted` | Decisions 2–3 marked superseded by ADR-0054 in a header line; no gate change (avoids loosening `arch:adr-docs` for one case) |
| D6 | **M19 vs D4**: scopes differ, and the stricter deadline wins on overlap | D4 governs the *message* acknowledgment clock; M19 tier SLAs stay as-is for triage calls. When a message escalates through M19, the smaller of the two applies. Never loosen either. M19 owner for the `EscalationRouter` seam still to be named |
| D7 | **Critical class: yes**, as `ack_class`, with a permanent "not the emergency path" notice | Mirrors the tiered-priority model common in clinical messaging products; critical uses all channels at once. Clinical lead signs off eligible roles |
| D8 | **Edits lock** once a message is urgent or has an acknowledgment request | Corrections after that point are a new linked message (visible amendment), never an overwrite |
| D9 | **Redaction**: two-person approval; single-officer fallback | Requester and approver must differ. If the agency has one eligible person, a second role (org admin/privacy officer) must countersign within a set period. Original kept in a restricted revision store (legal-hold aware), never hard-deleted; tombstone shows who/when/why. Separate permissions: `messaging.history.read`, `messaging.redact.request`, `messaging.redact.approve` |
| D10 | **Search review** = security architect + privacy officer, gates *building* 2.7b and *enabling* in production | Pre-build design review, then a leakage test before production enablement. Numeric/ID-like tokens and free-text identifiers are not indexed; patient names indexable behind a tenant flag; English-only at launch with a pluggable tokeniser |
| D11 | **Realtime**: websocket-first with long-polling fallback; sticky sessions at ingress | Socket activity does **not** extend the idle session timer; session expiry or revocation disconnects the socket. Ops runbook gets a realtime component owner (platform/ops) |

**Release gates.** Phase 1 supports controlled internal testing only. A production *clinical* rollout needs the
Phase 3–5 safety controls (acknowledgment, escalation fallback, access review, recovery rehearsal). Phase 6 stays optional
and feature-flagged per tenant.

## 5. Working agreements for this repo

- Every PR: `bun run typecheck && bun run arch:fitness && bun run test`, plus the relevant live suite on a **private**
  `pgvector/pgvector:pg18` container (never the shared Docker cluster — suites `DROP ROLE wardenx_app`).
- New migration → check `arch:migration-numbering` against `main` first; mirror enums/tables into `packages/db/src/enums.ts`,
  `packages/types`, and **both** manifests (`.ts` + `.cjs`).
- New live suite → `package.json` script **and** a `ci.yml` job row.
- **Batch pushes.** Actions minutes are metered; push per work-package group, not per round (CLAUDE.md, #257).
- Run `/ecc:code-review` on `git diff main...HEAD` in a fresh agent before any PR; add `/ecc:react-review` for `apps/web`
  and `/ecc:security-scan` for auth/PHI/RLS changes. Merge needs the user's explicit go-ahead.
- Hit changed backend routes on the Docker stack before merging (`main` auto-deploys). Use `docker compose run --rm migrate`,
  never host `db:migrate` (resets the app role).
- New UI follows the redesign kit (flat rail/drawer pattern, mockup blue palette) — no old-style inline UIs.
- Update `docs/README.md` index and mirror any `CLAUDE.md` change into `AGENTS.md` verbatim in the same commit.
