// apps/web/src/modules/16-bereavement — ONE SUPPORT GROUP (ADR-0109 D10, routes 55-66).
//
// The group's details, its sessions, its roster and attendance. `bereavement.group.manage` edits the group, opens a draft to families and
// closes it (completed, or cancelled); every state change carries the group version the page READ in `If-Match` and one `Idempotency-Key`
// per attempt. A 409/404 closes any open dialog, reloads the group and says why. The roster (it names families) is read only with
// `bereavement.group.run`. A 403 on the group renders nothing; any other failure is announced and never unmounts what is on screen.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
  useAttemptKey,
} from "@chartwarden/ui";
import { useCallback, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { errorMessage, isStaleVersion, isStaleWrite } from "./bereavement-api";
import { dateTime, humanize, shortDate, toneOf } from "./bereavement-status";
import {
  Card,
  ErrorText,
  Field,
  Modal,
  SummaryGrid,
  columnStyle,
  dangerButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  useActionStatus,
} from "./bereavement-ui";
import { GroupFormModal } from "./group-form-modal";
import { GroupRosterCard, useGroupRoster } from "./group-roster";
import { GroupSessions } from "./group-sessions";
import { useLoaded } from "./mailing-load";
import {
  GROUP_MANAGE_PERMISSION,
  GROUP_RUN_PERMISSION,
  GROUP_STATUS_TONE,
  canEditGroup,
  holds,
} from "./program-status";
import { type Group, closeGroup, getGroup, openGroup } from "./programs-api";

const GROUP_LOAD_FAILED = "The support group could not be loaded.";
const GROUP_MOVED =
  "This group changed while you were working on it. The page has been refreshed: check it and try again.";

type Ceremony = "edit" | "complete" | "cancel" | null;
type Action = "open" | "complete" | "cancel";

export function SupportGroupDetail(): JSX.Element | null {
  const { groupId } = useParams<{ groupId: string }>();
  // Keyed by group: a route-param change remounts, so one group's page is never shown under another's id.
  return <GroupPage key={groupId ?? "none"} groupId={groupId ?? ""} />;
}

function GroupPage({ groupId }: { groupId: string }): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const mayManage = holds(session?.permissions, GROUP_MANAGE_PERMISSION);
  const mayRun = holds(session?.permissions, GROUP_RUN_PERMISSION);
  const fetchGroup = useCallback(() => getGroup(client, groupId), [client, groupId]);
  const { state, reload, adopt } = useLoaded<Group>(fetchGroup, GROUP_LOAD_FAILED);
  const roster = useGroupRoster(groupId, mayRun);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const keys = useAttemptKey();
  const { announce, region } = useActionStatus();
  const closeDescId = useId();
  /** Bumped after a group write: the sessions re-read (an open or a close schedules or cancels them). */
  const [sessionsToken, setSessionsToken] = useState(0);
  const refreshParts = (): void => {
    setSessionsToken((n) => n + 1);
    void roster.reload();
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the support group" />;
  if (state.kind === "error") {
    return state.status === 404 ? (
      <EmptyState title="Not found" description="This support group does not exist." />
    ) : (
      <div className="wx-kit-column" style={columnStyle}>
        <ErrorText>{state.message}</ErrorText>
        <div>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const group = state.data;
  const openCeremony = (next: Ceremony): void => {
    setActionError(null);
    setCeremony(next);
  };
  const write = async (
    name: Action,
    call: (key: string) => Promise<{ data: Group | null; error: unknown; status: number }>,
    fallback: string,
    success: string,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(name);
    setActionError(null);
    const res = await call(keys.keyFor(`${name}:${group.version}`));
    keys.settle(res.status, res.error);
    inFlight.current = false;
    setBusy(null);
    if (res.error || !res.data) {
      const message = isStaleVersion(res.status, res.error)
        ? GROUP_MOVED
        : errorMessage(res.error, fallback);
      if (isStaleWrite(res.status)) {
        void reload();
        refreshParts();
        if (ceremony !== null) {
          setCeremony(null);
          announce(message);
          return;
        }
      }
      setActionError(message);
      return;
    }
    adopt(res.data);
    void reload(); // a write answers without the join link: the detail read carries it
    refreshParts();
    setCeremony(null);
    announce(success);
  };

  const offers = {
    edit: mayManage && canEditGroup(group.status),
    open: mayManage && group.status === "draft",
    close: mayManage && group.status === "open",
    cancel: mayManage && canEditGroup(group.status),
  };
  const recurrence = group.recurrence;
  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{group.name}</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill
              label={humanize(group.status)}
              tone={toneOf(GROUP_STATUS_TONE, group.status)}
            />
            <Link to="/bereavement/groups" style={ghostButtonStyle}>
              All groups
            </Link>
          </div>
        }
      />
      {region}
      {state.notice ? (
        <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{state.notice}</ErrorText>
          <Button
            size="sm"
            tone="secondary"
            loading={state.refreshing}
            onClick={() => void reload()}
          >
            Try again
          </Button>
        </div>
      ) : null}

      <Card title="Details">
        {group.description ? <span>{group.description}</span> : null}
        <SummaryGrid>
          <Field label="Format" value={humanize(group.format)} />
          <Field label="Modality" value={humanize(group.modality)} />
          <Field label="Enrollment required" value={group.enrollmentRequired ? "Yes" : "No"} />
          <Field label="Facilitator" value={humanize(group.facilitatorKind)} />
          <Field
            label="Enrolled"
            value={
              group.capacity === null
                ? group.enrolledCount
                : `${group.enrolledCount} / ${group.capacity}`
            }
          />
          <Field label="Time zone" value={group.timezone} />
          <Field label="Venue" value={group.venueText ?? "—"} />
          <Field label="Join link" value={group.hasJoinUrl ? "Set" : "None"} />
          <Field label="Next session" value={dateTime(group.nextSessionAt)} />
          {recurrence ? (
            <Field
              label="Schedule"
              value={`From ${shortDate(recurrence.firstDate)} at ${recurrence.startTime}, every ${
                recurrence.intervalWeeks === 1 ? "week" : `${recurrence.intervalWeeks} weeks`
              }, ${recurrence.count} sessions of ${recurrence.durationMinutes} minutes`}
            />
          ) : null}
        </SummaryGrid>
      </Card>

      {mayManage ? (
        <Card title="Actions">
          {!Object.values(offers).some(Boolean) ? (
            <span style={mutedStyle}>No actions are available for this group.</span>
          ) : (
            <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
              {offers.edit ? (
                <Button
                  tone="secondary"
                  disabled={busy !== null}
                  onClick={() => openCeremony("edit")}
                >
                  Edit group
                </Button>
              ) : null}
              {offers.open ? (
                <Button
                  loading={busy === "open"}
                  disabled={busy !== null}
                  onClick={() =>
                    void write(
                      "open",
                      (key) => openGroup(client, group.groupId, group.version, key),
                      "The group could not be opened.",
                      "The group is open to families.",
                    )
                  }
                >
                  Open to families
                </Button>
              ) : null}
              {offers.close ? (
                <Button
                  tone="secondary"
                  disabled={busy !== null}
                  onClick={() => openCeremony("complete")}
                >
                  Mark completed
                </Button>
              ) : null}
              {offers.cancel ? (
                <Button
                  tone="secondary"
                  disabled={busy !== null}
                  onClick={() => openCeremony("cancel")}
                >
                  Cancel group
                </Button>
              ) : null}
            </div>
          )}
          {actionError && ceremony === null ? <ErrorText>{actionError}</ErrorText> : null}
        </Card>
      ) : null}

      <GroupSessions
        group={group}
        mayManage={mayManage}
        mayRun={mayRun}
        roster={roster.state}
        announce={announce}
        refreshToken={sessionsToken}
        onSessionsChanged={() => void reload()}
        onAttendanceRecorded={() => void roster.reload()}
      />
      <GroupRosterCard state={roster.state} onRetry={() => void roster.reload()} />

      {ceremony === "edit" ? (
        <GroupFormModal
          group={group}
          onClose={() => setCeremony(null)}
          onStale={(message) => {
            setCeremony(null);
            announce(message);
            void reload();
            refreshParts();
          }}
          onSaved={(next) => {
            adopt(next);
            void reload(); // the PATCH answers without the join link: the detail read carries it
            refreshParts();
            setCeremony(null);
            announce("The group was saved.");
          }}
        />
      ) : null}
      {ceremony === "complete" || ceremony === "cancel" ? (
        <Modal
          title={ceremony === "complete" ? "Mark this group completed" : "Cancel this group"}
          onClose={() => setCeremony(null)}
          busy={busy !== null}
          role="alertdialog"
          describedBy={closeDescId}
          cancelLabel="Keep group"
          footer={
            <button
              type="button"
              style={ceremony === "cancel" ? dangerButtonStyle : primaryButtonStyle}
              disabled={busy !== null}
              onClick={() =>
                void write(
                  ceremony,
                  (key) =>
                    closeGroup(
                      client,
                      group.groupId,
                      group.version,
                      ceremony === "complete" ? "completed" : "cancelled",
                      key,
                    ),
                  "The group could not be closed.",
                  ceremony === "complete"
                    ? "The group was marked completed."
                    : "The group was cancelled.",
                )
              }
            >
              {busy
                ? "Saving…"
                : ceremony === "complete"
                  ? "Mark completed"
                  : "Yes, cancel this group"}
            </button>
          }
        >
          <span id={closeDescId} style={mutedStyle}>
            {ceremony === "complete"
              ? "The group has finished. Its future scheduled sessions are cancelled and every enrolled family is withdrawn (the group ended). It cannot be reopened."
              : "The group will not run. Its future scheduled sessions are cancelled and every enrolled family is withdrawn. It cannot be reopened."}
          </span>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
    </div>
  );
}
