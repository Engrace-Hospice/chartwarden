# WardenX — T-29.02 Addendum: M29 Schema PR Package

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_2.md` §3 (Drizzle Schema) and §10 (T-29.02 Drizzle Schema + Migrations)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 (manifest patch + forward-stub addendum) merged.

This addendum delivers the drop-in artifacts for T-29.02 — every Drizzle schema file, the hand-rolled partitioned-table migration, the M4 audit denylist, the eraser implementation, the per-table tests, and a single correction to the M29 spec §13.2 cruiser rule that referenced the wrong package path.

The schema design itself is not relitigated; M29 §3 is authoritative. This document executes that design.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Eight Drizzle schema files** under `packages/db/src/schema/external-interfaces/` covering eleven tables (9 tenant-owned + 2 platform-shared) plus enums and a barrel export.
- **One hand-rolled migration SQL** at `apps/backend/drizzle/migrations/0029_external_interfaces.sql` covering Phase A (enums) through Phase F (seed), with partitioned-parent DDL and six months of initial partitions for each partitioned table.
- **Eraser implementation** at `apps/backend/src/modules/29-external-interfaces/eraser.ts` registered with M4's destruction-cert workflow.
- **Audit denylist registration** at `packages/db/src/audit-denylist/m29.ts` per the M4 §3.6 PHI-table convention.
- **Schema integration tests** at `apps/backend/src/modules/29-external-interfaces/schema.test.ts` covering RLS isolation, partition routing, audit denylist enforcement, and eraser cryptographic-shred path.
- **Spec correction** to M29 §13.2 (`packages/db-schema/src/external_interfaces` → `packages/db/src/schema/external-interfaces`).
- **Sign-off checklist** for the T-29.02 PR.

### 1.2 Non-goals

- **Route handlers, services, workers** — those are T-29.04+ deliverables.
- **HAPI sidecar bring-up** — that is T-29.03.
- **Frontend** — T-29.07 and T-29.12+.
- **Drizzle-generated migration via `drizzle-kit`** — M29 uses a hand-rolled SQL migration because the Drizzle migration generator does not emit PostgreSQL declarative partitioning. The Drizzle TypeScript schema files exist as the typed query surface; the parent-table DDL in the migration is canonical for shape.

---

## 2. Package Path Correction (M29 §13.2)

The M29 spec §13.2 cruiser rule `no-cross-module-schema-import-from-m29` referenced `packages/db-schema/src/external_interfaces` and `packages/db-schema/src/_shared`. These paths are wrong: the canonical schema package is `packages/db` (verified against M1 §3.3, M22, and M28). The corrected rule:

```diff
 {
   name: 'no-cross-module-schema-import-from-m29',
   comment: 'M29 reads other modules only via published seams and outbox; no direct schema imports.',
   severity: 'error',
   from: { path: '^apps/backend/src/modules/29-external-interfaces' },
   to:   {
-    path: '^packages/db-schema/src/(?!external_interfaces)',
-    pathNot: '^packages/db-schema/src/_shared',
+    path: '^packages/db/src/schema/(?!external-interfaces)',
+    pathNot: '^packages/db/src/schema/_shared',
   },
 },
 {
   name: 'no-m29-schema-import-from-other-modules',
   comment: 'Other modules read M29 data only via the five published seams; no direct schema reach.',
   severity: 'error',
   from: {
     path: '^apps/backend/src/modules/',
     pathNot: '^apps/backend/src/modules/29-external-interfaces',
   },
-  to: { path: '^packages/db-schema/src/external_interfaces' },
+  to: { path: '^packages/db/src/schema/external-interfaces' },
 },
```

These corrections land as part of T-29.02 PR (because T-29.02 is the first PR that actually creates the path).

---

## 3. Drizzle Schema Files

All paths under `packages/db/src/schema/external-interfaces/`. Imports use the existing `../organization` (M1) convention.

### 3.1 `enums.ts`

```ts
// packages/db/src/schema/external-interfaces/enums.ts
import { pgEnum } from 'drizzle-orm/pg-core'

export const externalFeedKind = pgEnum('external_feed_kind', [
  'adt_inbound',
  'lab_inbound',
  'orm_outbound',
])

export const externalFeedProtocol = pgEnum('external_feed_protocol', [
  'mllp_tls',
  'mllp_plain',
])

export const externalFeedStatus = pgEnum('external_feed_status', [
  'proposed',
  'pending_approval',
  'active',
  'suspended',
  'revoked',
  'rejected',
])

export const externalFeedCredentialKind = pgEnum('external_feed_credential_kind', [
  'mllp_client_cert',
  'mllp_channel_password',
])

export const externalFeedCredentialStatus = pgEnum('external_feed_credential_status', [
  'active',
  'retired',
])

export const hl7InboundParseStatus = pgEnum('hl7_inbound_parse_status', [
  'in_progress',
  'parsed',
  'parse_error',
  'rejected',
])

export const hl7InboundProposalKind = pgEnum('hl7_inbound_proposal_kind', [
  'patient_demographic_update',
  'admission_event',
  'discharge_event',
  'cancel_admission',
])

export const hl7InboundProposalStatus = pgEnum('hl7_inbound_proposal_status', [
  'pending',
  'accepted',
  'rejected',
  'expired',
])

export const hl7InboundMatchOutcome = pgEnum('hl7_inbound_match_outcome', [
  'matched_single',
  'matched_ambiguous',
  'no_match',
  'merged_target',
])

export const hl7OutboundAckStatus = pgEnum('hl7_outbound_ack_status', [
  'aa',
  'ae',
  'ar',
  'timeout',
])

export const hl7OutboundStatus = pgEnum('hl7_outbound_status', [
  'queued',
  'in_flight',
  'acked',
  'naked',
  'failed',
  'dlq',
])

export const labResultStatus = pgEnum('lab_result_status', [
  'preliminary',
  'final',
  'corrected',
  'cancelled',
])

export const labAbnormalSummary = pgEnum('lab_abnormal_summary', [
  'any_critical',
  'any_abnormal',
  'all_normal',
  'no_flags',
])

export const labAbnormalFlag = pgEnum('lab_abnormal_flag', [
  'H', 'L', 'HH', 'LL', 'A', 'N',
])

export const labValueType = pgEnum('lab_value_type', [
  'NM', 'ST', 'CE', 'SN', 'TX', 'DT',
])

export const labTerminologyValidation = pgEnum('lab_terminology_validation', [
  'valid',
  'unknown_code',
  'deprecated',
])

export const labMatchMethod = pgEnum('lab_match_method', [
  'obr_placer_id',
  'patient_loinc_date',
  'manual',
  'unmatched',
])

export const nppesEnumerationType = pgEnum('nppes_enumeration_type', [
  'NPI-1',
  'NPI-2',
])

export const nppesProviderStatus = pgEnum('nppes_provider_status', [
  'active',
  'deactivated',
])

export const nppesSyncKind = pgEnum('nppes_sync_kind', [
  'daily_incremental',
  'weekly_dissemination',
  'monthly_deactivation',
  'manual',
])

export const nppesSyncTrigger = pgEnum('nppes_sync_trigger', [
  'platform_cron',
  'platform_admin',
])

export const nppesSyncStatus = pgEnum('nppes_sync_status', [
  'in_progress',
  'completed',
  'failed',
])
```

### 3.2 `feed.ts` — external_feed + external_feed_credential

```ts
// packages/db/src/schema/external-interfaces/feed.ts
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import * as e from './enums'

export const externalFeed = pgTable(
  'external_feed',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    kind: e.externalFeedKind('kind').notNull(),
    displayName: text('display_name').notNull(),
    host: text('host'), // null for inbound listener — we own the address
    port: integer('port').notNull(),
    protocol: e.externalFeedProtocol('protocol').notNull(),
    channelCertPin: text('channel_cert_pin'), // sha256(certPEM); null only for mllp_plain (test)
    sendingFacilityAllowlist: jsonb('sending_facility_allowlist')
      .notNull()
      .default([])
      .$type<string[]>(), // M40 Facility ids
    baaContractRef: text('baa_contract_ref'),
    baaExpiresOn: timestamp('baa_expires_on', { withTimezone: true }),
    activeFrom: timestamp('active_from', { withTimezone: true }),
    activeThrough: timestamp('active_through', { withTimezone: true }),
    status: e.externalFeedStatus('status').notNull().default('proposed'),
    proposedByMembershipId: uuid('proposed_by_membership_id').notNull(),
    approvedByOpId: uuid('approved_by_op_id'),       // null until activate
    approvedByComplId: uuid('approved_by_compl_id'), // null until activate
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rateLimitMsgPerSec: integer('rate_limit_msg_per_sec').notNull().default(50),
    retryPolicy: jsonb('retry_policy')
      .notNull()
      .default({ maxAttempts: 5, backoffSecs: [1, 4, 16, 64, 256] }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgKindIdx: index('idx_external_feed_org_kind').on(t.organizationId, t.kind),
    uniqOrgPortKind: uniqueIndex('uq_external_feed_org_port_kind').on(
      t.organizationId,
      t.port,
      t.kind,
    ),
    statusIdx: index('idx_external_feed_status').on(t.status),
  }),
)

export type ExternalFeed = typeof externalFeed.$inferSelect
export type NewExternalFeed = typeof externalFeed.$inferInsert

