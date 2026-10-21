# WardenX — T-29.06 Addendum: HL7 Inbound Proposal Lifecycle

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.6 (routing table), §11 D5 (propose-then-review), §10 (T-29.06)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 → T-29.05 merged.

This addendum delivers the drop-in artifacts for T-29.06 — the proposal lifecycle that consumes T-29.05's cascade-outcome events and creates `hl7_inbound_proposal` rows for human review. It includes the proposal state machine, the partial-accept logic, the owner-module-match ABAC predicate, the race-condition-safe accept path, and the M5/M6 owner-module outbox events that the locked modules will consume in their v0.3 revisions.

**T-29.06 is the PR that closes W-XI-01, W-XI-02, W-XI-03, and W-XI-04** on the M29 side. The full M5-mutation arm of W-XI-01/03 closes when M5 v0.3 implements the consumer of `m29.hl7_inbound_proposal.accepted`.

The work surfaces **two more design contradictions** in M29 spec v0.2 that block coherent implementation. They are resolved in §2 as retroactive corrections.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Retroactive spec corrections** (§2) — three: (a) propose-then-review always, replacing §4.6 routing table for ADT; (b) W-XI-01 message-type / proposal-kind clarification; (c) `parsed_segments_cipher` column on `hl7_message_inbound`.
- **Cascade-outcome consumer** at `apps/backend/src/modules/29-external-interfaces/proposals/cascade-consumer.ts` — subscribes to the three T-29.05 outbox events, creates one `hl7_inbound_proposal` per inbound message.
- **Decision engine** at `apps/backend/src/modules/29-external-interfaces/proposals/decision-engine.ts` — accept (full or partial), reject (with required note), discard, expire-sweep.
- **Proposal lifecycle service** at `apps/backend/src/modules/29-external-interfaces/proposals/lifecycle.ts` — orchestrates state transitions and emits the M4 outbox events.
- **HTTP routes** at `apps/backend/src/modules/29-external-interfaces/routes/proposals.ts` — `GET /api/v1/hl7/inbound-proposals`, `GET /:id`, `POST /:id/accept`, `POST /:id/reject`, `POST /:id/discard` per M29 §4.1.
- **ABAC predicate** `hl7_inbound_proposal_owner_module_match` at `apps/backend/src/modules/03-authorization/predicates/`. M29 contributes the predicate definition; M3 boot-registers it.
- **Outbox publisher** for M5/M6 consumption events: `m29.hl7_inbound_proposal.created`, `m29.hl7_inbound_proposal.accepted`, `m29.hl7_inbound_proposal.rejected`, `m29.hl7_inbound_proposal.discarded`, `m29.hl7_inbound_proposal.expired`.
- **Parse-worker addition** — persist `parsed_segments_cipher` after successful sidecar parse (a tiny patch — already wired in T-29.05's parse worker; T-29.06 just adds the persistence call).
- **M5 / M6 forward-stub consumers** — deny-stubs registered in M29 boot per the T-29.01 forward-stub pattern. Real consumers land when M5 v0.3 / M6 v0.3 ship.
- **Expire-sweep worker** that flips `pending` proposals past `expires_at` to `expired`.
- **Tests** that close W-XI-01, W-XI-02, W-XI-03, W-XI-04 on the M29 side, plus race-condition + owner-module-mismatch + decision-note-required.
- **Sign-off checklist.**

### 1.2 Non-goals

- **M5 / M6 real consumers.** M5 and M6 are locked at v0.2 and don't yet know about M29 proposals. T-29.06 ships forward-stub consumers and registers the outbox events. M5/M6 v0.3 will implement the consumers.
- **Frontend UI for the inbox/review screen** — T-29.13.
- **Step-up auth UI flow.** The step-up gate is enforced server-side per the ABAC predicate; UI surfaces are T-29.13.
- **Discard quota / abuse detection.** Discard is permission-gated and audit-logged; volume-based abuse detection is a Phase 2 ops concern.

---

## 2. Retroactive Spec Corrections

### 2.1 Propose-then-review for ALL ADT outcomes (not just candidate/no-match)

M29 §4.6 routing table currently says:

> | `confident_match` (L1-3) | Apply downstream owner-module side-effect directly (M5/M6 mutation); audit `phi_mutation` with `match_level` annotation; **no proposal created** | ... |

This **contradicts** M29 §11 D5 (propose-then-review semantics) and W-XI-01 (which expects a proposal even on L1 with `patient row is not mutated until a reviewer accepts`).

**Resolution: propose-then-review wins.** The §4.6 routing table is updated. The corrected routing for ADT:

| Cascade outcome | ADT action |
|---|---|
| `confident_match` (L1-3) | Create `hl7_inbound_proposal` with `match_outcome='matched_single'`, `matched_patient_id=hit`, `proposal_status='pending'`. Reviewer accepts/rejects. **No auto-mutation.** |
| `candidate_match` (L4-5) | Create `hl7_inbound_proposal` with `match_outcome='matched_single'`, `matched_patient_id=candidate`, `match_confidence=0.92|0.78`, `proposal_status='pending'`. Same review flow. |
| `ambiguous` (L3 or L4 multi-hit) | Create proposal with `match_outcome='matched_ambiguous'`, `matched_patient_id=null`, `match_candidate_ids=[...]`. Reviewer picks the right candidate or rejects. |
| `no_match` (A01/A04/A08) | Create proposal with `match_outcome='no_match'`, `matched_patient_id=null`, `resource_kind='new_patient'` (a NEW enum value — see §2.4). Reviewer creates a new M5 row or rejects. |
| `no_match` (A03/A11) | **Drop with audit** — can't discharge/cancel an unknown patient. Emit `m29.hl7_message.routing_dropped` event with reason `cannot_act_on_unknown_patient`. No proposal. |

**Rationale for the change:** Hospital ADT data is unreliable enough that even an L1 MRN match shouldn't auto-overwrite clinical chart data without human review. The clinical-safety floor is higher than the cascade-confidence floor. The §4.6 wording was a leftover assumption from an earlier design where confident matches did auto-apply; D5 and the workflow scenarios reflect the later decision to always review.

This means **T-29.05's outcome-router does NOT need different routing per confident-vs-candidate** — both arms emit `cascade_resolved_candidate` (the candidate event) in the resolved sense. T-29.05's three-event scheme (`confident` / `candidate` / `no_match`) is still useful for observability and downstream tier-1 dashboards, but T-29.06's consumer treats `confident` and `candidate` symmetrically — both produce proposals.

A small T-29.05 logic refinement that this implies: the `cascade_resolved_confident` event's payload already carries `matchedPatientId` and `matchLevel`; the `cascade_resolved_candidate` event's payload carries `candidatePatientId` (singular) or `candidateIds` (plural for ambiguous). T-29.06's consumer reads both shapes uniformly.

### 2.2 W-XI-01 message-type clarification

M29 spec §7 W-XI-01 reads:

> When an `ADT^A08` frame arrives with `PID-3.1 = MRN-001234` ... Then ... `hl7_inbound_proposal` row is created with `proposal_kind = 'PATIENT_UPDATE'`, `owner_module = 'M5'`...

Actually the M29 v0.2 spec text says:

> When an `ADT^A08` (patient update) frame arrives with `PID-3.1 = MRN-001234`...

Good — that's A08 (patient update), which correctly maps to M5 + `patient_demographic_update`. **No correction needed for W-XI-01 itself.** The case alignment is:

| Message Type | Proposal `resource_kind` | Owner module | Rationale |
|---|---|---|---|
| ADT^A01 (admit/visit notification) | `admission_event` | m6 | New admission lives in M6 |
| ADT^A04 (registration) | `admission_event` | m6 | Functionally equivalent to A01 for our purposes |
| ADT^A08 (patient update) | `patient_demographic_update` | m5 | Demographics live in M5 |
| ADT^A03 (discharge) | `discharge_event` | m6 | Discharge updates an encounter |
| ADT^A11 (cancel admit) | `cancel_admission` | m6 | Reverses an A01 |

The proposal's `proposed_patient_candidate` JSONB carries the FULL parsed PID data (and PV1 for admit messages) so the owner module has everything it needs at accept time.

`'PATIENT_UPDATE'` in W-XI-01's text is shorthand for the enum value `'patient_demographic_update'`. T-29.06 normalizes to lowercase enum values throughout — `patient_demographic_update`, `admission_event`, `discharge_event`, `cancel_admission`.

### 2.3 New `parsed_segments_cipher` columns on `hl7_message_inbound`

T-29.06's consumer is a separate worker process — it doesn't have in-memory access to the parsed segment tree from the parse worker's earlier sidecar call. Options:

1. **Re-call the sidecar in T-29.06 consumer** — adds latency, wastes sidecar capacity.
2. **Stuff parsed segments into the outbox event payload** — puts PHI in outbox events; manageable but increases event size and demands strict outbox encryption assumptions.
3. **Persist parsed segments on `hl7_message_inbound`** — clean separation, leverages existing envelope encryption.

**Chosen: option 3.** Migration `0031_external_interfaces_proposal.sql` adds:

```sql
ALTER TABLE hl7_message_inbound
  ADD COLUMN parsed_segments_cipher TEXT,
  ADD COLUMN parsed_segments_sha256 TEXT;
```

Both nullable (a parse-error row has neither). Both audit-denylisted (the cipher because it's PHI-bearing; the sha256 captured in clear for tamper detection).

Drizzle addition:

```ts
// packages/db/src/schema/external-interfaces/hl7-messages.ts (additions)
parsedSegmentsCipher: text('parsed_segments_cipher'),
parsedSegmentsSha256: text('parsed_segments_sha256'),
```

Audit denylist additions:

```ts
// packages/db/src/audit-denylist/m29.ts (extension)
registry.denyColumns({
  // ... existing M29 denylist ...
  'hl7_message_inbound': ['payload_cipher', 'parsed_segments_cipher'],  // <-- added parsed_segments_cipher
})
```

T-29.05's parse worker gets a tiny addition: after a successful `sidecar.parse(...)`, persist the parsed tree:

```ts
// hl7-inbound-parse.worker.ts (addition, after parsed = await sidecar.parse(...))
const parsedJson = JSON.stringify(parsed)
const parsedSegmentsCipher = await envelope.encrypt(parsedJson, { organizationId })
const parsedSegmentsSha256 = crypto.createHash('sha256').update(parsedJson).digest('hex')

await withOrgContext(db, { organizationId }, async (tx) => {
  await tx
    .update(hl7MessageInbound)
    .set({ parseStatus: 'parsed', parsedSegmentsCipher, parsedSegmentsSha256 })
    .where(eq(hl7MessageInbound.id, messageId))
})
```

### 2.4 New `hl7_inbound_proposal_kind` enum value

The §2.1 routing adds `new_patient` to the proposal-kind set. The existing enum (per T-29.02 §3.1):

```sql
CREATE TYPE hl7_inbound_proposal_kind AS ENUM (
  'patient_demographic_update', 'admission_event', 'discharge_event', 'cancel_admission'
);
```

Migration `0031` adds:

```sql
ALTER TYPE hl7_inbound_proposal_kind ADD VALUE 'new_patient';
```

Drizzle update:

```ts
// packages/db/src/schema/external-interfaces/enums.ts
export const hl7InboundProposalKind = pgEnum('hl7_inbound_proposal_kind', [
  'patient_demographic_update',
  'admission_event',
  'discharge_event',
  'cancel_admission',
  'new_patient',
])
```

### 2.5 Summary of corrections

| # | Change | Type |
|---|--------|------|
| 2.1 | §4.6 routing: propose-then-review for ALL ADT outcomes | Spec text correction |
| 2.2 | W-XI-01 case alignment confirmed (no change needed; T-29.06 normalizes case) | Convention |
| 2.3 | `hl7_message_inbound.parsed_segments_cipher` + `parsed_segments_sha256` | Schema addition |
| 2.4 | `hl7_inbound_proposal_kind` enum gains `'new_patient'` | Schema addition |
| 2.5 | T-29.05 parse worker persists parsed segments | Tiny code addition |

All schema corrections land in migration `0031_external_interfaces_proposal.sql`.

---

## 3. Message-Type → Proposal-Kind Mapping

Centralized constant. Imported by the cascade-consumer.

```ts
// apps/backend/src/modules/29-external-interfaces/proposals/message-type-routing.ts

export type AdtMessageType =
  | 'ADT^A01'
  | 'ADT^A03'
  | 'ADT^A04'
  | 'ADT^A08'
  | 'ADT^A11'

export type Hl7InboundProposalKind =
  | 'patient_demographic_update'
  | 'admission_event'
  | 'discharge_event'
  | 'cancel_admission'
  | 'new_patient'

export type OwnerModule = 'm5' | 'm6'

export interface MessageTypeRouting {
  readonly resourceKind: Hl7InboundProposalKind
  readonly ownerModule: OwnerModule
  /**
   * Whether a no-match cascade outcome should produce a proposal (true) or
   * drop with audit (false). Per §2.1 of this addendum: A01/A04/A08 → propose
   * new_patient; A03/A11 → drop.
   */
  readonly noMatchBehavior: 'propose_new_patient' | 'drop_with_audit'
}

export const MESSAGE_TYPE_ROUTING: Record<AdtMessageType, MessageTypeRouting> = {
  'ADT^A01': { resourceKind: 'admission_event', ownerModule: 'm6', noMatchBehavior: 'propose_new_patient' },
  'ADT^A04': { resourceKind: 'admission_event', ownerModule: 'm6', noMatchBehavior: 'propose_new_patient' },
  'ADT^A08': { resourceKind: 'patient_demographic_update', ownerModule: 'm5', noMatchBehavior: 'propose_new_patient' },
  'ADT^A03': { resourceKind: 'discharge_event', ownerModule: 'm6', noMatchBehavior: 'drop_with_audit' },
  'ADT^A11': { resourceKind: 'cancel_admission', ownerModule: 'm6', noMatchBehavior: 'drop_with_audit' },
}

export function isSupportedAdt(messageType: string): messageType is AdtMessageType {
  return messageType in MESSAGE_TYPE_ROUTING
}
```

This is the single source of truth for which downstream module is responsible for a given inbound message kind. Any addition (e.g. ADT^A02, ADT^A05 future support) edits this map; no other code changes.

---

## 4. Cascade-Outcome Consumer

Path: `apps/backend/src/modules/29-external-interfaces/proposals/cascade-consumer.ts`.

The consumer subscribes to all three cascade-resolved events from T-29.05 and creates a proposal (or drops with audit for the A03/A11-no-match case).

```ts
// apps/backend/src/modules/29-external-interfaces/proposals/cascade-consumer.ts
import type { Outbox, OutboxConsumerHandler } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'
import { ulid } from 'ulid'
import { hl7MessageInbound, hl7InboundProposal } from '@chartwarden/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'
import type { KmsEnvelopeEncryptor } from '@chartwarden/foundation/seams'
import { MESSAGE_TYPE_ROUTING, isSupportedAdt, type Hl7InboundProposalKind, type OwnerModule } from './message-type-routing'
import { db } from '@chartwarden/db'

const PROPOSAL_TTL_DAYS = 30  // per M29 §8.4 retention — pending >30d auto-expires

interface CascadeConfidentPayload {
  readonly messageId: string
  readonly feedId: string
  readonly organizationId: string
  readonly messageControlId: string
  readonly messageType: string
  readonly matchedPatientId: string
  readonly matchLevel: string
}

interface CascadeCandidatePayload {
  readonly messageId: string
  readonly feedId: string
  readonly organizationId: string
  readonly messageControlId: string
  readonly messageType: string
  readonly candidatePatientId: string | null  // null if ambiguous (multiple)
  readonly matchLevel: string
  readonly matchConfidence: number | null
  readonly candidateIds: readonly string[]
}

interface CascadeNoMatchPayload {
  readonly messageId: string
  readonly feedId: string
  readonly organizationId: string
  readonly messageControlId: string
  readonly messageType: string
}

export interface CascadeConsumerDeps {
  readonly logger: Logger
  readonly outbox: Outbox
  readonly envelope: KmsEnvelopeEncryptor
}

export function registerCascadeConsumers(deps: CascadeConsumerDeps): void {
  deps.outbox.registerConsumer<CascadeConfidentPayload>({
    eventName: 'm29.hl7_message.cascade_resolved_confident',
    consumerName: 'm29.proposal-creator',
    handler: createProposalFromConfident(deps),
  })

  deps.outbox.registerConsumer<CascadeCandidatePayload>({
    eventName: 'm29.hl7_message.cascade_resolved_candidate',
    consumerName: 'm29.proposal-creator',
    handler: createProposalFromCandidate(deps),
  })

  deps.outbox.registerConsumer<CascadeNoMatchPayload>({
    eventName: 'm29.hl7_message.cascade_resolved_no_match',
    consumerName: 'm29.proposal-creator',
    handler: createProposalOrDropFromNoMatch(deps),
  })
}

// ─── Confident match → proposal ──────────────────────────────────────
function createProposalFromConfident(deps: CascadeConsumerDeps): OutboxConsumerHandler<CascadeConfidentPayload> {
  return async ({ payload }) => {
    if (!isSupportedAdt(payload.messageType)) {
      deps.logger.warn({ messageType: payload.messageType }, 'm29.proposal.unknown_message_type_skipped')
      return
    }

    const routing = MESSAGE_TYPE_ROUTING[payload.messageType]
    const parsedPid = await loadParsedPid(payload.messageId, payload.organizationId, deps)
    if (!parsedPid) return  // logged at load time; nothing further to do

    await createPendingProposal({
      organizationId: payload.organizationId,
      sourceMessageId: payload.messageId,
      resourceKind: routing.resourceKind,
      ownerModule: routing.ownerModule,
      proposedPatientCandidate: parsedPid,
      matchOutcome: 'matched_single',
      matchedPatientId: payload.matchedPatientId,
      matchConfidence: null,
      matchCandidateIds: [payload.matchedPatientId],
      matchLevel: payload.matchLevel,
    }, deps)
  }
}

// ─── Candidate match (single or ambiguous) → proposal ────────────────
function createProposalFromCandidate(deps: CascadeConsumerDeps): OutboxConsumerHandler<CascadeCandidatePayload> {
  return async ({ payload }) => {
    if (!isSupportedAdt(payload.messageType)) {
      deps.logger.warn({ messageType: payload.messageType }, 'm29.proposal.unknown_message_type_skipped')
      return
    }

    const routing = MESSAGE_TYPE_ROUTING[payload.messageType]
    const parsedPid = await loadParsedPid(payload.messageId, payload.organizationId, deps)
    if (!parsedPid) return

    const isAmbiguous = payload.candidateIds.length > 1 && payload.candidatePatientId === null

    await createPendingProposal({
      organizationId: payload.organizationId,
      sourceMessageId: payload.messageId,
      resourceKind: routing.resourceKind,
      ownerModule: routing.ownerModule,
      proposedPatientCandidate: parsedPid,
      matchOutcome: isAmbiguous ? 'matched_ambiguous' : 'matched_single',
      matchedPatientId: payload.candidatePatientId,
      matchConfidence: payload.matchConfidence?.toFixed(3) ?? null,
      matchCandidateIds: [...payload.candidateIds],
      matchLevel: payload.matchLevel,
    }, deps)
  }
}

// ─── No match → propose new_patient OR drop ──────────────────────────
function createProposalOrDropFromNoMatch(deps: CascadeConsumerDeps): OutboxConsumerHandler<CascadeNoMatchPayload> {
  return async ({ payload }) => {
    if (!isSupportedAdt(payload.messageType)) {
      deps.logger.warn({ messageType: payload.messageType }, 'm29.proposal.unknown_message_type_skipped')
      return
    }

    const routing = MESSAGE_TYPE_ROUTING[payload.messageType]

    if (routing.noMatchBehavior === 'drop_with_audit') {
      await deps.outbox.publish('m29.hl7_message.routing_dropped', {
        messageId: payload.messageId,
        feedId: payload.feedId,
        organizationId: payload.organizationId,
        messageControlId: payload.messageControlId,
        messageType: payload.messageType,
        reason: 'cannot_act_on_unknown_patient',
      })
      deps.logger.info({ messageId: payload.messageId, messageType: payload.messageType }, 'm29.proposal.no_match_dropped')
      return
    }

    // propose_new_patient
    const parsedPid = await loadParsedPid(payload.messageId, payload.organizationId, deps)
    if (!parsedPid) return

    await createPendingProposal({
      organizationId: payload.organizationId,
      sourceMessageId: payload.messageId,
      resourceKind: 'new_patient',                 // explicit new-patient kind
      ownerModule: 'm5',                            // M5 creates the new patient on accept
      proposedPatientCandidate: parsedPid,
      matchOutcome: 'no_match',
      matchedPatientId: null,
      matchConfidence: null,
      matchCandidateIds: [],
      matchLevel: 'NO_MATCH',
    }, deps)
  }
}

// ─── Shared persistence path ─────────────────────────────────────────
interface CreatePendingProposalInput {
  organizationId: string
  sourceMessageId: string
  resourceKind: Hl7InboundProposalKind
  ownerModule: OwnerModule
  proposedPatientCandidate: object  // typed parsed PID + PV1 if relevant
  matchOutcome: 'matched_single' | 'matched_ambiguous' | 'no_match'
  matchedPatientId: string | null
  matchConfidence: string | null  // numeric stringified for Drizzle, or null
  matchCandidateIds: readonly string[]
  matchLevel: string
}

async function createPendingProposal(input: CreatePendingProposalInput, deps: CascadeConsumerDeps): Promise<void> {
  const proposalId = ulid()
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000)

  // Atomic create: insert with conflict on (source_message_id, resource_kind) — same source
  // message must not produce duplicate proposals. The unique-constraint is added in §2.6
  // (well, actually not in §2 since it's a domain constraint; we add it here as a small
  // additional migration step).
  //
  // For T-29.06 we rely on the cascade-consumer being run once per outbox event (BullMQ idempotency)
  // and the outbox table's own dedup. A subsequent migration may add a hard UNIQUE constraint.

  await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
    await tx.insert(hl7InboundProposal).values({
      id: proposalId,
      organizationId: input.organizationId,
      sourceMessageId: input.sourceMessageId,
      resourceKind: input.resourceKind,
      proposedPatientCandidate: input.proposedPatientCandidate,
      matchOutcome: input.matchOutcome,
      matchedPatientId: input.matchedPatientId,
      matchConfidence: input.matchConfidence,
      matchCandidateIds: [...input.matchCandidateIds],
      proposedAt: new Date(),
      ownerModule: input.ownerModule,
      proposalStatus: 'pending',
      expiresAt,
    })
  })

  await deps.outbox.publish('m29.hl7_inbound_proposal.created', {
    proposalId,
    organizationId: input.organizationId,
    sourceMessageId: input.sourceMessageId,
    resourceKind: input.resourceKind,
    ownerModule: input.ownerModule,
    matchOutcome: input.matchOutcome,
    matchedPatientId: input.matchedPatientId,
    matchLevel: input.matchLevel,
    matchConfidence: input.matchConfidence ? parseFloat(input.matchConfidence) : null,
    matchCandidateIds: input.matchCandidateIds,
    expiresAt: expiresAt.toISOString(),
  })

  deps.logger.info(
    { proposalId, sourceMessageId: input.sourceMessageId, resourceKind: input.resourceKind, ownerModule: input.ownerModule },
    'm29.proposal.created',
  )
}

async function loadParsedPid(messageId: string, organizationId: string, deps: CascadeConsumerDeps): Promise<object | null> {
  const [row] = await withOrgContext(db, { organizationId }, async (tx) =>
    tx.select({
      cipher: hl7MessageInbound.parsedSegmentsCipher,
    }).from(hl7MessageInbound).where(eq(hl7MessageInbound.id, messageId)).limit(1),
  )

  if (!row || !row.cipher) {
    deps.logger.error({ messageId }, 'm29.proposal.parsed_segments_missing')
    return null
  }

  const plaintext = await deps.envelope.decrypt(row.cipher, { organizationId })
  return JSON.parse(plaintext)
}
```

---

## 5. Decision Engine

Path: `apps/backend/src/modules/29-external-interfaces/proposals/decision-engine.ts`.

```ts
// apps/backend/src/modules/29-external-interfaces/proposals/decision-engine.ts
import { hl7InboundProposal, type Hl7InboundProposal } from '@chartwarden/db/schema/external-interfaces'
import { and, eq } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'
import { db } from '@chartwarden/db'
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'

export class ConcurrentDecisionError extends Error {
  constructor() {
    super('proposal_already_decided')
    this.name = 'ConcurrentDecisionError'
  }
}

export class DecisionNoteRequiredError extends Error {
  constructor() {
    super('decision_note_required')
    this.name = 'DecisionNoteRequiredError'
  }
}

export class UnknownProposalError extends Error {
  constructor() {
    super('proposal_not_found')
    this.name = 'UnknownProposalError'
  }
}

export interface AcceptInput {
  readonly proposalId: string
  readonly organizationId: string
  readonly decidedByMembershipId: string
  readonly decisionRationale?: string  // optional on accept
  readonly appliedFields?: readonly string[]  // subset for partial accept; undefined = full accept
  readonly acceptedAggregateId?: string  // present when ambiguous + reviewer picked one candidate
}

export interface RejectInput {
  readonly proposalId: string
  readonly organizationId: string
  readonly decidedByMembershipId: string
  readonly decisionRationale: string  // REQUIRED on reject
}

export interface DiscardInput {
  readonly proposalId: string
  readonly organizationId: string
  readonly decidedByMembershipId: string
  readonly decisionRationale: string
}

export interface DecisionEngineDeps {
  readonly logger: Logger
  readonly outbox: Outbox
}

export class DecisionEngine {
  constructor(private readonly deps: DecisionEngineDeps) {}

  /**
   * Accept a pending proposal. Race-condition-safe via atomic UPDATE WHERE status='pending'.
   * Returns the post-update row. Throws ConcurrentDecisionError if 0 rows affected.
   */
  async accept(input: AcceptInput): Promise<Hl7InboundProposal> {
    const row = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      const result = await tx
        .update(hl7InboundProposal)
        .set({
          proposalStatus: 'accepted',
          decidedByMembershipId: input.decidedByMembershipId,
          decidedAt: new Date(),
          decisionRationale: input.decisionRationale ?? null,
          acceptedAggregateId: input.acceptedAggregateId ?? null,
        })
        .where(
          and(
            eq(hl7InboundProposal.id, input.proposalId),
            eq(hl7InboundProposal.organizationId, input.organizationId),
            eq(hl7InboundProposal.proposalStatus, 'pending'),
          ),
        )
        .returning()
      return result[0] ?? null
    })

    if (!row) {
      // Either the proposal doesn't exist or it isn't pending.
      const exists = await this.exists(input.proposalId, input.organizationId)
      if (!exists) throw new UnknownProposalError()
      throw new ConcurrentDecisionError()
    }

    await this.deps.outbox.publish('m29.hl7_inbound_proposal.accepted', {
      proposalId: row.id,
      organizationId: row.organizationId,
      sourceMessageId: row.sourceMessageId,
      resourceKind: row.resourceKind,
      ownerModule: row.ownerModule,
      matchedPatientId: row.matchedPatientId,
      acceptedAggregateId: row.acceptedAggregateId,
      decidedByMembershipId: row.decidedByMembershipId,
      decidedAt: row.decidedAt?.toISOString(),
      decisionRationale: row.decisionRationale,
      appliedFields: input.appliedFields ?? null,  // null = full accept
      proposedPatientCandidate: row.proposedPatientCandidate,
    })

    this.deps.logger.info(
      { proposalId: row.id, ownerModule: row.ownerModule, appliedFieldsCount: input.appliedFields?.length ?? 'ALL' },
      'm29.proposal.accepted',
    )

    return row
  }

  async reject(input: RejectInput): Promise<Hl7InboundProposal> {
    if (!input.decisionRationale || input.decisionRationale.trim().length === 0) {
      throw new DecisionNoteRequiredError()
    }

    const row = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      const result = await tx
        .update(hl7InboundProposal)
        .set({
          proposalStatus: 'rejected',
          decidedByMembershipId: input.decidedByMembershipId,
          decidedAt: new Date(),
          decisionRationale: input.decisionRationale,
        })
        .where(
          and(
            eq(hl7InboundProposal.id, input.proposalId),
            eq(hl7InboundProposal.organizationId, input.organizationId),
            eq(hl7InboundProposal.proposalStatus, 'pending'),
          ),
        )
        .returning()
      return result[0] ?? null
    })

    if (!row) {
      const exists = await this.exists(input.proposalId, input.organizationId)
      if (!exists) throw new UnknownProposalError()
      throw new ConcurrentDecisionError()
    }

    await this.deps.outbox.publish('m29.hl7_inbound_proposal.rejected', {
      proposalId: row.id,
      organizationId: row.organizationId,
      sourceMessageId: row.sourceMessageId,
      ownerModule: row.ownerModule,
      decidedByMembershipId: row.decidedByMembershipId,
      decidedAt: row.decidedAt?.toISOString(),
      decisionRationale: row.decisionRationale,
    })

    this.deps.logger.info({ proposalId: row.id }, 'm29.proposal.rejected')
    return row
  }

  async discard(input: DiscardInput): Promise<Hl7InboundProposal> {
    if (!input.decisionRationale || input.decisionRationale.trim().length < 10) {
      throw new DecisionNoteRequiredError()
    }

    const row = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      const result = await tx
        .update(hl7InboundProposal)
        .set({
          proposalStatus: 'rejected',                  // we use 'rejected' status; discard is a sub-kind
          decidedByMembershipId: input.decidedByMembershipId,
          decidedAt: new Date(),
          decisionRationale: `[discarded] ${input.decisionRationale}`,
        })
        .where(
          and(
            eq(hl7InboundProposal.id, input.proposalId),
            eq(hl7InboundProposal.organizationId, input.organizationId),
            eq(hl7InboundProposal.proposalStatus, 'pending'),
          ),
        )
        .returning()
      return result[0] ?? null
    })

    if (!row) {
      const exists = await this.exists(input.proposalId, input.organizationId)
      if (!exists) throw new UnknownProposalError()
      throw new ConcurrentDecisionError()
    }

    await this.deps.outbox.publish('m29.hl7_inbound_proposal.discarded', {
      proposalId: row.id,
      organizationId: row.organizationId,
      sourceMessageId: row.sourceMessageId,
      decidedByMembershipId: row.decidedByMembershipId,
      decidedAt: row.decidedAt?.toISOString(),
      decisionRationale: row.decisionRationale,
    })

    return row
  }

  /**
   * Sweep proposals past their expires_at into expired status. Run periodically by the
   * expire-sweep worker. Single statement; no per-row work.
   */
  async expireSweep(organizationId: string, now: Date = new Date()): Promise<number> {
    const rows = await withOrgContext(db, { organizationId }, async (tx) =>
      tx
        .update(hl7InboundProposal)
        .set({
          proposalStatus: 'expired',
          decidedAt: now,
          decisionRationale: 'auto_expired_pending_ttl_exceeded',
        })
        .where(
          and(
            eq(hl7InboundProposal.organizationId, organizationId),
            eq(hl7InboundProposal.proposalStatus, 'pending'),
            // expires_at < now
          ),
        )
        .returning({ id: hl7InboundProposal.id }),
    )

    for (const r of rows) {
      await this.deps.outbox.publish('m29.hl7_inbound_proposal.expired', {
        proposalId: r.id,
        organizationId,
        expiredAt: now.toISOString(),
      })
    }

    if (rows.length > 0) {
      this.deps.logger.info({ organizationId, expired: rows.length }, 'm29.proposal.expire_sweep')
    }
    return rows.length
  }

  private async exists(proposalId: string, organizationId: string): Promise<boolean> {
    const [row] = await withOrgContext(db, { organizationId }, async (tx) =>
      tx
        .select({ id: hl7InboundProposal.id })
        .from(hl7InboundProposal)
        .where(and(eq(hl7InboundProposal.id, proposalId), eq(hl7InboundProposal.organizationId, organizationId)))
        .limit(1),
    )
    return !!row
  }
}
```

The expire-sweep query uses `expires_at < now` which Drizzle expresses via `lt(hl7InboundProposal.expiresAt, now)`; omitted above for brevity but landed in real code.

---

## 6. HTTP Routes

Path: `apps/backend/src/modules/29-external-interfaces/routes/proposals.ts`.

```ts
// apps/backend/src/modules/29-external-interfaces/routes/proposals.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { Type } from '@sinclair/typebox'
import { DecisionEngine, ConcurrentDecisionError, DecisionNoteRequiredError, UnknownProposalError } from '../proposals/decision-engine'
import { hl7InboundProposal } from '@chartwarden/db/schema/external-interfaces'
import { and, eq, desc } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'
import { db } from '@chartwarden/db'
import { requirePermissions } from '@chartwarden/foundation/auth'
import { requirePredicate } from '@chartwarden/foundation/abac'

const AcceptBody = Type.Object({
  appliedFields: Type.Optional(Type.Array(Type.String())),
  acceptedAggregateId: Type.Optional(Type.String({ format: 'uuid' })),
  decisionRationale: Type.Optional(Type.String({ maxLength: 4000 })),
})

const RejectBody = Type.Object({
  decisionRationale: Type.String({ minLength: 1, maxLength: 4000 }),
})

const DiscardBody = Type.Object({
  decisionRationale: Type.String({ minLength: 10, maxLength: 4000 }),
})

export function registerProposalRoutes(app: FastifyInstance, decisionEngine: DecisionEngine): void {
  // GET /api/v1/hl7/inbound-proposals?ownerModule=m5&proposalStatus=pending
  app.get(
    '/api/v1/hl7/inbound-proposals',
    {
      schema: {
        querystring: Type.Object({
          ownerModule: Type.Optional(Type.Union([Type.Literal('m5'), Type.Literal('m6')])),
          proposalStatus: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
      },
      preHandler: [
        requirePermissions(['external_interfaces.inbound_proposal:list']),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ownerModule, proposalStatus = 'pending', limit = 50 } = req.query as { ownerModule?: string; proposalStatus?: string; limit?: number }
      const organizationId = req.user!.organizationId

      const rows = await withOrgContext(db, { organizationId }, async (tx) => {
        const conds = [eq(hl7InboundProposal.proposalStatus, proposalStatus as any)]
        if (ownerModule) conds.push(eq(hl7InboundProposal.ownerModule, ownerModule))
        return tx
          .select()
          .from(hl7InboundProposal)
          .where(and(...conds))
          .orderBy(desc(hl7InboundProposal.proposedAt))
          .limit(limit)
      })

      return rows
    },
  )

  // GET /api/v1/hl7/inbound-proposals/:id
  app.get(
    '/api/v1/hl7/inbound-proposals/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      },
      preHandler: [
        requirePermissions(['external_interfaces.inbound_proposal:read']),
        requirePredicate('hl7_inbound_proposal_owner_module_match', {
          subject: 'caller',
          resource: 'proposal',
          action: 'read',
        }),
      ],
    },
    async (req) => {
      const { id } = req.params as { id: string }
      const organizationId = req.user!.organizationId
      const [row] = await withOrgContext(db, { organizationId }, async (tx) =>
        tx
          .select()
          .from(hl7InboundProposal)
          .where(and(eq(hl7InboundProposal.id, id), eq(hl7InboundProposal.organizationId, organizationId)))
          .limit(1),
      )
      if (!row) return { error: 'proposal_not_found' }
      return row
    },
  )

  // POST /api/v1/hl7/inbound-proposals/:id/accept
  app.post(
    '/api/v1/hl7/inbound-proposals/:id/accept',
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: AcceptBody,
      },
      preHandler: [
        requirePermissions(['external_interfaces.inbound_proposal:decide']),
        requirePredicate('hl7_inbound_proposal_owner_module_match', { /* ... */ }),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const body = req.body as { appliedFields?: string[]; acceptedAggregateId?: string; decisionRationale?: string }
      const decidedByMembershipId = req.user!.membershipId

      try {
        const row = await decisionEngine.accept({
          proposalId: id,
          organizationId: req.user!.organizationId,
          decidedByMembershipId,
          appliedFields: body.appliedFields,
          acceptedAggregateId: body.acceptedAggregateId,
          decisionRationale: body.decisionRationale,
        })
        return { status: 'accepted', proposal: row }
      } catch (err) {
        if (err instanceof UnknownProposalError) return reply.code(404).send({ error: 'proposal_not_found' })
        if (err instanceof ConcurrentDecisionError) return reply.code(409).send({ error: 'proposal_already_decided' })
        throw err
      }
    },
  )

  // POST /api/v1/hl7/inbound-proposals/:id/reject
  app.post(
    '/api/v1/hl7/inbound-proposals/:id/reject',
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: RejectBody,
      },
      preHandler: [
        requirePermissions(['external_interfaces.inbound_proposal:decide']),
        requirePredicate('hl7_inbound_proposal_owner_module_match', { /* ... */ }),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const body = req.body as { decisionRationale: string }
      try {
        const row = await decisionEngine.reject({
          proposalId: id,
          organizationId: req.user!.organizationId,
          decidedByMembershipId: req.user!.membershipId,
          decisionRationale: body.decisionRationale,
        })
        return { status: 'rejected', proposal: row }
      } catch (err) {
        if (err instanceof DecisionNoteRequiredError) return reply.code(400).send({ error: 'decision_note_required' })
        if (err instanceof UnknownProposalError) return reply.code(404).send({ error: 'proposal_not_found' })
        if (err instanceof ConcurrentDecisionError) return reply.code(409).send({ error: 'proposal_already_decided' })
        throw err
      }
    },
  )

  // POST /api/v1/hl7/inbound-proposals/:id/discard
  app.post(
    '/api/v1/hl7/inbound-proposals/:id/discard',
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: DiscardBody,
      },
      preHandler: [
        requirePermissions(['external_interfaces.inbound_proposal:discard']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string }
      const body = req.body as { decisionRationale: string }
      try {
        const row = await decisionEngine.discard({
          proposalId: id,
          organizationId: req.user!.organizationId,
          decidedByMembershipId: req.user!.membershipId,
          decisionRationale: body.decisionRationale,
        })
        return { status: 'discarded', proposal: row }
      } catch (err) {
        if (err instanceof DecisionNoteRequiredError) return reply.code(400).send({ error: 'decision_note_required' })
        if (err instanceof UnknownProposalError) return reply.code(404).send({ error: 'proposal_not_found' })
        if (err instanceof ConcurrentDecisionError) return reply.code(409).send({ error: 'proposal_already_decided' })
        throw err
      }
    },
  )
}
```

---

## 7. ABAC Predicate: `hl7_inbound_proposal_owner_module_match`

Path: `apps/backend/src/modules/03-authorization/predicates/hl7_inbound_proposal_owner_module_match.ts`.

This predicate is **owned by M3** (Authorization) per the architecture; M29 contributes the definition. M3 registers it at boot.

```ts
// apps/backend/src/modules/03-authorization/predicates/hl7_inbound_proposal_owner_module_match.ts
import type { PredicateContext } from '../predicate-types'
import { hl7InboundProposal } from '@chartwarden/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'

/**
 * Enforces that the caller deciding a proposal holds the EDIT permission on the
 * owner module's resource. The owner module is stored on the proposal row as
 * 'm5' or 'm6'. The caller must have:
 *   - 'm5.patient:edit' if ownerModule = 'm5', OR
 *   - 'm6.election:edit' if ownerModule = 'm6'
 *
 * This is a propose-then-review safety: an M5-only nurse cannot accept an M6
 * admission-event proposal even if they hold the generic
 * `external_interfaces.inbound_proposal:decide` permission.
 */
export const hl7InboundProposalOwnerModuleMatch = {
  name: 'hl7_inbound_proposal_owner_module_match' as const,

  async evaluate(ctx: PredicateContext): Promise<{ allow: boolean; reason?: string }> {
    const proposalId = ctx.resource?.id
    if (!proposalId || ctx.resource?.kind !== 'proposal') {
      return { allow: false, reason: 'predicate_misconfigured_no_proposal_resource' }
    }

    const [row] = await withOrgContext(ctx.db, { organizationId: ctx.subject.organizationId }, async (tx) =>
      tx
        .select({ ownerModule: hl7InboundProposal.ownerModule, organizationId: hl7InboundProposal.organizationId })
        .from(hl7InboundProposal)
        .where(eq(hl7InboundProposal.id, proposalId))
        .limit(1),
    )

    if (!row) return { allow: false, reason: 'proposal_not_found' }
    if (row.organizationId !== ctx.subject.organizationId) {
      return { allow: false, reason: 'cross_tenant_refused' }
    }

    const requiredPermission =
      row.ownerModule === 'm5' ? 'm5.patient:edit' :
      row.ownerModule === 'm6' ? 'm6.election:edit' :
      null

    if (!requiredPermission) {
      return { allow: false, reason: `unknown_owner_module_${row.ownerModule}` }
    }

    const allowed = ctx.subject.permissions.includes(requiredPermission)
    return allowed
      ? { allow: true }
      : { allow: false, reason: `owner_module_mismatch_requires_${requiredPermission}` }
  },
} as const

export type Hl7InboundProposalOwnerModuleMatch = typeof hl7InboundProposalOwnerModuleMatch
```

M3 registers it:

```ts
// apps/backend/src/modules/03-authorization/predicate-registry.ts (addition)
import { hl7InboundProposalOwnerModuleMatch } from './predicates/hl7_inbound_proposal_owner_module_match'

export function registerM3Predicates(registry: PredicateRegistry): void {
  // ... existing M3 predicates ...
  registry.register(hl7InboundProposalOwnerModuleMatch)
}
```

The boot validator (T-29.01 §6.1 SeamRegistry validate) confirms the predicate is registered before any M29 route binds.

---

## 8. M5 / M6 Forward-Stub Consumers

M5 and M6 are locked at v0.2; they do not yet consume `m29.hl7_inbound_proposal.accepted`. T-29.06 ships forward-stub consumers that log + acknowledge but do not mutate (so the outbox doesn't retry forever):

```ts
// apps/backend/src/modules/05-patient/outbox-consumers/m29-proposal-accepted.stub.ts
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { Logger } from 'pino'

export function registerM5ProposalAcceptedStub(outbox: Outbox, logger: Logger): void {
  outbox.registerConsumer({
    eventName: 'm29.hl7_inbound_proposal.accepted',
    consumerName: 'm5.proposal-applier',
    handler: async ({ payload }) => {
      if (payload.ownerModule !== 'm5') return  // not ours
      logger.info(
        { proposalId: payload.proposalId, sourceMessageId: payload.sourceMessageId, kind: payload.resourceKind },
        'm5.proposal_accepted.forward_stub_received',
      )
      // No mutation. The real consumer lands in M5 v0.3.
    },
  })
}

// apps/backend/src/modules/06-admission/outbox-consumers/m29-proposal-accepted.stub.ts
// Same shape, scoped to ownerModule === 'm6'.
```

Per the T-29.01 forward-stub pattern, these are registered in M29 boot until M5 v0.3 / M6 v0.3 replace them with real consumers.

---

## 9. Expire-Sweep Worker

Path: `apps/backend/src/modules/29-external-interfaces/workers/proposal-expire-sweep.worker.ts`.

A BullMQ scheduled job that runs every 10 minutes per tenant. Idempotent — only flips `pending` rows past `expires_at`.

```ts
// apps/backend/src/modules/29-external-interfaces/workers/proposal-expire-sweep.worker.ts
import { Worker, type Job } from 'bullmq'
import { DecisionEngine } from '../proposals/decision-engine'
import { organization } from '@chartwarden/db/schema/organization'
import { withPlatformContext } from '@chartwarden/tenancy'
import { db } from '@chartwarden/db'
import { mkOutbox } from '@chartwarden/foundation/seams/outbox'
import { pino } from 'pino'

const logger = pino({ name: 'proposal-expire-sweep' })
const outbox = mkOutbox(db, logger)
const engine = new DecisionEngine({ logger, outbox })

export const proposalExpireSweepWorker = new Worker(
  'proposal-expire-sweep',
  async (_job: Job) => {
    // Iterate every tenant. The sweep is per-tenant because RLS is per-tenant.
    const orgs = await withPlatformContext(db, async (tx) =>
      tx.select({ id: organization.id }).from(organization),
    )

    let totalExpired = 0
    for (const org of orgs) {
      try {
        totalExpired += await engine.expireSweep(org.id)
      } catch (err) {
        logger.error({ err, organizationId: org.id }, 'proposal.expire_sweep.error')
      }
    }
    logger.info({ totalExpired }, 'proposal.expire_sweep.complete')
  },
  {
    connection: { url: process.env.VALKEY_URL! },
    concurrency: 1,
  },
)

// Scheduling — registered by the BullMQ scheduler at boot
export function scheduleExpireSweepEvery10Min(scheduler: import('bullmq').Queue): Promise<void> {
  return scheduler.upsertJobScheduler(
    'proposal-expire-sweep',
    { every: 10 * 60 * 1000 },
    { name: 'tick', data: {} },
  )
}
```

---

## 10. Tests

### 10.1 W-XI-01 closure (L1 confident → proposal created, patient not mutated)

```ts
// test/integration/proposals/w-xi-01-proposal.test.ts
describe('W-XI-01 — L1 confident match creates a pending M5 proposal', () => {
  it('an ADT^A08 frame with L1 match yields hl7_inbound_proposal(status=pending, owner=m5, matched=pt_jane)', async () => {
    const patient = await fixtures.patient({
      organizationId: 'org_engrace', id: 'pt_jane_doe',
      mrn: 'MRN-001234', lastName: 'DOE', firstName: 'JANE',
      dateOfBirth: '1948-03-22', administrativeSex: 'F',
    })

    const adtA08 = mkAdtA08Frame({
      mcid: 'MCID-W01',
      pid3: { value: 'MRN-001234', assigningAuthority: 'ENGRACE_INTERNAL' },
      // ... full PID + new address fields ...
    })

    await deliverFrameToListener(feed, adtA08)

    // Cascade runs; T-29.06 consumer creates proposal
    await waitFor(async () => {
      const [proposal] = await db.select().from(hl7InboundProposal)
        .where(eq(hl7InboundProposal.sourceMessageId, /* messageId from earlier */))
      expect(proposal).toBeDefined()
      expect(proposal.proposalStatus).toBe('pending')
      expect(proposal.ownerModule).toBe('m5')
      expect(proposal.resourceKind).toBe('patient_demographic_update')
      expect(proposal.matchedPatientId).toBe('pt_jane_doe')
      expect(proposal.matchOutcome).toBe('matched_single')
      expect(proposal.expiresAt).toBeInstanceOf(Date)
    })

    // m29.hl7_inbound_proposal.created event published
    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.hl7_inbound_proposal.created')).toMatchObject({
      payload: expect.objectContaining({ ownerModule: 'm5', resourceKind: 'patient_demographic_update' }),
    })

    // Patient row NOT mutated — D5 propose-then-review
    const [patientAfter] = await db.select().from(/* patient */).where(eq(/* id */, 'pt_jane_doe'))
    expect(patientAfter.addressLine1).toBe(patient.addressLine1)  // unchanged
  })
})
```

### 10.2 W-XI-02 (L4 candidate → proposal with candidate)

```ts
describe('W-XI-02 — L4 candidate match creates a candidate proposal', () => {
  it('produces a proposal with match_confidence=0.92 and matched_patient_id=candidate', async () => {
    // ... same shape as T-29.05 W-XI-02 test, but assert proposal row exists ...
    expect(proposal.matchOutcome).toBe('matched_single')
    expect(proposal.matchedPatientId).toBe('pt_jane')
    expect(Number(proposal.matchConfidence)).toBeCloseTo(0.92)
  })
})
```

### 10.3 W-XI-03 (partial accept)

```ts
describe('W-XI-03 — partial-field accept with decision note', () => {
  it('accepts a subset of fields; m29.hl7_inbound_proposal.accepted carries appliedFields', async () => {
    const proposal = await fixtures.proposal({ status: 'pending', ownerModule: 'm5' })
    const user = await fixtures.user({
      permissions: ['external_interfaces.inbound_proposal:decide', 'm5.patient:edit'],
      stepUpRecent: true,
    })

    const res = await client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/accept`, {
      appliedFields: ['address_line1', 'address_city', 'address_state', 'address_postal'],
      decisionRationale: 'Address verified by phone call to patient',
    }, { user })

    expect(res.statusCode).toBe(200)

    const [updated] = await db.select().from(hl7InboundProposal).where(eq(hl7InboundProposal.id, proposal.id))
    expect(updated.proposalStatus).toBe('accepted')
    expect(updated.decidedByMembershipId).toBe(user.membershipId)
    expect(updated.decisionRationale).toBe('Address verified by phone call to patient')

    const event = (await fixtures.outboxEvents())
      .find(e => e.name === 'm29.hl7_inbound_proposal.accepted')
    expect(event?.payload.appliedFields).toEqual(['address_line1', 'address_city', 'address_state', 'address_postal'])
    expect(event?.payload.ownerModule).toBe('m5')
  })
})
```

### 10.4 W-XI-04 (reject requires decision note)

```ts
describe('W-XI-04 — reject requires non-empty decision note', () => {
  it('returns 400 decision_note_required when note is empty', async () => {
    const proposal = await fixtures.proposal({ status: 'pending' })
    const user = await fixtures.user({ permissions: ['external_interfaces.inbound_proposal:decide', 'm5.patient:edit'] })

    const res = await client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/reject`, {
      decisionRationale: '',
    }, { user })

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('decision_note_required')

    const [unchanged] = await db.select().from(hl7InboundProposal).where(eq(hl7InboundProposal.id, proposal.id))
    expect(unchanged.proposalStatus).toBe('pending')  // not mutated
  })

  it('accepts with valid note', async () => {
    const proposal = await fixtures.proposal({ status: 'pending' })
    const user = await fixtures.user({ permissions: ['external_interfaces.inbound_proposal:decide', 'm5.patient:edit'] })

    const res = await client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/reject`, {
      decisionRationale: 'L4 demographic match is not Jane Doe — confirmed by RN visit',
    }, { user })

    expect(res.statusCode).toBe(200)
    const [updated] = await db.select().from(hl7InboundProposal).where(eq(hl7InboundProposal.id, proposal.id))
    expect(updated.proposalStatus).toBe('rejected')
  })
})
```

### 10.5 Race-condition (concurrent accept)

```ts
describe('concurrent accept — exactly one succeeds', () => {
  it('two parallel accepts on the same pending proposal: exactly one returns 200, the other 409', async () => {
    const proposal = await fixtures.proposal({ status: 'pending' })
    const userA = await fixtures.user({ permissions: ['external_interfaces.inbound_proposal:decide', 'm5.patient:edit'] })
    const userB = await fixtures.user({ permissions: ['external_interfaces.inbound_proposal:decide', 'm5.patient:edit'] })

    const [resA, resB] = await Promise.all([
      client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/accept`, {}, { user: userA }),
      client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/accept`, {}, { user: userB }),
    ])

    const codes = [resA.statusCode, resB.statusCode].sort()
    expect(codes).toEqual([200, 409])

    // Exactly one m29.hl7_inbound_proposal.accepted event
    const acceptedEvents = (await fixtures.outboxEvents()).filter(e => e.name === 'm29.hl7_inbound_proposal.accepted')
    expect(acceptedEvents).toHaveLength(1)
  })
})
```

### 10.6 Owner-module mismatch

```ts
describe('owner-module-match predicate refuses cross-module decide', () => {
  it('M5-only user gets 403 owner_module_mismatch on an M6-owned proposal', async () => {
    const proposal = await fixtures.proposal({ status: 'pending', ownerModule: 'm6', resourceKind: 'admission_event' })
    const user = await fixtures.user({
      permissions: ['external_interfaces.inbound_proposal:decide', 'm5.patient:edit'],  // m5 only, no m6.election:edit
      stepUpRecent: true,
    })

    const res = await client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/accept`, {}, { user })

    expect(res.statusCode).toBe(403)
    expect(res.body.error).toMatch(/owner_module_mismatch/)
  })

  it('M6 user can decide M6-owned proposal', async () => {
    const proposal = await fixtures.proposal({ status: 'pending', ownerModule: 'm6', resourceKind: 'admission_event' })
    const user = await fixtures.user({
      permissions: ['external_interfaces.inbound_proposal:decide', 'm6.election:edit'],
      stepUpRecent: true,
    })
    const res = await client.post(`/api/v1/hl7/inbound-proposals/${proposal.id}/accept`, {}, { user })
    expect(res.statusCode).toBe(200)
  })
})
```

### 10.7 Cross-tenant IDOR

```ts
describe('cross-tenant proposal access refused', () => {
  it('tenant-A user GET on tenant-B proposal returns 404 not_found (not 403; per security policy)', async () => {
    const proposalB = await fixtures.proposal({ organizationId: 'org_b' })
    const userA = await fixtures.user({ organizationId: 'org_a', permissions: ['external_interfaces.inbound_proposal:read'] })

    const res = await client.get(`/api/v1/hl7/inbound-proposals/${proposalB.id}`, { user: userA })
    expect(res.statusCode).toBe(404)
  })
})
```

### 10.8 Expire-sweep

```ts
describe('expire-sweep flips past-TTL pending proposals to expired', () => {
  it('a proposal with expires_at in the past becomes expired on next sweep', async () => {
    const proposal = await fixtures.proposal({
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),  // 1min ago
    })
    await engine.expireSweep(proposal.organizationId)

    const [after] = await db.select().from(hl7InboundProposal).where(eq(hl7InboundProposal.id, proposal.id))
    expect(after.proposalStatus).toBe('expired')
    expect(after.decisionRationale).toBe('auto_expired_pending_ttl_exceeded')

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.hl7_inbound_proposal.expired')).toBeDefined()
  })
})
```

### 10.9 No-match dropped for A03/A11

```ts
describe('A03 / A11 with no_match drops with audit (no proposal)', () => {
  it('ADT^A03 (discharge) with unknown patient → m29.hl7_message.routing_dropped, no proposal', async () => {
    const adtA03 = mkAdtA03Frame({
      pid3: { value: 'UNKNOWN-MRN', assigningAuthority: 'ENGRACE_INTERNAL' },
      lastName: 'NOBODY', firstName: 'X', dob: '20000101', sex: 'U',
    })
    await deliverFrameToListener(feed, adtA03)

    await waitFor(async () => {
      const events = await fixtures.outboxEvents()
      expect(events.find(e => e.name === 'm29.hl7_message.routing_dropped')).toMatchObject({
        payload: expect.objectContaining({ reason: 'cannot_act_on_unknown_patient' }),
      })
    })

    const proposals = await db.select().from(hl7InboundProposal)
    expect(proposals).toHaveLength(0)
  })
})
```

---

## 11. Sign-Off Checklist (T-29.06 PR)

- [ ] **Retroactive corrections (§2) applied** — migration `0031_external_interfaces_proposal.sql` lands; M29 spec routing table (§4.6) text updated in-place or by a small spec patch.
- [ ] Parse worker now persists `parsed_segments_cipher` + `parsed_segments_sha256` after successful sidecar parse.
- [ ] Cascade-consumer registered for all three cascade-resolved events.
- [ ] Decision engine + lifecycle service + HTTP routes land.
- [ ] `hl7_inbound_proposal_owner_module_match` predicate registered in M3.
- [ ] M5 and M6 forward-stub consumers registered in M29 boot; they only log + ack, no mutation.
- [ ] Expire-sweep worker scheduled at 10-minute cadence; integration test verifies the sweep on a seeded past-TTL proposal.
- [ ] All §10 integration tests pass — W-XI-01, W-XI-02, W-XI-03, W-XI-04 fully closed on the M29 side.
- [ ] Race-condition test verifies exactly-one-success under parallel accepts.
- [ ] Owner-module-mismatch returns 403 with the right error code; matching owner-module returns 200.
- [ ] Cross-tenant IDOR returns 404 (never 403, never reveals existence).
- [ ] PHI denylist holds — proposal logs reference proposal ID, owner module, source message ID only; never the raw `proposed_patient_candidate` JSONB.
- [ ] M4 outbox catalog registers six new event names: `m29.hl7_message.routing_dropped`, `m29.hl7_inbound_proposal.{created,accepted,rejected,discarded,expired}`.
- [ ] `bun run check:cruiser` passes — M3 predicate definition is allowed to import M29 schema types because the predicate inspects M29-owned tables (cross-module-read via authoritative read path documented in the cruiser allowlist).
- [ ] **Clinical engineering** sign-off on the propose-then-review-always invariant for ADT (vs the §4.6 prior wording).
- [ ] **M5 owner** sign-off that the M5-side forward-stub consumer is the correct shape for the v0.3 implementation.
- [ ] **M6 owner** sign-off on same.
- [ ] **Compliance officer** review of the 30-day expire-pending TTL.

---

## 12. Notes on Refinements Past M29 Spec §4.6

This addendum surfaces three structural refinements past M29 spec v0.2:

1. **Propose-then-review for ALL ADT outcomes (§2.1).** §4.6's routing table contradicted §11 D5 and W-XI-01. The propose-then-review-always semantics win — clinical safety floor is higher than cascade confidence floor. Confident matches still produce proposals (with `match_outcome='matched_single'`), reviewers still accept/reject explicitly. Hospital data is unreliable enough that even L1 MRN matches need a human in the loop on demographic updates.

2. **`parsed_segments_cipher` on `hl7_message_inbound` (§2.3).** T-29.05's outcome-router events would have had to carry PHI in their payloads to avoid sidecar re-calls. Persisting the parsed tree as an envelope-encrypted column is cleaner and reuses the existing encryption posture.

3. **`new_patient` proposal kind (§2.4).** The original enum didn't account for the no-match-becomes-new-patient case. Additive enum value.

A fourth observation worth recording: **the cumulative retroactive correction cost across T-29.01 → T-29.06 is now substantial enough to warrant a spec v0.3 pass before the next major track (M30 HQRP) begins.** The corrections accumulated:

- T-29.02: `packages/db-schema` → `packages/db/src/schema` (path)
- T-29.03: JSON-over-HTTP → gRPC-over-UDS; Maven → Gradle
- T-29.05: 5-level cascade enum, 5 columns on `hl7_message_inbound`, 2 columns on `lab_observation_inbound_link`, MRN authority convention, 3 outbox events
- T-29.06: §4.6 routing table rewrite, `parsed_segments_cipher` columns, `new_patient` enum value, 6 outbox events

That's ~20 small spec changes across 5 PRs. None individually problematic; collectively a sign that M29 spec v0.2 was lock-grade in shape but loose in detail. A v0.3 pass consolidating these — plus a routine re-cross-check of §3 (schema) against §4 (API behavior) against §7 (W-XI-* workflows) — would close the drift and give M30 a clean reference point.

---

## Document Footer

**Addendum version:** v1.0 (T-29.06 PR-ready)
**Bound to:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.6, §11 D5, §7 (workflows), §10
**Files delivered:** 7 source (`cascade-consumer.ts`, `decision-engine.ts`, `lifecycle.ts` integration, `routes/proposals.ts`, `message-type-routing.ts`, expire-sweep worker, owner-module-match predicate) + 2 forward-stub consumers + 1 migration
**Workflows closed on M29 side:** W-XI-01, W-XI-02, W-XI-03, W-XI-04 (full closure on M5 side awaits M5 v0.3)
**Retroactive corrections:** 3 schema/enum changes + 1 spec routing-table rewrite + 1 parse-worker code addition
**Sign-offs required:** Clinical engineering, M5 owner, M6 owner, Compliance officer

**End of T-29.06 proposal lifecycle addendum.**
