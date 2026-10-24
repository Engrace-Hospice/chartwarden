// apps/backend/src/modules/36-messaging/ai/thread-input.ts - WP 6.5 (ADR-0095 sections 1.2-1.4): turn the hydrated thread read the caller can see
// into the ONE string that may reach a model.
//
//   * the input is exactly the messages the caller's own read returned (redaction masking and deleted-message filtering already applied),
//     bounded to the smaller of N messages and D days;
//   * a redacted, deleted, legally held, unreadable or system-authored message is EXCLUDED (its text is never read here) and appears as the
//     placeholder "[message withheld]", so refs and order stay truthful;
//   * senders become a role token plus a per-thread alias, the patient becomes [PATIENT], times become relative;
//   * each message gets an opaque ref m1..mN; the real id never reaches the model and is mapped back server-side from this very list.
// PURE: the caller supplies the messages, the role tokens and the patient names.
import { createHash } from "node:crypto";
import type { ResolvedMessage } from "@chartwarden/messaging";
import { MESSAGING_AI_LIMITS, MESSAGING_AI_WITHHELD_PLACEHOLDER } from "@chartwarden/types";
import { type RoleToken, aliasFor, relativeLabel, scrubBody } from "./pseudonymise";

const DAY_MS = 86_400_000;

export interface ThreadInputArgs {
  /** Oldest first, as the thread read returns them. */
  readonly messages: readonly ResolvedMessage[];
  readonly now: Date;
  /** The patient's names (empty for a channel that is not about a patient). */
  readonly patientNames: readonly string[];
  /** userId -> role token. A user missing from the map is [STAFF]. */
  readonly roleTokens: ReadonlyMap<string, RoleToken>;
  /** The user who asked; the draft prompt names the reply author by alias. */
  readonly callerUserId: string;
}

export interface ThreadInput {
  /** The user-turn text. Contains no id, no name, no clock time. */
  readonly promptText: string;
  /** ref -> real message id, for the messages whose TEXT was sent (withheld refs are absent). */
  readonly sentRefToMessageId: ReadonlyMap<string, string>;
  /** message id -> ISO sent time, for the same messages. */
  readonly sentAtByMessageId: ReadonlyMap<string, string>;
  /** alias ("Sender A") -> the real display name, for putting names back in the answer the CALLER reads. */
  readonly aliasToDisplayName: ReadonlyMap<string, string>;
  readonly includedCount: number;
  readonly withheldCount: number;
  readonly firstSentMessageId: string | null;
  readonly lastSentMessageId: string | null;
  /** sha256 over the sent message ids: unchanged thread, unchanged hash. */
  readonly inputHash: string;
}

/** Why a message is not sent. Never reported to the browser beyond the bare count. */
function isWithheld(message: ResolvedMessage): boolean {
  return (
    message.redactedAt !== undefined ||
    message.legalHold === true ||
    message.bodyUnreadable === true ||
    message.authorUserId === null ||
    message.body.trim().length === 0
  );
}

/** The window: newest `windowMaxMessages`, no older than `windowMaxDays`. */
export function windowOf(
  messages: readonly ResolvedMessage[],
  now: Date,
): readonly ResolvedMessage[] {
  const oldest = now.getTime() - MESSAGING_AI_LIMITS.windowMaxDays * DAY_MS;
  const recent = messages.filter((m) => Date.parse(m.createdAt) >= oldest);
  return recent.slice(-MESSAGING_AI_LIMITS.windowMaxMessages);
}

export function buildThreadInput(args: ThreadInputArgs): ThreadInput {
  const window = windowOf(args.messages, args.now);
  const aliasByUser = new Map<string, string>();
  const nameByUser = new Map<string, string>();
  const tokenOf = (userId: string): RoleToken => args.roleTokens.get(userId) ?? "[STAFF]";
  const aliasOf = (userId: string): string => {
    let alias = aliasByUser.get(userId);
    if (alias === undefined) {
      alias = aliasFor(aliasByUser.size);
      aliasByUser.set(userId, alias);
    }
    return alias;
  };
  // Aliases are handed out by first appearance among ALL authors in the window (also the ones whose text is withheld), so a name that appears
  // in a body can be mapped to its alias even if its owner's own messages were withheld.
  for (const m of window) {
    if (m.authorUserId === null) continue;
    aliasOf(m.authorUserId);
    if (m.authorDisplayName) nameByUser.set(m.authorUserId, m.authorDisplayName);
  }
  const participantLabels = new Map<string, string>();
  for (const [userId, name] of nameByUser) {
    participantLabels.set(name, `${aliasOf(userId)} ${tokenOf(userId)}`);
  }
  const lastMs = window.length === 0 ? 0 : Date.parse(window[window.length - 1]!.createdAt);

  const lines: string[] = [];
  const sentRefToMessageId = new Map<string, string>();
  const sentAtByMessageId = new Map<string, string>();
  const sentIds: string[] = [];
  let withheldCount = 0;
  window.forEach((message, index) => {
    const ref = `m${index + 1}`;
    if (isWithheld(message)) {
      withheldCount += 1;
      lines.push(`${ref} | ${MESSAGING_AI_WITHHELD_PLACEHOLDER}`);
      return;
    }
    const userId = message.authorUserId as string;
    const text = scrubBody(
      message.body,
      { patientNames: args.patientNames, participantLabels },
      MESSAGING_AI_LIMITS.maxCharsPerMessage,
    );
    const urgent = message.urgency === "urgent" ? " | urgent" : "";
    lines.push(
      `${ref} | ${aliasOf(userId)} ${tokenOf(userId)} | ${relativeLabel(lastMs, Date.parse(message.createdAt))}${urgent} | ${text}`,
    );
    sentRefToMessageId.set(ref, message.messageId);
    sentAtByMessageId.set(message.messageId, message.createdAt);
    sentIds.push(message.messageId);
  });

  const aliasToDisplayName = new Map<string, string>();
  for (const [userId, alias] of aliasByUser) {
    const name = nameByUser.get(userId);
    if (name) aliasToDisplayName.set(alias, name);
  }
  const callerAlias = `${aliasOf(args.callerUserId)} ${tokenOf(args.callerUserId)}`;
  const promptText = [
    `Conversation window: ${sentIds.length} messages included, ${withheldCount} not included.`,
    `The person asking is ${callerAlias}.`,
    "[MESSAGES BEGIN]",
    ...lines,
    "[MESSAGES END]",
  ].join("\n");
  return {
    promptText,
    sentRefToMessageId,
    sentAtByMessageId,
    aliasToDisplayName,
    includedCount: sentIds.length,
    withheldCount,
    firstSentMessageId: sentIds[0] ?? null,
    lastSentMessageId: sentIds[sentIds.length - 1] ?? null,
    inputHash: createHash("sha256").update(sentIds.join(",")).digest("hex"),
  };
}