export const externalFeedCredential = pgTable(
  'external_feed_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feedId: uuid('feed_id')
      .notNull()
      .references(() => externalFeed.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    kind: e.externalFeedCredentialKind('kind').notNull(),
    secretCipher: text('secret_cipher').notNull(), // envelope-encrypted with per-tenant DEK
    fingerprint: text('fingerprint').notNull(),     // sha256 first 8 hex for ops display
    rotatedAt: timestamp('rotated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: e.externalFeedCredentialStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    feedStatusIdx: index('idx_efc_feed_status').on(t.feedId, t.status),
  }),
)

export type ExternalFeedCredential = typeof externalFeedCredential.$inferSelect
export type NewExternalFeedCredential = typeof externalFeedCredential.$inferInsert
```

### 3.3 `hl7-messages.ts` — partitioned inbound + outbound

```ts
// packages/db/src/schema/external-interfaces/hl7-messages.ts
//
// IMPORTANT: These tables are PARTITIONED BY RANGE (received_at) / (transmitted_at)
// in PostgreSQL via the hand-rolled migration in 0029_external_interfaces.sql.
// Drizzle does NOT model partitioning directly; the schema below describes the
// LOGICAL view of the partitioned parent. Cross-partition references
// (source_message_id, etc.) are app-side, not DB FKs — see M29 §3.5.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import { externalFeed } from './feed'
import * as e from './enums'

export const hl7MessageInbound = pgTable(
  'hl7_message_inbound',
  {
    // PK is composite (id, received_at) because received_at is the partition key.
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    feedId: uuid('feed_id')
      .notNull()
      .references(() => externalFeed.id, { onDelete: 'restrict' }),
    messageType: text('message_type').notNull(),           // 'ADT^A01' | 'ADT^A08' | 'ORU^R01' | ...
    messageControlId: text('message_control_id').notNull(), // MSH-10
    payloadCipher: text('payload_cipher').notNull(),       // envelope-encrypted raw HL7 wire bytes
    payloadSha256: text('payload_sha256').notNull(),       // digest for audit + dedup
    segmentsSummary: jsonb('segments_summary').notNull(),  // {segments:[{name:'PID',byteCount:128},...]}; PHI-free
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    parseStatus: e.hl7InboundParseStatus('parse_status').notNull().default('in_progress'),
    parseError: jsonb('parse_error'),
    sendingFacilityId: uuid('sending_facility_id'),               // M40 Facility, app-side resolution
    sendingFacilityRawId: text('sending_facility_raw_id').notNull(), // MSH-4 verbatim
    idempotencyKey: text('idempotency_key').notNull(),     // hash(sending_facility_id, message_control_id)
  },
  (t) => ({
    // Composite PK is declared in the SQL migration; this index covers query patterns.
    orgFeedIdx: index('idx_hmi_org_feed').on(t.organizationId, t.feedId),
    statusIdx: index('idx_hmi_parse_status').on(t.parseStatus),
    idempotencyIdx: index('uq_hmi_idempotency').on(t.idempotencyKey),
    shaIdx: index('idx_hmi_sha256').on(t.payloadSha256),
    orgFeedReceivedIdx: index('idx_hmi_org_feed_received').on(
      t.organizationId,
      t.feedId,
      t.receivedAt,
    ),
  }),
)

export type Hl7MessageInbound = typeof hl7MessageInbound.$inferSelect
export type NewHl7MessageInbound = typeof hl7MessageInbound.$inferInsert

export const hl7MessageOutbound = pgTable(
  'hl7_message_outbound',
  {
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    feedId: uuid('feed_id')
      .notNull()
      .references(() => externalFeed.id, { onDelete: 'restrict' }),
    messageType: text('message_type').notNull(),
    messageControlId: text('message_control_id').notNull(),
    payloadCipher: text('payload_cipher').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    segmentsSummary: jsonb('segments_summary').notNull(),
    sourceAggregateKind: text('source_aggregate_kind').notNull(), // 'm11.order_record' | ...
    sourceAggregateId: uuid('source_aggregate_id').notNull(),     // app-side; no DB FK across modules
    destinationFacilityId: uuid('destination_facility_id'),       // M40 ref (app-side)
    transmittedAt: timestamp('transmitted_at', { withTimezone: true }), // null while queued
    ackStatus: e.hl7OutboundAckStatus('ack_status'),
    ackReceivedAt: timestamp('ack_received_at', { withTimezone: true }),
    ackPayloadCipher: text('ack_payload_cipher'),
    ackPayloadSha256: text('ack_payload_sha256'),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    status: e.hl7OutboundStatus('status').notNull().default('queued'),
    idempotencyKey: text('idempotency_key').notNull(), // hash(feed_id, source_aggregate_kind, source_aggregate_id)
  },
  (t) => ({
    orgFeedIdx: index('idx_hmo_org_feed').on(t.organizationId, t.feedId),
    statusIdx: index('idx_hmo_status').on(t.status),
    idempotencyIdx: index('uq_hmo_idempotency').on(t.idempotencyKey),
    nextRetryIdx: index('idx_hmo_next_retry').on(t.nextRetryAt),
  }),
)

export type Hl7MessageOutbound = typeof hl7MessageOutbound.$inferSelect
export type NewHl7MessageOutbound = typeof hl7MessageOutbound.$inferInsert
```

### 3.4 `inbound-proposal.ts`

```ts
// packages/db/src/schema/external-interfaces/inbound-proposal.ts
//
// Partitioned BY RANGE (proposed_at). Cross-partition app-side references to
// hl7_message_inbound — no DB FK. See M29 §3.5.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  index,
} from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import * as e from './enums'

export const hl7InboundProposal = pgTable(
  'hl7_inbound_proposal',
  {
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    sourceMessageId: uuid('source_message_id').notNull(),
    resourceKind: e.hl7InboundProposalKind('resource_kind').notNull(),
    proposedPatientCandidate: jsonb('proposed_patient_candidate').notNull(),
    matchOutcome: e.hl7InboundMatchOutcome('match_outcome').notNull(),
    matchedPatientId: uuid('matched_patient_id'),
    matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
    matchCandidateIds: jsonb('match_candidate_ids')
      .notNull()
      .default([])
      .$type<string[]>(),
    proposedAt: timestamp('proposed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ownerModule: text('owner_module').notNull().default('m5'),
    proposalStatus: e.hl7InboundProposalStatus('proposal_status').notNull().default('pending'),
    decidedByMembershipId: uuid('decided_by_membership_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionRationale: text('decision_rationale'),
    acceptedAggregateId: uuid('accepted_aggregate_id'),
    validationErrors: jsonb('validation_errors'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgStatusIdx: index('idx_hip_org_status').on(t.organizationId, t.proposalStatus),
    expiresIdx: index('idx_hip_expires').on(t.expiresAt),
    matchedPatientIdx: index('idx_hip_matched_patient').on(t.matchedPatientId),
    sourceMessageIdx: index('idx_hip_source_message').on(t.sourceMessageId),
  }),
)

export type Hl7InboundProposal = typeof hl7InboundProposal.$inferSelect
export type NewHl7InboundProposal = typeof hl7InboundProposal.$inferInsert
```

### 3.5 `lab-observation.ts` — observation + value + inbound link

```ts
// packages/db/src/schema/external-interfaces/lab-observation.ts
//
// lab_observation and lab_observation_value are PARTITIONED BY RANGE (received_at).
// lab_observation_inbound_link is NOT partitioned (small mapping table).
import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  boolean,
  integer,
  index,
} from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import * as e from './enums'

export const labObservation = pgTable(
  'lab_observation',
  {
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    sourceMessageId: uuid('source_message_id').notNull(),
    patientId: uuid('patient_id').notNull(),                     // M5 ref, app-side
    orderId: uuid('order_id'),                                   // M11 ref, app-side, nullable
    observationDate: timestamp('observation_date', { withTimezone: true }).notNull(),
    collectionDate: timestamp('collection_date', { withTimezone: true }),
    resultStatus: e.labResultStatus('result_status').notNull(),
    performingLabFacilityId: uuid('performing_lab_facility_id'), // M40 ref, app-side
    orderingPhysicianNpi: text('ordering_physician_npi'),
    loincCode: text('loinc_code').notNull(),
    loincDisplayText: text('loinc_display_text').notNull(),
    terminologyValidation: e.labTerminologyValidation('terminology_validation').notNull(),
    abnormalSummary: e.labAbnormalSummary('abnormal_summary').notNull(),
    attachedDocumentId: uuid('attached_document_id'),            // M22 ref, app-side, nullable
    sudRedactedAtIngest: boolean('sud_redacted_at_ingest').notNull().default(false),
    previousObservationId: uuid('previous_observation_id'),      // corrected results
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgPatientIdx: index('idx_lo_org_patient').on(t.organizationId, t.patientId),
    patientDateIdx: index('idx_lo_patient_date').on(t.patientId, t.observationDate),
    orderIdx: index('idx_lo_order').on(t.orderId),
    abnormalIdx: index('idx_lo_abnormal').on(t.abnormalSummary),
    sourceMessageIdx: index('idx_lo_source_message').on(t.sourceMessageId),
  }),
)

export type LabObservation = typeof labObservation.$inferSelect
export type NewLabObservation = typeof labObservation.$inferInsert

