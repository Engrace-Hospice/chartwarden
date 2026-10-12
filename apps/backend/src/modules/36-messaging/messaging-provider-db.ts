// apps/backend/src/modules/36-messaging — PRODUCTION `MessagingProvider` seam (§4.6) over Drizzle
// (FB-T05). The cross-module channel/message surface other modules consume without a direct schema
// edge: the implementation is injected into the M1 seam registry and validated by validateSeams(),
// replacing the Phase-0 deny-stub so the seam is REAL (not failing-closed) when a DB is present.
//
// Shares the FB-T05 write core with the route-service adapter: bodies are envelope-encrypted under the
// per-tenant DEK at write time (§3.4) and decrypted for entitled readers; sends fan out `delivered`
// receipts. Every op runs inside `withOrgContext` so RLS on `app.org_id` (+ the M4 write-audit trigger)
// is the backstop.
//
// SCOPE (FB-T05): the channel/message CRUD (`openChannel`/`sendMessage`/`markRead`/`listMessages`) is
// live. GAP-059 (2026-08-13) makes `syncCareTeamChannel` real too, over the new M5 `CareTeamProvider`
// seam (M36 spec D5) — it reconciles a `care_team` channel's `source:'auto'` membership against the
// real `patient_assignment` roster, leaving any `source:'manual'` rows untouched per D5's admin-override
// invariant. `syncOnCallChannel`/`syncBereavementChannel`/`archiveCareTeamChannel` stay forward-seam
// deferrals — driven by M16/M17/M19 outbox events not wired in Phase 1 — since they have no equivalent
// read seam yet (a clear NOT_IMPLEMENTED throw beats reconciling against source data with no producer).
// GAP-104 (2026-10-05): `archiveCareTeamChannel` is real (see `outbox-consumers/channel-membership-sync.ts`).
import { type DbClient, schema } from "@wardenx/db";
import type {
  ChannelKind,
  MessageBodyKind,
  MessagingProvider,
  ResolvedMessage,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { publishMessageHint } from "./message-hint-events";
import {
  type MessagingOutboxPort,
  createDbMessagingRouteService,
} from "./messaging-route-service-db";
import {
  type MessageBodyCipher,
  channelOr404,
  createMessageBodyCipher,
  insertEncryptedMessage,
} from "./messaging-write-core";
import { type Part2ChannelGate, createSeamPart2ChannelGate } from "./part2-channel-gate";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;

/** The seam envelope's actor id — a roster-reconcile write has no acting membership (M4 NULLIFs it). */
const SYNC_SYSTEM_USER_ID = "";

/** The channel-kind shape the §3.3 `channel_kind_subject_shape` CHECK enforces (subject + retention). */
function channelShape(kind: ChannelKind): {
  retentionClass: "operational" | "care_related" | "bereavement";
  subjectRequired: boolean;
} {
  switch (kind) {
    case "dm":
      return { retentionClass: "care_related", subjectRequired: false };
    case "announcement":
      return { retentionClass: "operational", subjectRequired: false };
    case "bereavement":
      return { retentionClass: "bereavement", subjectRequired: true };
    default: // care_team / discipline / location / on_call
      return { retentionClass: "care_related", subjectRequired: true };
  }
}

/** Build the production {@link MessagingProvider}. `opts.kek`/`opts.cipher` are injectable for tests. */
export function createDbMessagingProvider(
  db: DbClient,
  opts: {
    kek?: Buffer;
    cipher?: MessageBodyCipher;
    part2Gate?: Part2ChannelGate;
    /** Realtime hint source (ADR-0054 A4); absent in unit wiring, bound in the composition root. */
    outbox?: MessagingOutboxPort;
    warn?: (message: string, context: Record<string, string>) => void;
  } = {},
): MessagingProvider {
  const cipher = opts.cipher ?? createMessageBodyCipher({ kek: opts.kek });
  // GAP-065 — M39 consent gate on care_team membership (spec §7.13); seam-backed unless injected.
  const part2Gate = opts.part2Gate ?? createSeamPart2ChannelGate(db);
  // markRead/listMessages take a userId, so they must apply the same live-access rule as the routes
  // (active user, live membership, Part 2 gate) rather than trusting the caller — one rule, one place.
  const access = createDbMessagingRouteService(db, {
    cipher,
    part2Gate,
    warn: opts.warn,
    outbox: opts.outbox,
  });

  function notWired(hook: string): never {
    throw new WardenXError(
      "NOT_IMPLEMENTED",
      `${hook} is driven by a source-module outbox event (M5/M16/M17/M19) not wired in Phase 1`,
      501,
    );
  }

  return {
    async openChannel(orgId, spec) {
      if (spec.kind === "dm") {
        throw new WardenXError(
          "DM_REQUIRES_PARTICIPANT",
          "direct messages must be opened through the membership-validating DM workflow",
          422,
        );
      }
      const shape = channelShape(spec.kind);
      if (spec.kind === "bereavement") {
        // bereavement needs a pre-computed archives_at (M16 plan), so it is opened via the M16 sync hook.
        notWired("opening a bereavement channel");
      }
      return withOrgContext(
        db,
        { organizationId: orgId, userId: spec.creatorUserId },
        async (tx) => {
          if (shape.subjectRequired && spec.subjectId) {
            const existing = (await tx
              .select({ id: CH.id })
              .from(CH)
              .where(
                and(
                  eq(CH.organizationId, orgId),
                  eq(CH.channelKind, spec.kind),
                  eq(CH.subjectId, spec.subjectId),
                ),
              )
              .limit(1)) as Array<{ id: string }>;
            if (existing[0]) return { channelId: existing[0].id, created: false };
          }
          if (spec.kind === "announcement") {
            const existing = (await tx
              .select({ id: CH.id })
              .from(CH)
              .where(and(eq(CH.organizationId, orgId), eq(CH.channelKind, "announcement")))
              .limit(1)) as Array<{ id: string }>;
            if (existing[0]) return { channelId: existing[0].id, created: false };
          }
          const inserted = (await tx
            .insert(CH)
            .values({
              organizationId: orgId,
              channelKind: spec.kind,
              subjectId: shape.subjectRequired ? (spec.subjectId ?? null) : null,
              title: spec.title ?? defaultTitle(spec.kind),
              retentionClass: shape.retentionClass,
            })
            .returning({ id: CH.id })) as Array<{ id: string }>;
          const channelId = inserted[0]!.id;
          await tx.insert(CM).values({
            organizationId: orgId,
            channelId,
            userId: spec.creatorUserId,
            role: "owner",
            source: "manual",
          });
          return { channelId, created: true };
        },
      );
    },

    async sendMessage(orgId, input) {
      return withOrgContext(
        db,
        { organizationId: orgId, userId: input.authorUserId },
        async (tx) => {
          const ch = await channelOr404(tx, orgId, input.channelId);
          if (ch.isArchived) throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
          const sent = await insertEncryptedMessage(tx, cipher, {
            orgId,
            channelId: input.channelId,
            authorUserId: input.authorUserId,
            body: input.body,
            bodyKind: input.bodyKind,
            parentMessageId: input.parentMessageId,
            quotedMessageId: input.quotedMessageId,
          });
          await publishMessageHint(opts.outbox, tx, "sent", {
            orgId,
            channelId: input.channelId,
            messageId: sent.messageId,
            at: sent.createdAt,
          });
          return sent;
        },
      );
    },

    async markRead(orgId, input) {
      return access.markRead(orgId, input);
    },

    async listMessages(orgId, input) {
      if (!(await access.canViewChannel(orgId, input.userId, input.channelId))) {
        throw new NotFoundError("channel", input.channelId);
      }
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        await channelOr404(tx, orgId, input.channelId);
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        const rows = (await tx
          .select({
            id: MSG.id,
            channelId: MSG.channelId,
            authorUserId: MSG.authorUserId,
            bodyCipher: MSG.bodyCipher,
            bodyKind: MSG.bodyKind,
            status: MSG.status,
            createdAt: MSG.createdAt,
            parentMessageId: MSG.parentMessageId,
          })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.channelId, input.channelId)))
          .orderBy(asc(MSG.createdAt), asc(MSG.id))
          .limit(limit)) as Array<{
          id: string;
          channelId: string;
          authorUserId: string | null;
          bodyCipher: Buffer;
          bodyKind: string;
          status: string;
          createdAt: Date;
          parentMessageId: string | null;
        }>;
        const messages = rows.map(
          (m): ResolvedMessage => ({
            messageId: m.id,
            channelId: m.channelId,
            authorUserId: m.authorUserId,
            authorDisplayName: null,
            body: m.status === "deleted" ? "" : cipher.open(orgId, m.bodyCipher),
            bodyKind: m.bodyKind as MessageBodyKind,
            createdAt: m.createdAt.toISOString(),
            parentMessageId: m.parentMessageId,
            references: [],
          }),
        );
        return { messages };
      });
    },

    // GAP-059 / M36 spec D5 — reconcile the patient's `care_team` channel membership against the
    // real roster (M5 CareTeamProvider). Auto-sourced rows only: a `source:'manual'` add (admin
    // override) is left alone, never re-added and never removed by the reconciler.
    async syncCareTeamChannel(orgId, patientId) {
      // The M5 roster read runs BEFORE the write transaction opens, and must stay there.
      //
      // `CareTeamProvider`'s production store is `createDrizzleCareTeamStore(db)`, whose `listMembers`
      // opens its OWN `withOrgContext` — i.e. its own `db.transaction()` — on this same pooled handle.
      // Calling it from inside the transaction below therefore held TWO pool connections for the
      // duration of one sync: the outer transaction's, plus the one the seam needs to make progress.
      // The pool is `max: 10` with no `connectionTimeoutMillis`, and M31's portal routes call this per
      // request, so ten concurrent portal reads for a patient each held a transaction open while
      // waiting for connection #11 — a pool-wide deadlock that never times out and takes every other
      // request in the process down with it, until restart.
      //
      // Hoisting costs NOTHING in consistency, which is the part worth being explicit about: because
      // the seam acquires a SEPARATE connection, its read was never inside this transaction's snapshot
      // to begin with. Nesting bought an illusion of atomicity, not the fact of it. And the M11
      // "read within tx" rule does not apply here — `patient_assignment` is not written by this
      // transaction, so there is no same-tx write this read could miss.
      const careTeam = await getSeam("CareTeamProvider").careTeamMembers({
        organizationId: orgId,
        patientId,
      });
      // GAP-065 / spec §7.13 — for a SUD-flagged patient only members M39's Part 2 release covers stay on
      // the roster; the rest are excluded from this re-sync (and an existing auto member who no longer
      // qualifies is removed below). A throw (privacy flag unreadable) aborts the sync: membership is
      // left exactly as it was and the relay retries, rather than admitting on a guess.
      const roster = new Set(
        await part2Gate.allowedUserIds({
          organizationId: orgId,
          patientId,
          userIds: [...new Set(careTeam)],
        }),
      );
      return withOrgContext(
        db,
        { organizationId: orgId, userId: SYNC_SYSTEM_USER_ID },
        async (tx) => {
          const shape = channelShape("care_team");
          const existing = (await tx
            .select({ id: CH.id, isArchived: CH.isArchived })
            .from(CH)
            .where(
              and(
                eq(CH.organizationId, orgId),
                eq(CH.channelKind, "care_team"),
                eq(CH.subjectId, patientId),
              ),
            )
            .limit(1)) as Array<{ id: string; isArchived: boolean }>;
          let channel = existing[0];
          if (!channel) {
            const inserted = (await tx
              .insert(CH)
              .values({
                organizationId: orgId,
                channelKind: "care_team",
                subjectId: patientId,
                title: defaultTitle("care_team"),
                retentionClass: shape.retentionClass,
              })
              // `channel_unique_subject` is the database arbiter. A concurrent request may win
              // between the SELECT and INSERT; the loser retrieves that row instead of surfacing
              // a uniqueness error or creating a second channel.
              .onConflictDoNothing()
              .returning({ id: CH.id, isArchived: CH.isArchived })) as Array<{
              id: string;
              isArchived: boolean;
            }>;
            channel = inserted[0];
            if (!channel) {
              const raced = (await tx
                .select({ id: CH.id, isArchived: CH.isArchived })
                .from(CH)
                .where(
                  and(
                    eq(CH.organizationId, orgId),
                    eq(CH.channelKind, "care_team"),
                    eq(CH.subjectId, patientId),
                  ),
                )
                .limit(1)) as Array<{ id: string; isArchived: boolean }>;
              channel = raced[0];
            }
          }
          if (!channel) {
            throw new WardenXError(
              "CARE_TEAM_CHANNEL_CREATE_FAILED",
              "could not open care team conversation",
              503,
            );
          }
          const channelId = channel.id;
          const channelArchived = channel.isArchived;

          const activeMembers = (await tx
            .select({ id: CM.id, userId: CM.userId, source: CM.source })
            .from(CM)
            .where(
              and(eq(CM.organizationId, orgId), eq(CM.channelId, channelId), isNull(CM.removedAt)),
            )) as Array<{ id: string; userId: string; source: "auto" | "manual" }>;
          const activeUserIds = new Set(activeMembers.map((m) => m.userId));

          // GAP-104 — an archived (discharged/deceased) channel takes no NEW members; removals still apply
          // (a clinician unassigned after discharge must lose access) and history stays readable.
          const toAdd = channelArchived
            ? []
            : [...roster].filter((userId) => !activeUserIds.has(userId));
          const toRemove = activeMembers.filter(
            (m) => m.source === "auto" && !roster.has(m.userId),
          );

          if (toAdd.length > 0) {
            await tx.insert(CM).values(
              toAdd.map((userId) => ({
                organizationId: orgId,
                channelId,
                userId,
                role: "member" as const,
                source: "auto" as const,
              })),
            );
          }
          for (const m of toRemove) {
            await tx.update(CM).set({ removedAt: new Date() }).where(eq(CM.id, m.id));
          }

          return { channelId, membershipChanged: toAdd.length > 0 || toRemove.length > 0 };
        },
      );
    },
    async syncOnCallChannel() {
      notWired("syncOnCallChannel");
    },
    async syncBereavementChannel() {
      notWired("syncBereavementChannel");
    },
    // GAP-104 — spec §2.3/§4.7: a discharged/deceased patient's care_team channel is archived (no new
    // messages — `sendMessage` 410s on `is_archived`), never deleted: the 6+ yr `care_related` history is
    // retained and existing members keep read access. Idempotent; no channel = nothing to archive.
    async archiveCareTeamChannel(orgId, patientId) {
      await setCareTeamChannelArchived(db, orgId, patientId, true);
    },
  };
}

