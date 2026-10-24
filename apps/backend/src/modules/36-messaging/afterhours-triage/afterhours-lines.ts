// apps/backend/src/modules/36-messaging/afterhours-triage/afterhours-lines.ts - ADR-0082 slice S4: the thread line for an after-hours send.
// The line is DERIVED at read time from the link row through the CLOSED map in @chartwarden/types; nothing from M19 except the closed outcome
// ever reaches it, so there is no free text to scrub and a redelivered reply cannot post a second line (the link records the outcome once).
// Q8 default: in a restricted (42 CFR Part 2) channel the outcome wording is withheld; a lookup that cannot say is read as restricted.
import {
  AFTERHOURS_TRIAGE_LINE_TEXT,
  type AfterHoursTriageLineDto,
  type AfterHoursTriageLineState,
  type AfterHoursTriageLinesResponse,
  type AfterHoursTriageOutcome,
  NotFoundError,
} from "@chartwarden/types";
import type { AfterHoursLinkStore } from "./afterhours-link-store";

/** Bounded so a request cannot ask for an unbounded join. */
export const AFTERHOURS_LINES_MAX_MESSAGES = 50;

export interface AfterHoursLinesDeps {
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly store: Pick<AfterHoursLinkStore, "findForChannel">;
  /** True when the channel's patient is restricted (Part 2). A throw is read as restricted. */
  readonly isRestrictedChannel: (orgId: string, channelId: string) => Promise<boolean>;
}

export interface AfterHoursLinesService {
  /** The caller has already passed the channel-visibility guard. Flag off is the uniform 404. */
  forChannel(
    orgId: string,
    channelId: string,
    messageIds: readonly string[],
  ): Promise<AfterHoursTriageLinesResponse>;
}

export function lineStateOf(
  outcome: AfterHoursTriageOutcome | null,
  restricted: boolean,
): AfterHoursTriageLineState {
  // Restricted: every link row reads the same, an unanswered request included, so a member cannot learn that a triage request exists.
  if (restricted) return "withheld";
  return outcome ?? "not_confirmed";
}

export function createAfterHoursLinesService(deps: AfterHoursLinesDeps): AfterHoursLinesService {
  return {
    async forChannel(orgId, channelId, messageIds) {
      if (!(await deps.isEnabled(orgId))) throw new NotFoundError("channel");
      const ids = [...new Set(messageIds)].slice(0, AFTERHOURS_LINES_MAX_MESSAGES);
      // Evaluated before the rows are read, whatever they hold, so the two paths cost and shape the same.
      const [restricted, rows] = await Promise.all([
        deps.isRestrictedChannel(orgId, channelId).catch(() => true),
        deps.store.findForChannel(orgId, channelId, ids),
      ]);
      const lines: AfterHoursTriageLineDto[] = rows.map((r) => {
        const state = lineStateOf(r.outcome, restricted);
        return { message_id: r.messageId, state, text: AFTERHOURS_TRIAGE_LINE_TEXT[state] };
      });
      return { lines };
    },
  };
}
