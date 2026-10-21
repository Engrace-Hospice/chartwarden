import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  formatDateOnly,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/09-assessments — Scale-license registry, admin (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// One row per (org × scale): status chip (active / pending_renewal / expired), vendor, effective/expiry dates,
// seats. Expired licensed scales are auto-disabled for new writes (D3) — historical reads are preserved. The
// Record uses POST; Edit and Renew update the existing (org × scale) row through PATCH. The server
// enforces org-admin scope
// (ADR-0030 — no authz on the frontend). Leaves only.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { LICENSE_TONE, stateLabel } from "./assessment-status";

interface LicenseRow {
  id: string;
  scaleType: string;
  vendor: string;
  effectiveDate: string;
  expiresAt: string;
  seats: number | null;
  status: string;
}

const PAGE_SIZES = [10, 25, 50] as const;
const LICENSED_SCALES = ["pps", "fast", "gds", "braden", "morse"] as const;

type LicenseDraft = {
  scaleType: (typeof LICENSED_SCALES)[number];
  vendor: string;
  effectiveDate: string;
  expiresAt: string;
};

type LicenseAction = "edit" | "renew";

const today = (): string => new Date().toISOString().slice(0, 10);
const newDraft = (): LicenseDraft => ({
  scaleType: "fast",
  vendor: "",
  effectiveDate: today(),
  expiresAt: "",
});

export function ScaleLicenseRegistry(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<LicenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "pending_renewal" | "expired"
  >("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<{ license: LicenseRow; action: LicenseAction } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<LicenseDraft>(newDraft);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/admin/scales/licenses");
      if (!active) return;
      if (err) {
        setError("Could not load licenses.");
        setLoading(false);
        return;
      }
      setItems((data?.licenses ?? []) as LicenseRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const filtered = items.filter((license) => {
    const q = query.trim().toLowerCase();
    const matchesQuery =
      !q || license.scaleType.toLowerCase().includes(q) || license.vendor.toLowerCase().includes(q);
    const matchesStatus = statusFilter === "all" || license.status === statusFilter;
    return matchesQuery && matchesStatus;
  });
  const hasActiveFilters = query !== "" || statusFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const paged = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);
  const invalidDates = draft.expiresAt !== "" && draft.expiresAt < draft.effectiveDate;

  async function saveLicense(): Promise<void> {
    if (!draft.vendor.trim() || !draft.expiresAt || invalidDates) return;
    if (!editing && items.some((license) => license.scaleType === draft.scaleType)) {
      setError("A license already exists for this scale. Use Edit or Renew on the existing row.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      vendor: draft.vendor.trim(),
      effectiveDate: draft.effectiveDate,
      expiresAt: draft.expiresAt,
    };
    const result = editing
      ? await client.PATCH("/api/v1/admin/scales/licenses/{id}", {
          params: { path: { id: editing.license.id } },
          body,
        })
      : await client.POST("/api/v1/admin/scales/licenses", {
          body: { ...body, scaleType: draft.scaleType },
        });
    const { data, error: err } = result;
    setSaving(false);
    if (err || !data) {
      setError(
        `Could not ${editing ? "update" : "record"} the license. Confirm the vendor, dates, and your administrator access.`,
      );
      return;
    }
    const saved = data as LicenseRow;
    setItems((current) =>
      editing
        ? current.map((license) => (license.id === saved.id ? saved : license))
        : [...current, saved],
    );
    setRecording(false);
    setEditing(null);
    setDraft(newDraft());
  }

  function beginLicenseAction(license: LicenseRow, action: LicenseAction): void {
    setError(null);
    setDraft({
      scaleType: license.scaleType as LicenseDraft["scaleType"],
      vendor: license.vendor,
      effectiveDate: action === "renew" ? today() : license.effectiveDate.slice(0, 10),
      expiresAt: action === "renew" ? "" : license.expiresAt.slice(0, 10),
    });
    setEditing({ license, action });
    setRecording(true);
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Scale Licenses" breadcrumb="Admin / Assessments">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review licensed clinical scales, vendor coverage, seat limits, and renewal state.
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <Button
                onClick={() => {
                  setError(null);
                  setEditing(null);
                  setDraft(newDraft());
                  setRecording(true);
                }}
              >
                Record license
              </Button>
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
              <span className="wx-toolbar-count">Licenses · {filtered.length}</span>

              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
              >
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    aria-label="Search licenses"
                    placeholder="Search scale or vendor..."
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <label className="wx-filter-field">
                  <span>Status</span>
                  <select
                    className="wx-select"
                    aria-label="Filter by license status"
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value as typeof statusFilter);
                      setPage(1);
                    }}
                    style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                  >
                    <option value="all">All</option>
                    <option value="active">Active</option>
                    <option value="pending_renewal">Pending renewal</option>
                    <option value="expired">Expired</option>
                  </select>
                </label>
                {hasActiveFilters ? (
                  <Button
                    size="sm"
                    tone="tertiary"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("all");
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
          loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No licenses"
                description="No scale licenses are recorded for this organization."
              />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No matching licenses"
                description="Try adjusting the scale, vendor, or status filters."
                action={
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("all");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeaderRowStyle}>
                    <th style={{ ...thStyle, width: "24%" }}>Scale</th>
                    <th style={{ ...thStyle, width: "24%" }}>Vendor</th>
                    <th style={{ ...thStyle, width: "14%" }}>Effective</th>
                    <th style={{ ...thStyle, width: "14%" }}>Expires</th>
                    <th style={{ ...thStyle, width: "10%" }}>Seats</th>
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                    <th style={{ ...thStyle, width: "12%" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((license) => (
                    <tr
                      key={license.id}
                      style={{ ...tableRowStyle, opacity: license.status === "expired" ? 0.66 : 1 }}
                    >
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                          {formatScale(license.scaleType)}
                        </div>
                        <div className="wx-data-md" style={mutedCodeStyle}>
                          {license.scaleType}
                        </div>
                      </td>
                      <td style={tdStyle}>{license.vendor}</td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {formatDate(license.effectiveDate)}
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {formatDate(license.expiresAt)}
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {license.seats ?? "—"}
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(license.status)}
                          tone={LICENSE_TONE[license.status] ?? "neutral"}
                        />
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: "0.35rem", whiteSpace: "nowrap" }}>
                          <Button
                            size="sm"
                            tone="tertiary"
                            onClick={() => beginLicenseAction(license, "edit")}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            tone="secondary"
                            onClick={() => beginLicenseAction(license, "renew")}
                          >
                            Renew
                          </Button>
                        </div>
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
                noun="licenses"
              />
            </div>
          )
        }
        fullPageScroll
      />

      {recording ? (
        <Modal
          open
          onClose={saving ? undefined : () => setRecording(false)}
          ariaLabel={`${editing ? (editing.action === "renew" ? "Renew" : "Edit") : "Record"} scale license`}
          width="34rem"
        >
          <div style={modalBodyStyle}>
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
              {editing
                ? editing.action === "renew"
                  ? "Renew license"
                  : "Edit license"
                : "Record scale license"}
            </h2>
            <p style={modalHintStyle}>
              {editing?.action === "renew"
                ? "Enter the renewed term. This updates the existing license row for the scale."
                : editing
                  ? "Update the vendor or license term for this scale."
                  : "Record the agency’s vendor licence before clinicians capture this proprietary instrument."}
            </p>
            <label style={fieldStyle}>
              Scale
              <select
                value={draft.scaleType}
                disabled={editing !== null}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    scaleType: event.target.value as LicenseDraft["scaleType"],
                  }))
                }
              >
                {LICENSED_SCALES.map((scaleType) => (
                  <option
                    key={scaleType}
                    value={scaleType}
                    disabled={!editing && items.some((license) => license.scaleType === scaleType)}
                  >
                    {formatScale(scaleType)}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldStyle}>
              Vendor / licence holder
              <input
                value={draft.vendor}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, vendor: event.target.value }))
                }
                maxLength={200}
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <label style={fieldStyle}>
                Effective date
                <input
                  type="date"
                  value={draft.effectiveDate}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, effectiveDate: event.target.value }))
                  }
                />
              </label>
              <label style={fieldStyle}>
                Expiry date
                <input
                  type="date"
                  value={draft.expiresAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, expiresAt: event.target.value }))
                  }
                />
              </label>
            </div>
            {invalidDates ? (
              <p role="alert" style={errorTextStyle}>
                The expiry date must be on or after the effective date.
              </p>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <Button tone="tertiary" disabled={saving} onClick={() => setRecording(false)}>
                Cancel
              </Button>
              <Button
                disabled={saving || !draft.vendor.trim() || !draft.expiresAt || invalidDates}
                onClick={() => void saveLicense()}
              >
                {saving
                  ? "Saving…"
                  : editing?.action === "renew"
                    ? "Renew license"
                    : editing
                      ? "Save changes"
                      : "Record license"}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function formatScale(scaleType: string): string {
  return scaleType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const formatDate = (dateOnly: string): string => formatDateOnly(dateOnly) || "—";

const modalBodyStyle = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.875rem",
};
const modalHintStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};
const fieldStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const errorTextStyle = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };

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

const mutedCodeStyle = {
  display: "block",
  marginTop: "0.2rem",
  maxWidth: "18rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
