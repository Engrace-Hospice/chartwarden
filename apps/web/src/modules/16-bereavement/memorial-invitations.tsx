// apps/web/src/modules/16-bereavement — a memorial service's INVITATIONS (ADR-0109 D10, routes 73 / 75). The list names every invited family,
// so it is oversight only: the parent mounts this card only for `bereavement.memorial.manage`, and a 403 still renders nothing. Once the
// service has started (and was not cancelled), each row can be marked attended or not; the row takes the server's answer.
import {
  Button,
  LoadingSpinner,
  Panel,
  StatusPill,
  useApiClient,
  useAttemptKey,
} from "@chartwarden/ui";
import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "./bereavement-api";
import { dateTime, humanize, toneOf } from "./bereavement-status";
import { ErrorText, linkStyle, tdNum, thNum } from "./bereavement-ui";
import { useLoaded } from "./mailing-load";
import { INVITATION_STATUS_TONE, invitationLabel } from "./program-status";
import {
  type Memorial,
  type MemorialInvitation,
  listInvitations,
  recordMemorialAttendance,
} from "./programs-api";

const LOAD_FAILED = "The invitations could not be loaded.";

export function MemorialInvitations({
  service,
  onRecorded,
  now = Date.now(),
}: {
  service: Memorial;
  /** Attendance changed the service's counts: the page reads it again. */
  onRecorded: (message: string) => void;
  now?: number;
}): JSX.Element | null {
  const client = useApiClient();
  const keys = useAttemptKey();
  const inFlight = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRows = useCallback(
    () => listInvitations(client, service.serviceId),
    [client, service.serviceId],
  );
  const { state, reload, patch } = useLoaded<MemorialInvitation[]>(fetchRows, LOAD_FAILED);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading invitations" />;

  const started = service.status !== "cancelled" && Date.parse(service.startsAt) <= now;
  const mark = async (row: MemorialInvitation, attended: boolean): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyId(row.invitationId);
    setError(null);
    const res = await recordMemorialAttendance(
      client,
      service.serviceId,
      row.invitationId,
      attended,
      keys.keyFor(`${row.invitationId}:${row.version}:${attended}`),
    );
    keys.settle(res.status, res.error);
    inFlight.current = false;
    setBusyId(null);
    if (res.error || !res.data) {
      setError(errorMessage(res.error, "The attendance could not be recorded."));
      return;
    }
    const next = res.data;
    patch((rows) => rows.map((r) => (r.invitationId === next.invitationId ? next : r)));
    onRecorded(`${next.displayName} marked as ${attended ? "attended" : "did not attend"}.`);
  };

  const rows = state.kind === "ready" ? state.data : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  return (
    <Panel stack headingLevel={3} title="Invitations">
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <span className="wx-text-muted">
          {service.status === "draft"
            ? "Invitations are created when the service is published."
            : "No family was invited to this service."}
        </span>
      ) : null}
      {rows.length > 0 ? (
        <table aria-label="Invitations">
          <thead>
            <tr>
              <th>Family member</th>
              <th>Relationship</th>
              <th>Delivery</th>
              <th>Answer</th>
              <th style={thNum}>Guests</th>
              <th>Answered</th>
              {started ? <th>Attendance</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.invitationId}>
                <td>
                  <Link
                    to={`/bereavement/plans/${row.planId}/contacts/${row.contactId}`}
                    style={linkStyle}
                  >
                    {row.displayName}
                  </Link>
                </td>
                <td>{humanize(row.relationshipCode)}</td>
                <td>{row.delivery === "mailing" ? "Mailed" : "Portal only"}</td>
                <td>
                  <StatusPill
                    label={invitationLabel(row.status)}
                    tone={toneOf(INVITATION_STATUS_TONE, row.status)}
                  />
                </td>
                <td style={tdNum}>{row.guests}</td>
                <td>
                  {row.rsvpSource
                    ? `${row.rsvpSource === "portal" ? "Portal" : "By phone"}, ${dateTime(row.rsvpAt)}`
                    : "—"}
                </td>
                {started ? (
                  <td>
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={busyId !== null || row.status === "attended"}
                        aria-label={`${row.displayName} attended`}
                        onClick={() => void mark(row, true)}
                      >
                        Attended
                      </Button>
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={busyId !== null || row.status === "no_show"}
                        aria-label={`${row.displayName} did not attend`}
                        onClick={() => void mark(row, false)}
                      >
                        Did not attend
                      </Button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Panel>
  );
}
