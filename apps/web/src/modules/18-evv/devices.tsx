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
// apps/web/src/modules/18-evv — EVV Devices (M18 §5.1 `/app/evv/devices/pending`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The team device roster (devices awaiting approval surface first):
// one row per `evv_device` with platform / model / integrity status. The approve / reject / suspend / retire
// write CTAs fill in as those write paths harden; the SERVER owns the device lifecycle + RLS (ADR-0030 — no
// frontend authz). Reads GET /api/v1/evv/devices via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { EVV_DEVICE_TONE, stateLabel } from "./evv-shared";

interface DeviceRow {
  id: string;
  membershipId: string;
  platform: string;
  modelDescription: string;
  status: string;
}

/** Shared device roster; `mine` scopes to the session membership (the self-service `/me/evv/devices` variant). */
export function EvvDeviceRoster({
  title,
  initialStatus = "",
}: { title: string; initialStatus?: string }): JSX.Element {
  const client = useApiClient();
  const isMine = title.toLowerCase().startsWith("my");
  const [items, setItems] = useState<DeviceRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [platform, setPlatform] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/devices", { params: { query: {} } });
    if (err) {
      setError("Could not load EVV devices.");
      setLoading(false);
      return;
    }
    setItems(((data ?? []) as DeviceRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const platformOptions = useMemo(
    () => [...new Set(items.map((d) => d.platform).filter(Boolean))].sort(),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((d) => {
      const matchesStatus = !status || d.status === status;
      const matchesPlatform = !platform || d.platform === platform;
      const matchesSearch =
        !q ||
        d.id.toLowerCase().includes(q) ||
        d.membershipId.toLowerCase().includes(q) ||
        d.platform.toLowerCase().includes(q) ||
        d.modelDescription.toLowerCase().includes(q) ||
        d.status.toLowerCase().includes(q);
      return matchesStatus && matchesPlatform && matchesSearch;
    });

    return [...visible].sort(
      (a, b) => deviceRank(a.status) - deviceRank(b.status) || a.platform.localeCompare(b.platform),
    );
  }, [items, platform, searchQuery, status]);

  const activeFilters = [searchQuery.trim() !== "", status !== "", platform !== ""].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setPlatform("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title={title.replace("—", "-")}
          breadcrumb={isMine ? "Field / EVV" : "Admin / EVV"}
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            {isMine
              ? "Review your registered EVV devices and approval status."
              : "Review EVV devices awaiting approval and lifecycle follow-up."}
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
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Roster</span>
              <strong>{rows.length} matching devices</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search device, clinician, model..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search EVV devices"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Device status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Status: All</option>
                <option value="pending_approval">Pending approval</option>
                <option value="approved">Approved</option>
                <option value="suspended">Suspended</option>
                <option value="rejected">Rejected</option>
                <option value="retired">Retired</option>
              </select>
              <select
                aria-label="Device platform"
                value={platform}
                onChange={(e) => {
                  setPlatform(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Platform: All</option>
                {platformOptions.map((option) => (
                  <option key={option} value={option}>
                    {stateLabel(option)}
                  </option>
                ))}
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
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && items.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching devices" : "No devices"}
              description={
                activeFilters > 0
                  ? "Try adjusting the device filters."
                  : "No EVV devices are registered."
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
                  <th style={{ ...thStyle, width: "30%" }}>Device</th>
                  <th style={{ ...thStyle, width: "22%" }}>Clinician</th>
                  <th style={{ ...thStyle, width: "14%" }}>Platform</th>
                  <th style={{ ...thStyle, width: "20%" }}>Model</th>
                  <th style={{ ...thStyle, width: "14%", textAlign: "right" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((d) => (
                  <tr key={d.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>EVV device</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(d.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(d.membershipId)}
                      </code>
                    </td>
                    <td style={tdStyle}>{stateLabel(d.platform)}</td>
                    <td style={tdStyle}>{d.modelDescription}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <StatusPill
                        label={stateLabel(d.status)}
                        tone={EVV_DEVICE_TONE[d.status] ?? "neutral"}
                      />
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
              pageSizeOptions={EVV_PAGE_SIZES}
              noun="devices"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

export function EvvDevicesPending(): JSX.Element {
  return (
    <EvvDeviceRoster title="EVV Devices - Pending Approval" initialStatus="pending_approval" />
  );
}

export function EvvMyDevices(): JSX.Element {
  return <EvvDeviceRoster title="My EVV Devices" />;
}

const EVV_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function deviceRank(status: string): number {
  if (status === "pending_approval") return 0;
  if (status === "suspended" || status === "rejected") return 1;
  if (status === "approved") return 2;
  return 3;
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};

const searchWrapStyle = {
  minWidth: "15rem",
};

const searchInputStyle = {
  width: "100%",
  height: "2.25rem",
  fontSize: "0.85rem",
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
