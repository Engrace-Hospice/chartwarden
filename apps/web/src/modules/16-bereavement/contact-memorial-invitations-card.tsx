// apps/web/src/modules/16-bereavement — the MEMORIAL INVITATIONS panel of the contact detail (ADR-0109 D10, routes 74 and 76).
//
// Which memorial services this family is invited to, what they answered, and a place to record an answer they gave by PHONE. The panel exists
// only for a reader who holds `bereavement.memorial.rsvp` (the family's counselor or oversight): without it nothing is requested and nothing
// renders, and a 403 renders nothing either. An answer can be recorded only while the service is published (afterwards the RSVP is closed).
// The write carries one Idempotency-Key per attempt; the row is replaced by the server's answer. A refusal (409: closed, full) is said in
// place and the list is read again.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { errorMessage, isStaleWrite } from "./bereavement-api";
import { dateTime, humanize, toneOf } from "./bereavement-status";
import {
  Card,
  ErrorText,
  Modal,
  SelectField,
  TextField,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  useActionStatus,
  useIdempotencyKey,
  visuallyHidden,
} from "./bereavement-ui";
import { useLoaded } from "./mailing-load";
import {
  INVITATION_STATUS_TONE,
  MEMORIAL_RSVP_PERMISSION,
  holds,
  intOrNull,
  invitationLabel,
} from "./program-status";
import {
  type ContactInvitation,
  type RsvpBody,
  listContactInvitations,
  recordPhoneRsvp,
} from "./programs-api";

const LOAD_FAILED = "This family's memorial invitations could not be loaded.";
const MAX_GUESTS = 10;

export function ContactMemorialInvitationsCard({
  contactId,
}: { contactId: string }): JSX.Element | null {
  const session = useSession();
  if (!holds(session?.permissions, MEMORIAL_RSVP_PERMISSION)) return null;
  return <InvitationsPanel contactId={contactId} />;
}

function InvitationsPanel({ contactId }: { contactId: string }): JSX.Element | null {
  const client = useApiClient();
  const fetcher = useCallback(() => listContactInvitations(client, contactId), [client, contactId]);
  const { state, reload, patch } = useLoaded<ContactInvitation[]>(fetcher, LOAD_FAILED);
  const { announce, region } = useActionStatus();
  const [answering, setAnswering] = useState<ContactInvitation | null>(null);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading memorial invitations" />;
  const rows = state.kind === "ready" ? state.data : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  return (
    <Card title="Memorial invitations">
      {region}
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <span style={mutedStyle}>This family has not been invited to a memorial service.</span>
      ) : null}
      {rows.length > 0 ? (
        <table style={tableStyle} aria-label="Memorial invitations">
          <thead>
            <tr>
              <th style={th}>Service</th>
              <th style={th}>When</th>
              <th style={th}>Answer</th>
              <th style={th}>Guests</th>
              <th style={th}>Recorded</th>
              <th style={th}>
                <span style={visuallyHidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.invitationId} style={rowLine}>
                <td style={td}>{row.serviceTitle}</td>
                <td style={td}>{dateTime(row.startsAt)}</td>
                <td style={td}>
                  <StatusPill
                    label={invitationLabel(row.status)}
                    tone={toneOf(INVITATION_STATUS_TONE, row.status)}
                  />
                </td>
                <td style={td}>{row.guests}</td>
                <td style={td}>
                  {row.rsvpAt
                    ? `${dateTime(row.rsvpAt)} (${row.rsvpSource === "portal" ? "family portal" : humanize(row.rsvpSource)})`
                    : "—"}
                </td>
                <td style={td}>
                  {row.serviceStatus === "published" ? (
                    <Button size="sm" tone="secondary" onClick={() => setAnswering(row)}>
                      Record phone RSVP
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {answering ? (
        <RsvpModal
          contactId={contactId}
          invitation={answering}
          onClose={() => setAnswering(null)}
          onRefused={() => void reload()}
          onDone={(next) => {
            setAnswering(null);
            patch((prev) => prev.map((r) => (r.invitationId === next.invitationId ? next : r)));
            announce(`RSVP recorded: ${invitationLabel(next.status)}.`);
          }}
        />
      ) : null}
    </Card>
  );
}

const RESPONSE_OF: Record<string, RsvpBody["response"]> = {
  rsvp_yes: "yes",
  rsvp_no: "no",
  rsvp_maybe: "maybe",
};

function RsvpModal({
  contactId,
  invitation,
  onClose,
  onRefused,
  onDone,
}: {
  contactId: string;
  invitation: ContactInvitation;
  onClose: () => void;
  /** The server refused because the invitation moved (closed, full, gone): the panel re-reads the list. */
  onRefused: () => void;
  onDone: (row: ContactInvitation) => void;
}): JSX.Element {
  const client = useApiClient();
  const keys = useIdempotencyKey();
  const [response, setResponse] = useState<RsvpBody["response"]>(
    RESPONSE_OF[invitation.status] ?? "yes",
  );
  const [guests, setGuests] = useState(String(invitation.guests));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guestCount = response === "no" ? 0 : intOrNull(guests);
  const guestsValid = guestCount !== null && guestCount >= 0 && guestCount <= MAX_GUESTS;

  const submit = async (): Promise<void> => {
    if (busy || !guestsValid) return;
    setBusy(true);
    setError(null);
    const body: RsvpBody = { response, guests: guestCount ?? 0 };
    const {
      data,
      error: err,
      status,
    } = await recordPhoneRsvp(
      client,
      contactId,
      invitation.invitationId,
      body,
      keys.keyFor(`rsvp:${invitation.invitationId}:${response}:${guestCount}`),
    );
    keys.settle(status);
    setBusy(false);
    if (err || !data) {
      setError(errorMessage(err, "The RSVP could not be recorded."));
      if (isStaleWrite(status)) onRefused();
      return;
    }
    onDone(data);
  };

  return (
    <Modal
      title={`RSVP for ${invitation.serviceTitle}`}
      onClose={onClose}
      busy={busy}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || !guestsValid}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Save RSVP"}
        </button>
      }
    >
      <span style={mutedStyle}>Record the answer the family gave by phone.</span>
      <SelectField
        label="Answer"
        value={response}
        onChange={(v) => setResponse(v as RsvpBody["response"])}
        options={[
          { value: "yes", label: "Coming" },
          { value: "maybe", label: "Maybe" },
          { value: "no", label: "Not coming" },
        ]}
      />
      {response === "no" ? null : (
        <TextField
          label={`Guests coming with them (0 to ${MAX_GUESTS})`}
          type="number"
          value={guests}
          onChange={setGuests}
        />
      )}
      {!guestsValid ? (
        <ErrorText>Guests must be a whole number from 0 to {MAX_GUESTS}.</ErrorText>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
