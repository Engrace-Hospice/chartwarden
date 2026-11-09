// apps/web/src/modules/16-bereavement — a memorial service's INVITATIONS (ADR-0109 D10, routes 73 / 75). The list names every invited family,
// so it is oversight only: the parent mounts this card only for `bereavement.memorial.manage`, and a 403 still renders nothing. Once the
// service has started (and was not cancelled), each row can be marked attended or not; the row takes the server's answer.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "./bereavement-api";
import { dateTime, humanize, toneOf } from "./bereavement-status";
import {
  Card,
  ErrorText,
  linkStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
  useIdempotencyKey,
} from "./bereavement-ui";
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
  const keys = useIdempotencyKey();
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
    keys.settle(res.status);
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
    <Card title="Invitations">
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <span style={mutedStyle}>
          {service.status === "draft"
            ? "Invitations are created when the service is published."
            : "No family was invited to this service."}
        </span>
      ) : null}
      {rows.length > 0 ? (
        <table style={tableStyle} aria-label="Invitations">
          <thead>
            <tr>
              <th style={th}>Family member</th>
              <th style={th}>Relationship</th>
              <th style={th}>Delivery</th>
              <th style={th}>Answer</th>
              <th style={thNum}>Guests</th>
              <th style={th}>Answered</th>
              {started ? <th style={th}>Attendance</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.invitationId} style={rowLine}>
                <td style={td}>
                  <Link
                    to={`/bereavement/plans/${row.planId}/contacts/${row.contactId}`}
                    style={linkStyle}
                  >
                    {row.displayName}
                  </Link>
                </td>
                <td style={td}>{humanize(row.relationshipCode)}</td>
                <td style={td}>{row.delivery === "mailing" ? "Mailed" : "Portal only"}</td>
                <td style={td}>
                  <StatusPill
                    label={invitationLabel(row.status)}
                    tone={toneOf(INVITATION_STATUS_TONE, row.status)}
                  />
                </td>
                <td style={tdNum}>{row.guests}</td>
                <td style={td}>
                  {row.rsvpSource
                    ? `${row.rsvpSource === "portal" ? "Portal" : "By phone"}, ${dateTime(row.rsvpAt)}`
                    : "—"}
                </td>
                {started ? (
                  <td style={td}>
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
    </Card>
  );
}
