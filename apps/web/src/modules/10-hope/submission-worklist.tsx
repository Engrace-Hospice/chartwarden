import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  type ReadStatus,
  StatusPill,
  WorkQueueLayout,
  settleRead,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — HOPE submission worklist (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Work Queue."
// Submission batches per ProviderEntity, per-period: status, item/accepted/rejected counts, transmit time.
// A row drills into the submission detail (per-item outcomes + retry). Reads GET /api/v1/hope/submissions
// via the typed client; the server enforces every scope incl. PE scope (ADR-0030 — no authz on the
// frontend). Leaves only (@chartwarden/ui).
//
// The one write here is "Generate iQIES package" (#150): iQIES has no submission API (CMS HOPE FAQs Q30),
// so the workflow is manual — generate the package, download the ZIP on the batch's detail page, upload
// it in the iQIES portal, mark it uploaded. `assemble` builds that package and answers `packaged`. Retry
// is still absent: it requeues into a stage that cannot reach iQIES. The server enforces
// `hope.submission.manage`; the button is hidden without it so a reader is not offered a 403.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import { assembleSubmission } from "./hope-api";
import { HopeListReadState } from "./hope-read-state";
import { SUBMISSION_TONE, stateLabel } from "./hope-status";

const MANAGE_PERMISSION = "hope.submission.manage";
const PROVIDER_ENTITY_PAGE_SIZE = 100;

interface ProviderEntityOption {
  id: string;
  legalName: string;
  ccn?: string | null;
}

interface SubmissionRow {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: string | null;
}

export function SubmissionWorklist(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<SubmissionRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [period, setPeriod] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readStatus, setReadStatus] = useState<ReadStatus>("ok");
  const canGenerate = useSession()?.permissions?.includes(MANAGE_PERMISSION) ?? false;
  const [providerEntities, setProviderEntities] = useState<ProviderEntityOption[]>([]);
  const [providerEntityId, setProviderEntityId] = useState("");
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!canGenerate) return;
    let cancelled = false;
    void client
      .GET("/api/v1/provider-entities", { params: { query: { limit: PROVIDER_ENTITY_PAGE_SIZE } } })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) {
          setError("Could not load provider entities, so a package cannot be generated.");
          return;
        }
        const options = (data?.items ?? []) as ProviderEntityOption[];
        setProviderEntities(options);
        setProviderEntityId((current) => current || (options[0]?.id ?? ""));
      });
    return () => {
      cancelled = true;
    };
  }, [canGenerate, client]);

  // Synchronous guard: `disabled={generating}` only takes effect after the next render, so a fast second click
  // (or a key-repeat) could otherwise start a second batch.
  const generatingRef = useRef(false);
  const generatePackage = async (): Promise<void> => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
    setError(null);
    try {
      const result = await assembleSubmission(client, providerEntityId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      navigate(`/hope/submissions/${encodeURIComponent(result.value.id)}`);
    } catch {
      setError("Could not generate the iQIES package. Check your connection and try again.");
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  };

  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    setLoading(true);
    setReadStatus("ok");
    const { status: readOutcome, res } = await settleRead(
      client.GET("/api/v1/hope/submissions", { params: { query: {} } }),
      "denied",
    );
    if (mine !== latestLoad.current) return;
    setReadStatus(readOutcome);
    setItems(readOutcome === "ok" ? ((res?.data?.submissions ?? []) as SubmissionRow[]) : []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const periodOptions = useMemo(
    () => [...new Set(items.map((s) => s.submissionPeriod).filter(Boolean))].sort().reverse(),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((s) => {
      const matchesStatus = !status || s.status === status;
      const matchesPeriod = !period || s.submissionPeriod === period;
      const matchesSearch =
        !q ||
        s.id.toLowerCase().includes(q) ||
        s.providerEntityId.toLowerCase().includes(q) ||
        s.submissionPeriod.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q);
      return matchesStatus && matchesPeriod && matchesSearch;
    });
    return [...visible].sort((a, b) => submissionSortMs(b) - submissionSortMs(a));
  }, [items, period, searchQuery, status]);

  const activeFilters = [searchQuery.trim() !== "", status !== "", period !== ""].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setPeriod("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="HOPE Submissions" breadcrumb="Clinical / HOPE">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor CMS submission batches by period, provider entity, and outcome status.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <div style={pipelineNoticeStyle}>
            iQIES has no submission API. <strong>Generate an iQIES package</strong>, download its
            ZIP from the batch page, upload it in the iQIES portal, then mark it uploaded.
          </div>
          {canGenerate ? (
            <div style={controlGroupStyle}>
              {providerEntities.length > 1 ? (
                <label className="wx-filter-field">
                  <span>Provider entity</span>
                  <select
                    className="wx-select"
                    aria-label="Provider entity"
                    value={providerEntityId}
                    onChange={(e) => setProviderEntityId(e.target.value)}
                    style={selectStyle}
                  >
                    {providerEntities.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.ccn ? `${p.legalName} (${p.ccn})` : p.legalName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Button
                size="sm"
                onClick={() => void generatePackage()}
                disabled={!providerEntityId || generating}
              >
                {generating ? "Generating…" : "Generate iQIES package"}
              </Button>
            </div>
          ) : null}
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Queue</span>
              <strong>
                {readStatus === "ok"
                  ? `${rows.length} matching submissions`
                  : "Submissions unavailable"}
              </strong>
            </div>
            <div style={controlGroupStyle}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search submission, provider, period..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search HOPE submissions"
                />
              </label>
              <label className="wx-filter-field">
                <span>Status</span>
                <select
                  className="wx-select"
                  aria-label="Submission status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">All</option>
                  <option value="queued">Queued</option>
                  <option value="in_flight">In flight</option>
                  <option value="accepted">Accepted</option>
                  <option value="partially_accepted">Partially accepted</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
              <label className="wx-filter-field">
                <span>Period</span>
                <select
                  className="wx-select"
                  aria-label="Submission period"
                  value={period}
                  onChange={(e) => {
                    setPeriod(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">All</option>
                  {periodOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        readStatus !== "ok" ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <HopeListReadState
              status={readStatus}
              subject="the agency-wide HOPE submissions"
              failedTitle="HOPE submissions could not be loaded"
              onRetry={() => void load()}
            />
          </div>
        ) : loading && items.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching submissions" : "No submissions"}
              description={
                activeFilters > 0
                  ? "Try adjusting the submission filters."
                  : "No HOPE submission batches have been assembled."
              }
              action={
                activeFilters > 0 ? (
                  <Button size="sm" tone="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "28%" }}>Submission</th>
                  <th style={{ ...thStyle, width: "20%" }}>Provider entity</th>
                  <th style={{ ...thStyle, width: "14%" }}>Period</th>
                  <th style={{ ...thStyle, width: "12%" }}>Status</th>
                  <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Items</th>
                  <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Accepted</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Rejected</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((s) => (
                  <tr
                    key={s.id}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/hope/submissions/${s.id}`)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        navigate(`/hope/submissions/${s.id}`);
                      }
                    }}
                    style={rowStyle}
                    className="wx-data-row-interactive"
                  >
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>HOPE submission</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(s.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(s.providerEntityId)}
                      </code>
                    </td>
                    <td style={tdStyle}>{s.submissionPeriod}</td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(s.status)}
                        tone={SUBMISSION_TONE[s.status] ?? "neutral"}
                      />
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    >
                      {s.itemCount}
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    >
                      {s.acceptedCount}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        color: s.rejectedCount > 0 ? "var(--color-error)" : undefined,
                      }}
                    >
                      {s.rejectedCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={rows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={HOPE_PAGE_SIZES}
              noun="submissions"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const pipelineNoticeStyle = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-variant)",
  borderRadius: "0.375rem",
  padding: "0.5rem 0.625rem",
  marginBottom: "0.5rem",
} as const;

const HOPE_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function submissionSortMs(row: SubmissionRow): number {
  if (row.transmittedAt) {
    const transmitted = Date.parse(row.transmittedAt);
    if (!Number.isNaN(transmitted)) return transmitted;
  }
  const period = Date.parse(row.submissionPeriod);
  return Number.isNaN(period) ? 0 : period;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};

const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "color-mix(in srgb, var(--color-error) 60%, var(--color-on-surface))",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const dismissButtonStyle = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};

const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
};

const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
  cursor: "pointer",
  transition: "background 0.15s ease",
};

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};

const primaryTextStyle = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const codeStyle = {
  display: "inline-block",
  maxWidth: "13rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
