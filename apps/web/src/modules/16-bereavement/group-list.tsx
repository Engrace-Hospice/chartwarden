// apps/web/src/modules/16-bereavement — the SUPPORT GROUPS list (ADR-0109 D10, routes 53-54).
//
// The agency's grief support groups, newest first: filter by status, see how many families are enrolled and when the next session is, open
// one. Oversight creates a draft group here ("New group"); the group page opens it to families. No family is named on this list.
// A 403 renders nothing; any other failure is announced with a retry and never blanks rows already shown.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import { countLabel, dateTime, humanize, toneOf } from "./bereavement-status";
import {
  ErrorText,
  FilterRow,
  SelectField,
  columnStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./bereavement-ui";
import { GroupFormModal } from "./group-form-modal";
import { usePagedList } from "./mailing-load";
import {
  GROUP_MANAGE_PERMISSION,
  GROUP_STATUSES,
  GROUP_STATUS_TONE,
  holds,
} from "./program-status";
import { type GroupListItem, type GroupStatus, listGroups } from "./programs-api";

const GROUP_PAGE_SIZE = 50;
const GROUPS_LOAD_FAILED = "The support groups could not be loaded.";
const ALL_STATUSES = "";

export function SupportGroups(): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const mayManage = holds(session?.permissions, GROUP_MANAGE_PERMISSION);
  const [status, setStatus] = useState<GroupStatus | typeof ALL_STATUSES>(ALL_STATUSES);
  const [creating, setCreating] = useState(false);

  const fetchPage = useCallback(
    async (cursor: string | null) =>
      listGroups(client, {
        ...(status === ALL_STATUSES ? {} : { status }),
        ...(cursor === null ? {} : { cursor }),
        limit: GROUP_PAGE_SIZE,
      }),
    [client, status],
  );
  const { state, reload, loadMore } = usePagedList<GroupListItem>(fetchPage, GROUPS_LOAD_FAILED);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading support groups" />;

  const rows = state.kind === "ready" ? state.rows : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  const busy = state.kind === "ready" && state.busy;
  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Support groups</span>}
        actions={mayManage ? <Button onClick={() => setCreating(true)}>New group</Button> : null}
      />
      <span style={mutedStyle}>
        Grief support groups the agency runs for bereaved families. Open a group to manage its
        sessions, its roster and attendance.
      </span>
      <FilterRow>
        <SelectField
          label="Status"
          value={status}
          onChange={(next) => setStatus(next as GroupStatus | typeof ALL_STATUSES)}
          options={[
            { value: ALL_STATUSES, label: "All statuses" },
            ...GROUP_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
          ]}
        />
      </FilterRow>
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" loading={busy} onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <EmptyState
          title="No support groups"
          description={
            status === ALL_STATUSES
              ? "No support group has been set up yet."
              : "No group has this status. Choose another status."
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <table style={tableStyle} aria-label="Support groups" aria-busy={busy}>
            <thead>
              <tr>
                <th style={th}>Group</th>
                <th style={th}>Status</th>
                <th style={th}>Format</th>
                <th style={th}>Modality</th>
                <th style={thNum}>Enrolled</th>
                <th style={th}>Next session</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((group) => (
                <tr key={group.groupId} style={rowLine}>
                  <td style={td}>
                    <Link to={`/bereavement/groups/${group.groupId}`} style={linkStyle}>
                      {group.name}
                    </Link>
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(group.status)}
                      tone={toneOf(GROUP_STATUS_TONE, group.status)}
                    />
                  </td>
                  <td style={td}>{humanize(group.format)}</td>
                  <td style={td}>{humanize(group.modality)}</td>
                  <td style={tdNum}>
                    {group.capacity === null
                      ? group.enrolledCount
                      : `${group.enrolledCount} / ${group.capacity}`}
                  </td>
                  <td style={td}>{dateTime(group.nextSessionAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={mutedStyle}>
              {countLabel(rows.length, state.kind === "ready" && state.hasMore)} groups shown
            </span>
            {state.kind === "ready" && state.hasMore ? (
              <Button size="sm" tone="secondary" loading={busy} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {creating ? (
        <GroupFormModal
          group={null}
          onClose={() => setCreating(false)}
          onSaved={(group) => navigate(`/bereavement/groups/${group.groupId}`)}
        />
      ) : null}
    </div>
  );
}