/**
 * Flip a patient's `care_team` channel archived / active. Returns whether a row changed (false = no
 * channel, or already in that state — re-delivery is a no-op). Un-archiving is the spec's "care_team on
 * un-discharge" transition (§2.3 state machine); it clears `archives_at` so the channel reads as live.
 */
export async function setCareTeamChannelArchived(
  db: DbClient,
  orgId: string,
  patientId: string,
  archived: boolean,
): Promise<boolean> {
  return withOrgContext(db, { organizationId: orgId, userId: SYNC_SYSTEM_USER_ID }, async (tx) => {
    const changed = (await tx
      .update(CH)
      .set({ isArchived: archived, archivesAt: archived ? new Date() : null })
      .where(
        and(
          eq(CH.organizationId, orgId),
          eq(CH.channelKind, "care_team"),
          eq(CH.subjectId, patientId),
          eq(CH.isArchived, !archived),
        ),
      )
      .returning({ id: CH.id })) as Array<{ id: string }>;
    return changed.length > 0;
  });
}

/** A human title for a freshly opened channel when the caller supplied none (title is NOT NULL). */
function defaultTitle(kind: ChannelKind): string {
  switch (kind) {
    case "announcement":
      return "Announcements";
    case "dm":
      return "Direct message";
    case "care_team":
      return "Care team";
    default:
      return kind.replace(/_/g, " ");
  }
}

