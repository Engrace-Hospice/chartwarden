// apps/backend/src/modules/36-messaging/ai/binding.ts - WP 6.5 (ADR-0095): the composition-root binding. READ-ONLY adapters over what already exists:
// the platform flag reader (`messaging.ai.enabled`, absent = off), the thread read the caller could do anyway (membership gate included), M5's
// privacy flags and patient names, the roles table (for role tokens only), a fixed-window counter, and one audit row. The AI port itself is
// injected by the boot: absent means UNAVAILABLE_AI_PORT, so a deployment without a governed M32 backend answers "AI unavailable" on every call.
import { type AuditExecutor, audit } from "@chartwarden/audit";
import { resolveActorPermissions } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import type { MessagingRouteService } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  MESSAGING_AI_FLAG_KEY,
  MESSAGING_AI_LIMITS,
  MESSAGING_AI_USE_PERMISSION,
  type MessagingAiPort,
} from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { RateLimitStore } from "../../../bootstrap/plugins/rate-limit-store";
import { SUD_PRIVACY_FLAG, readSeamPatientPrivacyFlags } from "../part2-channel-gate";
import { cacheFlagRead } from "../presence/binding";
import { type AiAuditEntry, type AiService, createAiService } from "./ai-service";
import { type RoleToken, roleTokenFor } from "./pseudonymise";
import { UNAVAILABLE_AI_PORT } from "./unavailable-ai-port";

const CH = schema.channels;
const M = schema.memberships;
const MR = schema.membershipRoles;
const R = schema.roles;

const THREAD_PAGE = 200;
/** Bounds the read (2,000 replies); the 14-day / 50-message window makes anything beyond it unlikely. */
const THREAD_MAX_PAGES = 10;

/**
 * A redaction that is REQUESTED but not yet approved does not mask the body for readers, but it means someone said the message holds too much
 * (often the wrong patient). It must not go to a vendor either: such a message is marked redacted here so the input builder withholds it.
 */
async function withheldIfRedactionRequested<T extends { messageId: string; redactedAt?: string }>(
  db: DbClient,
  orgId: string,
  messages: readonly T[],
): Promise<readonly T[]> {
  if (messages.length === 0) return messages;
  const rows = await withOrgContext(db, systemOrgContext(orgId), (tx) =>
    tx
      .select({ id: schema.messageRedactions.messageId })
      .from(schema.messageRedactions)
      .where(
        and(
          eq(schema.messageRedactions.organizationId, orgId),
          inArray(
            schema.messageRedactions.messageId,
            messages.map((m) => m.messageId),
          ),
        ),
      ),
  );
  const requested = new Set(rows.map((r) => r.id));
  if (requested.size === 0) return messages;
  return messages.map((m) =>
    requested.has(m.messageId) && m.redactedAt === undefined
      ? { ...m, redactedAt: "requested" }
      : m,
  );
}

