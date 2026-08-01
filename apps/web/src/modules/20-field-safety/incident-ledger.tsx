// apps/web/src/modules/20-field-safety — §5.1 "INCIDENT LEDGER" (`/safety/incidents`, Track B/ADR-0030).
//
// The filterable register of workforce-safety incidents: category, severity, lifecycle state, and the
// OSHA-reportable filter §5.1 calls out by name.
//
// ── THE SERVER FILTERS ON TWO OF THE FOUR, AND THE SCREEN SAYS WHICH ─────────────────────────────────
//
// §4.1's `IncidentListQuery` takes `lifecycleState` and `oshaReportable` and nothing else. Category,
// severity and date are therefore PAGE-LOCAL filters — they narrow the rows already fetched, they do not
// ask the server for more, and the copy under the filter row says exactly that. Presenting a page-local
// narrowing as a search would be the worst kind of lie on a compliance ledger: a Compliance Officer who
// filters to `physical_assault`, sees three rows and concludes there were three.
//
// ── NO COUNT, EVER ──────────────────────────────────────────────────────────────────────────────────
//
// §4.1.1 forbids `total_count` because a count is an enumeration oracle. Every figure on this page is
// therefore derived from the FETCHED PAGE and labelled "on this page". A ledger that printed a total
// would be answering "how many incidents does this agency have" to a caller who cannot read them.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { type SafetyIncidentView, errorMessage, listIncidents } from "./safety-api";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  dateTime,
  incidentCategoryLabel,
  humanize,
  shortDate,
  shortId,
} from "./safety-status";
import {
  Card,
  CountGrid,
  FilterRow,
  IncidentStatePill,
  Notice,
  SelectField,
  SeverityPill,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./safety-ui";

const ANY = "";

export function IncidentLedgerScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<SafetyIncidentView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server-side (§4.1's query).
  const [lifecycleState, setLifecycleState] = useState(ANY);
  const [oshaOnly, setOshaOnly] = useState(ANY);
  // Page-local (see the module header).
  const [category, setCategory] = useState(ANY);
  const [severity, setSeverity] = useState(ANY);
  const [occurredFrom, setOccurredFrom] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listIncidents(client, {
      limit: 100,
      ...(lifecycleState ? { lifecycleState } : {}),
      ...(oshaOnly ? { oshaReportable: oshaOnly === "yes" } : {}),
    });
    if (res.error || !res.page) {
      setError(errorMessage(res.error, "The incident ledger could not be read."));
      setRows([]);
      setCursor(null);
      setHasMore(false);
    } else {
      setRows(res.page.data);
      setCursor(res.page.next_cursor);
      setHasMore(res.page.has_more);
    }
    setLoading(false);
  }, [client, lifecycleState, oshaOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  /** §4.1.1 — the cursor is opaque and HMAC-signed; it is echoed, never parsed or constructed. */
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setPaging(true);
    const res = await listIncidents(client, {
      limit: 100,
      cursor,
      ...(lifecycleState ? { lifecycleState } : {}),
      ...(oshaOnly ? { oshaReportable: oshaOnly === "yes" } : {}),
    });
    setPaging(false);
    if (res.error || !res.page) {
      setError(errorMessage(res.error, "The next page could not be read."));
      return;
    }
    setRows((prev) => [...prev, ...res.page!.data]);
    setCursor(res.page.next_cursor);
    setHasMore(res.page.has_more);
  }, [client, cursor, lifecycleState, oshaOnly]);

  const shown = useMemo(() => {
    const fromMs = occurredFrom ? Date.parse(occurredFrom) : Number.NaN;
    return rows
      .filter((r) => (category ? r.category === category : true))
      .filter((r) => (severity ? r.severity === severity : true))
      .filter((r) => (Number.isNaN(fromMs) ? true : Date.parse(r.occurredAt) >= fromMs))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [category, occurredFrom, rows, severity]);

  if (loading) return <LoadingSpinner />;
  if (error && rows.length === 0)
    return <EmptyState title="Incident ledger unavailable" description={error} />;

  const osha = shown.filter((r) => r.oshaReportable).length;
  const unsigned = shown.filter(
    (r) => r.oshaReportable && r.oshaReportableSignedOffAt === null,
  ).length;
  const open = shown.filter(
    (r) => !["closed_with_action_plan", "closed_no_action"].includes(r.lifecycleState),
  ).length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Safety incidents</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety/incidents/new" style={ghostButtonStyle}>
              Report an incident
            </Link>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
          </div>
        }
      />

      {error ? (
        <Notice tone="warning" live>
          {error} The rows below are the last page that did answer.
        </Notice>
      ) : null}

      <Card title="On this page">
        <CountGrid
          entries={[
            { label: "Incidents shown", value: shown.length },
            { label: "Still open", value: open, tone: open > 0 ? "warning" : undefined },
            { label: "OSHA-reportable", value: osha, tone: osha > 0 ? "critical" : undefined },
            {
              label: "Reportable, unsigned",
              value: unsigned,
              tone: unsigned > 0 ? "error" : undefined,
            },
          ]}
        />
        <span style={mutedStyle}>
          Every figure counts the rows <strong>on this page</strong>. §4.1.1 publishes no total, on purpose:
          a count is an enumeration oracle — it would tell a caller who cannot read an incident how many
          there are. Page through with the button below to widen what these tiles cover.
        </span>
      </Card>

      <Card title="Filters">
        <FilterRow>
          <SelectField
            label="Lifecycle state (server)"
            value={lifecycleState}
            options={[
              { value: ANY, label: "Any state" },
              ...INCIDENT_STATES.map((v) => ({ value: v, label: humanize(v) })),
            ]}
            onChange={setLifecycleState}
          />
          <SelectField
            label="OSHA-reportable (server)"
            value={oshaOnly}
            options={[
              { value: ANY, label: "Either" },
              { value: "yes", label: "Reportable only" },
              { value: "no", label: "Not reportable only" },
            ]}
            onChange={setOshaOnly}
          />
          <SelectField
            label="Category (this page)"
            value={category}
            options={[
              { value: ANY, label: "Any category" },
              ...INCIDENT_CATEGORIES.map((v) => ({ value: v, label: incidentCategoryLabel(v) })),
            ]}
            onChange={setCategory}
          />
          <SelectField
            label="Severity (this page)"
            value={severity}
            options={[
              { value: ANY, label: "Any severity" },
              ...INCIDENT_SEVERITIES.map((v) => ({ value: v, label: humanize(v) })),
            ]}
            onChange={setSeverity}
          />
          <TextField
            label="Occurred on or after (this page)"
            value={occurredFrom}
            onChange={setOccurredFrom}
            type="date"
          />
        </FilterRow>
        <span style={mutedStyle}>
          The two marked <strong>server</strong> re-query; the three marked <strong>this page</strong>{" "}
          narrow only the rows already fetched, because §4.1's list query takes no category, severity or
          date parameter. That distinction is on the labels rather than buried here: filtering to one
          category and reading the count as a total is exactly the mistake a compliance ledger must not
          invite.
        </span>
      </Card>

      <Card title="Ledger">
        {shown.length === 0 ? (
          <Notice tone="info" live>
            No incidents match. If a filter marked "this page" is set, widen it or page further — those
            filters cannot reach rows the server has not sent.
          </Notice>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Occurred</th>
                <th style={th}>Category</th>
                <th style={th}>Severity</th>
                <th style={th}>State</th>
                <th style={th}>Affected</th>
                <th style={th}>OSHA</th>
                <th style={th}>Workers' comp</th>
                <th style={th}>Incident</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} style={rowLine}>
                  <td style={td}>{dateTime(r.occurredAt)}</td>
                  <td style={td}>{incidentCategoryLabel(r.category)}</td>
                  <td style={td}>
                    <SeverityPill severity={r.severity} />
                  </td>
                  <td style={td}>
                    <IncidentStatePill state={r.lifecycleState} />
                  </td>
                  <td style={td}>
                    <span style={{ fontFamily: t.fontMono }}>
                      {shortId(r.affectedClinicianMembershipId)}
                    </span>
                    {r.affectedClinicianMembershipId !== r.reportedByMembershipId ? (
                      // §2.2.3's supervisor-opens-on-behalf-of path. Worth showing: the affected
                      // clinician must acknowledge before the row may close, and that obligation is
                      // invisible unless somebody can see the two ids differ.
                      <div style={mutedStyle}>filed on her behalf</div>
                    ) : null}
                  </td>
                  <td style={td}>
                    {r.oshaReportable ? (
                      <StatusPill
                        label={r.oshaReportableSignedOffAt ? "Reportable — signed" : "Reportable — UNSIGNED"}
                        tone={r.oshaReportableSignedOffAt ? "critical" : "error"}
                      />
                    ) : (
                      <span style={mutedStyle}>No</span>
                    )}
                  </td>
                  <td style={td}>
                    {r.workersCompClaimInitiated ? (
                      <>
                        Initiated
                        {r.workersCompClaimReference ? (
                          <div style={{ ...mutedStyle, fontFamily: t.fontMono }}>
                            {r.workersCompClaimReference}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    <Link to={`/safety/incidents/${r.id}`} style={linkStyle}>
                      {shortId(r.id)}
                    </Link>
                    <div style={mutedStyle}>reported {shortDate(r.reportedAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hasMore ? (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={paging}
            style={paging ? disabledButtonStyle : ghostButtonStyle}
          >
            {paging ? "Loading…" : "Load more"}
          </button>
        ) : (
          <span style={mutedStyle}>
            That is every row the server sent for these filters. It is not necessarily every incident in
            the agency — it is every one you may read.
          </span>
        )}
      </Card>

      <Card title="What the narratives say">
        <span style={mutedStyle}>
          No incident narrative appears on this page, deliberately: the free text rides the per-tenant
          encryption envelope and is fetched only by the detail read, which carries its own audit entry.
          A ledger that spread every clinician's account of being threatened across a browser cache would
          have made the encryption ornamental.
        </span>
      </Card>
    </div>
  );
}