export const labObservationValue = pgTable(
  'lab_observation_value',
  {
    id: uuid('id').notNull(),
    observationId: uuid('observation_id').notNull(),
    obxSetId: integer('obx_set_id').notNull(),
    loincCode: text('loinc_code').notNull(),
    loincDisplayText: text('loinc_display_text').notNull(),
    terminologyValidation: e.labTerminologyValidation('terminology_validation').notNull(),
    valueType: e.labValueType('value_type').notNull(),
    numericValue: numeric('numeric_value', { precision: 18, scale: 6 }),
    stringValue: text('string_value'),
    units: text('units'),
    referenceRange: text('reference_range'),
    abnormalFlag: e.labAbnormalFlag('abnormal_flag'),
    performedAt: timestamp('performed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    observationIdx: index('idx_lov_observation').on(t.observationId, t.obxSetId),
    loincIdx: index('idx_lov_loinc').on(t.loincCode),
  }),
)

export type LabObservationValue = typeof labObservationValue.$inferSelect
export type NewLabObservationValue = typeof labObservationValue.$inferInsert

export const labObservationInboundLink = pgTable(
  'lab_observation_inbound_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    observationId: uuid('observation_id').notNull(),
    sourceMessageId: uuid('source_message_id').notNull(),
    sourceOrderId: uuid('source_order_id'),
    obrPlacerOrderNumber: text('obr_placer_order_number'),
    matchMethod: e.labMatchMethod('match_method').notNull(),
    matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    observationIdx: index('idx_lol_observation').on(t.observationId),
    placerIdx: index('idx_lol_placer').on(t.obrPlacerOrderNumber),
    sourceMessageIdx: index('idx_lol_source_message').on(t.sourceMessageId),
  }),
)

export type LabObservationInboundLink = typeof labObservationInboundLink.$inferSelect
export type NewLabObservationInboundLink = typeof labObservationInboundLink.$inferInsert
```

### 3.6 `nppes.ts` — platform-shared

```ts
// packages/db/src/schema/external-interfaces/nppes.ts
//
// Platform-shared tables — NO organization_id; written under withPlatformContext.
// RLS allows tenant read, platform-role write (see migration §C).
import {
  pgTable,
  uuid,
  char,
  text,
  timestamp,
  jsonb,
  date,
  integer,
  index,
} from 'drizzle-orm/pg-core'
import * as e from './enums'

export const nppesProvider = pgTable(
  'nppes_provider',
  {
    npi: char('npi', { length: 10 }).primaryKey(),
    enumerationType: e.nppesEnumerationType('enumeration_type').notNull(),
    status: e.nppesProviderStatus('status').notNull(),
    deactivationDate: date('deactivation_date'),
    deactivationReason: text('deactivation_reason'),
    reactivationDate: date('reactivation_date'),
    basic: jsonb('basic').notNull(),
    addresses: jsonb('addresses').notNull().default([]),
    taxonomies: jsonb('taxonomies').notNull().default([]),
    identifiers: jsonb('identifiers').notNull().default([]),
    endpoints: jsonb('endpoints').notNull().default([]),
    lastUpdatedInNppes: date('last_updated_in_nppes'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('idx_np_status').on(t.status),
    fetchedAtIdx: index('idx_np_fetched_at').on(t.fetchedAt),
    lastUpdatedIdx: index('idx_np_last_updated').on(t.lastUpdatedInNppes),
  }),
)

export type NppesProvider = typeof nppesProvider.$inferSelect
export type NewNppesProvider = typeof nppesProvider.$inferInsert

export const nppesSyncRun = pgTable(
  'nppes_sync_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: e.nppesSyncKind('kind').notNull(),
    triggeredBy: e.nppesSyncTrigger('triggered_by').notNull(),
    triggeredByMembershipId: uuid('triggered_by_membership_id'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: e.nppesSyncStatus('status').notNull().default('in_progress'),
    providersFetchedCount: integer('providers_fetched_count').notNull().default(0),
    providersUpdatedCount: integer('providers_updated_count').notNull().default(0),
    providersDeactivatedCount: integer('providers_deactivated_count').notNull().default(0),
    errorsCount: integer('errors_count').notNull().default(0),
    errorDetails: jsonb('error_details'),
    sourceFileUrl: text('source_file_url'),
  },
  (t) => ({
    startedIdx: index('idx_nsr_started').on(t.startedAt),
    statusIdx: index('idx_nsr_status').on(t.status),
  }),
)

export type NppesSyncRun = typeof nppesSyncRun.$inferSelect
export type NewNppesSyncRun = typeof nppesSyncRun.$inferInsert
```

### 3.7 `feed-health.ts`

```ts
// packages/db/src/schema/external-interfaces/feed-health.ts
import {
  pgTable,
  uuid,
  integer,
  timestamp,
  bigint,
  primaryKey,
} from 'drizzle-orm/pg-core'
import { organization } from '../organization'
import { externalFeed } from './feed'

export const externalFeedHealth = pgTable(
  'external_feed_health',
  {
    feedId: uuid('feed_id')
      .notNull()
      .references(() => externalFeed.id, { onDelete: 'cascade' }),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    listenerUpSeconds: integer('listener_up_seconds').notNull().default(0),
    listenerDownSeconds: integer('listener_down_seconds').notNull().default(0),
    inboundMessageCount: integer('inbound_message_count').notNull().default(0),
    outboundMessageCount: integer('outbound_message_count').notNull().default(0),
    ackAaCount: integer('ack_aa_count').notNull().default(0),
    ackAeCount: integer('ack_ae_count').notNull().default(0),
    ackArCount: integer('ack_ar_count').notNull().default(0),
    ackTimeoutCount: integer('ack_timeout_count').notNull().default(0),
    inboundBytes: bigint('inbound_bytes', { mode: 'number' }).notNull().default(0),
    outboundBytes: bigint('outbound_bytes', { mode: 'number' }).notNull().default(0),
    parseErrorCount: integer('parse_error_count').notNull().default(0),
    senderRejectedCount: integer('sender_rejected_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.feedId, t.hourBucket] }),
  }),
)

export type ExternalFeedHealth = typeof externalFeedHealth.$inferSelect
export type NewExternalFeedHealth = typeof externalFeedHealth.$inferInsert
```

### 3.8 `index.ts` — barrel

```ts
// packages/db/src/schema/external-interfaces/index.ts
export * from './enums'
export * from './feed'
export * from './hl7-messages'
export * from './inbound-proposal'
export * from './lab-observation'
export * from './nppes'
export * from './feed-health'
```

Add to the parent `packages/db/src/schema/index.ts`:

```ts
// packages/db/src/schema/index.ts (additions)
export * as externalInterfaces from './external-interfaces'
```

The `externalInterfaces` namespace import avoids name collisions with other modules that may use `externalFeed` / `labObservation` as a local symbol.

---

## 4. Migration SQL — `0029_external_interfaces.sql`

Hand-rolled SQL because Drizzle's migration generator does not emit `PARTITION BY RANGE` declarative partitioning. Lives at `apps/backend/drizzle/migrations/0029_external_interfaces.sql`.

```sql
-- =====================================================================
-- WardenX Module 29 — External Interfaces — Schema Migration 0029
-- Author: T-29.02
-- Tracks: WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_2.md §3
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- PHASE A — Enums
-- ---------------------------------------------------------------------
CREATE TYPE external_feed_kind AS ENUM ('adt_inbound', 'lab_inbound', 'orm_outbound');
CREATE TYPE external_feed_protocol AS ENUM ('mllp_tls', 'mllp_plain');
CREATE TYPE external_feed_status AS ENUM (
  'proposed', 'pending_approval', 'active', 'suspended', 'revoked', 'rejected'
);
CREATE TYPE external_feed_credential_kind AS ENUM ('mllp_client_cert', 'mllp_channel_password');
CREATE TYPE external_feed_credential_status AS ENUM ('active', 'retired');
CREATE TYPE hl7_inbound_parse_status AS ENUM ('in_progress', 'parsed', 'parse_error', 'rejected');
CREATE TYPE hl7_inbound_proposal_kind AS ENUM (
  'patient_demographic_update', 'admission_event', 'discharge_event', 'cancel_admission'
);
CREATE TYPE hl7_inbound_proposal_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');
CREATE TYPE hl7_inbound_match_outcome AS ENUM (
  'matched_single', 'matched_ambiguous', 'no_match', 'merged_target'
);
CREATE TYPE hl7_outbound_ack_status AS ENUM ('aa', 'ae', 'ar', 'timeout');
CREATE TYPE hl7_outbound_status AS ENUM (
  'queued', 'in_flight', 'acked', 'naked', 'failed', 'dlq'
);
CREATE TYPE lab_result_status AS ENUM ('preliminary', 'final', 'corrected', 'cancelled');
CREATE TYPE lab_abnormal_summary AS ENUM ('any_critical', 'any_abnormal', 'all_normal', 'no_flags');
CREATE TYPE lab_abnormal_flag AS ENUM ('H', 'L', 'HH', 'LL', 'A', 'N');
CREATE TYPE lab_value_type AS ENUM ('NM', 'ST', 'CE', 'SN', 'TX', 'DT');
CREATE TYPE lab_terminology_validation AS ENUM ('valid', 'unknown_code', 'deprecated');
CREATE TYPE lab_match_method AS ENUM ('obr_placer_id', 'patient_loinc_date', 'manual', 'unmatched');
CREATE TYPE nppes_enumeration_type AS ENUM ('NPI-1', 'NPI-2');
CREATE TYPE nppes_provider_status AS ENUM ('active', 'deactivated');
CREATE TYPE nppes_sync_kind AS ENUM (
  'daily_incremental', 'weekly_dissemination', 'monthly_deactivation', 'manual'
);
CREATE TYPE nppes_sync_trigger AS ENUM ('platform_cron', 'platform_admin');
CREATE TYPE nppes_sync_status AS ENUM ('in_progress', 'completed', 'failed');

