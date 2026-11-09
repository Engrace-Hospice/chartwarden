// apps/web/src/modules/16-bereavement — the MEMORIAL SERVICES list (ADR-0109 D10, route 67). The list names no family: a service, its time
// and its RSVP counts. A 403 renders nothing; any other failure is announced with a retry; a filter change or "Load more" keeps the rows.
// "New memorial service" is offered only to oversight (`bereavement.memorial.manage`); the server enforces it either way.
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
import { usePagedList } from "./mailing-load";
import { MemorialFormModal } from "./memorial-form-modal";
import {
  MEMORIAL_MANAGE_PERMISSION,
  MEMORIAL_STATUSES,
  MEMORIAL_STATUS_TONE,
  holds,
} from "./program-status";
import {
  type MemorialListItem,
  type MemorialPage,
  type MemorialStatus,
  listMemorials,
} from "./programs-api";

const PAGE_SIZE = 50;
const LOAD_FAILED = "The memorial services could not be loaded.";
const ALL = "";

export function MemorialServices(): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const mayManage = holds(session?.permissions, MEMORIAL_MANAGE_PERMISSION);
  const [status, setStatus] = useState<MemorialStatus | typeof ALL>(ALL);
  const [creating, setCreating] = useState(false);

  const fetchPage = useCallback(
    (cursor: string | null) =>
      listMemorials(client, {
        ...(status === ALL ? {} : { status }),
        ...(cursor === null ? {} : { cursor }),
        limit: PAGE_SIZE,
      }),
    [client, status],
  );
  const { state, reload, loadMore } = usePagedList<MemorialListItem, MemorialPage>(
    fetchPage,
    LOAD_FAILED,
  );

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading memorial services" />;

  const rows = state.kind === "ready" ? state.rows : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  const busy = state.kind === "ready" && state.busy;
  const hasMore = state.kind === "ready" && state.hasMore;
  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Memorial services</span>}
        actions={
          mayManage ? <Button onClick={() => setCreating(true)}>New memorial service</Button> : null
        }
      />
      <span style={mutedStyle}>
        Services of remembrance the agency holds for bereaved families. Publishing a service invites
        every eligible family.
      </span>
      <FilterRow>
        <SelectField
          label="Status"
          value={status}
          onChange={(next) => setStatus(next as MemorialStatus | typeof ALL)}
          options={[
            { value: ALL, label: "All statuses" },
            ...MEMORIAL_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
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
          title="No memorial services"
          description={
            status === ALL
              ? "A memorial service appears here once it is created."
              : "No service has this status. Choose another status."
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <table style={tableStyle} aria-label="Memorial services" aria-busy={busy}>
            <thead>
              <tr>
                <th style={th}>Service</th>
                <th style={th}>Starts</th>
                <th style={th}>Status</th>
                <th style={thNum}>Invited</th>
                <th style={thNum}>Coming</th>
                <th style={thNum}>Maybe</th>
                <th style={thNum}>Not coming</th>
                <th style={thNum}>Guests expected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.serviceId} style={rowLine}>
                  <td style={td}>
                    <Link to={`/bereavement/memorials/${s.serviceId}`} style={linkStyle}>
                      {s.title}
                    </Link>
                  </td>
                  <td style={td}>{dateTime(s.startsAt)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(s.status)}
                      tone={toneOf(MEMORIAL_STATUS_TONE, s.status)}
                    />
                  </td>
                  <td style={tdNum}>{s.invitedCount}</td>
                  <td style={tdNum}>{s.rsvpCounts.yes}</td>
                  <td style={tdNum}>{s.rsvpCounts.maybe}</td>
                  <td style={tdNum}>{s.rsvpCounts.no}</td>
                  <td style={tdNum}>{s.rsvpCounts.guestsExpected}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={mutedStyle}>{countLabel(rows.length, hasMore)} services shown</span>
            {hasMore ? (
              <Button size="sm" tone="secondary" loading={busy} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {creating ? (
        <MemorialFormModal
          service={null}
          onClose={() => setCreating(false)}
          onSaved={(saved) => navigate(`/bereavement/memorials/${saved.serviceId}`)}
        />
      ) : null}
    </div>
  );
}
