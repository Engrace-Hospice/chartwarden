// @wardenx/messaging — the §4.6 published seam CONTRACTS (the surfaces every consumer imports).
//
// M36-T06. These are the interfaces clinical/billing modules import to consume messaging without
// a direct schema edge (ADR-0005 D1): the IMPLEMENTATION is injected at boot into the M1 seam
// registry and validated by validateSeams(); consumers resolve a typed handle through the
// module-36 accessor (apps/backend/src/modules/36-messaging/seams.ts). Like M38's
// `TerminologyProvider`, the rich shapes live HERE in the feature package (not the leaf
// @wardenx/types, which `leaves-stay-leaves` forbids importing them) — so the M1 registry holds
// the instance opaquely and this file is the typed boundary.
//
// SCOPE (T06): this task ships the published TYPES + the boot-validated `AlertEmitter` (its real
// slice impl composes the T04 resolution/fan-out engine — see ../seams). `MessagingProvider`
// (channel/message CRUD with per-tenant DEK body encryption) is declared here and registered
// fail-closed (deny-stub) in the M1 registry; its DB-backed implementation lands with the routes
// and realtime/jobs tasks (M36-T07/T08).

import type { ChannelKind, MessageBodyKind } from "./kinds";

/** An attachment supplied with {@link MessagingProvider.sendMessage} (§3.4). The body/object
 *  store wiring is M36-T08; the seam contract only names the caller-supplied metadata. */
export interface AttachmentInput {
  /** Object-store key the upload was staged under (pre-signed PUT, M36-T08). */
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export type MessageReferenceKind = "staff" | "patient";

/** UTF-16 code-unit offsets, matching the browser textarea selection model. */
export interface MessageReferenceInput {
  readonly kind: MessageReferenceKind;
  readonly entityId: string;
  readonly start: number;
  readonly end: number;
}

export interface ResolvedMessageReference extends MessageReferenceInput {
  /** Server-authoritative label; never accepted from the client. */
  readonly displayLabel: string;
  /** False when current authorization no longer permits navigation to the entity. */
  readonly navigable: boolean;
}

/** A message as returned to an entitled reader (§3.4) — body decrypted for users who may see it. */
export interface ResolvedMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorUserId: string | null; // null ⇒ system-authored (§3.4 author_kind)
  readonly authorDisplayName: string | null;
  readonly body: string; // decrypted under the tenant DEK for entitled readers only
  readonly bodyKind: MessageBodyKind;
  readonly createdAt: string; // ISO-8601
  readonly parentMessageId: string | null;
  readonly references: readonly ResolvedMessageReference[];
}

/**
 * M36 — the channel/message surface (§4.6). Body is plaintext at the seam boundary and is
 * encrypted at write time under the tenant DEK (§3.4 / D2); `listMessages` decrypts only for
 * entitled readers. Auto-sync hooks (`sync*`) are driven by M5/M16/M19 outbox events so a
 * channel's membership tracks the source-of-truth lifecycle (§2.3 `membership_source = auto`).
 */
export interface MessagingProvider {
  /** Open or fetch a channel by (kind, subject) — idempotent (§3.3). */
  openChannel(
    orgId: string,
    spec: { kind: ChannelKind; subjectId?: string; title?: string; creatorUserId: string },
  ): Promise<{ channelId: string; created: boolean }>;

  /** Send a message — body is plaintext, encrypted at write time under the tenant DEK. */
  sendMessage(
    orgId: string,
    input: {
      channelId: string;
      authorUserId: string;
      body: string;
      bodyKind?: MessageBodyKind;
      parentMessageId?: string;
      quotedMessageId?: string;
      attachments?: readonly AttachmentInput[];
      correlationId?: string;
      references?: readonly MessageReferenceInput[];
    },
  ): Promise<{ messageId: string; createdAt: string }>;

  /** Mark message(s) read for a user (§3.4 receipts). */
  markRead(
    orgId: string,
    input: { userId: string; messageId: string; upTo?: boolean },
  ): Promise<void>;

  /** Paginated channel history (decrypts bodies for entitled users only). */
  listMessages(
    orgId: string,
    input: { channelId: string; userId: string; cursor?: string; limit?: number },
  ): Promise<{ messages: readonly ResolvedMessage[]; nextCursor?: string }>;

  /** Auto-sync hooks consumed by M5/M17/M19/M16 outbox events (§2.3). */
  syncCareTeamChannel(
    orgId: string,
    patientId: string,
  ): Promise<{ channelId: string; membershipChanged: boolean }>;
  syncOnCallChannel(orgId: string, providerEntityId: string): Promise<void>;
  syncBereavementChannel(
    orgId: string,
    bereavementPlanId: string,
    action: "open" | "close",
  ): Promise<void>;
  archiveCareTeamChannel(orgId: string, patientId: string): Promise<void>;
}
