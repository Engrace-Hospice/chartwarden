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

import type { MessageReactionSummary, MessageUrgency, PollView, RichBody } from "@wardenx/types";
import type { ChannelKind, MessageBodyKind } from "./kinds";

/** An attachment supplied with {@link MessagingProvider.sendMessage} (§3.4, WP 1.5). It references an upload the SAME
 *  user already authorized and completed through `POST /api/v1/messaging/attachments/uploads`; the server looks the
 *  rest up and never trusts client-supplied file metadata. */
export interface AttachmentInput {
  readonly attachmentId: string;
}

/** An attachment as an entitled reader sees it. Never a document reference, object key or permanent URL: the bytes
 *  are fetched through `GET /api/v1/messaging/attachments/:id/access`, which re-authorizes every open. */
export interface MessageAttachmentView {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  /** `available`: scanned clean. `scanning`: pending - shown to the uploader only; every other reader gets no entry. */
  readonly availability: "available" | "scanning";
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
  /** WP 2.1: for `bodyKind: "rich"`, `body` is the plain-text projection and this is the sanitised document. */
  readonly bodyDoc?: RichBody;
  /** WP 2.1: a rich body that is stored but no longer parses; `body` is then empty and the UI says so. */
  readonly bodyUnreadable?: true;
  readonly createdAt: string; // ISO-8601
  /** WP 1.3: when a live message was last edited; null/absent means never edited (or deleted). */
  readonly editedAt?: string | null;
  readonly parentMessageId: string | null;
  /** WP 4.1: present only when the message is not routine (`urgent` = raised through "Urgent clinical"). Display only. */
  readonly urgency?: Exclude<MessageUrgency, "routine">;
  /** WP 2.2: live (not deleted) direct replies. Absent on providers that do not compute it; 0 means none. */
  readonly replyCount?: number;
  /** WP 2.2: created_at of the newest live direct reply, or null. */
  readonly lastReplyAt?: string | null;
  readonly references: readonly ResolvedMessageReference[];
  /**
   * WP 3.2: the message's clinical links as ids and kind only. No status or label: the client calls
   * `GET /clinical-links/:link_id/resolve` per chip, which re-checks the viewer. Absent when the message has none.
   */
  readonly clinicalLinks?: readonly { link_id: string; kind: string; entity_id: string }[];
  /** WP 2.4: non-clinical reactions (counts + the viewer's own); absent/empty means none. NEVER a sign-off. */
  readonly reactions?: readonly MessageReactionSummary[];
  /** WP 2.4: true when the message is pinned in its channel. */
  readonly pinned?: boolean;
  /** WP 2.10: the poll on this message (non-clinical; counts + the viewer's own vote); absent when it has none. */
  readonly poll?: PollView;
  /** WP 1.5: scan-gated attachment metadata (quarantined and, for non-uploaders, pending ones are omitted). */
  readonly attachments?: readonly MessageAttachmentView[];
  /** Bound files this viewer cannot see (scanning for others, or withheld): a bare count, never ids, names or state. */
  readonly hiddenAttachmentCount?: number;
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
      /** WP 1.2: client-minted, stable across retries; a repeat returns the original message. */
      clientMessageId?: string;
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
