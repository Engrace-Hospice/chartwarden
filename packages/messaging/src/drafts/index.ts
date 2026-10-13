// @wardenx/messaging — WP 2.5 server-side message drafts.
//
// One PRIVATE draft per (user, channel, thread root): `parentMessageId` null is the channel composer, a message id is
// that thread's reply composer. The interface is shared by the in-memory slice impl (below) and the Drizzle impl in the
// backend (which encrypts the body under the tenant DEK); both use `decideDraftSave` so they cannot disagree on conflicts.
//
// Conflict model: every save carries the revision the client last saw (`baseRevision`) and a client-minted `deviceId`.
// A save is accepted when the revision is current, or when the draft was last written by the SAME device (last writer
// wins per device: a retried or reordered autosave from one tab must not fight itself). A save from a DIFFERENT device
// that has not seen the latest revision is a 409 DRAFT_CONFLICT; the client then reads the server draft and offers the
// user a merge prompt, and re-saves with the server's revision as its base.
import { ValidationError, WardenXError } from "@wardenx/types";
import type { MessageReferenceInput } from "../interfaces/provider";

/** Same ceiling as a sent message body. */
export const MAX_DRAFT_BODY_LENGTH = 8000;
export const MAX_DRAFT_REFERENCES = 25;

export interface DraftView {
  readonly channelId: string;
  readonly parentMessageId: string | null;
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
  readonly revision: number;
  readonly deviceId: string;
  readonly updatedAt: string;
}

export interface DraftKey {
  readonly userId: string;
  readonly channelId: string;
  readonly parentMessageId?: string | null | undefined;
}

export interface SaveDraftInput extends DraftKey {
  readonly body: string;
  readonly references?: readonly MessageReferenceInput[] | undefined;
  readonly deviceId: string;
  /** The revision the client last saw; 0 when it has none. */
  readonly baseRevision: number;
}

export interface MessageDraftService {
  /** The caller's own draft, or null. Never anyone else's. */
  getDraft(orgId: string, key: DraftKey): Promise<DraftView | null>;
  /** Create/replace the caller's draft; an empty body discards it (returns null). 409 DRAFT_CONFLICT across devices. */
  saveDraft(orgId: string, input: SaveDraftInput): Promise<DraftView | null>;
  /** Idempotent. */
  deleteDraft(orgId: string, key: DraftKey): Promise<void>;
}

export type DraftSaveDecision = "write" | "conflict";

export function decideDraftSave(
  current: { readonly revision: number; readonly deviceId: string } | null,
  input: { readonly baseRevision: number; readonly deviceId: string },
): DraftSaveDecision {
  if (!current) return "write";
  if (input.baseRevision === current.revision) return "write";
  return current.deviceId === input.deviceId ? "write" : "conflict";
}

export function draftConflictError(): WardenXError {
  return new WardenXError(
    "DRAFT_CONFLICT",
    "this draft was changed on another device; read it and choose how to merge",
    409,
  );
}

/** True when a save carries nothing worth keeping (the client's way to discard). */
export function isEmptyDraft(input: Pick<SaveDraftInput, "body">): boolean {
  return input.body.trim() === "";
}

/** Throws a 422 for a draft the store must not hold. */
export function assertDraftWithinLimits(input: Pick<SaveDraftInput, "body" | "references">): void {
  if (input.body.length > MAX_DRAFT_BODY_LENGTH) {
    throw new ValidationError("draft is too long", [
      { field: "body", code: "TOO_LONG", message: `at most ${MAX_DRAFT_BODY_LENGTH} characters` },
    ]);
  }
  if ((input.references?.length ?? 0) > MAX_DRAFT_REFERENCES) {
    throw new ValidationError("too many references", [
      { field: "references", code: "TOO_MANY", message: `at most ${MAX_DRAFT_REFERENCES}` },
    ]);
  }
}

export function createInMemoryDraftService(): MessageDraftService {
  const rows = new Map<string, DraftView>();
  const keyOf = (orgId: string, k: DraftKey): string =>
    JSON.stringify([orgId, k.userId, k.channelId, k.parentMessageId ?? null]);

  return {
    async getDraft(orgId, key) {
      return rows.get(keyOf(orgId, key)) ?? null;
    },
    async saveDraft(orgId, input) {
      assertDraftWithinLimits(input);
      const k = keyOf(orgId, input);
      if (isEmptyDraft(input)) {
        rows.delete(k);
        return null;
      }
      const current = rows.get(k) ?? null;
      if (decideDraftSave(current, input) === "conflict") throw draftConflictError();
      const next: DraftView = {
        channelId: input.channelId,
        parentMessageId: input.parentMessageId ?? null,
        body: input.body,
        references: input.references ?? [],
        revision: (current?.revision ?? 0) + 1,
        deviceId: input.deviceId,
        updatedAt: new Date().toISOString(),
      };
      rows.set(k, next);
      return next;
    },
    async deleteDraft(orgId, key) {
      rows.delete(keyOf(orgId, key));
    },
  };
}