export interface AiBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  /** The thread read and its membership gate; the AI binding never uses a send, edit or task method. */
  readonly messaging: Pick<MessagingRouteService, "canViewChannel" | "listMessages" | "listThread">;
  readonly rateLimitStore: RateLimitStore;
  /** M32's governed pipeline behind the port; absent = fail closed. */
  readonly port?: MessagingAiPort | undefined;
  readonly warn?: ((message: string, context: Record<string, string>) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface AiBinding {
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: AiService;
}

export function buildAiDeps(input: AiBindingInput): AiBinding {
  const { db, messaging } = input;
  const isEnabled = cacheFlagRead(async (organizationId) =>
    input.flags
      ? (await input.flags.forOrg(organizationId))[MESSAGING_AI_FLAG_KEY] === true
      : false,
  );
  const service = createAiService({
    port: input.port ?? UNAVAILABLE_AI_PORT,
    isEnabled,
    canUseAi: async (organizationId, userId) =>
      (await resolveActorPermissions({ organizationId, userId })).has(MESSAGING_AI_USE_PERMISSION),
    canViewChannel: (orgId, userId, channelId) =>
      messaging.canViewChannel(orgId, userId, channelId),
    channelFacts: (orgId, channelId) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const [row] = await tx
          .select({ kind: CH.channelKind, subjectId: CH.subjectId, archived: CH.isArchived })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
          .limit(1);
        if (!row) return null;
        return {
          patientId: row.kind === "care_team" ? row.subjectId : null,
          archived: row.archived,
        };
      }),
    isPart2Restricted: async (orgId, patientId) =>
      (await readSeamPatientPrivacyFlags(orgId, patientId)).includes(SUD_PRIVACY_FLAG),
    readWindow: async (orgId, userId, channelId, rootMessageId) =>
      withheldIfRedactionRequested(
        db,
        orgId,
        await (async () => {
          // The caller's OWN thread read; `showLegalHold` lets the input builder EXCLUDE held messages and is never returned to the browser.
          if (rootMessageId) {
            // listThread answers OLDEST first, so page to the end: the window keeps the NEWEST replies (a long thread's current state).
            const first = await messaging.listThread(orgId, {
              channelId,
              messageId: rootMessageId,
              userId,
              limit: THREAD_PAGE,
              showLegalHold: true,
            });
            const replies = [...first.replies];
            let cursor = first.nextCursor;
            for (let pages = 1; cursor && pages < THREAD_MAX_PAGES; pages += 1) {
              const next = await messaging.listThread(orgId, {
                channelId,
                messageId: rootMessageId,
                userId,
                cursor,
                limit: THREAD_PAGE,
                showLegalHold: true,
              });
              replies.push(...next.replies);
              cursor = next.nextCursor;
            }
            return [first.root, ...replies];
          }
          const page = await messaging.listMessages(orgId, {
            channelId,
            userId,
            limit: MESSAGING_AI_LIMITS.windowMaxMessages,
            direction: "backward",
            showLegalHold: true,
          });
          return page.messages;
        })(),
      ),
    patientNames: async (orgId, patientId) => {
      const patient = await getSeam("PatientReader").findById({
        organizationId: orgId,
        id: patientId,
      });
      if (!patient || patient.organizationId !== orgId) throw new Error("patient not found");
      return [
        patient.firstName,
        patient.lastName,
        `${patient.firstName} ${patient.lastName}`,
        patient.mrn,
        ...(patient.externalMrns ?? []).map((e) => e.value),
        ...(patient.ssnLast4 ? [patient.ssnLast4] : []),
      ].filter((n) => n.trim().length > 0);
    },
    roleTokens: async (orgId, userIds): Promise<ReadonlyMap<string, RoleToken>> => {
      if (userIds.length === 0) return new Map();
      const rows = await withOrgContext(db, systemOrgContext(orgId), (tx) =>
        tx
          .select({ userId: M.userId, key: R.key, category: R.category })
          .from(M)
          .innerJoin(MR, eq(MR.membershipId, M.id))
          .innerJoin(R, eq(R.id, MR.roleId))
          .where(and(eq(M.organizationId, orgId), inArray(M.userId, [...userIds]))),
      );
      const byUser = new Map<string, { keys: string[]; categories: string[] }>();
      for (const row of rows) {
        const entry = byUser.get(row.userId) ?? { keys: [], categories: [] };
        entry.keys.push(row.key);
        entry.categories.push(String(row.category));
        byUser.set(row.userId, entry);
      }
      return new Map(
        [...byUser].map(([userId, e]) => [userId, roleTokenFor(e.keys, e.categories)] as const),
      );
    },
    withinQuota: async (key, windowMs, limit) =>
      (await input.rateLimitStore.increment(key, windowMs)) <= limit,
    audit: (entry: AiAuditEntry) =>
      withOrgContext(db, { organizationId: entry.orgId, userId: entry.userId }, (tx) =>
        audit(
          tx as unknown as AuditExecutor,
          {
            organizationId: entry.orgId,
            userId: entry.userId,
            actorKind: "user",
            correlationId: crypto.randomUUID(),
          },
          {
            eventType: "m36.ai.summary_viewed",
            resourceKind: "messaging_channel",
            resourceId: entry.channelId,
            outcome: "success",
            severity: "info",
            retentionClass: "compliance",
            context: {
              kind: entry.kind,
              invocationId: entry.invocationId,
              included: entry.includedCount,
              withheld: entry.withheldCount,
            },
          },
        ),
      ),
    ...(input.warn ? { warn: input.warn } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return { isEnabled, service };
}
