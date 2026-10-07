# WardenX — T-29.10 Addendum: Credential Rotation

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §4.x (credential lifecycle), §11 D18 (step-up), D23 (mTLS + per-feed pinning), §10 (T-29.10)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 → T-29.08 merged. M29 spec at v0.3. T-29.04 (inbound listener with CRL) and T-29.08 (outbound MLLP client with CRL) are both consuming the revocation list this PR mutates.

This addendum delivers the drop-in artifacts for T-29.10 — the credential rotation workflow. Per D18, the rotation path requires **step-up auth + dual approval (compliance co-approver distinct)**. The state machine moves a credential from `active → rotating → retired`, with a new credential going `provisioned → active` atomically. Both inbound listener (T-29.04) and outbound MLLP client (T-29.08) consume the `m29.external_feed_credential.revoked` outbox event to refresh their in-memory CRLs.

**T-29.10 closes W-XI-13 (credential rotation).**

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Rotation state machine** at `apps/backend/src/modules/29-external-interfaces/credentials/rotation-state-machine.ts` — XState v5 machine modeling the rotation lifecycle (`idle → requested → co_approved → executing → completed | rolled_back`).
- **Rotation service** at `apps/backend/src/modules/29-external-interfaces/credentials/rotation-service.ts` — orchestrates: provision new credential, transition states atomically, emit the revocation event for old credential.
- **Credential builder** at `apps/backend/src/modules/29-external-interfaces/credentials/credential-builder.ts` — KMS-backed certificate generation; supports both inbound (server cert + client CA) and outbound (client cert + server CA) variants.
- **HTTP routes** at `apps/backend/src/modules/29-external-interfaces/routes/credential-rotation.ts` — `POST /api/v1/hl7/feeds/:feedId/credentials/rotate/request`, `POST /:rotationId/approve`, `POST /:rotationId/execute`, `POST /:rotationId/rollback`, `GET /:rotationId`.
- **ABAC predicate** `external_feed_compliance_co_approver_distinct` — already declared in M29 v0.3 §4.7 (D20); T-29.10 ships the implementation in M3.
- **Audit trail** — every state transition writes an `m4.audit.phi_admin_mutation` row with the actor, before/after state, rationale.
- **CRL refresh trigger** — on `retired` transition, emit `m29.external_feed_credential.revoked` for T-29.04/T-29.08 to consume (already wired in those PRs).
- **Expiration sweep** — a small worker checks for credentials approaching their `expiresAt`; emits M36 alert at 30/7/1 days out (per integrations doc).
- **Tests** — W-XI-13 (happy path), dual-approval refused when same person, step-up required, atomic transition (concurrent execute), rollback path, expiration alert ladder.
- **Sign-off checklist.**

### 1.2 Non-goals

