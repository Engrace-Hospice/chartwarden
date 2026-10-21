// apps/backend/src/modules/37-ipu/routes/irc-episode-open.ts — the `irc_episode` opening handler (§2.5).
//
// "Cap-window resumption rule: if an IRC episode is closed and the same patient is re-admitted to IRC within
// 30 days, the new episode's `consecutive_day_count` does NOT reset ... resumption is detected by the
// `irc_episode.opening_handler` which queries the patient's M37 episode history." Before this handler every
// episode opened at day 1, so two 3-day respite stays a day apart each looked like a compliant 3 days — the
// split-episode workaround the 30-day look-back exists to stop.
//
// The pure rule is `resumedStartingDayCount` (`@chartwarden/inpatient`); this file is the IO around it: read the
// patient's closed episodes, insert the row at the inherited day, and report the cap state it opened IN so the
// caller can announce it. A resumed episode can open at day 4 or 5+; the state is derived at the insert (the
// `within_cap` billing gate reads it immediately) and the matching event is returned for the caller to publish
// in the same transaction — the hourly watchdog only ever announces a state ENTRY it advances into.
import { type DbClient, schema } from "@chartwarden/db";
import {
  IRC_CAP_DAYS,
  type IrcOutboxEvent,
  computeIrcState,
  resumedStartingDayCount,
} from "@chartwarden/inpatient";
import { and, eq, isNotNull, ne } from "drizzle-orm";

const IRC = schema.ircEpisode;
const DAY_MS = 86_400_000;

export interface OpenedIrcEpisode {
  readonly episodeId: string;
  readonly consecutiveDayCount: number;
  readonly carriedOverDays: number;
  readonly state: ReturnType<typeof computeIrcState>;
  /** The state-entry event to publish (a resumed episode can open already at/over the cap), else null. */
  readonly event: Extract<
    IrcOutboxEvent,
    "m37.irc_episode.cap_approaching" | "m37.irc_episode.cap_breached"
  > | null;
}

export async function openIrcEpisodeRow(
  t: DbClient,
  input: {
    readonly organizationId: string;
    readonly ipuAdmissionId: string;
    readonly providerEntityId: string;
    readonly patientId: string;
    readonly now?: Date;
  },
): Promise<OpenedIrcEpisode> {
  const now = input.now ?? new Date();
  const prior = await t
    .select({ closedAt: IRC.closedAt, count: IRC.consecutiveDayCount })
    .from(IRC)
    .where(
      and(
        eq(IRC.patientId, input.patientId),
        eq(IRC.state, "closed"),
        isNotNull(IRC.closedAt),
        ne(IRC.ipuAdmissionId, input.ipuAdmissionId),
      ),
    );
  const startingDay = resumedStartingDayCount(
    prior.map((p) => ({
      closedAtMs: p.closedAt ? p.closedAt.getTime() : null,
      consecutiveDayCount: p.count,
    })),
    now.getTime(),
  );
  const state = computeIrcState(startingDay, 0);
  const carriedOverDays = startingDay - 1;
  const [row] = await t
    .insert(IRC)
    .values({
      organizationId: input.organizationId,
      ipuAdmissionId: input.ipuAdmissionId,
      providerEntityId: input.providerEntityId,
      patientId: input.patientId,
      startedAt: now,
      // The window is what is LEFT of the 5-day cap, never less than the day the stay starts on.
      expectedEndAt: new Date(now.getTime() + Math.max(IRC_CAP_DAYS - carriedOverDays, 1) * DAY_MS),
      consecutiveDayCount: startingDay,
      carriedOverDays,
      state,
    })
    .returning({ id: IRC.id });
  if (!row) throw new Error("M37_IRC_OPEN: irc_episode insert returned no row");
  return {
    episodeId: row.id,
    consecutiveDayCount: startingDay,
    carriedOverDays,
    state,
    event:
      state === "breached"
        ? "m37.irc_episode.cap_breached"
        : state === "approaching_cap"
          ? "m37.irc_episode.cap_approaching"
          : null,
  };
}
