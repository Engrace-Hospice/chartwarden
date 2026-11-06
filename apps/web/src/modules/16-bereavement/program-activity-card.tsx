// apps/web/src/modules/16-bereavement — the PROGRAM ACTIVITY card of the contact detail (ADR-0109 D10, route 52).
//
// What has this family been sent or invited to, and what happened on each touchpoint? The contact's timeline reads both kinds of row
// newest first: a TOUCHPOINT (an outreach: a call, a letter, a visit) and a PROGRAM ACTIVITY (a newsletter or holiday mailing, a
// support-group session, a memorial attendance). The two are labelled differently in words, not colour alone, because a program activity
// satisfies no cadence item: a newsletter is not a call.
//
// A bereavement volunteer sees WHEN each touchpoint happened and its kind but never its outcome (what was said on a call is clinical):
// the field is absent from the response, and that is shown as "Not shown to you", never as a guess. A 403 renders nothing; any other
// failure is announced and keeps the entries on screen; "Load more" appends.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback } from "react";
import type { JSX } from "react";
import {
  type ContactTimelinePage,
  type TimelineEntry,
  listContactTimeline,
} from "./bereavement-api";
import { dateTime, outreachKindLabel, redactionLabel } from "./bereavement-status";
import { Card, ErrorText, mutedStyle, rowLine, tableStyle, td, th } from "./bereavement-ui";
import { usePagedList } from "./mailing-load";
import { activityLabel, timelineOutcomeLabel } from "./mailing-status";

const TIMELINE_PAGE_SIZE = 25;
const TIMELINE_LOAD_FAILED = "This survivor's program activity could not be loaded.";

/** What an entry is, in words: a program activity names its kind, a touchpoint names its modality. */
const entryLabel = (entry: TimelineEntry): string =>
  entry.source === "program_activity"
    ? activityLabel(entry.activityKind)
    : outreachKindLabel(entry.kind);

export function ProgramActivityCard({ contactId }: { contactId: string }): JSX.Element | null {
  const client = useApiClient();
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const { page, error, status } = await listContactTimeline(client, contactId, {
        ...(cursor === null ? {} : { cursor }),
        limit: TIMELINE_PAGE_SIZE,
      });
      return { data: page, error, status };
    },
    [client, contactId],
  );
  const { state, reload, loadMore } = usePagedList<TimelineEntry, ContactTimelinePage>(
    fetchPage,
    TIMELINE_LOAD_FAILED,
  );

  if (state.kind === "hidden") return null;
  const rows = state.kind === "ready" ? state.rows : [];
  const failure =
    state.kind === "error" ? state.message : state.kind === "ready" ? state.notice : null;
  const busy = state.kind === "ready" && state.busy;
  const hasMore = state.kind === "ready" && state.hasMore;
  const redaction =
    state.kind === "ready" ? redactionLabel(state.last.redactedCategories ?? []) : null;
  return (
    <Card title="Program activity">
      <span style={mutedStyle}>
        Touchpoints and program activities such as mailings, newest first. A program activity is not
        a touchpoint: it does not count toward the outreach schedule.
      </span>
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" loading={busy} onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "loading" ? <LoadingSpinner label="Loading program activity" /> : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <span style={mutedStyle}>Nothing has been recorded for this survivor yet.</span>
      ) : null}
      {rows.length > 0 ? (
        <table style={tableStyle} aria-label="Program activity timeline" aria-busy={busy}>
          <thead>
            <tr>
              <th style={th}>When</th>
              <th style={th}>Type</th>
              <th style={th}>What</th>
              <th style={th}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const withheld = entry.outcome === undefined;
              return (
                <tr key={entry.entryId} style={rowLine}>
                  <td style={td}>{dateTime(entry.at)}</td>
                  <td style={td}>
                    {entry.source === "program_activity" ? (
                      <StatusPill label="Program activity" tone="progress" />
                    ) : (
                      <StatusPill label="Touchpoint" tone="neutral" />
                    )}
                  </td>
                  <td style={td}>{entryLabel(entry)}</td>
                  <td style={td}>
                    {withheld ? (
                      <span style={{ ...mutedStyle, fontStyle: "italic" }}>
                        {timelineOutcomeLabel(entry)}
                      </span>
                    ) : (
                      timelineOutcomeLabel(entry)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {redaction ? <span style={mutedStyle}>{redaction}</span> : null}
      {hasMore ? (
        <div>
          <Button size="sm" tone="secondary" loading={busy} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