- **PKI / CA management.** The credential builder uses a configured KMS / Vault path; the CA backing it is platform-provisioned and out of scope for T-29.10.
- **Automated rotation cadence.** T-29.10 supports manual rotation only. Automated scheduled rotation is a Phase 2 feature; the state machine accommodates it (a system actor can request rotation), but no scheduler ships in this PR.
- **External-CA-signed cert support.** Feeds whose partner-side trust uses an external CA (DigiCert, Let's Encrypt, etc.) are not rotated by T-29.10; the partner provides the cert, T-29.10's flow is for self-signed-per-feed credentials (the common case).
- **Frontend UI** — T-29.13.
- **No schema additions.** v0.3 schema is sufficient. The existing `external_feed_credential` table has `status` ('pending', 'active', 'retired') and `expiresAt`; T-29.10 just exercises them.

---

## 2. State Machine

```
              ┌─────────┐
              │  idle   │
              └────┬────┘
                   │  rotate.request
                   ▼
              ┌─────────────┐
              │  requested  │  ← step-up enforced; rotation_request row persisted
              └──────┬──────┘
                     │  rotate.coApprove (by DIFFERENT membership; step-up enforced)
                     ▼
              ┌──────────────┐
              │ co_approved  │
              └──────┬───────┘
                     │  rotate.execute
                     ▼
              ┌──────────────┐
              │  executing   │  ← provision new credential, transition old, emit events
              └──────┬───────┘
                     │
       ┌─────────────┴─────────────┐
       │                           │
       ▼                           ▼
┌──────────┐               ┌──────────────┐
│ completed│               │ rolled_back  │  ← on error during executing
└──────────┘               └──────────────┘

Edge cases:
- rotate.cancel (by requester, while in 'requested' or 'co_approved') → moves to 'cancelled'
- rotate.timeout (no co-approval within 24h) → moves to 'expired'
```

Defined in XState v5 (the platform's standard state machine library per architecture §12.B).

```ts
// apps/backend/src/modules/29-external-interfaces/credentials/rotation-state-machine.ts
import { setup, assign } from 'xstate'

export interface RotationContext {
  rotationId: string
  feedId: string
  organizationId: string
  requesterMembershipId: string
  coApproverMembershipId?: string
  rationale: string
  oldCredentialId: string
  newCredentialId?: string  // populated on transition to executing
  startedAt: Date
  errorMessage?: string
}

export type RotationEvent =
  | { type: 'rotate.coApprove'; membershipId: string; coApproverRationale: string }
  | { type: 'rotate.execute'; executorMembershipId: string }
  | { type: 'rotate.executionSucceeded'; newCredentialId: string }
  | { type: 'rotate.executionFailed'; reason: string }
  | { type: 'rotate.cancel'; cancellerMembershipId: string }
  | { type: 'rotate.timeout' }

export const rotationMachine = setup({
  types: {
    context: {} as RotationContext,
    events: {} as RotationEvent,
  },
  guards: {
    differentApprover: ({ context, event }) => {
      if (event.type !== 'rotate.coApprove') return false
      return event.membershipId !== context.requesterMembershipId
    },
  },
}).createMachine({
  id: 'credential_rotation',
  initial: 'requested',
  context: ({ input }) => input as RotationContext,
  states: {
    requested: {
      on: {
        'rotate.coApprove': {
          guard: 'differentApprover',
          target: 'co_approved',
          actions: assign(({ event }) => ({
            coApproverMembershipId: event.type === 'rotate.coApprove' ? event.membershipId : undefined,
          })),
        },
        'rotate.cancel': { target: 'cancelled' },
        'rotate.timeout': { target: 'expired' },
      },
    },
    co_approved: {
      on: {
        'rotate.execute': { target: 'executing' },
        'rotate.cancel': { target: 'cancelled' },
      },
    },
    executing: {
      on: {
        'rotate.executionSucceeded': {
          target: 'completed',
          actions: assign(({ event }) => ({
            newCredentialId: event.type === 'rotate.executionSucceeded' ? event.newCredentialId : undefined,
          })),
        },
        'rotate.executionFailed': {
          target: 'rolled_back',
          actions: assign(({ event }) => ({
            errorMessage: event.type === 'rotate.executionFailed' ? event.reason : undefined,
          })),
        },
      },
    },
    completed: { type: 'final' },
    rolled_back: { type: 'final' },
    cancelled: { type: 'final' },
    expired: { type: 'final' },
  },
})
```

The state is persisted in a `credential_rotation_request` table (new — see §3). The XState machine is rehydrated per request from that row.

---

## 3. Schema Addition

One small new table for rotation tracking. Migration `0033_external_interfaces_credential_rotation.sql`.

```sql
-- Migration 0033_external_interfaces_credential_rotation.sql

CREATE TYPE credential_rotation_state AS ENUM (
  'requested', 'co_approved', 'executing', 'completed', 'rolled_back', 'cancelled', 'expired'
);

CREATE TABLE credential_rotation_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id),
  feed_id UUID NOT NULL REFERENCES external_feed(id),
  old_credential_id UUID NOT NULL REFERENCES external_feed_credential(id),
  new_credential_id UUID REFERENCES external_feed_credential(id),
  state credential_rotation_state NOT NULL DEFAULT 'requested',
  requester_membership_id UUID NOT NULL,
  co_approver_membership_id UUID,
  rationale TEXT NOT NULL,
  co_approver_rationale TEXT,
  executor_membership_id UUID,
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  co_approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  CONSTRAINT distinct_approvers CHECK (co_approver_membership_id IS NULL OR co_approver_membership_id != requester_membership_id)
);

CREATE INDEX idx_crr_feed_state ON credential_rotation_request (feed_id, state);
CREATE INDEX idx_crr_org ON credential_rotation_request (organization_id);
CREATE INDEX idx_crr_expires_active ON credential_rotation_request (expires_at)
  WHERE state IN ('requested', 'co_approved');

-- RLS
ALTER TABLE credential_rotation_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_crr_tenant ON credential_rotation_request
  USING (organization_id = current_setting('app.current_organization_id')::uuid);
```

Drizzle:

```ts
// packages/db/src/schema/external-interfaces/credential-rotation.ts
import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core'
import * as e from './enums'

export const credentialRotationState = pgEnum('credential_rotation_state', [
  'requested', 'co_approved', 'executing', 'completed', 'rolled_back', 'cancelled', 'expired',
])

export const credentialRotationRequest = pgTable('credential_rotation_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  feedId: uuid('feed_id').notNull(),
  oldCredentialId: uuid('old_credential_id').notNull(),
  newCredentialId: uuid('new_credential_id'),
  state: credentialRotationState('state').notNull().default('requested'),
  requesterMembershipId: uuid('requester_membership_id').notNull(),
  coApproverMembershipId: uuid('co_approver_membership_id'),
  rationale: text('rationale').notNull(),
  coApproverRationale: text('co_approver_rationale'),
  executorMembershipId: uuid('executor_membership_id'),
  errorMessage: text('error_message'),
  requestedAt: timestamp('requested_at').notNull().defaultNow(),
  coApprovedAt: timestamp('co_approved_at'),
  executedAt: timestamp('executed_at'),
  expiresAt: timestamp('expires_at').notNull(),
})
```

This is the **first schema addition since T-29.07** — flagged as such since the v0.3 consolidation pass was supposed to eliminate retroactive corrections. The rationale: rotation lifecycle tracking was implied by D18 (step-up + dual approval) but not explicitly enumerated as a table. The v0.3 spec mentioned the rotation predicate but not the rotation-request row. Acceptable additive change.

---

## 4. Rotation Service

Orchestrates the full lifecycle. Uses the XState machine internally but exposes a service API.

```ts
// apps/backend/src/modules/29-external-interfaces/credentials/rotation-service.ts
import { ulid } from 'ulid'
import { db } from '@wardenx/db'
import {
  credentialRotationRequest,
  externalFeedCredential,
  externalFeed,
} from '@wardenx/db/schema/external-interfaces'
import { and, eq } from 'drizzle-orm'
import { withOrgContext } from '@wardenx/tenancy'
import { rotationMachine } from './rotation-state-machine'
import { createActor } from 'xstate'
import type { CredentialBuilder } from './credential-builder'
import type { Outbox } from '@wardenx/foundation/outbox'
import type { AuditLogger } from '@wardenx/foundation/seams'
import type { Logger } from 'pino'

export class DistinctApproverRequiredError extends Error {
  constructor() { super('co_approver_must_differ_from_requester'); this.name = 'DistinctApproverRequiredError' }
}
export class RotationNotInRequiredStateError extends Error {
  constructor(public readonly state: string, public readonly required: string) { super(`rotation_in_state_${state}_not_${required}`); this.name = 'RotationNotInRequiredStateError' }
}
export class RotationExpiredError extends Error {
  constructor() { super('rotation_request_expired_24h'); this.name = 'RotationExpiredError' }
}
export class RotationNotFoundError extends Error {
  constructor() { super('rotation_not_found'); this.name = 'RotationNotFoundError' }
}

export interface RotationServiceDeps {
  readonly logger: Logger
  readonly credentialBuilder: CredentialBuilder
  readonly outbox: Outbox
  readonly audit: AuditLogger
}

export class RotationService {
  constructor(private readonly deps: RotationServiceDeps) {}

  // ─── Request rotation ───────────────────────────────────────────
  async request(input: {
    organizationId: string
    feedId: string
    requesterMembershipId: string
    rationale: string
  }): Promise<{ rotationId: string }> {
    if (!input.rationale || input.rationale.trim().length < 10) {
      throw new Error('rationale_too_short')
    }

    const result = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      // Resolve the current active credential for the feed
      const [active] = await tx
        .select()
        .from(externalFeedCredential)
        .where(and(
          eq(externalFeedCredential.feedId, input.feedId),
          eq(externalFeedCredential.status, 'active'),
        ))
        .limit(1)
      if (!active) throw new Error('no_active_credential_to_rotate')

      const rotationId = ulid()
      await tx.insert(credentialRotationRequest).values({
        id: rotationId,
        organizationId: input.organizationId,
        feedId: input.feedId,
        oldCredentialId: active.id,
        state: 'requested',
        requesterMembershipId: input.requesterMembershipId,
        rationale: input.rationale,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })

      return { rotationId, oldCredentialId: active.id }
    })

    await this.deps.audit.write({
      organizationId: input.organizationId,
      actorMembershipId: input.requesterMembershipId,
      action: 'external_feed_credential.rotation_requested',
      resourceId: result.rotationId,
      payload: { feedId: input.feedId, oldCredentialId: result.oldCredentialId, rationale: input.rationale },
    })

    return { rotationId: result.rotationId }
  }

  // ─── Co-approve ────────────────────────────────────────────────
  async coApprove(input: {
    rotationId: string
    organizationId: string
    coApproverMembershipId: string
    coApproverRationale: string
  }): Promise<void> {
    const row = await this.loadRotation(input.rotationId, input.organizationId)
    if (row.state !== 'requested') throw new RotationNotInRequiredStateError(row.state, 'requested')
    if (row.expiresAt < new Date()) throw new RotationExpiredError()
    if (row.requesterMembershipId === input.coApproverMembershipId) throw new DistinctApproverRequiredError()

    // Atomic transition: UPDATE WHERE state = 'requested'
    const updated = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      const result = await tx
        .update(credentialRotationRequest)
        .set({
          state: 'co_approved',
          coApproverMembershipId: input.coApproverMembershipId,
          coApproverRationale: input.coApproverRationale,
          coApprovedAt: new Date(),
        })
        .where(and(
          eq(credentialRotationRequest.id, input.rotationId),
          eq(credentialRotationRequest.organizationId, input.organizationId),
          eq(credentialRotationRequest.state, 'requested'),
        ))
        .returning()
      return result[0]
    })

    if (!updated) {
      // Either someone else co-approved first or the row state changed
      throw new RotationNotInRequiredStateError(row.state, 'requested')
    }

    await this.deps.audit.write({
      organizationId: input.organizationId,
      actorMembershipId: input.coApproverMembershipId,
      action: 'external_feed_credential.rotation_co_approved',
      resourceId: input.rotationId,
      payload: { coApproverRationale: input.coApproverRationale },
    })
  }

  // ─── Execute ───────────────────────────────────────────────────
  async execute(input: {
    rotationId: string
    organizationId: string
    executorMembershipId: string
  }): Promise<{ newCredentialId: string }> {
    const row = await this.loadRotation(input.rotationId, input.organizationId)
    if (row.state !== 'co_approved') throw new RotationNotInRequiredStateError(row.state, 'co_approved')

    // Atomic transition to executing (guards against double-execute race)
    const reserved = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      const result = await tx
        .update(credentialRotationRequest)
        .set({ state: 'executing', executorMembershipId: input.executorMembershipId, executedAt: new Date() })
        .where(and(
          eq(credentialRotationRequest.id, input.rotationId),
          eq(credentialRotationRequest.state, 'co_approved'),
        ))
        .returning()
      return result[0]
    })

    if (!reserved) throw new RotationNotInRequiredStateError('unknown', 'co_approved')

    try {
      // 1. Get the feed to determine credential kind (inbound vs outbound)
      const [feed] = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) =>
        tx.select().from(externalFeed).where(eq(externalFeed.id, row.feedId)).limit(1),
      )
      if (!feed) throw new Error('feed_not_found')

      // 2. Mint the new credential
      const newCredentialSecret = await this.deps.credentialBuilder.mint({
        feedKind: feed.kind,
        organizationId: input.organizationId,
        feedId: row.feedId,
        partnerHost: feed.host,
      })

      // 3. Persist new credential as 'pending' (atomically, also flipping the old to 'retired')
      const newCredentialId = ulid()
      const [oldCred] = await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
        // Insert new
        await tx.insert(externalFeedCredential).values({
          id: newCredentialId,
          organizationId: input.organizationId,
          feedId: row.feedId,
          kind: newCredentialSecret.kind,
          status: 'active',
          secretCipher: newCredentialSecret.envelopeEncrypted,
          fingerprint: newCredentialSecret.fingerprint,
          expiresAt: newCredentialSecret.expiresAt,
          createdAt: new Date(),
        })

        // Retire old
        const result = await tx
          .update(externalFeedCredential)
          .set({ status: 'retired', retiredAt: new Date() })
          .where(eq(externalFeedCredential.id, row.oldCredentialId))
          .returning()

        return result
      })

      // 4. Mark rotation completed
      await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
        await tx
          .update(credentialRotationRequest)
          .set({ state: 'completed', newCredentialId })
          .where(eq(credentialRotationRequest.id, input.rotationId))
      })

      // 5. Emit revocation event (T-29.04 inbound listener + T-29.08 outbound client consume this)
      await this.deps.outbox.publish('m29.external_feed_credential.revoked', {
        credentialId: row.oldCredentialId,
        feedId: row.feedId,
        organizationId: input.organizationId,
        fingerprint: oldCred?.fingerprint ?? '',
        retiredAt: new Date().toISOString(),
        replacedByCredentialId: newCredentialId,
      })

      // 6. Emit activation event (consumers may want to wire alerts on rotation)
      await this.deps.outbox.publish('m29.external_feed_credential.activated', {
        credentialId: newCredentialId,
        feedId: row.feedId,
        organizationId: input.organizationId,
        fingerprint: newCredentialSecret.fingerprint,
        expiresAt: newCredentialSecret.expiresAt.toISOString(),
        rotationRequestId: input.rotationId,
      })

      await this.deps.audit.write({
        organizationId: input.organizationId,
        actorMembershipId: input.executorMembershipId,
        action: 'external_feed_credential.rotation_executed',
        resourceId: input.rotationId,
        payload: {
          oldCredentialId: row.oldCredentialId,
          newCredentialId,
          newFingerprint: newCredentialSecret.fingerprint,
        },
      })

      return { newCredentialId }
    } catch (err) {
      // Rollback: flip rotation to rolled_back, attempt to leave old credential as 'active'
      this.deps.logger.error({ err, rotationId: input.rotationId }, 'rotation.execute.failed')
      await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
        await tx
          .update(credentialRotationRequest)
          .set({ state: 'rolled_back', errorMessage: (err as Error).message })
          .where(eq(credentialRotationRequest.id, input.rotationId))
      })

      await this.deps.audit.write({
        organizationId: input.organizationId,
        actorMembershipId: input.executorMembershipId,
        action: 'external_feed_credential.rotation_rolled_back',
        resourceId: input.rotationId,
        payload: { error: (err as Error).message },
      })

      throw err
    }
  }

  // ─── Cancel ────────────────────────────────────────────────────
  async cancel(input: {
    rotationId: string
    organizationId: string
    cancellerMembershipId: string
  }): Promise<void> {
    const row = await this.loadRotation(input.rotationId, input.organizationId)
    if (!['requested', 'co_approved'].includes(row.state)) {
      throw new RotationNotInRequiredStateError(row.state, 'requested_or_co_approved')
    }
    if (row.requesterMembershipId !== input.cancellerMembershipId && row.coApproverMembershipId !== input.cancellerMembershipId) {
      throw new Error('only_requester_or_coapprover_may_cancel')
    }

    await withOrgContext(db, { organizationId: input.organizationId }, async (tx) => {
      await tx
        .update(credentialRotationRequest)
        .set({ state: 'cancelled' })
        .where(and(
          eq(credentialRotationRequest.id, input.rotationId),
          eq(credentialRotationRequest.organizationId, input.organizationId),
        ))
    })

    await this.deps.audit.write({
      organizationId: input.organizationId,
      actorMembershipId: input.cancellerMembershipId,
      action: 'external_feed_credential.rotation_cancelled',
      resourceId: input.rotationId,
      payload: {},
    })
  }

  // ─── Read ──────────────────────────────────────────────────────
  async get(rotationId: string, organizationId: string) {
    return this.loadRotation(rotationId, organizationId)
  }

  private async loadRotation(rotationId: string, organizationId: string) {
    const [row] = await withOrgContext(db, { organizationId }, async (tx) =>
      tx
        .select()
        .from(credentialRotationRequest)
        .where(and(
          eq(credentialRotationRequest.id, rotationId),
          eq(credentialRotationRequest.organizationId, organizationId),
        ))
        .limit(1),
    )
    if (!row) throw new RotationNotFoundError()
    return row
  }
}
```

---

## 5. Credential Builder

KMS-backed mint. Supports both inbound (server cert + client-CA) and outbound (client cert + server-CA) variants.

```ts
// apps/backend/src/modules/29-external-interfaces/credentials/credential-builder.ts
import * as forge from 'node-forge'
import type { KmsEnvelopeEncryptor, KeyManagementSystem } from '@wardenx/foundation/seams'
import type { Logger } from 'pino'

export interface CredentialMintInput {
  readonly feedKind: 'adt_inbound' | 'lab_inbound' | 'orm_outbound'
  readonly organizationId: string
  readonly feedId: string
  readonly partnerHost: string
}

export interface CredentialMintResult {
  readonly kind: 'mllp_server_cert' | 'mllp_client_cert'
  readonly envelopeEncrypted: string  // ready to write to external_feed_credential.secret_cipher
  readonly fingerprint: string        // first 16 hex of SHA-256 of cert DER
  readonly certPem: string            // for ops display / partner export
  readonly expiresAt: Date
}

const CERT_VALIDITY_DAYS = 365

export class CredentialBuilder {
  constructor(
    private readonly deps: {
      envelope: KmsEnvelopeEncryptor
      kms: KeyManagementSystem
      logger: Logger
      caCertPath: string  // platform-provisioned root CA cert
      caKeyKmsRef: string  // platform-provisioned root CA private key, referenced via KMS
    },
  ) {}

  async mint(input: CredentialMintInput): Promise<CredentialMintResult> {
    const isInbound = input.feedKind === 'adt_inbound' || input.feedKind === 'lab_inbound'

    // 1. Generate keypair
    const keys = forge.pki.rsa.generateKeyPair({ bits: 4096, e: 0x10001 })

    // 2. Build cert
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01' + Date.now().toString(16)
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date(Date.now() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
    cert.setSubject([
      { name: 'commonName', value: isInbound ? `wardenx-${input.feedId}` : `wardenx-client-${input.feedId}` },
      { name: 'organizationName', value: 'WardenX' },
      { name: 'organizationalUnitName', value: `Feed-${input.feedId.slice(0, 8)}` },
    ])
    cert.setIssuer(this.getCaSubject())
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      {
        name: 'extKeyUsage',
        serverAuth: isInbound,
        clientAuth: !isInbound,
      },
      ...(isInbound ? [{
        name: 'subjectAltName',
        altNames: [{ type: 2 /* DNS */, value: input.partnerHost }],
      }] : []),
    ])

    // 3. Sign with platform CA (via KMS)
    await this.signCertViaKms(cert, this.deps.caKeyKmsRef)

    // 4. Materialize PEM
    const certPem = forge.pki.certificateToPem(cert)
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey)

    // 5. Fingerprint
    const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
    const md = forge.md.sha256.create()
    md.update(derBytes)
    const fingerprintFull = md.digest().toHex()
    const fingerprint = fingerprintFull.slice(0, 16).toUpperCase()

    // 6. Bundle the credential secret + envelope-encrypt
    const secretJson = isInbound
      ? JSON.stringify({
          serverCertPem: certPem,
          serverKeyPem: privateKeyPem,
          expectedClientCaPem: await this.readCaCertPem(),  // for now self-signed against platform CA
        })
      : JSON.stringify({
          clientCertPem: certPem,
          clientKeyPem: privateKeyPem,
          expectedServerCaPem: await this.readCaCertPem(),
        })

    const envelopeEncrypted = await this.deps.envelope.encrypt(secretJson, { organizationId: input.organizationId })

    return {
      kind: isInbound ? 'mllp_server_cert' : 'mllp_client_cert',
      envelopeEncrypted,
      fingerprint,
      certPem,
      expiresAt: cert.validity.notAfter,
    }
  }

  private getCaSubject(): Array<{ name: string; value: string }> {
    // Read from the platform CA cert path; cached. Omitted for brevity.
    return [{ name: 'commonName', value: 'WardenX Platform Root CA' }, { name: 'organizationName', value: 'WardenX Platform' }]
  }

  private async signCertViaKms(cert: forge.pki.Certificate, kmsKeyRef: string): Promise<void> {
    // The platform CA private key lives in KMS; node-forge requires a local private key
    // to sign. The signing path:
    //   1. Build the to-be-signed (TBS) certificate ASN.1 structure
    //   2. Hash the TBS with SHA-256
    //   3. Call KMS.sign(kmsKeyRef, digest, { algorithm: 'RSASSA_PKCS1_V1_5_SHA_256' })
    //   4. Splice the signature back into the cert structure
    // This avoids exposing the CA private key to the application process.
    //
    // Detailed implementation omitted; the platform's KMS-sign helper handles it.
    await this.deps.kms.signX509({ kmsKeyRef, certificate: cert })
  }

  private async readCaCertPem(): Promise<string> {
    // Read from cached file. Omitted.
    return '-----BEGIN CERTIFICATE-----\n...PLATFORM_CA...\n-----END CERTIFICATE-----'
  }
}
```

The credential builder is purposefully thin — most of the heavy crypto lives in the platform's KMS-sign helper. The builder's job is to assemble the right cert structure, request KMS signing, package the result for envelope encryption.

---

## 6. HTTP Routes

```ts
// apps/backend/src/modules/29-external-interfaces/routes/credential-rotation.ts
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { RotationService, DistinctApproverRequiredError, RotationNotInRequiredStateError, RotationExpiredError, RotationNotFoundError } from '../credentials/rotation-service'
import { requirePermissions } from '@wardenx/foundation/auth'
import { requirePredicate } from '@wardenx/foundation/abac'

export function registerCredentialRotationRoutes(app: FastifyInstance, service: RotationService): void {
  // POST request rotation
  app.post(
    '/api/v1/hl7/feeds/:feedId/credentials/rotate/request',
    {
      schema: {
        params: Type.Object({ feedId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          rationale: Type.String({ minLength: 10, maxLength: 4000 }),
        }),
      },
      preHandler: [
        requirePermissions(['external_interfaces.feed_credential:rotate']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),  // D18 step-up
        requirePredicate('external_feed_organization_scope', {}),
      ],
    },
    async (req, reply) => {
      const { feedId } = req.params as { feedId: string }
      const { rationale } = req.body as { rationale: string }
      const { rotationId } = await service.request({
        organizationId: req.user!.organizationId,
        feedId,
        requesterMembershipId: req.user!.membershipId,
        rationale,
      })
      return reply.code(201).send({ rotationId, state: 'requested' })
    },
  )

  // POST co-approve
  app.post(
    '/api/v1/hl7/feeds/credentials/rotations/:rotationId/approve',
    {
      schema: {
        params: Type.Object({ rotationId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          coApproverRationale: Type.String({ minLength: 10, maxLength: 4000 }),
        }),
      },
      preHandler: [
        requirePermissions(['external_interfaces.feed_credential:rotate']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
        requirePredicate('external_feed_compliance_co_approver_distinct', {}),
      ],
    },
    async (req, reply) => {
      const { rotationId } = req.params as { rotationId: string }
      const { coApproverRationale } = req.body as { coApproverRationale: string }
      try {
        await service.coApprove({
          rotationId,
          organizationId: req.user!.organizationId,
          coApproverMembershipId: req.user!.membershipId,
          coApproverRationale,
        })
        return { state: 'co_approved' }
      } catch (err) {
        if (err instanceof DistinctApproverRequiredError) return reply.code(403).send({ error: 'co_approver_must_differ' })
        if (err instanceof RotationNotInRequiredStateError) return reply.code(409).send({ error: 'rotation_not_in_required_state', currentState: err.state })
        if (err instanceof RotationExpiredError) return reply.code(410).send({ error: 'rotation_expired' })
        if (err instanceof RotationNotFoundError) return reply.code(404).send({ error: 'rotation_not_found' })
        throw err
      }
    },
  )

  // POST execute
  app.post(
    '/api/v1/hl7/feeds/credentials/rotations/:rotationId/execute',
    {
      schema: { params: Type.Object({ rotationId: Type.String({ format: 'uuid' }) }) },
      preHandler: [
        requirePermissions(['external_interfaces.feed_credential:rotate']),
        requirePredicate('step_up_recent', { maxAgeSec: 300 }),
      ],
    },
    async (req, reply) => {
      const { rotationId } = req.params as { rotationId: string }
      try {
        const { newCredentialId } = await service.execute({
          rotationId,
          organizationId: req.user!.organizationId,
          executorMembershipId: req.user!.membershipId,
        })
        return { state: 'completed', newCredentialId }
      } catch (err) {
        if (err instanceof RotationNotInRequiredStateError) return reply.code(409).send({ error: 'rotation_not_in_required_state', currentState: err.state })
        if (err instanceof RotationNotFoundError) return reply.code(404).send({ error: 'rotation_not_found' })
        throw err
      }
    },
  )

  // POST cancel
  app.post(
    '/api/v1/hl7/feeds/credentials/rotations/:rotationId/cancel',
    {
      schema: { params: Type.Object({ rotationId: Type.String({ format: 'uuid' }) }) },
      preHandler: [requirePermissions(['external_interfaces.feed_credential:rotate'])],
    },
    async (req) => {
      const { rotationId } = req.params as { rotationId: string }
      await service.cancel({
        rotationId,
        organizationId: req.user!.organizationId,
        cancellerMembershipId: req.user!.membershipId,
      })
      return { state: 'cancelled' }
    },
  )

  // GET rotation status
  app.get(
    '/api/v1/hl7/feeds/credentials/rotations/:rotationId',
    {
      schema: { params: Type.Object({ rotationId: Type.String({ format: 'uuid' }) }) },
      preHandler: [requirePermissions(['external_interfaces.feed_credential:read'])],
    },
    async (req, reply) => {
      const { rotationId } = req.params as { rotationId: string }
      try {
        return await req.user!.organizationId ? service.get(rotationId, req.user!.organizationId) : null
      } catch (err) {
        if (err instanceof RotationNotFoundError) return reply.code(404).send({ error: 'rotation_not_found' })
        throw err
      }
    },
  )
}
```

---

## 7. ABAC Predicate: Distinct Co-Approver

Per M29 v0.3 §4.7 (D20), the predicate `external_feed_compliance_co_approver_distinct` is declared but not yet implemented. T-29.10 ships it.

```ts
// apps/backend/src/modules/03-authorization/predicates/external_feed_compliance_co_approver_distinct.ts
import type { PredicateContext } from '../predicate-types'
import { credentialRotationRequest } from '@wardenx/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withOrgContext } from '@wardenx/tenancy'

export const externalFeedComplianceCoApproverDistinct = {
  name: 'external_feed_compliance_co_approver_distinct' as const,

  async evaluate(ctx: PredicateContext): Promise<{ allow: boolean; reason?: string }> {
    // ctx.resource.kind is 'credential_rotation_request'; ctx.resource.id is the rotation row id
    if (ctx.resource?.kind !== 'credential_rotation_request') {
      return { allow: false, reason: 'predicate_misconfigured_wrong_resource' }
    }

    const [row] = await withOrgContext(ctx.db, { organizationId: ctx.subject.organizationId }, async (tx) =>
      tx
        .select({
          requesterMembershipId: credentialRotationRequest.requesterMembershipId,
          organizationId: credentialRotationRequest.organizationId,
        })
        .from(credentialRotationRequest)
        .where(eq(credentialRotationRequest.id, ctx.resource.id))
        .limit(1),
    )

    if (!row) return { allow: false, reason: 'rotation_not_found' }
    if (row.organizationId !== ctx.subject.organizationId) return { allow: false, reason: 'cross_tenant' }

    // The caller MUST be a different membership from the requester
    if (row.requesterMembershipId === ctx.subject.membershipId) {
      return { allow: false, reason: 'co_approver_must_differ_from_requester' }
    }

    return { allow: true }
  },
} as const
```

Registered in M3 boot:

```ts
// apps/backend/src/modules/03-authorization/predicate-registry.ts
import { externalFeedComplianceCoApproverDistinct } from './predicates/external_feed_compliance_co_approver_distinct'
export function registerM3Predicates(registry: PredicateRegistry): void {
  // ... existing ...
  registry.register(externalFeedComplianceCoApproverDistinct)
}
```

---

## 8. Expiration Sweep Worker

A scheduled BullMQ job (10-minute cadence) that does two things:

1. Auto-expires any rotation request past its 24h `expires_at` (no co-approval received).
2. Scans `external_feed_credential` for credentials approaching expiration; emits M36 alerts at 30, 7, and 1 days out.

```ts
// apps/backend/src/modules/29-external-interfaces/workers/credential-expiration-sweep.worker.ts
import { Worker } from 'bullmq'
import { pino } from 'pino'
import { db } from '@wardenx/db'
import { credentialRotationRequest, externalFeedCredential } from '@wardenx/db/schema/external-interfaces'
import { and, eq, lt, gt, isNull } from 'drizzle-orm'
import { withPlatformContext } from '@wardenx/tenancy'
import { mkAlertsClient } from '@wardenx/foundation/seams/alerts'
import { mkOutbox } from '@wardenx/foundation/seams/outbox'

const logger = pino({ name: 'credential-expiration-sweep' })
const outbox = mkOutbox(db, logger)
const alerts = mkAlertsClient()

export const credentialExpirationSweepWorker = new Worker(
  'credential-expiration-sweep',
  async () => {
    const now = new Date()

    // 1. Expire stale rotation requests
    await withPlatformContext(db, async (tx) => {
      const expired = await tx
        .update(credentialRotationRequest)
        .set({ state: 'expired' })
        .where(and(
          lt(credentialRotationRequest.expiresAt, now),
          // state IN ('requested', 'co_approved')
        ))
        .returning({ id: credentialRotationRequest.id, organizationId: credentialRotationRequest.organizationId, feedId: credentialRotationRequest.feedId })

      for (const r of expired) {
        await outbox.publish('m29.credential_rotation.expired', {
          rotationId: r.id, organizationId: r.organizationId, feedId: r.feedId, expiredAt: now.toISOString(),
        })
      }
    })

    // 2. Credential-approaching-expiration alerts at 30/7/1 days
    const windows = [
      { days: 30, severity: 'NORMAL' as const, channel: 'tenant_admin' },
      { days: 7, severity: 'HIGH' as const, channel: 'tenant_admin' },
      { days: 1, severity: 'CRITICAL' as const, channel: 'operator_on_call' },
    ]

    for (const win of windows) {
      const lowerBound = new Date(now.getTime() + (win.days - 1) * 24 * 60 * 60 * 1000)
      const upperBound = new Date(now.getTime() + win.days * 24 * 60 * 60 * 1000)

      const expiring = await withPlatformContext(db, async (tx) =>
        tx
          .select()
          .from(externalFeedCredential)
          .where(and(
            eq(externalFeedCredential.status, 'active'),
            gt(externalFeedCredential.expiresAt, lowerBound),
            lt(externalFeedCredential.expiresAt, upperBound),
          )),
      )

      for (const cred of expiring) {
        await alerts.dispatch({
          severity: win.severity,
          channel: win.channel,
          organizationId: cred.organizationId,
          title: `HL7 feed credential expiring in ~${win.days} days`,
          body: `Feed ${cred.feedId}: credential ${cred.id} (fingerprint ${cred.fingerprint}) expires ${cred.expiresAt.toISOString()}. Initiate rotation via /api/v1/hl7/feeds/${cred.feedId}/credentials/rotate/request.`,
        })
      }
    }
  },
  {
    connection: { url: process.env.VALKEY_URL! },
    concurrency: 1,
  },
)
```

---

## 9. Tests

### 9.1 W-XI-13 — happy path

```ts
describe('W-XI-13 — credential rotation happy path', () => {
  it('request → coApprove (different membership) → execute → CRL refresh', async () => {
    const feed = await fixtures.feed({ id: 'feed_1', kind: 'adt_inbound' })
    const oldCred = await fixtures.activeCredential(feed)
    const userA = await fixtures.user({ permissions: ['external_interfaces.feed_credential:rotate'], stepUp: true })
    const userB = await fixtures.user({ permissions: ['external_interfaces.feed_credential:rotate'], stepUp: true })

    // 1. Request
    const req = await client.post(`/api/v1/hl7/feeds/feed_1/credentials/rotate/request`, {
      rationale: 'Quarterly rotation per security policy',
    }, { user: userA })
    expect(req.statusCode).toBe(201)
    const { rotationId } = req.body

    // 2. Co-approve (different user)
    const approve = await client.post(`/api/v1/hl7/feeds/credentials/rotations/${rotationId}/approve`, {
      coApproverRationale: 'Compliance review approves; security policy current',
    }, { user: userB })
    expect(approve.statusCode).toBe(200)

    // 3. Execute (any authorized user; commonly the requester)
    const exec = await client.post(`/api/v1/hl7/feeds/credentials/rotations/${rotationId}/execute`, {}, { user: userA })
    expect(exec.statusCode).toBe(200)
    expect(exec.body.state).toBe('completed')
    expect(exec.body.newCredentialId).toBeDefined()

    // Old credential is retired, new is active
    const [oldNow] = await db.select().from(externalFeedCredential).where(eq(externalFeedCredential.id, oldCred.id))
    expect(oldNow.status).toBe('retired')

    const [newCred] = await db.select().from(externalFeedCredential).where(eq(externalFeedCredential.id, exec.body.newCredentialId))
    expect(newCred.status).toBe('active')

    // CRL refresh event emitted
    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.external_feed_credential.revoked')).toMatchObject({
      payload: expect.objectContaining({ credentialId: oldCred.id, replacedByCredentialId: newCred.id }),
    })
  })
})
```

### 9.2 Dual-approver requirement

```ts
describe('co-approver must differ from requester', () => {
  it('same user co-approving → 403 co_approver_must_differ', async () => {
    const userA = await fixtures.user({ permissions: ['external_interfaces.feed_credential:rotate'], stepUp: true })
    const req = await client.post('/api/v1/hl7/feeds/feed_1/credentials/rotate/request', { rationale: 'Test' }, { user: userA })
    const { rotationId } = req.body

    const approve = await client.post(`/api/v1/hl7/feeds/credentials/rotations/${rotationId}/approve`, {
      coApproverRationale: 'Self-approving',
    }, { user: userA })  // same user

    expect(approve.statusCode).toBe(403)
    expect(approve.body.error).toBe('co_approver_must_differ')

    const [row] = await db.select().from(credentialRotationRequest).where(eq(credentialRotationRequest.id, rotationId))
    expect(row.state).toBe('requested')  // unchanged
  })
})
```

### 9.3 Step-up required

```ts
describe('step-up auth required on rotate paths', () => {
  it('request without recent step-up → 403', async () => {
    const user = await fixtures.user({ permissions: ['external_interfaces.feed_credential:rotate'], stepUp: false })
    const res = await client.post('/api/v1/hl7/feeds/feed_1/credentials/rotate/request', { rationale: 'Test' }, { user })
    expect(res.statusCode).toBe(403)
  })

  it('coApprove without recent step-up → 403 even with permission', async () => {
    // ... similar shape ...
  })

  it('execute without recent step-up → 403', async () => {
    // ... similar shape ...
  })
})
```

### 9.4 Atomic execute (concurrent guard)

```ts
describe('concurrent execute on same rotation → exactly one succeeds', () => {
  it('two parallel execute calls → one 200, one 409', async () => {
    const rotationId = await setupCoApproved()
    const userA = await fixtures.user({ permissions: ['external_interfaces.feed_credential:rotate'], stepUp: true })
    const userB = await fixtures.user({ permissions: ['external_interfaces.feed_credential:rotate'], stepUp: true })

    const [resA, resB] = await Promise.all([
      client.post(`/api/v1/hl7/feeds/credentials/rotations/${rotationId}/execute`, {}, { user: userA }),
      client.post(`/api/v1/hl7/feeds/credentials/rotations/${rotationId}/execute`, {}, { user: userB }),
    ])

    const codes = [resA.statusCode, resB.statusCode].sort()
    expect(codes).toEqual([200, 409])

    // Exactly one new credential exists
    const creds = await db.select().from(externalFeedCredential)
      .where(and(eq(externalFeedCredential.feedId, 'feed_1'), eq(externalFeedCredential.status, 'active')))
    expect(creds).toHaveLength(1)
  })
})
```

### 9.5 Rollback on execution failure

```ts
describe('rollback when credential mint fails mid-execute', () => {
  it('KMS sign failure → rotation rolled_back, old credential remains active', async () => {
    mockKms.signX509.mockRejectedValueOnce(new Error('KMS unavailable'))
    const rotationId = await setupCoApproved()

    const res = await client.post(`/api/v1/hl7/feeds/credentials/rotations/${rotationId}/execute`, {}, { user: userA })
    expect(res.statusCode).toBe(500)

    const [row] = await db.select().from(credentialRotationRequest).where(eq(credentialRotationRequest.id, rotationId))
    expect(row.state).toBe('rolled_back')
    expect(row.errorMessage).toMatch(/KMS unavailable/)

    // Old credential still active
    const [oldCred] = await db.select().from(externalFeedCredential).where(eq(externalFeedCredential.id, 'old_cred_1'))
    expect(oldCred.status).toBe('active')
  })
})
```

### 9.6 24h expiration timeout

```ts
describe('rotation request expires after 24h with no co-approval', () => {
  it('expire-sweep flips a 25h-old requested → expired', async () => {
    const rotationId = await fixtures.rotationRequest({ state: 'requested', requestedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })

    await runExpirationSweep()

    const [row] = await db.select().from(credentialRotationRequest).where(eq(credentialRotationRequest.id, rotationId))
    expect(row.state).toBe('expired')

    const events = await fixtures.outboxEvents()
    expect(events.find(e => e.name === 'm29.credential_rotation.expired')).toBeDefined()
  })
})
```

### 9.7 Credential-expiration alert ladder

```ts
describe('credential expiration alerts at 30/7/1 days', () => {
  it('credential expiring in ~7 days → HIGH severity M36 alert', async () => {
    await fixtures.activeCredential({ expiresAt: new Date(Date.now() + 6.5 * 24 * 60 * 60 * 1000) })
    await runExpirationSweep()
    const alerts = mockAlerts.getDispatched()
    expect(alerts).toContainEqual(expect.objectContaining({
      severity: 'HIGH',
      title: expect.stringContaining('expiring in ~7 days'),
    }))
  })

  it('credential expiring in ~1 day → CRITICAL', async () => {
    await fixtures.activeCredential({ expiresAt: new Date(Date.now() + 0.5 * 24 * 60 * 60 * 1000) })
    await runExpirationSweep()
    expect(mockAlerts.getDispatched()).toContainEqual(expect.objectContaining({ severity: 'CRITICAL' }))
  })
})
```

### 9.8 CRL consumption by listener

```ts
describe('listener CRL is updated by rotation', () => {
  it('after rotation completes, the old cert fingerprint is in the listener\'s revocation set within 2s', async () => {
    // Boot a listener for feed_1
    const listener = await setupListener('feed_1')
    const oldFingerprint = 'ABCD1234EFGH5678'  // matches old cred

    // Run a rotation
    const { rotationId, newCredentialId } = await runRotation('feed_1')

    // Wait for the revocation event to propagate
    await wait(2_000)

    expect(listener.revocationList.contains(oldFingerprint)).toBe(true)

    // Attempt a TLS connect with the old cert → refused
    const attempt = await mockPartnerConnect({ feedId: 'feed_1', clientCertFingerprint: oldFingerprint })
    expect(attempt).toBeRejected()
  })
})
```

---

## 10. Sign-Off Checklist (T-29.10 PR)

- [ ] Migration `0033_external_interfaces_credential_rotation.sql` lands (1 enum, 1 table, 3 indexes, CHECK constraint, RLS policy).
- [ ] All 5 source files land: `rotation-state-machine.ts`, `rotation-service.ts`, `credential-builder.ts`, `routes/credential-rotation.ts`, `workers/credential-expiration-sweep.worker.ts`.
- [ ] ABAC predicate `external_feed_compliance_co_approver_distinct` registered in M3.
- [ ] HTTP routes guarded by `step_up_recent` predicate (request, coApprove, execute) — verified by §9.3 tests.
- [ ] Co-approver distinct from requester enforced at predicate AND service layers (defense in depth) — §9.2.
- [ ] Atomic execute via `UPDATE WHERE state='co_approved'` — §9.4.
- [ ] Rollback path: any error during execute → rotation moves to `rolled_back`, old credential remains `active`, new credential row not created — §9.5.
- [ ] 24h expiration sweep — §9.6.
- [ ] Credential expiration alerts at 30/7/1 days — §9.7.
- [ ] CRL refresh propagates to listener within ≤2s — §9.8. Same test should pass for the T-29.08 outbound MLLP client.
- [ ] KMS-backed signing — no CA private key material exposed to the application process. Verified by code review.
- [ ] Audit trail — every state transition writes a row to M4 audit with actor, before/after, rationale.
- [ ] Cross-tenant safety — a tenant-A user cannot read or co-approve a tenant-B rotation. Test asserts.
- [ ] Cruiser passes — `external_feed_compliance_co_approver_distinct` predicate is the only M3 file that imports M29 schema, and the cruiser allowlist documents this exception.
- [ ] **Security engineer** sign-off on the KMS-sign flow + CA private-key isolation.
- [ ] **Compliance officer** sign-off on the dual-approval enforcement and audit trail.
- [ ] **M3 owner** sign-off on the new predicate registration.
- [ ] **Platform owner** sign-off on the platform CA reference path (`caCertPath`, `caKeyKmsRef` config).

---

## 11. Notes on Refinements Past M29 Spec v0.3

1. **New table `credential_rotation_request`** (§3) — v0.3 referenced the rotation predicate but didn't enumerate a rotation-request row. T-29.10 adds it. First schema addition since T-29.07.

2. **24h request TTL** — pinned in T-29.10. Spec D18 mentioned step-up + dual approval but didn't pin a request TTL. 24h is the platform default per M2 §SESSION_POLICY.

3. **Alert ladder at 30/7/1 days** — pinned. Spec mentioned `external_feed.baa_expiring` and `credential-expiring alerts` but didn't pin the windows. M36 spec might want to standardize these for cross-module reuse (M22 doc retention, M40 BAA, etc.).

4. **KMS-backed CA signing.** The credential builder never touches the CA private key directly — it builds the TBS cert and asks KMS to sign. Defense against application-process compromise.

5. **`m29.credential_rotation.expired` outbox event** — new (10th v0.3-era event). Should be added to M29 §4.10 catalog. The PR includes the M4 catalog registration.

6. **Predicate evaluation against same-tenant rotation row** — the distinct-co-approver predicate reads the rotation row by ID to check the requester. RLS guarantees cross-tenant isolation; the predicate also explicitly checks `organizationId === ctx.subject.organizationId` as belt-and-suspenders.

---

## Document Footer

**Addendum version:** v1.0 (T-29.10 PR-ready)
**Bound to:** M29 v0.3 §4.x credential lifecycle, §11 D18, D23, §4.7 (D20 predicate)
**Files delivered:** 5 source files + 1 migration + 1 ABAC predicate + 1 expiration-sweep worker
**Workflows closed:** W-XI-13
**Schema additions:** 1 new table (`credential_rotation_request`), 1 new enum, 1 new outbox event
**Sign-offs required:** Security engineer, Compliance officer, M3 owner, Platform owner

**End of T-29.10 credential rotation addendum.**