/**
 * Soft-remove every active `channel_member` row a user holds in an org (revoked membership or org offboarding,
 * audit F3). `removed_at` — not a delete — so the M4 trigger on `channel_member` records who lost access and
 * when. Returns how many rows ended; a redelivery ends zero (idempotent).
 */
export async function endChannelMembershipsForUser(
  db: DbClient,
  orgId: string,
  userId: string,
): Promise<number> {
  return withOrgContext(db, { organizationId: orgId, userId: SYNC_SYSTEM_USER_ID }, async (tx) => {
    const ended = (await tx
      .update(CM)
      .set({ removedAt: new Date() })
      .where(and(eq(CM.organizationId, orgId), eq(CM.userId, userId), isNull(CM.removedAt)))
      .returning({ id: CM.id })) as Array<{ id: string }>;
    return ended.length;
  });
}

/**
 * Who a realtime hint for this channel should reach: the active members, or the whole org for the announcement
 * channel. Read under RLS as the system principal; returns ids only (the hint is PHI-free anyway).
 */
export async function channelHintAudience(
  db: DbClient,
  orgId: string,
  channelId: string,
): Promise<{ orgWide: true } | { userIds: string[] }> {
  return withOrgContext(db, { organizationId: orgId, userId: SYNC_SYSTEM_USER_ID }, async (tx) => {
    const [channel] = await tx
      .select({ kind: CH.channelKind })
      .from(CH)
      .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
      .limit(1);
    if (!channel) return { userIds: [] };
    if (channel.kind === "announcement") return { orgWide: true as const };
    const members = await tx
      .select({ userId: CM.userId })
      .from(CM)
      .where(and(eq(CM.organizationId, orgId), eq(CM.channelId, channelId), isNull(CM.removedAt)));
    return { userIds: members.map((m) => m.userId) };
  });
}
