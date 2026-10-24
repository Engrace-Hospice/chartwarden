import type { ResolvedMessage } from "@chartwarden/messaging";
// apps/backend/src/modules/36-messaging/ai/ai-service.ts - WP 6.5 (ADR-0095): AI thread summaries and reply drafts through M32.
//
// THE SHAPE OF THE GUARANTEE. This service READS (the caller's own hydrated thread read), MINIMISES (pseudonymise + thread-input), asks a
// `MessagingAiPort` for TEXT, and VALIDATES that text. Nothing it is handed can send a message, create a task, place an order or write a chart
// record: there is no such dependency in `AiServiceDeps`, and `arch:ai-messaging-readonly` fails the build if this folder ever imports one.
// A draft is returned to the browser only; it is not written to the message store, the drafts store or any queue.
//
// ORDER (each step fails closed): flag -> current membership (canViewChannel) -> Part 2 refusal -> read window -> minimum-necessary input ->
// quotas -> ONE re-check of membership and permission immediately before dispatch -> port -> parse/validate (retry once) -> denylist ->
// membership once more before anything is returned -> audit -> answer.
import {
  ChartWardenError,
  MESSAGING_AI_DRAFT_LABEL,
  MESSAGING_AI_DRAFT_SCHEMA,
  MESSAGING_AI_LIMITS,
  MESSAGING_AI_SUMMARY_LABEL,
  MESSAGING_AI_SUMMARY_SCHEMA,
  type MessagingAiCompletion,
  type MessagingAiDraftDto,
  type MessagingAiOutcome,
  type MessagingAiPort,
  type MessagingAiRequest,
  type MessagingAiSummaryDto,
  NotFoundError,
  RateLimitedError,
} from "@chartwarden/types";
import { parseDrafts, parseSummary } from "./ai-output";
import type { RoleToken } from "./pseudonymise";
import { buildThreadInput } from "./thread-input";

export const AI_NOT_ENABLED = "AI_NOT_ENABLED";
export const AI_UNAVAILABLE = "AI_UNAVAILABLE";
export const AI_OUTPUT_REFUSED = "AI_OUTPUT_REFUSED";
export const AI_NOT_AVAILABLE_FOR_CHANNEL = "AI_NOT_AVAILABLE_FOR_CHANNEL";

export interface AiActor {
  readonly orgId: string;
  readonly userId: string;
}

export type AiKind = "summary" | "draft";

export interface AiChannelFacts {
  /** The patient of a care_team channel; null for any other channel kind. */
  readonly patientId: string | null;
  readonly archived: boolean;
}

/** Everything the service may touch. Every member is READ-ONLY or a pure check; none can write a message, task, order or chart record. */
export interface AiServiceDeps {
  readonly port: MessagingAiPort;
  /** Tenant flag `messaging.ai.enabled`. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The permission `messaging.ai.use`, evaluated now (route guard answers first; this is the pre-dispatch re-check). */
  readonly canUseAi: (orgId: string, userId: string) => Promise<boolean>;
  /** The thread read's own gate (membership, Part 2 consent, roster). NOT the break-glass read variant: a grant never opens AI. */
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly channelFacts: (orgId: string, channelId: string) => Promise<AiChannelFacts | null>;
  /** True when the channel's patient carries the Part 2 `sud` flag. A throw is treated as true (fail closed). */
  readonly isPart2Restricted: (orgId: string, patientId: string) => Promise<boolean>;
  /** The hydrated thread read as `userId` (legal-hold flag included for exclusion only). Oldest first. */
  readonly readWindow: (
    orgId: string,
    userId: string,
    channelId: string,
    threadRootMessageId: string | null,
  ) => Promise<readonly ResolvedMessage[]>;
  /** Names the patient is known by, for [PATIENT]. A throw refuses the call (we cannot scrub what we cannot name). */
  readonly patientNames: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly roleTokens: (
    orgId: string,
    userIds: readonly string[],
  ) => Promise<ReadonlyMap<string, RoleToken>>;
  /** Fixed-window counter: true while the count is within `limit`. A store error throws and the call is refused (fail closed). */
  readonly withinQuota: (key: string, windowMs: number, limit: number) => Promise<boolean>;
  readonly audit: (entry: AiAuditEntry) => Promise<void>;
  readonly warn?: (message: string, context: Record<string, string>) => void;
  readonly now?: () => Date;
}

export interface AiAuditEntry {
  readonly orgId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly kind: AiKind;
  readonly invocationId: string;
  readonly includedCount: number;
  readonly withheldCount: number;
}

const HOUR_MS = 3_600_000;
const TEN_MINUTES_MS = 600_000;

export interface AiService {
  enabledFor(orgId: string, userId: string): Promise<boolean>;
  summarize(
    actor: AiActor,
    channelId: string,
    threadRootMessageId: string | null,
  ): Promise<MessagingAiSummaryDto>;
  draftReply(
    actor: AiActor,
    channelId: string,
    threadRootMessageId: string | null,
  ): Promise<MessagingAiDraftDto>;
  recordOutcome(
    actor: AiActor,
    channelId: string,
    input: { invocationId: string; invokedAt: string; outcome: MessagingAiOutcome },
  ): Promise<void>;
}

