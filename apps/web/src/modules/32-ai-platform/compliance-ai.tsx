import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/web/src/modules/32-ai-platform — M32 §5.2 Compliance Officer view (`/compliance/ai`,
// `ai.invocation.read`). GAP-049.
//
// Three sections, all org-scoped by the routes themselves (this is the tenant app; RLS and the ABAC
// guard pin the org — nothing here passes an organization id):
//   • Tenant invocation log — the §164.528 disclosure ledger for THIS organization, PHI masked.
//   • Tenant opt-in audit — which capabilities this org enabled, with the BAA / ZDR / clinical-review
//     acknowledgments captured at enrolment, plus revocations.
//   • Hallucination report archive — reports filed inside this org with their triage outcomes.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

type InvocationPage =
  operations["getApiV1AiInvocations"]["responses"][200]["content"]["application/json"];
type Invocation = InvocationPage["rows"][number];
type OptInPage =
  operations["getApiV1AiTenantoptin"]["responses"][200]["content"]["application/json"];
type OptIn = OptInPage["optIns"][number];
type ReportPage =
  operations["getApiV1AiHallucinationreports"]["responses"][200]["content"]["application/json"];
type Report = ReportPage["reports"][number];
type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];

const INVOCATION_TONE: Record<string, "success" | "error" | "warning" | "critical" | "neutral"> = {
  completed: "success",
  failed: "error",
  timed_out: "error",
  killed: "critical",
  capability_unavailable: "warning",
};
const TRIAGE_TONE: Record<
  string,
  "success" | "error" | "warning" | "critical" | "progress" | "neutral"
> = {
  open: "error",
  investigating: "progress",
  root_cause_identified: "progress",
  mitigated: "warning",
  closed: "success",
  escalated_to_clinical_safety: "critical",
};

