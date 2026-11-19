// apps/web/src/modules/16-bereavement — one support group's ROSTER (ADR-0109 D10, route 61). It names families, so it is read only by a
// session holding `bereavement.group.run` (oversight, the staff facilitator, or a volunteer facilitator who passes the 418.78 gates): without
// the key it is never requested, and a 403 renders nothing. A volunteer gets the reduced projection: no relationship and no plan, shown as
// "Not shown to you", never guessed.
import { Button, LoadingSpinner, Panel, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { humanize } from "./bereavement-status";
import { ErrorText, linkStyle, tdNum, thNum } from "./bereavement-ui";
import { type Loaded, useLoaded } from "./mailing-load";
import { type GroupRoster, getRoster } from "./programs-api";

const ROSTER_LOAD_FAILED = "The roster could not be loaded.";
const NOT_ASKED = { data: null, error: null, status: 403 } as const;

/** The roster, read only when `mayRun`; the caller shares it between the roster card and the attendance dialog. */
export function useGroupRoster(groupId: string, mayRun: boolean) {
  const client = useApiClient();
  const fetchRoster = useCallback(
    async () => (mayRun ? getRoster(client, groupId) : NOT_ASKED),
    [client, groupId, mayRun],
  );
  return useLoaded<GroupRoster>(fetchRoster, ROSTER_LOAD_FAILED);
}

export function GroupRosterCard({
  state,
  onRetry,
}: {
  state: Loaded<GroupRoster>;
  onRetry: () => void;
}): JSX.Element | null {
  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the roster" />;
  const failure = state.kind === "error" ? state.message : state.notice;
  const entries = state.kind === "ready" ? state.data.entries : [];
  return (
    <Panel stack headingLevel={3} title="Roster">
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && entries.length === 0 ? (
        <span className="wx-text-muted">No family is enrolled in this group yet.</span>
      ) : null}
      {entries.length > 0 ? (
        <table aria-label="Group roster">
          <thead>
            <tr>
              <th>Name</th>
              <th>Relationship</th>
              <th>Enrollment</th>
              <th style={thNum}>Sessions attended</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.contactId}>
                <td>
                  {entry.planId ? (
                    <Link
                      to={`/bereavement/plans/${entry.planId}/contacts/${entry.contactId}`}
                      style={linkStyle}
                    >
                      {entry.displayName}
                    </Link>
                  ) : (
                    entry.displayName
                  )}
                </td>
                <td>
                  {entry.relationshipCode ? (
                    humanize(entry.relationshipCode)
                  ) : (
                    <span className="wx-text-muted" style={{ fontStyle: "italic" }}>
                      Not shown to you
                    </span>
                  )}
                </td>
                <td>
                  <StatusPill
                    label={humanize(entry.enrollmentStatus)}
                    tone={entry.enrollmentStatus === "enrolled" ? "success" : "neutral"}
                  />
                </td>
                <td style={tdNum}>{entry.attendedSessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
