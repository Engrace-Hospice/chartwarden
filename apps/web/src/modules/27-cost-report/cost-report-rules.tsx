import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/27-cost-report — the VALIDATION RULE LIBRARY (R2, §5 / §11.B / D21). The platform-
// default + tenant-extension rule catalog (org-NULL platform floor a tenant layers tightenings onto). A
// collection surface (`/cost-report-validation-rules`); read-only — the server is the only authz point.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { cellStyle, headStyle, rowStyle, tableStyle } from "./cost-report-shared";
import { SEVERITY_TONE, humanize, toneOf } from "./cost-report-status";

interface RuleRow {
  ruleId: string;
  organizationId: string | null;
  ruleCode: string;
  category: string;
  description: string;
  regulatoryRequired: boolean;
  severity: string;
  status: string;
  macJurisdictionScope: string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CostReportRules(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [requiredFilter, setRequiredFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cost-report-validation-rules");
    if (res.error) {
      setError("The validation rule library could not be loaded.");
      setLoading(false);
      return;
    }
    const d = res.data as unknown as { items?: RuleRow[] };
    setRows(d.items ?? (res.data as unknown as RuleRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const platform = rows.filter((r) => r.organizationId === null).length;
    const required = rows.filter((r) => r.regulatoryRequired).length;
    return { platform, tenant: rows.length - platform, required };
  }, [rows]);

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "Any category" },
      ...Array.from(new Set(rows.map((r) => r.category)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [rows],
  );
  const severityOptions = useMemo(
    () => [
      { value: "", label: "Any severity" },
      ...Array.from(new Set(rows.map((r) => r.severity)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows
      .filter((r) => {
        const source = r.organizationId === null ? "platform" : "tenant";
        const matchesCategory = !categoryFilter || r.category === categoryFilter;
        const matchesSeverity = !severityFilter || r.severity === severityFilter;
        const matchesSource = !sourceFilter || source === sourceFilter;
        const matchesRequired =
          !requiredFilter ||
          (requiredFilter === "required" ? r.regulatoryRequired : !r.regulatoryRequired);
        const matchesSearch =
          !q ||
          [
            r.ruleId,
            r.ruleCode,
            r.category,
            r.description,
            r.severity,
            r.status,
            r.macJurisdictionScope,
            source,
          ].some((value) => value.toLowerCase().includes(q));
        return (
          matchesCategory && matchesSeverity && matchesSource && matchesRequired && matchesSearch
        );
      })
      .sort((a, b) => a.ruleCode.localeCompare(b.ruleCode));
  }, [categoryFilter, requiredFilter, rows, searchQuery, severityFilter, sourceFilter]);

  const activeCount = rows.filter((r) => r.status === "active").length;
  const blockSeverityCount = rows.filter((r) => r.severity === "block").length;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters =
    categoryFilter !== "" ||
    severityFilter !== "" ||
    sourceFilter !== "" ||
    requiredFilter !== "" ||
    searchQuery !== "";

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader
          title="Validation Rules"
          breadcrumb="Revenue Cycle — pre-submission rule library (§11.B)"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Browse platform defaults and tenant extensions by rule code, category, severity, MAC
            scope, and regulatory requirement.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Rules"
            value={loading || error ? "—" : rows.length}
            detail="Catalog entries"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Platform"
            value={loading || error ? "—" : stats.platform}
            detail="Default floor"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            selected={sourceFilter === "platform"}
            onSelect={() => {
              setSourceFilter("platform");
              setPage(1);
            }}
          />
          <KpiCard
            label="Tenant"
            value={loading || error ? "—" : stats.tenant}
            detail="Org extensions"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            selected={sourceFilter === "tenant"}
            onSelect={() => {
              setSourceFilter("tenant");
              setPage(1);
            }}
          />
          <KpiCard
            label="Regulatory"
            value={loading || error ? "—" : stats.required}
            detail="Required rules"
            tone="warning"
            accentColor="var(--color-warning)"
            selected={requiredFilter === "required"}
            onSelect={() => {
              setRequiredFilter("required");
              setPage(1);
            }}
          />
          <KpiCard
            label="Blocking"
            value={loading || error ? "—" : blockSeverityCount}
            detail={`${activeCount} active`}
            tone={blockSeverityCount > 0 ? "danger" : "neutral"}
            accentColor={
              blockSeverityCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
            }
            selected={severityFilter === "block"}
            onSelect={() => {
              setSeverityFilter("block");
              setPage(1);
            }}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <div style={{ position: "relative", minWidth: "17rem" }}>
              <input
                type="search"
                placeholder="Search code, description, scope..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search validation rules"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Category</span>
              <select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {categoryOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Severity</span>
              <select
                aria-label="Filter by severity"
                value={severityFilter}
                onChange={(e) => {
                  setSeverityFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {severityOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Source</span>
              <select
                aria-label="Filter by source"
                value={sourceFilter}
                onChange={(e) => {
                  setSourceFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any source</option>
                <option value="platform">Platform</option>
                <option value="tenant">Tenant</option>
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Required</span>
              <select
                aria-label="Filter by regulatory requirement"
                value={requiredFilter}
                onChange={(e) => {
                  setRequiredFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any</option>
                <option value="required">Required</option>
                <option value="optional">Optional</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setCategoryFilter("");
                  setSeverityFilter("");
                  setSourceFilter("");
                  setRequiredFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredRows.length} of {rows.length} rules
            </span>
          </div>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No rules"
              description={
                hasActiveFilters
                  ? "No validation rule matches these filters."
                  : "No validation rules are registered."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setCategoryFilter("");
                      setSeverityFilter("");
                      setSourceFilter("");
                      setRequiredFilter("");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <section
              aria-label="Validation rules"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
              tabIndex={0}
              style={tableViewportStyle}
            >
              <table style={rulesTableStyle}>
                <colgroup>
                  <col style={{ width: "34%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "8%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={headStyle}>Rule</th>
                    <th style={headStyle}>Category</th>
                    <th style={headStyle}>Severity</th>
                    <th style={headStyle}>Scope</th>
                    <th style={headStyle}>Source</th>
                    <th style={headStyle}>Status</th>
                    <th style={headStyle}>Required</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r) => (
                    <tr key={r.ruleId} style={rowStyle}>
                      <td style={primaryCellStyle}>
                        <code style={ruleCodeStyle}>{r.ruleCode}</code>
                        <span style={descriptionStyle}>{r.description}</span>
                      </td>
                      <td style={cellStyle}>{humanize(r.category)}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={toneOf(SEVERITY_TONE, r.severity)}
                          label={humanize(r.severity)}
                        />
                      </td>
                      <td style={cellStyle}>{r.macJurisdictionScope}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={r.organizationId === null ? "neutral" : "progress"}
                          label={r.organizationId === null ? "Platform" : "Tenant"}
                        />
                      </td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={r.status === "active" ? "success" : "neutral"}
                          label={humanize(r.status)}
                        />
                      </td>
                      <td style={cellStyle}>
                        {r.regulatoryRequired ? (
                          <StatusPill tone="warning" label="Required" />
                        ) : (
                          <span style={mutedStyle}>Optional</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="rules"
            />
          </>
        )
      }
    />
  );
}

const filterPanelStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "0.75rem",
};

const filterLabelStyle: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const searchInputStyle: CSSProperties = {
  width: "100%",
  minHeight: "2.35rem",
  padding: "0.45rem 0.75rem 0.45rem 2rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const searchIconStyle: CSSProperties = {
  position: "absolute",
  left: "0.65rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none",
};

const selectStyle: CSSProperties = {
  minHeight: "2.35rem",
  padding: "0.45rem 0.65rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};

const tableViewportStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const rulesTableStyle: CSSProperties = {
  ...tableStyle,
  minWidth: "72rem",
  tableLayout: "fixed",
};

const primaryCellStyle: CSSProperties = {
  ...cellStyle,
  display: "grid",
  gap: "0.2rem",
};

const ruleCodeStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8125rem",
  fontVariantNumeric: "tabular-nums",
};

const descriptionStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
  lineHeight: 1.35,
};