export function ComplianceAiView(): JSX.Element {
  const client = useApiClient();
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [optIns, setOptIns] = useState<OptIn[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [capabilityKeys, setCapabilityKeys] = useState<Map<string, string>>(new Map());
  const [phiMasked, setPhiMasked] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [invocationStatus, setInvocationStatus] = useState("");
  const [reportStatus, setReportStatus] = useState("");
  const [invocationPage, setInvocationPage] = useState(1);
  const [invocationPageSize, setInvocationPageSize] = useState(10);
  const [optInPage, setOptInPage] = useState(1);
  const [optInPageSize, setOptInPageSize] = useState(5);
  const [reportPage, setReportPage] = useState(1);
  const [reportPageSize, setReportPageSize] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [inv, opts, reps, caps] = await Promise.all([
      client.GET("/api/v1/ai/invocations", { params: { query: { limit: 50 } } }),
      client.GET("/api/v1/ai/tenant-opt-in", {}),
      client.GET("/api/v1/ai/hallucination-reports", { params: { query: {} } }),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (inv.error || opts.error || reps.error || caps.error) {
      setError("AI compliance view unavailable.");
      setLoading(false);
      return;
    }
    setInvocations(inv.data.rows);
    setPhiMasked(inv.data.phiMasked);
    setOptIns(opts.data.optIns);
    setReports(reps.data.reports);
    const page = caps.data as CapabilityPage;
    setCapabilityKeys(new Map(page.capabilities.map((c) => [c.id, c.capabilityKey])));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const keyOf = useMemo(() => (id: string) => capabilityKeys.get(id) ?? id, [capabilityKeys]);

  const filteredInvocations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return invocations.filter((i) => {
      const matchesStatus = !invocationStatus || i.status === invocationStatus;
      const matchesSearch =
        !q ||
        i.invocationId.toLowerCase().includes(q) ||
        i.capabilityKey.toLowerCase().includes(q) ||
        i.backendKey.toLowerCase().includes(q) ||
        i.status.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [invocations, invocationStatus, searchQuery]);

  const filteredOptIns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return optIns.filter((o) => {
      const capability = keyOf(o.capabilityId).toLowerCase();
      return (
        !q ||
        o.id.toLowerCase().includes(q) ||
        capability.includes(q) ||
        o.status.toLowerCase().includes(q) ||
        (o.routingPreferenceSnapshot?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [keyOf, optIns, searchQuery]);

  const filteredReports = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return reports.filter((r) => {
      const capability = keyOf(r.capabilityId).toLowerCase();
      const matchesStatus = !reportStatus || r.triageStatus === reportStatus;
      const matchesSearch =
        !q ||
        r.id.toLowerCase().includes(q) ||
        capability.includes(q) ||
        r.hallucinationKind.toLowerCase().includes(q) ||
        r.severity.toLowerCase().includes(q) ||
        r.triageStatus.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [keyOf, reports, reportStatus, searchQuery]);

  const pagedInvocations = paginate(filteredInvocations, invocationPage, invocationPageSize);
  const pagedOptIns = paginate(filteredOptIns, optInPage, optInPageSize);
  const pagedReports = paginate(filteredReports, reportPage, reportPageSize);
  const activeFilters = [
    searchQuery.trim() !== "",
    invocationStatus !== "",
    reportStatus !== "",
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setInvocationStatus("");
    setReportStatus("");
    setInvocationPage(1);
    setOptInPage(1);
    setReportPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="AI compliance" breadcrumb="Compliance / AI">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review masked AI invocation disclosures, tenant opt-ins, and hallucination reports.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}
          <div role="note" style={noteStyle}>
            <StatusPill
              label={phiMasked ? "PHI masked" : "PHI visible"}
              tone={phiMasked ? "warning" : "critical"}
            />
            <span>
              {phiMasked
                ? "Prompt, response and chart-context payloads are never returned to this view. Patient identity is masked."
                : "This view is serving unmasked patient identity. Every read is audited."}
            </span>
          </div>
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Compliance ledger</span>
              <strong>
                {filteredInvocations.length} invocations / {filteredReports.length} reports
              </strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search capability, backend, report..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setInvocationPage(1);
                    setOptInPage(1);
                    setReportPage(1);
                  }}
                  aria-label="Search AI compliance"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Invocation status"
                value={invocationStatus}
                onChange={(e) => {
                  setInvocationStatus(e.target.value);
                  setInvocationPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Invocation: All</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="timed_out">Timed out</option>
                <option value="killed">Killed</option>
                <option value="capability_unavailable">Capability unavailable</option>
              </select>
              <select
                aria-label="Report triage status"
                value={reportStatus}
                onChange={(e) => {
                  setReportStatus(e.target.value);
                  setReportPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Report: All</option>
                <option value="open">Open</option>
                <option value="investigating">Investigating</option>
                <option value="root_cause_identified">Root cause identified</option>
                <option value="mitigated">Mitigated</option>
                <option value="closed">Closed</option>
                <option value="escalated_to_clinical_safety">Escalated</option>
              </select>
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
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title={error} description="Retry shortly." />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <SectionTitle
              title="Tenant invocation log"
              detail="Vendor disclosures are flagged per row"
            />
            {filteredInvocations.length === 0 ? (
              <EmptyBlock
                title="No invocations"
                description="No AI call has been made in this window."
              />
            ) : (
              <>
                <table style={tableStyle}>
                  <thead>
                    <tr style={headerRowStyle}>
                      <th style={{ ...thStyle, width: "18%" }}>Invoked</th>
                      <th style={{ ...thStyle, width: "22%" }}>Capability</th>
                      <th style={{ ...thStyle, width: "16%" }}>Backend</th>
                      <th style={{ ...thStyle, width: "12%" }}>Chart</th>
                      <th style={{ ...thStyle, width: "12%" }}>Disclosed</th>
                      <th style={{ ...thStyle, width: "10%" }}>ZDR</th>
                      <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedInvocations.map((i) => (
                      <tr key={i.invocationId} style={rowStyle}>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(i.invokedAt)}
                        </td>
                        <td style={tdStyle}>
                          <code className="wx-data-md" style={codeStyle}>
                            {i.capabilityKey}
                          </code>
                        </td>
                        <td style={tdStyle}>
                          <code className="wx-data-md" style={codeStyle}>
                            {i.backendKey}
                          </code>
                        </td>
                        <td style={tdStyle}>{i.touchedPatientChart ? "Yes" : "No"}</td>
                        <td style={tdStyle}>
                          {i.disclosedToVendor ? (
                            <StatusPill label="Vendor" tone="warning" />
                          ) : (
                            "No"
                          )}
                        </td>
                        <td style={tdStyle}>
                          {i.disclosedToVendor && !i.zdrConfirmed ? (
                            <StatusPill label="Not confirmed" tone="error" />
                          ) : i.zdrConfirmed ? (
                            "Confirmed"
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <StatusPill
                            label={cap(i.status)}
                            tone={INVOCATION_TONE[i.status] ?? "neutral"}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <OffsetPagination
                  page={clampPage(invocationPage, filteredInvocations.length, invocationPageSize)}
                  pageSize={invocationPageSize}
                  totalItems={filteredInvocations.length}
                  onPageChange={setInvocationPage}
                  onPageSizeChange={(nextPageSize) => {
                    setInvocationPageSize(nextPageSize);
                    setInvocationPage(1);
                  }}
                  pageSizeOptions={AI_PAGE_SIZES}
                  noun="invocations"
                />
              </>
            )}

            <SectionTitle title="Tenant opt-in audit" />
            {filteredOptIns.length === 0 ? (
              <EmptyBlock
                title="No opt-in records"
                description="This organization has not enabled any AI capability."
              />
            ) : (
              <>
                <table style={tableStyle}>
                  <thead>
                    <tr style={headerRowStyle}>
                      <th style={{ ...thStyle, width: "24%" }}>Capability</th>
                      <th style={{ ...thStyle, width: "12%" }}>Status</th>
                      <th style={{ ...thStyle, width: "18%" }}>Routing</th>
                      <th style={{ ...thStyle, width: "10%" }}>Pilot</th>
                      <th style={{ ...thStyle, width: "12%" }}>Opted in</th>
                      <th style={{ ...thStyle, width: "12%" }}>Paused</th>
                      <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>Revoked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedOptIns.map((o) => (
                      <tr key={o.id} style={rowStyle}>
                        <td style={tdStyle}>
                          <code className="wx-data-md" style={codeStyle}>
                            {keyOf(o.capabilityId)}
                          </code>
                        </td>
                        <td style={tdStyle}>{cap(o.status)}</td>
                        <td style={tdStyle}>
                          {o.routingPreferenceSnapshot ? cap(o.routingPreferenceSnapshot) : "—"}
                        </td>
                        <td style={tdStyle}>{o.pilotEnrollment ? "Yes" : "No"}</td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(o.optedInAt)}
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(o.pausedAt)}
                        </td>
                        <td
                          style={{
                            ...tdStyle,
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatDate(o.optedOutAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <OffsetPagination
                  page={clampPage(optInPage, filteredOptIns.length, optInPageSize)}
                  pageSize={optInPageSize}
                  totalItems={filteredOptIns.length}
                  onPageChange={setOptInPage}
                  onPageSizeChange={(nextPageSize) => {
                    setOptInPageSize(nextPageSize);
                    setOptInPage(1);
                  }}
                  pageSizeOptions={AI_PAGE_SIZES}
                  noun="opt-ins"
                />
              </>
            )}
            <p style={mutedNoteStyle}>
              The BAA, ZDR and clinical-reviewer acknowledgments captured at enrolment are stored on
              each record for audit but are not returned by this read surface.
            </p>

            <SectionTitle title="Hallucination report archive" />
            {filteredReports.length === 0 ? (
              <EmptyBlock
                title="No reports"
                description="No clinician in this organization has filed an AI hallucination report."
              />
            ) : (
              <>
                <table style={tableStyle}>
                  <thead>
                    <tr style={headerRowStyle}>
                      <th style={{ ...thStyle, width: "16%" }}>Reported</th>
                      <th style={{ ...thStyle, width: "22%" }}>Capability</th>
                      <th style={{ ...thStyle, width: "16%" }}>Kind</th>
                      <th style={{ ...thStyle, width: "12%" }}>Severity</th>
                      <th style={{ ...thStyle, width: "16%" }}>Triage</th>
                      <th style={{ ...thStyle, width: "10%" }}>Disposition</th>
                      <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedReports.map((r) => (
                      <tr key={r.id} style={rowStyle}>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(r.reportedAt)}
                        </td>
                        <td style={tdStyle}>
                          <code className="wx-data-md" style={codeStyle}>
                            {keyOf(r.capabilityId)}
                          </code>
                        </td>
                        <td style={tdStyle}>{cap(r.hallucinationKind)}</td>
                        <td style={tdStyle}>{cap(r.severity)}</td>
                        <td style={tdStyle}>
                          <StatusPill
                            label={cap(r.triageStatus)}
                            tone={TRIAGE_TONE[r.triageStatus] ?? "neutral"}
                          />
                        </td>
                        <td style={tdStyle}>
                          {r.triageDisposition ? cap(r.triageDisposition) : "—"}
                        </td>
                        <td
                          style={{
                            ...tdStyle,
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatDate(r.closedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <OffsetPagination
                  page={clampPage(reportPage, filteredReports.length, reportPageSize)}
                  pageSize={reportPageSize}
                  totalItems={filteredReports.length}
                  onPageChange={setReportPage}
                  onPageSizeChange={(nextPageSize) => {
                    setReportPageSize(nextPageSize);
                    setReportPage(1);
                  }}
                  pageSizeOptions={AI_PAGE_SIZES}
                  noun="reports"
                />
              </>
            )}

            <SectionTitle title="Monthly evidence pack" />
            <p style={mutedNoteStyle}>
              The §5.2 per-month evidence-pack export is not built. No route, job binding or
              object-store handshake exists for it yet, and a partial pack filed as §164.528
              evidence would be worse than none.
            </p>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function SectionTitle({ title, detail }: { title: string; detail?: string }): JSX.Element {
  return (
    <div style={sectionTitleRowStyle}>
      <h2 style={sectionTitleStyle}>{title}</h2>
      {detail ? <span style={sectionDetailStyle}>{detail}</span> : null}
    </div>
  );
}

function EmptyBlock({ title, description }: { title: string; description: string }): JSX.Element {
  return (
    <div style={{ padding: "1rem 0" }}>
      <EmptyState title={title} description={description} />
    </div>
  );
}

const AI_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const current = clampPage(page, items.length, pageSize);
  return items.slice((current - 1) * pageSize, current * pageSize);
}

function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}

function cap(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchWrapStyle = { minWidth: "15rem" };
const searchInputStyle = { width: "100%", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
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
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const codeStyle = {
  display: "inline-block",
  maxWidth: "14rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
const sectionTitleRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  paddingTop: "1rem",
};
const sectionTitleStyle = {
  margin: "0 0 0.75rem",
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const sectionDetailStyle = {
  marginBottom: "0.75rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};
const mutedNoteStyle = {
  margin: "0.75rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};
