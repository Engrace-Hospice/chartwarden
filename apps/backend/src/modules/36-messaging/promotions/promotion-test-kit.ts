// WP 3.7 test support: a fully in-memory promotion service (memory store, fake db, captured outbox, controllable ports) and
// source reader. Not a test file itself; the *.test.ts files in this directory build on it.
import type { DbClient } from "@wardenx/db";
import { messageBodySha256 } from "@wardenx/messaging";
import { WardenXError } from "@wardenx/types";
import { type PromotionService, createPromotionService } from "./promotion-service";
import type { PromotionBodyPorts, StoredBody } from "./promotion-snapshot";
import { createPromotionSourceReader } from "./promotion-source-reader";
import { createMemoryPromotionStore } from "./promotion-store-memory";

export const ORG = "00000000-0000-4000-8000-0000000000a1";
export const ALICE = "00000000-0000-4000-8000-00000000aaa1";
export const BOB = "00000000-0000-4000-8000-00000000bbb1";
export const CAROL = "00000000-0000-4000-8000-00000000ccc1";
export const P1 = "00000000-0000-4000-8000-0000000000e1";
export const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
export const MESSAGE = "00000000-0000-4000-8000-0000000000d1";
export const MEETING = "00000000-0000-4000-8000-0000000000f1";
export const BODY_TEXT = "Patient reports new pain in left hip";
export const NOW = new Date("2026-10-14T12:00:00.000Z");

export const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

export const actor = (userId: string) => ({ orgId: ORG, userId });
export const sha = (text: string): string => messageBodySha256(text);

export interface KitOptions {
  channelKind?: string;
  subjectId?: string | null;
  live?: boolean;
  authorUserId?: string | null;
  body?: string;
  /** `userId:patientId` pairs the Part 2 gate refuses. */
  part2Denied?: string[];
  part2Throws?: boolean;
  missingPermission?: string[];
  viewableChannels?: string[];
  meetings?: string[];
  flagOn?: boolean;
}

export function buildKit(opts: KitOptions = {}) {
  // `opts` and `state` are read lazily so a test may change the world after the first request.
  const state = {
    body: opts.body ?? BODY_TEXT,
    live: opts.live ?? true,
    revisions: [] as string[],
    erased: false,
  };
  const store = createMemoryPromotionStore();
  const published: Array<{
    eventName: string;
    payload: Record<string, unknown>;
    aggregateId: string;
  }> = [];
  const warnings: Array<{ message: string; context: Record<string, string> }> = [];
  const viewable = new Set(opts.viewableChannels ?? [CHANNEL]);
  const part2Gate = {
    allowedUserIds: async ({
      patientId,
      userIds,
    }: { patientId: string; userIds: readonly string[] }) => {
      if (opts.part2Throws) throw new Error("privacy flag unreadable");
      return new Set(
        userIds.filter((u) => !(opts.part2Denied ?? []).includes(`${u}:${patientId}`)),
      );
    },
  };
  const service: PromotionService = createPromotionService({
    db: fakeDb,
    outbox: {
      publish: async (_tx, e) =>
        void published.push({
          eventName: e.eventName,
          payload: e.payload,
          aggregateId: e.aggregateId,
        }),
    },
    store,
    messaging: { canViewChannel: async (_o, _u, channelId) => viewable.has(channelId) },
    messageLookup: async () => ({
      live: state.live,
      channelKind: opts.channelKind ?? "care_team",
      subjectId: opts.subjectId === undefined ? P1 : opts.subjectId,
      authorUserId: opts.authorUserId === undefined ? BOB : opts.authorUserId,
      bodySha256: sha(state.body),
      createdAt: new Date("2026-10-14T11:00:00.000Z"),
    }),
    part2Gate,
    permissionsFor: async (_o, userId) =>
      new Set(
        ["messaging.read", "messaging.send", "messaging.promote", "patient.read"].filter(
          (p) => !(opts.missingPermission ?? []).includes(`${userId}:${p}`),
        ),
      ),
    meetingExists: async (_o, id) => (opts.meetings ?? [MEETING]).includes(id),
    displayName: async (_o, u) => (u === ALICE ? "Alice" : u === BOB ? "Bob" : null),
    now: () => NOW,
    warn: (message, context) => void warnings.push({ message, context }),
  });
  const stored = (text: string): StoredBody => ({
    bodyCipher: Buffer.from(text, "utf8"),
    bodyKind: "plain",
    bodySha256: sha(text),
  });
  const bodies: PromotionBodyPorts = {
    current: async () =>
      !state.live || state.erased ? null : state.erased ? null : stored(state.body),
    revisionBySha: async (_o, _m, wanted) => {
      const hit = [...state.revisions].reverse().find((t) => sha(t) === wanted);
      return hit === undefined ? null : stored(hit);
    },
    open: async (_o, cipher) => cipher.toString("utf8"),
  };
  const reader = createPromotionSourceReader({
    store,
    isEnabled: async () => opts.flagOn ?? true,
    part2Gate,
    bodies,
  });
  return {
    service,
    store,
    reader,
    bodies,
    published,
    warnings,
    viewable,
    /** The sender edits the message: the old text becomes a revision. */
    editMessage(text: string) {
      state.revisions.push(state.body);
      state.body = text;
    },
    eraseMessage() {
      state.erased = true;
    },
  };
}

export type Kit = ReturnType<typeof buildKit>;

export const standardRequest = {
  channelId: CHANNEL,
  messageId: MESSAGE,
  targetModule: "m8",
  targetKind: "encounter_addendum",
} as const;

/** The `status:code` of a rejected promise, or "no-error". */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WardenXError) return `${e.statusCode}:${e.code}`;
    throw e;
  }
  return "no-error";
}
