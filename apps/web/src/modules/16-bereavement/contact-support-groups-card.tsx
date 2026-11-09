// apps/web/src/modules/16-bereavement — the SUPPORT GROUPS panel of the contact detail (ADR-0109 D10, routes 53, 63, 64 and 66).
//
// Which groups is this family in, and sign them up for (or take them out of) one. The panel exists only for a reader who holds
// `bereavement.group.enroll` (the family's counselor or oversight): without it nothing is requested and nothing renders, and a 403 from the
// server renders nothing either. Enrolling picks from the OPEN groups; a withdrawal records why (the family asked, or staff removed them).
// Every write carries one Idempotency-Key per attempt; a stale refusal (409: full, closed, already enrolled or withdrawn) closes the dialog,
// is said in the panel and the list is read again; any other failure is said in the dialog, which stays open.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useId, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import { errorMessage, isStaleWrite } from "./bereavement-api";
import { humanize, shortDate, toneOf } from "./bereavement-status";
import {
  Card,
  ErrorText,
  Modal,
  SelectField,
  dangerButtonStyle,
  linkStyle,
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
import { GROUP_ENROLL_PERMISSION, GROUP_STATUS_TONE, holds } from "./program-status";
import {
  type Enrollment,
  type GroupListItem,
  type WithdrawReason,
  enrollContact,
  listContactEnrollments,
  listGroups,
  withdrawEnrollment,
} from "./programs-api";

const LOAD_FAILED = "This family's support groups could not be loaded.";
const OPEN_GROUPS_LIMIT = 100;

export function ContactSupportGroupsCard({ contactId }: { contactId: string }): JSX.Element | null {
  const session = useSession();
  if (!holds(session?.permissions, GROUP_ENROLL_PERMISSION)) return null;
  return <SupportGroupsPanel contactId={contactId} />;
}

function SupportGroupsPanel({ contactId }: { contactId: string }): JSX.Element | null {
  const client = useApiClient();
  const fetcher = useCallback(() => listContactEnrollments(client, contactId), [client, contactId]);
  const { state, reload } = useLoaded<Enrollment[]>(fetcher, LOAD_FAILED);
  const { announce, region } = useActionStatus();
  const [enrolling, setEnrolling] = useState(false);
  const [withdrawing, setWithdrawing] = useState<Enrollment | null>(null);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading support groups" />;
  const rows = state.kind === "ready" ? state.data : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  const enrolledIds = new Set(rows.filter((r) => r.status === "enrolled").map((r) => r.groupId));
  return (
    <Card
      title="Support groups"
      actions={
        <Button size="sm" tone="secondary" onClick={() => setEnrolling(true)}>
          Enroll in a group
        </Button>
      }
    >
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
        <span style={mutedStyle}>This family is not in any support group.</span>
      ) : null}
      {rows.length > 0 ? (
        <table style={tableStyle} aria-label="Support group enrollments">
          <thead>
            <tr>
              <th style={th}>Group</th>
              <th style={th}>Group status</th>
              <th style={th}>Enrollment</th>
              <th style={th}>Since</th>
              <th style={th}>
                <span style={visuallyHidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.enrollmentId} style={rowLine}>
                <td style={td}>
                  <Link to={`/bereavement/groups/${row.groupId}`} style={linkStyle}>
                    {row.groupName}
                  </Link>
                </td>
                <td style={td}>
                  <StatusPill
                    label={humanize(row.groupStatus)}
                    tone={toneOf(GROUP_STATUS_TONE, row.groupStatus)}
                  />
                </td>
                <td style={td}>
                  {row.status === "enrolled"
                    ? "Enrolled"
                    : `Withdrawn (${humanize(row.withdrawnReason)})`}
                </td>
                <td style={td}>{shortDate(row.withdrawnAt ?? row.enrolledAt)}</td>
                <td style={td}>
                  {row.status === "enrolled" ? (
                    <Button size="sm" tone="secondary" onClick={() => setWithdrawing(row)}>
                      Withdraw
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {enrolling ? (
        <EnrollModal
          contactId={contactId}
          exclude={enrolledIds}
          onClose={() => setEnrolling(false)}
          onRefused={(message) => {
            setEnrolling(false);
            announce(message);
            void reload();
          }}
          onDone={(row) => {
            setEnrolling(false);
            announce(`Enrolled in ${row.groupName}.`);
            void reload();
          }}
        />
      ) : null}
      {withdrawing ? (
        <WithdrawModal
          enrollment={withdrawing}
          onClose={() => setWithdrawing(null)}
          onRefused={(message) => {
            setWithdrawing(null);
            announce(message);
            void reload();
          }}
          onDone={(row) => {
            setWithdrawing(null);
            announce(`Withdrawn from ${row.groupName}.`);
            void reload();
          }}
        />
      ) : null}
    </Card>
  );
}

function EnrollModal({
  contactId,
  exclude,
  onClose,
  onRefused,
  onDone,
}: {
  contactId: string;
  exclude: ReadonlySet<string>;
  onClose: () => void;
  /** The server refused (409: full, closed, already enrolled): the panel closes the dialog, says why and re-reads the list. */
  onRefused: (message: string) => void;
  onDone: (row: Enrollment) => void;
}): JSX.Element {
  const client = useApiClient();
  const fetcher = useCallback(async () => {
    const res = await listGroups(client, { status: "open", limit: OPEN_GROUPS_LIMIT });
    return { ...res, data: res.data ? res.data.data : null };
  }, [client]);
  const { state } = useLoaded<GroupListItem[]>(fetcher, "The open groups could not be loaded.");
  const keys = useIdempotencyKey();
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = state.kind === "ready" ? state.data.filter((g) => !exclude.has(g.groupId)) : [];
  const chosen = groupId || groups[0]?.groupId || "";

  const submit = async (): Promise<void> => {
    if (busy || !chosen) return;
    setBusy(true);
    setError(null);
    const {
      data,
      error: err,
      status,
    } = await enrollContact(client, chosen, contactId, keys.keyFor(`enroll:${chosen}`));
    keys.settle(status);
    setBusy(false);
    if (err || !data) {
      const message = errorMessage(err, "The family could not be enrolled.");
      if (isStaleWrite(status)) onRefused(message);
      else setError(message);
      return;
    }
    onDone(data);
  };

  return (
    <Modal
      title="Enroll in a support group"
      onClose={onClose}
      busy={busy}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || !chosen}
          onClick={() => void submit()}
        >
          {busy ? "Enrolling…" : "Enroll"}
        </button>
      }
    >
      {state.kind === "loading" ? <LoadingSpinner label="Loading open groups" /> : null}
      {state.kind === "error" ? <ErrorText>{state.message}</ErrorText> : null}
      {state.kind === "hidden" ? (
        <span style={mutedStyle}>You cannot see the support groups.</span>
      ) : null}
      {state.kind === "ready" && groups.length === 0 ? (
        <span style={mutedStyle}>No open group is available for this family.</span>
      ) : null}
      {groups.length > 0 ? (
        <SelectField
          label="Group"
          value={chosen}
          onChange={setGroupId}
          options={groups.map((g) => ({ value: g.groupId, label: g.name }))}
        />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

function WithdrawModal({
  enrollment,
  onClose,
  onRefused,
  onDone,
}: {
  enrollment: Enrollment;
  onClose: () => void;
  /** The server refused (409: already withdrawn, the group closed): the panel closes the dialog, says why and re-reads the list. */
  onRefused: (message: string) => void;
  onDone: (row: Enrollment) => void;
}): JSX.Element {
  const client = useApiClient();
  const descId = useId();
  const keys = useIdempotencyKey();
  const [reason, setReason] = useState<WithdrawReason>("requested");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const {
      data,
      error: err,
      status,
    } = await withdrawEnrollment(
      client,
      enrollment.groupId,
      enrollment.contactId,
      reason,
      keys.keyFor(`withdraw:${enrollment.enrollmentId}:${reason}`),
    );
    keys.settle(status);
    setBusy(false);
    if (err || !data) {
      const message = errorMessage(err, "The family could not be withdrawn.");
      if (isStaleWrite(status)) onRefused(message);
      else setError(message);
      return;
    }
    onDone(data);
  };

  return (
    <Modal
      title={`Withdraw from ${enrollment.groupName}`}
      onClose={onClose}
      busy={busy}
      role="alertdialog"
      describedBy={descId}
      cancelLabel="Keep enrolled"
      footer={
        <button
          type="button"
          style={dangerButtonStyle}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Withdrawing…" : "Withdraw"}
        </button>
      }
    >
      <span id={descId} style={mutedStyle}>
        The family leaves {enrollment.groupName} and is no longer on its roster. Choose why below.
      </span>
      <SelectField
        label="Reason"
        value={reason}
        onChange={(v) => setReason(v as WithdrawReason)}
        options={[
          { value: "requested", label: "The family asked to leave" },
          { value: "staff_removed", label: "Removed by staff" },
        ]}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
