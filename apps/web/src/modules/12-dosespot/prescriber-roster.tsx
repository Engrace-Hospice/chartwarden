import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — prescriber roster admin (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (prescriber roster admin).
// The per-tenant DoseSpot prescriber list for org_admin / compliance_officer: membership, enrollment, the
// DEA schedules authorized, and the IAL2 identity-proofing status (§1311.115). The enroll / revoke / IAL2
// re-verification write actions fill in as their write surfaces harden (each step-up enforced server-side).
// `dosespot.epcs` is OFF in Phase 1, so EPCS-enabled prescribers are architecture-only here. Reads
// GET /api/v1/admin/dosespot-prescribers via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { IAL2_TONE, stateLabel } from "./medication-status";

interface PrescriberRow {
  membershipId: string;
  enrolled: boolean;
  deaAuthorizedSchedules: string[];
  ial2Status: string;
}

const PAGE_SIZES = [10, 25, 50] as const;

export function PrescriberRoster(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<PrescriberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [enrollmentFilter, setEnrollmentFilter] = useState<"all" | "enrolled" | "not_enrolled">(
    "all",
  );
  const [ial2Filter, setIal2Filter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admin/dosespot-prescribers", {});
    if (err) {
      setError("Could not load the prescriber roster.");
      setLoading(false);
      return;
    }
    setItems((data?.prescribers ?? []) as PrescriberRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const ial2Options = Array.from(new Set(items.map((p) => p.ial2Status))).sort();
  const filtered = items.filter((prescriber) => {
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || prescriber.membershipId.toLowerCase().includes(q);
    const matchesEnrollment =
      enrollmentFilter === "all" ||
      (enrollmentFilter === "enrolled" && prescriber.enrolled) ||
      (enrollmentFilter === "not_enrolled" && !prescriber.enrolled);
    const matchesIal2 = ial2Filter === "all" || prescriber.ial2Status === ial2Filter;
    return matchesQuery && matchesEnrollment && matchesIal2;
  });
  const hasActiveFilters = query !== "" || enrollmentFilter !== "all" || ial2Filter !== "all";
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const paged = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="DoseSpot Prescriber Roster" breadcrumb="Admin / Medications">
          <div
            style={{
              color: "var(--color-on-surface-variant)",
              fontSize: "0.875rem",
            }}
          >
            Review tenant prescriber enrollment, DEA schedule authorization, and IAL2
            identity-proofing state.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}

          <div style={toolbarStyle}>
            <div className="wx-subtabs wx-subtabs-inline" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={enrollmentFilter === "enrolled"}
                onClick={() => {
                  setEnrollmentFilter("enrolled");
                  setPage(1);
                }}
              >
                Enrolled
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={enrollmentFilter === "not_enrolled"}
                onClick={() => {
                  setEnrollmentFilter("not_enrolled");
                  setPage(1);
                }}
              >
                Not enrolled
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={enrollmentFilter === "all"}
                onClick={() => {
                  setEnrollmentFilter("all");
                  setPage(1);
                }}
              >
                All ({filtered.length})
              </button>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  aria-label="Search prescribers"
                  placeholder="Search membership..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <select
                aria-label="Filter by IAL2 status"
                value={ial2Filter}
                onChange={(e) => {
                  setIal2Filter(e.target.value);
                  setPage(1);
                }}
                style={{
                  height: "2.25rem",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
              >
                <option value="all">IAL2: All</option>
                {ial2Options.map((status) => (
                  <option key={status} value={status}>
                    {stateLabel(status)}
                  </option>
                ))}
              </select>
              {hasActiveFilters ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  onClick={() => {
                    setQuery("");
                    setEnrollmentFilter("all");
                    setIal2Filter("all");
                    setPage(1);
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        loading && items.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No prescribers enrolled"
              description="No DoseSpot prescribers on this tenant."
            />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching prescribers"
              description="Try adjusting membership, enrollment, or IAL2 filters."
              action={
                <Button
                  tone="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setEnrollmentFilter("all");
                    setIal2Filter("all");
                    setPage(1);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              overflowX: "auto",
              padding: "0 1.5rem 1.5rem 1.5rem",
            }}
          >
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeaderRowStyle}>
                  <th style={{ ...thStyle, width: "36%" }}>Membership</th>
                  <th style={{ ...thStyle, width: "16%" }}>Enrollment</th>
                  <th style={{ ...thStyle, width: "28%" }}>DEA schedules</th>
                  <th style={{ ...thStyle, width: "20%" }}>IAL2 status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((prescriber) => (
                  <tr key={prescriber.membershipId} style={tableRowStyle}>
                    <td style={tdStyle}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.75rem",
                        }}
                      >
                        <div style={avatarStyle}>
                          <Glyph name="user" size={16} />
                        </div>
                        <div className="wx-data-md" style={membershipStyle}>
                          {prescriber.membershipId}
                        </div>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={prescriber.enrolled ? "Enrolled" : "Not enrolled"}
                        tone={prescriber.enrolled ? "success" : "neutral"}
                      />
                    </td>
                    <td style={tdStyle}>
                      {prescriber.deaAuthorizedSchedules.length > 0 ? (
                        <span
                          style={{
                            display: "inline-flex",
                            flexWrap: "wrap",
                            gap: "0.25rem",
                          }}
                        >
                          {prescriber.deaAuthorizedSchedules.map((schedule) => (
                            <StatusPill
                              key={schedule}
                              label={`C-${schedule}`}
                              tone="critical"
                              glyph="alert"
                            />
                          ))}
                        </span>
                      ) : (
                        <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(prescriber.ial2Status)}
                        tone={IAL2_TONE[prescriber.ial2Status] ?? "neutral"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="prescribers"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
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

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
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

const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};

const tableHeaderRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const tableRowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
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

const avatarStyle = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const membershipStyle = {
  maxWidth: "22rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface)",
};