const unavailable = (): ChartWardenError =>
  new ChartWardenError(
    AI_UNAVAILABLE,
    "AI is unavailable right now. Read the conversation instead.",
    503,
  );

export function createAiService(deps: AiServiceDeps): AiService {
  const clock = deps.now ?? (() => new Date());
  const flagOn = (orgId: string): Promise<boolean> => deps.isEnabled(orgId).catch(() => false);

  async function requireEnabled(orgId: string): Promise<void> {
    if (!(await flagOn(orgId)))
      throw new ChartWardenError(AI_NOT_ENABLED, "AI is not turned on", 404);
  }

  async function requireMember(actor: AiActor, channelId: string): Promise<void> {
    if (!(await deps.canViewChannel(actor.orgId, actor.userId, channelId))) {
      throw new NotFoundError("channel", channelId);
    }
  }

  /** Membership AND permission, evaluated now. Used once immediately before dispatch and once before anything is returned. */
  async function stillEntitled(actor: AiActor, channelId: string): Promise<void> {
    const [member, allowed] = await Promise.all([
      deps.canViewChannel(actor.orgId, actor.userId, channelId),
      deps.canUseAi(actor.orgId, actor.userId),
    ]);
    if (!member) throw new NotFoundError("channel", channelId);
    if (!allowed) throw new ChartWardenError("FORBIDDEN", "not permitted", 403);
  }

  async function prepare(actor: AiActor, channelId: string, root: string | null, kind: AiKind) {
    await requireEnabled(actor.orgId);
    await requireMember(actor, channelId);
    const facts = await deps.channelFacts(actor.orgId, channelId);
    if (!facts || (kind === "draft" && facts.archived))
      throw new NotFoundError("channel", channelId);
    const notForChannel = new ChartWardenError(
      AI_NOT_AVAILABLE_FOR_CHANNEL,
      "AI is not available for this conversation.",
      422,
    );
    if (facts.patientId) {
      const restricted = await deps
        .isPart2Restricted(actor.orgId, facts.patientId)
        .catch(() => true);
      if (restricted) throw notForChannel;
    }
    const names = facts.patientId
      ? await deps.patientNames(actor.orgId, facts.patientId).catch(() => {
          throw notForChannel;
        })
      : [];
    const messages = await deps.readWindow(actor.orgId, actor.userId, channelId, root);
    const authorIds = [
      ...new Set(messages.flatMap((m) => (m.authorUserId ? [m.authorUserId] : []))),
    ];
    const roleTokens = await deps
      .roleTokens(actor.orgId, [...authorIds, actor.userId])
      .catch(() => {
        throw unavailable();
      });
    const input = buildThreadInput({
      messages,
      now: clock(),
      patientNames: names,
      roleTokens,
      callerUserId: actor.userId,
    });
    return { facts, input };
  }

  async function dispatch(
    kind: AiKind,
    actor: AiActor,
    channelId: string,
    patientId: string | null,
    input: ReturnType<typeof buildThreadInput>,
  ): Promise<MessagingAiCompletion> {
    const request: MessagingAiRequest = {
      organizationId: actor.orgId,
      actorUserId: actor.userId,
      channelId,
      patientId,
      messageRange: {
        firstMessageId: input.firstSentMessageId as string,
        lastMessageId: input.lastSentMessageId as string,
        count: input.includedCount,
      },
      promptText: input.promptText,
      responseSchema: kind === "summary" ? MESSAGING_AI_SUMMARY_SCHEMA : MESSAGING_AI_DRAFT_SCHEMA,
      maxOutputTokens:
        kind === "summary"
          ? MESSAGING_AI_LIMITS.maxOutputTokensSummary
          : MESSAGING_AI_LIMITS.maxOutputTokensDraft,
      dispatchTimeoutMs: MESSAGING_AI_LIMITS.dispatchTimeoutMs,
    };
    try {
      return await (kind === "summary"
        ? deps.port.summarize(request)
        : deps.port.draftReply(request));
    } catch (err) {
      deps.warn?.("messaging AI port threw; answering unavailable", {
        organizationId: actor.orgId,
        channelId,
        error: err instanceof Error ? err.name : "unknown",
      });
      return { available: false };
    }
  }

  /** The system itself discards an answer it will not show: record that as the human-equivalent decision "rejected" (best effort). */
  async function discard(
    actor: AiActor,
    channelId: string,
    call: Extract<MessagingAiCompletion, { available: true }>,
  ) {
    await deps.port
      .recordOutcome({
        organizationId: actor.orgId,
        actorUserId: actor.userId,
        channelId,
        invocationId: call.invocationId,
        invokedAt: call.invokedAt,
        outcome: "rejected",
      })
      .catch(() => undefined);
  }

  async function consume(key: string, windowMs: number, limit: number): Promise<void> {
    let ok: boolean;
    try {
      ok = await deps.withinQuota(key, windowMs, limit);
    } catch {
      throw unavailable();
    }
    if (!ok) throw new RateLimitedError();
  }

  async function audited(
    actor: AiActor,
    channelId: string,
    kind: AiKind,
    call: Extract<MessagingAiCompletion, { available: true }>,
    input: ReturnType<typeof buildThreadInput>,
  ): Promise<void> {
    await deps.audit({
      orgId: actor.orgId,
      userId: actor.userId,
      channelId,
      kind,
      invocationId: call.invocationId,
      includedCount: input.includedCount,
      withheldCount: input.withheldCount,
    });
  }

  return {
    async enabledFor(orgId, userId) {
      if (!(await flagOn(orgId))) return false;
      return deps.canUseAi(orgId, userId).catch(() => false);
    },

    async summarize(actor, channelId, root) {
      const { facts, input } = await prepare(actor, channelId, root, "summary");
      const base = {
        label: MESSAGING_AI_SUMMARY_LABEL,
        included_count: input.includedCount,
        withheld_count: input.withheldCount,
        input_hash: input.inputHash,
      } as const;
      if (input.includedCount < MESSAGING_AI_LIMITS.minMessagesToSummarise) {
        // Too little to summarise: the model is not called, so nothing is disclosed to a vendor.
        return {
          ...base,
          invocation_id: null,
          invoked_at: null,
          status: "insufficient_context",
          points: [],
          open_questions: [],
        };
      }
      await consume(
        `m36-ai:sum:user:${actor.orgId}:${actor.userId}`,
        HOUR_MS,
        MESSAGING_AI_LIMITS.summariesPerUserPerHour,
      );
      await consume(
        `m36-ai:sum:chan:${actor.orgId}:${channelId}`,
        TEN_MINUTES_MS,
        MESSAGING_AI_LIMITS.summariesPerChannelPerTenMinutes,
      );
      await stillEntitled(actor, channelId);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const call = await dispatch("summary", actor, channelId, facts.patientId, input);
        if (!call.available) throw unavailable();
        const parsed = parseSummary(call.text, input);
        if (parsed.kind === "invalid") {
          await discard(actor, channelId, call);
          continue; // retry once (governance 8.6), then unavailable
        }
        if (parsed.kind === "refused") {
          await discard(actor, channelId, call);
          throw new ChartWardenError(
            AI_OUTPUT_REFUSED,
            "The AI answer was withheld because it stated a dose, order or diagnosis. Read the conversation instead.",
            422,
          );
        }
        await stillEntitled(actor, channelId);
        await audited(actor, channelId, "summary", call, input);
        const tooLittle = parsed.insufficientContext || parsed.points.length === 0;
        return {
          ...base,
          invocation_id: call.invocationId,
          invoked_at: call.invokedAt,
          status: tooLittle ? "insufficient_context" : "ok",
          points: tooLittle ? [] : parsed.points,
          open_questions: parsed.openQuestions,
        };
      }
      throw unavailable();
    },

    async draftReply(actor, channelId, root) {
      const { facts, input } = await prepare(actor, channelId, root, "draft");
      if (input.includedCount < 1) {
        throw new ChartWardenError(
          AI_NOT_AVAILABLE_FOR_CHANNEL,
          "There is nothing to reply to yet.",
          422,
        );
      }
      await consume(
        `m36-ai:draft:user:${actor.orgId}:${actor.userId}`,
        HOUR_MS,
        MESSAGING_AI_LIMITS.draftsPerUserPerHour,
      );
      await stillEntitled(actor, channelId);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const call = await dispatch("draft", actor, channelId, facts.patientId, input);
        if (!call.available) throw unavailable();
        const parsed = parseDrafts(call.text, input.aliasToDisplayName);
        if (parsed.kind === "invalid") {
          await discard(actor, channelId, call);
          continue;
        }
        if (parsed.kind === "refused") {
          await discard(actor, channelId, call);
          throw new ChartWardenError(
            AI_OUTPUT_REFUSED,
            "The AI draft was withheld because it stated a dose, order or diagnosis. Write the reply yourself.",
            422,
          );
        }
        await stillEntitled(actor, channelId);
        await audited(actor, channelId, "draft", call, input);
        return {
          label: MESSAGING_AI_DRAFT_LABEL,
          invocation_id: call.invocationId,
          invoked_at: call.invokedAt,
          drafts: parsed.drafts,
          included_count: input.includedCount,
          withheld_count: input.withheldCount,
        };
      }
      throw unavailable();
    },

    async recordOutcome(actor, channelId, input) {
      await requireEnabled(actor.orgId);
      await requireMember(actor, channelId);
      const result = await deps.port.recordOutcome({
        organizationId: actor.orgId,
        actorUserId: actor.userId,
        channelId,
        invocationId: input.invocationId,
        invokedAt: input.invokedAt,
        outcome: input.outcome,
      });
      if (result === "not_found") throw new NotFoundError("invocation", input.invocationId);
    },
  };
}