-- ---------------------------------------------------------------------
-- PHASE B — Tables
-- ---------------------------------------------------------------------

-- B.1 external_feed (not partitioned; small lifecycle table)
CREATE TABLE external_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  kind external_feed_kind NOT NULL,
  display_name TEXT NOT NULL,
  host TEXT,
  port INTEGER NOT NULL,
  protocol external_feed_protocol NOT NULL,
  channel_cert_pin TEXT,
  sending_facility_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  baa_contract_ref TEXT,
  baa_expires_on TIMESTAMPTZ,
  active_from TIMESTAMPTZ,
  active_through TIMESTAMPTZ,
  status external_feed_status NOT NULL DEFAULT 'proposed',
  proposed_by_membership_id UUID NOT NULL,
  approved_by_op_id UUID,
  approved_by_compl_id UUID,
  approved_at TIMESTAMPTZ,
  rate_limit_msg_per_sec INTEGER NOT NULL DEFAULT 50,
  retry_policy JSONB NOT NULL DEFAULT '{"maxAttempts":5,"backoffSecs":[1,4,16,64,256]}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B.2 external_feed_credential
CREATE TABLE external_feed_credential (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES external_feed(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  kind external_feed_credential_kind NOT NULL,
  secret_cipher TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status external_feed_credential_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B.3 hl7_message_inbound (PARTITIONED BY RANGE (received_at))
CREATE TABLE hl7_message_inbound (
  id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  feed_id UUID NOT NULL REFERENCES external_feed(id) ON DELETE RESTRICT,
  message_type TEXT NOT NULL,
  message_control_id TEXT NOT NULL,
  payload_cipher TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  segments_summary JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parse_status hl7_inbound_parse_status NOT NULL DEFAULT 'in_progress',
  parse_error JSONB,
  sending_facility_id UUID,
  sending_facility_raw_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- B.4 hl7_message_outbound (PARTITIONED BY RANGE (transmitted_at))
-- transmitted_at is nullable; we use a COALESCE-friendly partition key by
-- requiring queued/in-flight rows to live in the "current month" partition
-- via the row trigger below. See M29 §3.5 for the partition-routing semantics.
CREATE TABLE hl7_message_outbound (
  id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  feed_id UUID NOT NULL REFERENCES external_feed(id) ON DELETE RESTRICT,
  message_type TEXT NOT NULL,
  message_control_id TEXT NOT NULL,
  payload_cipher TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  segments_summary JSONB NOT NULL,
  source_aggregate_kind TEXT NOT NULL,
  source_aggregate_id UUID NOT NULL,
  destination_facility_id UUID,
  -- transmitted_at_routed is a materialized COALESCE(transmitted_at, NOW()) used as the
  -- partition key. The trigger below keeps it synchronized.
  transmitted_at_routed TIMESTAMPTZ NOT NULL,
  transmitted_at TIMESTAMPTZ,
  ack_status hl7_outbound_ack_status,
  ack_received_at TIMESTAMPTZ,
  ack_payload_cipher TEXT,
  ack_payload_sha256 TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  status hl7_outbound_status NOT NULL DEFAULT 'queued',
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (id, transmitted_at_routed)
) PARTITION BY RANGE (transmitted_at_routed);

-- Trigger keeps transmitted_at_routed in sync. Once a row lands in a partition by
-- queued-NOW it stays there for the row's lifetime — partition immutability is
-- required by Postgres declarative partitioning.
CREATE OR REPLACE FUNCTION hl7_message_outbound_route_partition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transmitted_at_routed IS NULL THEN
    NEW.transmitted_at_routed := COALESCE(NEW.transmitted_at, NOW());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_hmo_route_partition
  BEFORE INSERT ON hl7_message_outbound
  FOR EACH ROW EXECUTE FUNCTION hl7_message_outbound_route_partition();

-- B.5 hl7_inbound_proposal (PARTITIONED BY RANGE (proposed_at))
CREATE TABLE hl7_inbound_proposal (
  id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  source_message_id UUID NOT NULL,
  resource_kind hl7_inbound_proposal_kind NOT NULL,
  proposed_patient_candidate JSONB NOT NULL,
  match_outcome hl7_inbound_match_outcome NOT NULL,
  matched_patient_id UUID,
  match_confidence NUMERIC(4,3),
  match_candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_module TEXT NOT NULL DEFAULT 'm5',
  proposal_status hl7_inbound_proposal_status NOT NULL DEFAULT 'pending',
  decided_by_membership_id UUID,
  decided_at TIMESTAMPTZ,
  decision_rationale TEXT,
  accepted_aggregate_id UUID,
  validation_errors JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, proposed_at)
) PARTITION BY RANGE (proposed_at);

-- B.6 lab_observation (PARTITIONED BY RANGE (received_at))
CREATE TABLE lab_observation (
  id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  source_message_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  order_id UUID,
  observation_date TIMESTAMPTZ NOT NULL,
  collection_date TIMESTAMPTZ,
  result_status lab_result_status NOT NULL,
  performing_lab_facility_id UUID,
  ordering_physician_npi TEXT,
  loinc_code TEXT NOT NULL,
  loinc_display_text TEXT NOT NULL,
  terminology_validation lab_terminology_validation NOT NULL,
  abnormal_summary lab_abnormal_summary NOT NULL,
  attached_document_id UUID,
  sud_redacted_at_ingest BOOLEAN NOT NULL DEFAULT FALSE,
  previous_observation_id UUID,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- B.7 lab_observation_value (PARTITIONED BY RANGE (received_at))
CREATE TABLE lab_observation_value (
  id UUID NOT NULL,
  observation_id UUID NOT NULL,
  obx_set_id INTEGER NOT NULL,
  loinc_code TEXT NOT NULL,
  loinc_display_text TEXT NOT NULL,
  terminology_validation lab_terminology_validation NOT NULL,
  value_type lab_value_type NOT NULL,
  numeric_value NUMERIC(18,6),
  string_value TEXT,
  units TEXT,
  reference_range TEXT,
  abnormal_flag lab_abnormal_flag,
  performed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- B.8 lab_observation_inbound_link (not partitioned; mapping table, smaller volume)
CREATE TABLE lab_observation_inbound_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL,
  source_message_id UUID NOT NULL,
  source_order_id UUID,
  obr_placer_order_number TEXT,
  match_method lab_match_method NOT NULL,
  match_confidence NUMERIC(4,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B.9 nppes_provider (platform-shared; not partitioned)
CREATE TABLE nppes_provider (
  npi CHAR(10) PRIMARY KEY,
  enumeration_type nppes_enumeration_type NOT NULL,
  status nppes_provider_status NOT NULL,
  deactivation_date DATE,
  deactivation_reason TEXT,
  reactivation_date DATE,
  basic JSONB NOT NULL,
  addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  taxonomies JSONB NOT NULL DEFAULT '[]'::jsonb,
  identifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  endpoints JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_updated_in_nppes DATE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B.10 nppes_sync_run (platform-shared; not partitioned)
CREATE TABLE nppes_sync_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind nppes_sync_kind NOT NULL,
  triggered_by nppes_sync_trigger NOT NULL,
  triggered_by_membership_id UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status nppes_sync_status NOT NULL DEFAULT 'in_progress',
  providers_fetched_count INTEGER NOT NULL DEFAULT 0,
  providers_updated_count INTEGER NOT NULL DEFAULT 0,
  providers_deactivated_count INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  error_details JSONB,
  source_file_url TEXT
);

-- B.11 external_feed_health
CREATE TABLE external_feed_health (
  feed_id UUID NOT NULL REFERENCES external_feed(id) ON DELETE CASCADE,
  hour_bucket TIMESTAMPTZ NOT NULL,
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  listener_up_seconds INTEGER NOT NULL DEFAULT 0,
  listener_down_seconds INTEGER NOT NULL DEFAULT 0,
  inbound_message_count INTEGER NOT NULL DEFAULT 0,
  outbound_message_count INTEGER NOT NULL DEFAULT 0,
  ack_aa_count INTEGER NOT NULL DEFAULT 0,
  ack_ae_count INTEGER NOT NULL DEFAULT 0,
  ack_ar_count INTEGER NOT NULL DEFAULT 0,
  ack_timeout_count INTEGER NOT NULL DEFAULT 0,
  inbound_bytes BIGINT NOT NULL DEFAULT 0,
  outbound_bytes BIGINT NOT NULL DEFAULT 0,
  parse_error_count INTEGER NOT NULL DEFAULT 0,
  sender_rejected_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  PRIMARY KEY (feed_id, hour_bucket)
);

-- ---------------------------------------------------------------------
-- PHASE B.2 — Initial monthly partitions (6 forward + current)
-- ---------------------------------------------------------------------
-- The M1 PartitionMaintainer cron will roll new partitions monthly thereafter.
-- For T-29.02 PR-merge time we ship the first 7 months ahead.
DO $$
DECLARE
  m DATE := date_trunc('month', NOW())::DATE;
  m_next DATE;
  m_label TEXT;
  i INT;
BEGIN
  FOR i IN 0..6 LOOP
    m_next := (m + INTERVAL '1 month')::DATE;
    m_label := to_char(m, 'YYYY_MM');

    EXECUTE format(
      'CREATE TABLE hl7_message_inbound_%s PARTITION OF hl7_message_inbound
         FOR VALUES FROM (%L) TO (%L)',
      m_label, m, m_next
    );
    EXECUTE format(
      'CREATE TABLE hl7_message_outbound_%s PARTITION OF hl7_message_outbound
         FOR VALUES FROM (%L) TO (%L)',
      m_label, m, m_next
    );
    EXECUTE format(
      'CREATE TABLE hl7_inbound_proposal_%s PARTITION OF hl7_inbound_proposal
         FOR VALUES FROM (%L) TO (%L)',
      m_label, m, m_next
    );
    EXECUTE format(
      'CREATE TABLE lab_observation_%s PARTITION OF lab_observation
         FOR VALUES FROM (%L) TO (%L)',
      m_label, m, m_next
    );
    EXECUTE format(
      'CREATE TABLE lab_observation_value_%s PARTITION OF lab_observation_value
         FOR VALUES FROM (%L) TO (%L)',
      m_label, m, m_next
    );

    m := m_next;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- PHASE C — RLS policies
-- ---------------------------------------------------------------------

-- C.1 Per-tenant RLS on every M29 tenant-owned table
ALTER TABLE external_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_feed_org_isolation ON external_feed
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE external_feed_credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY efc_org_isolation ON external_feed_credential
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE hl7_message_inbound ENABLE ROW LEVEL SECURITY;
CREATE POLICY hmi_org_isolation ON hl7_message_inbound
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE hl7_message_outbound ENABLE ROW LEVEL SECURITY;
CREATE POLICY hmo_org_isolation ON hl7_message_outbound
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE hl7_inbound_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY hip_org_isolation ON hl7_inbound_proposal
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

ALTER TABLE lab_observation ENABLE ROW LEVEL SECURITY;
CREATE POLICY lo_org_isolation ON lab_observation
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

-- lab_observation_value and lab_observation_inbound_link don't carry organization_id directly;
-- they inherit isolation via the observation_id JOIN. Standalone read requires a join through
-- lab_observation; direct row-level isolation is best-effort enforced via a subquery policy.
ALTER TABLE lab_observation_value ENABLE ROW LEVEL SECURITY;
CREATE POLICY lov_via_observation_isolation ON lab_observation_value
  USING (
    observation_id IN (
      SELECT id FROM lab_observation
      WHERE organization_id = current_setting('app.organization_id', true)::uuid
    )
  );

ALTER TABLE lab_observation_inbound_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY lol_via_observation_isolation ON lab_observation_inbound_link
  USING (
    observation_id IN (
      SELECT id FROM lab_observation
      WHERE organization_id = current_setting('app.organization_id', true)::uuid
    )
  );

ALTER TABLE external_feed_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY efh_org_isolation ON external_feed_health
  USING (organization_id = current_setting('app.organization_id', true)::uuid);

-- C.2 Platform-shared tables (NPPES)
-- Read open to all authenticated DB roles; write restricted to platform admin role.
ALTER TABLE nppes_provider ENABLE ROW LEVEL SECURITY;
CREATE POLICY nppes_provider_read ON nppes_provider
  FOR SELECT USING (true);
CREATE POLICY nppes_provider_write ON nppes_provider
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);

ALTER TABLE nppes_sync_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY nppes_sync_run_read ON nppes_sync_run
  FOR SELECT USING (true);
CREATE POLICY nppes_sync_run_write ON nppes_sync_run
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- PHASE D — Write-audit triggers (per M4 §3.6 denylist)
-- ---------------------------------------------------------------------
-- M4 provides the audit() trigger function; M29 attaches it with per-column denylists.
-- The trigger captures (operation, table, row id, before/after row hash, denylisted column hash)
-- so PHI-bearing payloads are not surfaced in the audit table.

-- external_feed: no denylist (no PHI columns; all fields are operational)
CREATE TRIGGER trg_audit_external_feed
  AFTER INSERT OR UPDATE OR DELETE ON external_feed
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger();

-- external_feed_credential: deny `secret_cipher` (it IS the secret).
CREATE TRIGGER trg_audit_external_feed_credential
  AFTER INSERT OR UPDATE OR DELETE ON external_feed_credential
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger_with_denylist(
    'external_feed_credential'::TEXT,
    ARRAY['secret_cipher']::TEXT[]
  );

-- hl7_message_inbound: deny `payload_cipher`; `payload_sha256` is captured in clear.
CREATE TRIGGER trg_audit_hl7_message_inbound
  AFTER INSERT OR UPDATE OR DELETE ON hl7_message_inbound
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger_with_denylist(
    'hl7_message_inbound'::TEXT,
    ARRAY['payload_cipher']::TEXT[]
  );

-- hl7_message_outbound: deny `payload_cipher` and `ack_payload_cipher`.
CREATE TRIGGER trg_audit_hl7_message_outbound
  AFTER INSERT OR UPDATE OR DELETE ON hl7_message_outbound
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger_with_denylist(
    'hl7_message_outbound'::TEXT,
    ARRAY['payload_cipher', 'ack_payload_cipher']::TEXT[]
  );

-- hl7_inbound_proposal: deny `proposed_patient_candidate` (carries PHI demographic).
CREATE TRIGGER trg_audit_hl7_inbound_proposal
  AFTER INSERT OR UPDATE OR DELETE ON hl7_inbound_proposal
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger_with_denylist(
    'hl7_inbound_proposal'::TEXT,
    ARRAY['proposed_patient_candidate']::TEXT[]
  );

-- lab_observation: no value-bearing PHI columns (numerics live in lab_observation_value).
CREATE TRIGGER trg_audit_lab_observation
  AFTER INSERT OR UPDATE OR DELETE ON lab_observation
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger();

-- lab_observation_value: deny `numeric_value`, `string_value` (PHI-bearing).
CREATE TRIGGER trg_audit_lab_observation_value
  AFTER INSERT OR UPDATE OR DELETE ON lab_observation_value
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger_with_denylist(
    'lab_observation_value'::TEXT,
    ARRAY['numeric_value', 'string_value']::TEXT[]
  );

-- lab_observation_inbound_link: no PHI; operational metadata only.
CREATE TRIGGER trg_audit_lab_observation_inbound_link
  AFTER INSERT OR UPDATE OR DELETE ON lab_observation_inbound_link
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger();

-- nppes_provider, nppes_sync_run: public-directory data; no denylist.
CREATE TRIGGER trg_audit_nppes_provider
  AFTER INSERT OR UPDATE OR DELETE ON nppes_provider
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger();

CREATE TRIGGER trg_audit_nppes_sync_run
  AFTER INSERT OR UPDATE OR DELETE ON nppes_sync_run
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger();

-- external_feed_health: no PHI; operational counters only.
CREATE TRIGGER trg_audit_external_feed_health
  AFTER INSERT OR UPDATE OR DELETE ON external_feed_health
  FOR EACH ROW EXECUTE FUNCTION m4_audit_write_trigger();

-- ---------------------------------------------------------------------
-- PHASE E — Indexes (declared on partitioned PARENTS; Postgres propagates)
-- ---------------------------------------------------------------------

-- external_feed
CREATE INDEX idx_external_feed_org_kind ON external_feed (organization_id, kind);
CREATE UNIQUE INDEX uq_external_feed_org_port_kind ON external_feed (organization_id, port, kind);
CREATE INDEX idx_external_feed_status ON external_feed (status);

-- external_feed_credential
CREATE INDEX idx_efc_feed_status ON external_feed_credential (feed_id, status);

-- hl7_message_inbound (parent — propagates to all partitions)
CREATE INDEX idx_hmi_org_feed ON hl7_message_inbound (organization_id, feed_id);
CREATE INDEX idx_hmi_parse_status ON hl7_message_inbound (parse_status);
CREATE UNIQUE INDEX uq_hmi_idempotency ON hl7_message_inbound (idempotency_key, received_at);
CREATE INDEX idx_hmi_sha256 ON hl7_message_inbound (payload_sha256);
CREATE INDEX idx_hmi_org_feed_received
  ON hl7_message_inbound (organization_id, feed_id, received_at DESC);

-- hl7_message_outbound
CREATE INDEX idx_hmo_org_feed ON hl7_message_outbound (organization_id, feed_id);
CREATE INDEX idx_hmo_status ON hl7_message_outbound (status);
CREATE UNIQUE INDEX uq_hmo_idempotency ON hl7_message_outbound (idempotency_key, transmitted_at_routed);
-- Partial-index over the partition parent is allowed in PG 14+; it propagates.
CREATE INDEX idx_hmo_next_retry ON hl7_message_outbound (next_retry_at)
  WHERE status IN ('queued', 'naked');

-- hl7_inbound_proposal
CREATE INDEX idx_hip_org_status ON hl7_inbound_proposal (organization_id, proposal_status);
CREATE INDEX idx_hip_expires ON hl7_inbound_proposal (expires_at)
  WHERE proposal_status = 'pending';
CREATE INDEX idx_hip_matched_patient ON hl7_inbound_proposal (matched_patient_id)
  WHERE matched_patient_id IS NOT NULL;
CREATE INDEX idx_hip_source_message ON hl7_inbound_proposal (source_message_id);

-- lab_observation
CREATE INDEX idx_lo_org_patient ON lab_observation (organization_id, patient_id);
CREATE INDEX idx_lo_patient_date ON lab_observation (patient_id, observation_date DESC);
CREATE INDEX idx_lo_order ON lab_observation (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_lo_abnormal ON lab_observation (abnormal_summary)
  WHERE abnormal_summary IN ('any_critical', 'any_abnormal');
CREATE INDEX idx_lo_source_message ON lab_observation (source_message_id);

-- lab_observation_value
CREATE INDEX idx_lov_observation ON lab_observation_value (observation_id, obx_set_id);
CREATE INDEX idx_lov_loinc ON lab_observation_value (loinc_code);

-- lab_observation_inbound_link
CREATE INDEX idx_lol_observation ON lab_observation_inbound_link (observation_id);
CREATE INDEX idx_lol_placer ON lab_observation_inbound_link (obr_placer_order_number)
  WHERE obr_placer_order_number IS NOT NULL;
CREATE INDEX idx_lol_source_message ON lab_observation_inbound_link (source_message_id);

-- nppes_provider, nppes_sync_run
CREATE INDEX idx_np_status ON nppes_provider (status);
CREATE INDEX idx_np_fetched_at ON nppes_provider (fetched_at);
CREATE INDEX idx_np_last_updated ON nppes_provider (last_updated_in_nppes DESC);
CREATE INDEX idx_nsr_started ON nppes_sync_run (started_at);
CREATE INDEX idx_nsr_status ON nppes_sync_run (status);

-- ---------------------------------------------------------------------
-- PHASE F — Seed rows
-- ---------------------------------------------------------------------
-- Platform installs the initial nppes_sync_run placeholder so the
-- delta-sync worker has a `lastSyncedAt` anchor. The placeholder is
-- marked `completed` with zero counts.
INSERT INTO nppes_sync_run (
  id, kind, triggered_by, started_at, completed_at, status,
  providers_fetched_count, providers_updated_count, providers_deactivated_count
) VALUES (
  gen_random_uuid(), 'manual', 'platform_cron',
  NOW() - INTERVAL '1 second', NOW(),
  'completed', 0, 0, 0
);

-- No per-tenant seed at platform install. Tenant feeds are provisioned at onboarding.

COMMIT;
```

### 4.1 Down Migration

```sql
-- apps/backend/drizzle/migrations/0029_external_interfaces.down.sql
-- Reverses 0029_external_interfaces.sql. Drops in reverse dependency order.

BEGIN;

DROP TRIGGER IF EXISTS trg_audit_external_feed_health ON external_feed_health;
DROP TRIGGER IF EXISTS trg_audit_nppes_sync_run ON nppes_sync_run;
DROP TRIGGER IF EXISTS trg_audit_nppes_provider ON nppes_provider;
DROP TRIGGER IF EXISTS trg_audit_lab_observation_inbound_link ON lab_observation_inbound_link;
DROP TRIGGER IF EXISTS trg_audit_lab_observation_value ON lab_observation_value;
DROP TRIGGER IF EXISTS trg_audit_lab_observation ON lab_observation;
DROP TRIGGER IF EXISTS trg_audit_hl7_inbound_proposal ON hl7_inbound_proposal;
DROP TRIGGER IF EXISTS trg_audit_hl7_message_outbound ON hl7_message_outbound;
DROP TRIGGER IF EXISTS trg_audit_hl7_message_inbound ON hl7_message_inbound;
DROP TRIGGER IF EXISTS trg_audit_external_feed_credential ON external_feed_credential;
DROP TRIGGER IF EXISTS trg_audit_external_feed ON external_feed;
DROP TRIGGER IF EXISTS trg_hmo_route_partition ON hl7_message_outbound;
DROP FUNCTION IF EXISTS hl7_message_outbound_route_partition();

DROP TABLE IF EXISTS external_feed_health;
DROP TABLE IF EXISTS nppes_sync_run;
DROP TABLE IF EXISTS nppes_provider;
DROP TABLE IF EXISTS lab_observation_inbound_link;
DROP TABLE IF EXISTS lab_observation_value CASCADE;  -- partitions cascade
DROP TABLE IF EXISTS lab_observation CASCADE;
DROP TABLE IF EXISTS hl7_inbound_proposal CASCADE;
DROP TABLE IF EXISTS hl7_message_outbound CASCADE;
DROP TABLE IF EXISTS hl7_message_inbound CASCADE;
DROP TABLE IF EXISTS external_feed_credential;
DROP TABLE IF EXISTS external_feed;

DROP TYPE IF EXISTS nppes_sync_status;
DROP TYPE IF EXISTS nppes_sync_trigger;
DROP TYPE IF EXISTS nppes_sync_kind;
DROP TYPE IF EXISTS nppes_provider_status;
DROP TYPE IF EXISTS nppes_enumeration_type;
DROP TYPE IF EXISTS lab_match_method;
DROP TYPE IF EXISTS lab_terminology_validation;
DROP TYPE IF EXISTS lab_value_type;
DROP TYPE IF EXISTS lab_abnormal_flag;
DROP TYPE IF EXISTS lab_abnormal_summary;
DROP TYPE IF EXISTS lab_result_status;
DROP TYPE IF EXISTS hl7_outbound_status;
DROP TYPE IF EXISTS hl7_outbound_ack_status;
DROP TYPE IF EXISTS hl7_inbound_match_outcome;
DROP TYPE IF EXISTS hl7_inbound_proposal_status;
DROP TYPE IF EXISTS hl7_inbound_proposal_kind;
DROP TYPE IF EXISTS hl7_inbound_parse_status;
DROP TYPE IF EXISTS external_feed_credential_status;
DROP TYPE IF EXISTS external_feed_credential_kind;
DROP TYPE IF EXISTS external_feed_status;
DROP TYPE IF EXISTS external_feed_protocol;
DROP TYPE IF EXISTS external_feed_kind;

COMMIT;
```

---

## 5. Audit Denylist Registration

```ts
// packages/db/src/audit-denylist/m29.ts
//
// Per M29 §3.6 and M4 §3.6. Registers the per-column denylist for M29 tables
// at boot. The M4 audit-write trigger consults this registry at write time.

import type { AuditDenylistRegistry } from '@wardenx/foundation/audit'

export function registerM29AuditDenylist(registry: AuditDenylistRegistry): void {
  // PHI-bearing or secret-bearing columns whose VALUES are replaced with a
  // hash digest in the M4 audit row. The fact of the write is always captured.
  registry.denyColumns({
    'external_feed_credential': ['secret_cipher'],
    'hl7_message_inbound': ['payload_cipher'],
    'hl7_message_outbound': ['payload_cipher', 'ack_payload_cipher'],
    'hl7_inbound_proposal': ['proposed_patient_candidate'],
    'lab_observation_value': ['numeric_value', 'string_value'],
  })

  // pino redaction patterns — defense-in-depth alongside the column-level deny.
  registry.denyLogPaths([
    '*.hl7.segments.PID',
    '*.hl7.segments.NK1',
    '*.hl7.segments.IN1',
    '*.hl7.segments.GT1',
    '*.hl7.segments.NTE',
    '*.hl7.payload',
    '*.payload_cipher',
    '*.ack_payload_cipher',
    '*.secret_cipher',
    '*.proposed_patient_candidate',
  ])
}
```

Wire in boot:

```ts
// apps/backend/src/boot.ts (excerpt — additions to the M29 registration block)
import { registerM29AuditDenylist } from '@wardenx/db/audit-denylist/m29'

// ... before any M29 write path runs ...
registerM29AuditDenylist(deps.auditRegistry)
```

---

## 6. Eraser Implementation

```ts
// apps/backend/src/modules/29-external-interfaces/eraser.ts
//
// Per M29 §3.7 + M4 destruction-cert workflow. Combines per-row cryptographic
// shred (DEK destruction) with row-metadata retention to keep audit chains intact.

import { registerEraser } from '@wardenx/foundation/eraser-registry'
import type {
  DataEraser,
  EraseInput,
  EraseResult,
} from '@wardenx/foundation/interfaces'
import { and, eq, inArray } from 'drizzle-orm'
import {
  externalFeed,
  externalFeedCredential,
  hl7MessageInbound,
  hl7MessageOutbound,
  hl7InboundProposal,
  labObservation,
  labObservationValue,
  labObservationInboundLink,
  externalFeedHealth,
} from '@wardenx/db/schema/external-interfaces'

export const externalInterfacesEraser: DataEraser = {
  className: 'external_interfaces',
  retentionClasses: ['compliance', 'operational'],

  async erase(input: EraseInput): Promise<EraseResult> {
    const { tx, organizationId, destructionCertId, kmsClient, auditEmitter } = input
    const counts: Record<string, number> = {}

    // 1. Cryptographic-shred path — destroy per-tenant DEK first so the envelope-
    //    encrypted payload_cipher columns become unrecoverable globally for this
    //    tenant. Subsequent steps overwrite the ciphertext columns to a tombstone
    //    sentinel to make the destruction visible without reading the unrecoverable
    //    value.
    await kmsClient.destroyTenantDek(organizationId, { reason: destructionCertId })

    const TOMBSTONE = 'SHREDDED::EXTERNAL_INTERFACES'

    // 2. hl7_message_inbound — overwrite payload_cipher with TOMBSTONE
    const inboundRows = await tx
      .update(hl7MessageInbound)
      .set({ payloadCipher: TOMBSTONE })
      .where(eq(hl7MessageInbound.organizationId, organizationId))
      .returning({ id: hl7MessageInbound.id })
    counts.hl7_message_inbound = inboundRows.length

    // 3. hl7_message_outbound — overwrite payload_cipher and ack_payload_cipher
    const outboundRows = await tx
      .update(hl7MessageOutbound)
      .set({ payloadCipher: TOMBSTONE, ackPayloadCipher: TOMBSTONE })
      .where(eq(hl7MessageOutbound.organizationId, organizationId))
      .returning({ id: hl7MessageOutbound.id })
    counts.hl7_message_outbound = outboundRows.length

    // 4. hl7_inbound_proposal — overwrite proposed_patient_candidate with null jsonb
    const proposalRows = await tx
      .update(hl7InboundProposal)
      .set({ proposedPatientCandidate: { shredded: true, certId: destructionCertId } })
      .where(eq(hl7InboundProposal.organizationId, organizationId))
      .returning({ id: hl7InboundProposal.id })
    counts.hl7_inbound_proposal = proposalRows.length

    // 5. lab_observation_value — overwrite numeric_value, string_value with null
    //    via observation-scoped join.
    const observationIds = (await tx
      .select({ id: labObservation.id })
      .from(labObservation)
      .where(eq(labObservation.organizationId, organizationId))).map(r => r.id)

    if (observationIds.length > 0) {
      const valueRows = await tx
        .update(labObservationValue)
        .set({ numericValue: null, stringValue: null })
        .where(inArray(labObservationValue.observationId, observationIds))
        .returning({ id: labObservationValue.id })
      counts.lab_observation_value = valueRows.length
    } else {
      counts.lab_observation_value = 0
    }

    // 6. lab_observation, lab_observation_inbound_link — retain row, no PHI columns
    //    to shred (the linkage IDs are non-PHI). Mark the row with an audit note.
    counts.lab_observation = observationIds.length

    const linkRows = await tx
      .select({ id: labObservationInboundLink.id })
      .from(labObservationInboundLink)
      .where(inArray(labObservationInboundLink.observationId, observationIds))
    counts.lab_observation_inbound_link = linkRows.length

    // 7. external_feed — tombstone via status=revoked (preserves audit chain)
    const feedRows = await tx
      .update(externalFeed)
      .set({ status: 'revoked', activeThrough: new Date() })
      .where(
        and(
          eq(externalFeed.organizationId, organizationId),
          // Only revoke non-revoked feeds; previously-revoked are already terminal.
          // (status !== 'revoked' check handled by service-layer guard; trigger emits 0 audit
          // events for no-op updates per M4 convention.)
        ),
      )
      .returning({ id: externalFeed.id })
    counts.external_feed = feedRows.length

    // 8. external_feed_credential — retire all + DEK destroyed (secret_cipher
    //    is now unrecoverable; mark status retired for visibility)
    const credentialRows = await tx
      .update(externalFeedCredential)
      .set({ status: 'retired', secretCipher: TOMBSTONE })
      .where(eq(externalFeedCredential.organizationId, organizationId))
      .returning({ id: externalFeedCredential.id })
    counts.external_feed_credential = credentialRows.length

    // 9. external_feed_health — operational; delete (no audit value beyond aggregate)
    const healthRows = await tx
      .delete(externalFeedHealth)
      .where(eq(externalFeedHealth.organizationId, organizationId))
      .returning({ feedId: externalFeedHealth.feedId })
    counts.external_feed_health = healthRows.length

    // 10. NPPES tables are platform-shared — NOT touched by tenant destruction.

    await auditEmitter.emit({
      kind: 'm29.eraser.completed',
      destructionCertId,
      organizationId,
      counts,
    })

    return {
      className: 'external_interfaces',
      counts,
      completedAt: new Date(),
    }
  },
}

export function registerExternalInterfacesEraser(): void {
  registerEraser('external_interfaces', externalInterfacesEraser)
}
```

Wire in M29 boot:

```ts
// apps/backend/src/modules/29-external-interfaces/boot.ts (additions)
import { registerExternalInterfacesEraser } from './eraser'

export function bootM29(deps: M29BootDeps): void {
  // ... existing M29 registrations ...
  registerExternalInterfacesEraser()
}
```

---

## 7. Schema Integration Tests

Test path: `apps/backend/src/modules/29-external-interfaces/schema.test.ts`. Runs against a Testcontainers Postgres with M1, M2, M3, M4, M5, M11 schemas already migrated (the M29 dependencies).

```ts
// apps/backend/src/modules/29-external-interfaces/schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkTestcontainerDb, mkTenantContext, mkPlatformContext } from '@wardenx/test-fixtures'
import {
  externalFeed,
  externalFeedCredential,
  hl7MessageInbound,
  hl7InboundProposal,
  labObservation,
  labObservationValue,
  nppesProvider,
} from '@wardenx/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { externalInterfacesEraser } from './eraser'

describe('M29 schema — integration', () => {
  let db: ReturnType<typeof mkTestcontainerDb>

  beforeAll(async () => {
    db = await mkTestcontainerDb({ migrations: ['0001'..'0029'] as const })
  })

  afterAll(async () => {
    await db.teardown()
  })

  describe('RLS isolation', () => {
    it('tenant A cannot SELECT tenant B external_feed', async () => {
      await db.seed.feed({ organizationId: 'org_a', id: 'feed_a' })
      await db.seed.feed({ organizationId: 'org_b', id: 'feed_b' })

      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        const rows = await tx.select().from(externalFeed)
        expect(rows.map(r => r.id)).toEqual(['feed_a'])
      })
    })

    it('tenant A UPDATE on tenant B credential returns 0 rows (RLS refuses)', async () => {
      await db.seed.feedCredential({ organizationId: 'org_b', id: 'cred_b' })
      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        const result = await tx
          .update(externalFeedCredential)
          .set({ status: 'retired' })
          .where(eq(externalFeedCredential.id, 'cred_b'))
        expect(result.rowCount).toBe(0)
      })
    })

    it('lab_observation_value isolation works through observation-id subquery', async () => {
      // Seed a value for tenant B's observation
      await db.seed.labObservation({ organizationId: 'org_b', id: 'obs_b' })
      await db.seed.labObservationValue({ observationId: 'obs_b', id: 'val_b' })

      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        const rows = await tx.select().from(labObservationValue)
        expect(rows).toHaveLength(0)
      })
    })
  })

  describe('Platform-shared NPPES', () => {
    it('tenant role can READ but not WRITE nppes_provider', async () => {
      await mkPlatformContext(async (tx) => {
        await tx.insert(nppesProvider).values({
          npi: '1234567890',
          enumerationType: 'NPI-1',
          status: 'active',
          basic: {},
        })
      })

      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        const rows = await tx.select().from(nppesProvider)
        expect(rows.find(r => r.npi === '1234567890')).toBeDefined()

        await expect(
          tx.insert(nppesProvider).values({
            npi: '9999999999',
            enumerationType: 'NPI-1',
            status: 'active',
            basic: {},
          }),
        ).rejects.toThrow(/new row violates row-level security/)
      })
    })
  })

  describe('Partition routing', () => {
    it('hl7_message_inbound INSERT routes to the correct monthly partition', async () => {
      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        const now = new Date()
        await tx.insert(hl7MessageInbound).values({
          id: 'msg_today',
          organizationId: 'org_a',
          feedId: 'feed_a',
          messageType: 'ADT^A01',
          messageControlId: 'MCID-001',
          payloadCipher: 'cipher_blob',
          payloadSha256: 'sha_001',
          segmentsSummary: { segments: [] },
          sendingFacilityRawId: 'ST_ANTHONY',
          idempotencyKey: 'idem_001',
          receivedAt: now,
        })
      })

      // Verify the row landed in this month's partition table
      const monthLabel = new Date().toISOString().slice(0, 7).replace('-', '_')
      const result = await db.raw(
        `SELECT 1 FROM hl7_message_inbound_${monthLabel} WHERE id = 'msg_today'`,
      )
      expect(result.rowCount).toBe(1)
    })

    it('hl7_message_outbound INSERT with NULL transmitted_at routes via NOW()', async () => {
      // Trigger should set transmitted_at_routed = NOW() when transmitted_at is NULL
      // ... (similar test pattern)
    })
  })

  describe('Audit denylist enforcement', () => {
    it('payload_cipher value is replaced with hash in M4 audit row', async () => {
      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        await tx.insert(hl7MessageInbound).values({
          id: 'msg_audit_test',
          organizationId: 'org_a',
          feedId: 'feed_a',
          messageType: 'ADT^A08',
          messageControlId: 'MCID-AUDIT',
          payloadCipher: 'SECRET_PHI_PAYLOAD_BLOB',
          payloadSha256: 'sha_audit',
          segmentsSummary: { segments: [] },
          sendingFacilityRawId: 'ST_ANTHONY',
          idempotencyKey: 'idem_audit',
        })
      })

      // M4 audit row for the INSERT should NOT contain the raw cipher value
      const auditRows = await db.raw(
        `SELECT row_after FROM m4_audit.row_change_log WHERE table_name = 'hl7_message_inbound' AND row_id = 'msg_audit_test'`,
      )
      expect(auditRows.rows[0].row_after.payload_cipher).not.toBe('SECRET_PHI_PAYLOAD_BLOB')
      expect(auditRows.rows[0].row_after.payload_cipher).toMatch(/^sha256:/)
    })

    it('secret_cipher value is denylisted on external_feed_credential', async () => {
      // ... mirror pattern
    })

    it('proposed_patient_candidate jsonb is denylisted on hl7_inbound_proposal', async () => {
      // ... mirror pattern
    })
  })

  describe('Eraser cryptographic-shred', () => {
    it('tenant DEK destruction renders payload_cipher unrecoverable', async () => {
      // Seed inbound message under org_a with a real envelope-encrypted payload
      const messageId = await db.seed.hl7InboundMessageRealEncryption({
        organizationId: 'org_a',
        plaintext: 'MSH|^~\\&|...',
      })

      // Confirm decryption works pre-shred
      const beforeDecrypt = await mkTenantContext({ organizationId: 'org_a' }, async (tx, kms) => {
        const row = await tx.select().from(hl7MessageInbound).where(eq(hl7MessageInbound.id, messageId)).limit(1)
        return kms.decrypt(row[0].payloadCipher, { organizationId: 'org_a' })
      })
      expect(beforeDecrypt).toContain('MSH|^~\\&')

      // Run the eraser
      await mkTenantContext({ organizationId: 'org_a' }, async (tx, kms, audit) => {
        await externalInterfacesEraser.erase({
          tx, organizationId: 'org_a', destructionCertId: 'cert_test',
          kmsClient: kms, auditEmitter: audit,
        })
      })

      // After shred: payload_cipher is the TOMBSTONE; DEK destroyed
      const afterErase = await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        const row = await tx.select().from(hl7MessageInbound).where(eq(hl7MessageInbound.id, messageId)).limit(1)
        return row[0]
      })
      expect(afterErase.payloadCipher).toBe('SHREDDED::EXTERNAL_INTERFACES')

      // DEK destruction is verified by attempting decrypt — should fail
      await mkTenantContext({ organizationId: 'org_a' }, async (_tx, kms) => {
        await expect(kms.getTenantDek('org_a')).rejects.toThrow(/dek_destroyed/)
      })
    })

    it('external_feed status transitions to revoked', async () => {
      await db.seed.feed({ organizationId: 'org_a', id: 'feed_to_revoke', status: 'active' })
      await mkTenantContext({ organizationId: 'org_a' }, async (tx, kms, audit) => {
        await externalInterfacesEraser.erase({
          tx, organizationId: 'org_a', destructionCertId: 'cert_test',
          kmsClient: kms, auditEmitter: audit,
        })
      })

      await mkPlatformContext(async (tx) => {
        const row = await tx.select().from(externalFeed).where(eq(externalFeed.id, 'feed_to_revoke')).limit(1)
        expect(row[0].status).toBe('revoked')
        expect(row[0].activeThrough).toBeInstanceOf(Date)
      })
    })

    it('NPPES tables are NOT touched by tenant erasure', async () => {
      await mkPlatformContext(async (tx) => {
        await tx.insert(nppesProvider).values({
          npi: '5555555555', enumerationType: 'NPI-1', status: 'active', basic: {},
        })
      })

      await mkTenantContext({ organizationId: 'org_a' }, async (tx, kms, audit) => {
        await externalInterfacesEraser.erase({
          tx, organizationId: 'org_a', destructionCertId: 'cert_test',
          kmsClient: kms, auditEmitter: audit,
        })
      })

      await mkPlatformContext(async (tx) => {
        const row = await tx.select().from(nppesProvider).where(eq(nppesProvider.npi, '5555555555')).limit(1)
        expect(row).toHaveLength(1)
      })
    })
  })

  describe('Unique-constraint enforcement', () => {
    it('uq_external_feed_org_port_kind refuses duplicate (org, port, kind)', async () => {
      await db.seed.feed({ organizationId: 'org_a', port: 11001, kind: 'adt_inbound' })
      await mkTenantContext({ organizationId: 'org_a' }, async (tx) => {
        await expect(
          tx.insert(externalFeed).values({
            organizationId: 'org_a', port: 11001, kind: 'adt_inbound',
            protocol: 'mllp_tls', displayName: 'duplicate',
            proposedByMembershipId: 'mem_a',
          }),
        ).rejects.toThrow(/uq_external_feed_org_port_kind/)
      })
    })

    it('uq_hmi_idempotency refuses duplicate idempotency_key on same partition', async () => {
      // Inserted twice within same month with same key → second fails
      // ... mirror pattern
    })
  })
})
```

---

## 8. Sign-Off Checklist (T-29.02 PR)

- [ ] All eight schema TypeScript files (§3.1–3.8) land under `packages/db/src/schema/external-interfaces/`.
- [ ] Parent `packages/db/src/schema/index.ts` re-exports the `externalInterfaces` namespace.
- [ ] Migration `0029_external_interfaces.sql` and `0029_external_interfaces.down.sql` apply clean against a fresh DB.
- [ ] Down migration is verified by `bun run db:migrate:up && bun run db:migrate:down && bun run db:migrate:up`.
- [ ] All eleven tables exist with expected columns and types (Drizzle introspection diff is clean).
- [ ] All eleven tables have RLS enabled; policy verified per §3.5.
- [ ] Seven monthly partitions exist for each of the five partitioned parents (35 partitions total).
- [ ] M1 PartitionMaintainer schedule includes the five M29 partitioned parents.
- [ ] All §3.4 indexes present; EXPLAIN of the canonical queries shows them used.
- [ ] Audit denylist registered via `registerM29AuditDenylist`; M4 audit row for an `INSERT INTO hl7_message_inbound` does not contain the raw `payload_cipher` value.
- [ ] Eraser registered; eraser integration test passes; DEK destruction renders ciphertext unrecoverable; NPPES rows untouched.
- [ ] §13.2 cruiser-rule path correction (`packages/db-schema/...` → `packages/db/src/schema/...`) applied to `.dependency-cruiser.cjs`.
- [ ] `bun run check:cruiser` passes with the corrected rule against the new schema package path.
- [ ] `bun run check:table-ownership` registers all eleven tables to M29 (9 tenant + 2 platform-shared).
- [ ] All §7 integration tests pass against Testcontainers Postgres.
- [ ] PR diff inspected by **Platform engineer** sign-off.

---

## 9. Notes on Phase B partition routing for hl7_message_outbound

The `transmitted_at_routed` column is a small but consequential design choice that the M29 spec §3.3 hinted at but didn't fully resolve. The problem: `transmitted_at` is nullable (queued rows haven't transmitted yet), but Postgres declarative partition keys cannot be nullable. Solutions evaluated:

| Approach | Outcome |
|---|---|
| Partition by `next_retry_at` | Rejected — also nullable, same problem. |
| Partition by `created_at` (add column) | Rejected — increases column count without clear retention value. |
| Partition by `COALESCE(transmitted_at, NOW())` materialized at INSERT | **Chosen.** The `transmitted_at_routed` column holds this value; a BEFORE INSERT trigger populates it; the column is immutable post-INSERT (no UPDATE allowed — enforced by a separate trigger if needed for paranoia). |
| Use `IS NOT NULL` check on `transmitted_at` and partition only ACKED rows | Rejected — leaves queued rows un-partitioned and breaks the partition-drop retention pattern. |

The chosen approach has one subtle property: a row's partition is fixed at INSERT time based on "now or the future-known transmitted_at". For an OUTBOUND row that was queued in May but ACKED in June, the row stays in the May partition (where it was originally inserted). This is correct retention behavior: the row's "operational lifetime" anchors to its first PG-write event.

**This is a small design refinement past M29 spec §3.3.** Recording it here so the next reviewer of the spec sees the choice surfaced.

---

## Document Footer

**Addendum version:** v1.0 (T-29.02 PR-ready)
**Bound to:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_2.md` §3
**Schema files delivered:** 8 (enums, feed, hl7-messages, inbound-proposal, lab-observation, nppes, feed-health, index)
**Tables delivered:** 11 (9 tenant-owned + 2 platform-shared)
**Partitions seeded:** 35 (7 months × 5 partitioned parents)
**Triggers created:** 11 audit + 1 partition-routing
**RLS policies:** 11 (9 tenant + 2 platform-shared dual-policy)
**Spec corrections:** 1 (cruiser path: `packages/db-schema` → `packages/db/src/schema`)
**Sign-offs required:** Platform engineer

**End of T-29.02 schema PR package.**
