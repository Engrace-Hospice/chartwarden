// apps/web/src/modules/16-bereavement — the MAILING RUNS list (ADR-0109 D10, route 44). Oversight only.
//
// A run is one mailing's batch of letters for one date: the sweep drafts it ahead of the date, staff write or check the wording, generate
// the batch, print and mail it, then confirm it was mailed. This list is where staff find the runs that need them: filter by status,
// see how many families are in each, open one.
//
// A reader the server refuses (403: a session whose permission list is stale) sees NOTHING here: no heading, no empty state, no hint
// that mailings exist. Any other failure is said (and announced) with a retry. A filter change or "Load more" keeps the rows on screen.
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
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import { type MailingRun, type MailingRunStatus, listMailingRuns } from "./bereavement-api";
import { countLabel, humanize, shortDate, toneOf } from "./bereavement-status";
import {
  ErrorText,
  FilterRow,
  SelectField,
  columnStyle,
  ghostButtonStyle,
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
import {
  MAILING_MANAGE_PERMISSION,
  RUN_STATUSES,
  RUN_STATUS_TONE,
  mailingLabel,
} from "./mailing-status";

const RUN_PAGE_SIZE = 50;
const RUNS_LOAD_FAILED = "The mailing runs could not be loaded.";
const ALL_STATUSES = "";

export function MailingRuns(): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const mayManage = session?.permissions?.includes(MAILING_MANAGE_PERMISSION) ?? false;
  const [status, setStatus] = useState<MailingRunStatus | typeof ALL_STATUSES>(ALL_STATUSES);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const {
        page,
        error,
        status: http,
      } = await listMailingRuns(client, {
        ...(status === ALL_STATUSES ? {} : { status }),
        ...(cursor === null ? {} : { cursor }),
        limit: RUN_PAGE_SIZE,
      });
      return { data: page, error, status: http };
    },
    [client, status],
  );
  const { state, reload, loadMore } = usePagedList<MailingRun>(fetchPage, RUNS_LOAD_FAILED);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading mailing runs" />;

  const rows = state.kind === "ready" ? state.rows : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  const busy = state.kind === "ready" && state.busy;
  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Mailing runs</span>}
        actions={
          mayManage ? (
            <Link to="/bereavement/mailings/settings" style={ghostButtonStyle}>
              Mailing settings
            </Link>
          ) : null
        }
      />
      <span style={mutedStyle}>
        Each run is one mailing's batch of letters for one date. Open a run to write its wording,
        generate the batch, and confirm it was mailed.
      </span>
      <FilterRow>
        <SelectField
          label="Status"
          value={status}
          onChange={(next) => setStatus(next as MailingRunStatus | typeof ALL_STATUSES)}
          options={[
            { value: ALL_STATUSES, label: "All statuses" },
            ...RUN_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
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
          title="No mailing runs"
          description={
            status === ALL_STATUSES
              ? "A run appears here when an enabled mailing comes within its lead time."
              : "No run has this status. Choose another status."
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <table style={tableStyle} aria-label="Mailing runs" aria-busy={busy}>
            <thead>
              <tr>
                <th style={th}>Mailing</th>
                <th style={th}>For</th>
                <th style={th}>Status</th>
                <th style={thNum}>In the batch</th>
                <th style={thNum}>Left out</th>
                <th style={thNum}>Logged as mailed</th>
                <th style={thNum}>Left out after printing</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.runId} style={rowLine}>
                  <td style={td}>
                    <Link
                      to={`/bereavement/mailings/runs/${run.runId}`}
                      style={linkStyle}
                      aria-label={`Open the ${mailingLabel(run.mailingKey)} run for ${run.scheduledFor}`}
                    >
                      {mailingLabel(run.mailingKey)}
                    </Link>
                  </td>
                  <td style={td}>{shortDate(run.scheduledFor)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(run.status)}
                      tone={toneOf(RUN_STATUS_TONE, run.status)}
                    />
                  </td>
                  <td style={tdNum}>{run.itemCounts.included}</td>
                  <td style={tdNum}>{run.itemCounts.excluded}</td>
                  <td style={tdNum}>{run.itemCounts.logged}</td>
                  <td style={tdNum}>{run.itemCounts.excludedAfterRender}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={mutedStyle}>
              {countLabel(rows.length, state.kind === "ready" && state.hasMore)} runs shown
            </span>
            {state.kind === "ready" && state.hasMore ? (
              <Button size="sm" tone="secondary" loading={busy} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
