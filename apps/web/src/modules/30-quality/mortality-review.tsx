import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import type { paths } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  DIMENSION_FIELDS,
  DIMENSION_ORDER,
  DIMENSION_TITLES,
  type DimensionKey,
  type DimensionValues,
  type FieldDef,
  areAllDimensionsComplete,
} from "./mortality-form";
import { MORTALITY_STATUS_TONE, humanize, readErrorMessage, toneOf } from "./quality-status";

// M30 mortality-review worklist (S-14, R-70..R-73). Reviews are CREATED by the M6 discharge-by-death consumer;
// this screen only works them (view, save the three dimensions, complete). The server owns every rule
// (assignee-only writes, completeness, the 30-day target) — refusals are shown, never pre-empted.
type ReviewRow =
  paths["/api/v1/quality/mortality"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type ReviewDetail =
  paths["/api/v1/quality/mortality/{reviewId}"]["get"]["responses"][200]["content"]["application/json"];

const MAX_PAGE = 100;
type StatusFilter = "all" | ReviewRow["status"];

export const isOverdue = (row: ReviewRow, now: number = Date.now()): boolean =>
  row.status !== "completed" && Date.parse(row.targetCompletionAt) < now;

export function MortalityReview(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let active = true;
    void reloadTick;
    void (async () => {
      setLoading(true);
      const result = await client.GET("/api/v1/quality/mortality", {
        params: {
          query: { limit: MAX_PAGE, ...(statusFilter === "all" ? {} : { status: statusFilter }) },
        },
      });
      if (!active) return;
      if (result.error) setError(readErrorMessage(result.response?.status, "mortality.read"));
      else {
        setError(null);
        setRows(result.data?.items ?? []);
        setNextCursor(result.data?.nextCursor ?? null);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, statusFilter, reloadTick]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const result = await client.GET("/api/v1/quality/mortality", {
      params: {
        query: {
          limit: MAX_PAGE,
          cursor: nextCursor,
          ...(statusFilter === "all" ? {} : { status: statusFilter }),
        },
      },
    });
    if (result.error) setError(readErrorMessage(result.response?.status, "mortality.read"));
    else {
      setRows((current) => [...current, ...(result.data?.items ?? [])]);
      setNextCursor(result.data?.nextCursor ?? null);
    }
    setLoadingMore(false);
  }, [client, nextCursor, statusFilter]);

  const counts = useMemo(
    () => ({
      open: rows.filter((r) => r.status !== "completed").length,
      overdue: rows.filter((r) => isOverdue(r)).length,
      completed: rows.filter((r) => r.status === "completed").length,
    }),
    [rows],
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Mortality Reviews" breadcrumb="Compliance / Quality">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Every hospice death is reviewed across clinical, satisfaction and compliance within 30
            days.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open reviews"
            value={loading ? "—" : String(counts.open)}
            detail="Pending or in progress"
            tone={counts.open > 0 ? "warning" : "neutral"}
            accentColor={counts.open > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Overdue"
            value={loading ? "—" : String(counts.overdue)}
            detail="Past the 30-day target"
            tone={counts.overdue > 0 ? "danger" : "neutral"}
            accentColor={counts.overdue > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Completed"
            value={loading ? "—" : String(counts.completed)}
            detail="Loaded reviews"
            tone="success"
            accentColor="var(--color-primary)"
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              {error}
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Review register</span>
              <strong>
                {rows.length} {rows.length === 1 ? "review" : "reviews"}
              </strong>
            </div>
            <div style={controlGroupStyle}>
              <label className="wx-filter-field">
                <span>Status</span>
                <select
                  className="wx-select"
                  aria-label="Review status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  style={selectStyle}
                >
                  <option value="all">All</option>
                  <option value="created">Pending</option>
                  <option value="in_progress">In progress</option>
                  <option value="completed">Completed</option>
                </select>
              </label>
              {statusFilter !== "all" ? (
                <Button size="sm" tone="tertiary" onClick={() => setStatusFilter("all")}>
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
        ) : error && rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No mortality reviews"
              description={
                statusFilter === "all"
                  ? "A review is opened automatically when a patient is discharged by death."
                  : "No reviews match this status."
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={thStyle}>Patient</th>
                  <th style={thStyle}>Date of death</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Due</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Assignment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.reviewId}
                    aria-label={`Open review ${patientLabel(r)}`}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(r.reviewId)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        setSelectedId(r.reviewId);
                      }
                    }}
                    style={{
                      ...rowStyle,
                      background:
                        selectedId === r.reviewId ? "var(--color-primary-tint)" : "transparent",
                    }}
                    className="wx-data-row-interactive"
                  >
                    <td style={tdStyle}>
                      <code className="wx-data-md">{patientLabel(r)}</code>
                    </td>
                    <td style={tdStyle}>{formatDate(r.dateOfDeath)}</td>
                    <td style={tdStyle}>
                      <StatusPill
                        tone={toneOf(MORTALITY_STATUS_TONE, r.status)}
                        label={statusLabel(r.status)}
                      />
                      {isOverdue(r) ? (
                        <>
                          {" "}
                          <StatusPill tone="error" label="Overdue" />
                        </>
                      ) : null}
                    </td>
                    <td style={tdStyle}>{formatDate(r.targetCompletionAt)}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {r.assignedToMembershipId ? "Assigned" : "Unassigned"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextCursor ? (
              <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: "1rem" }}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </Button>
              </div>
            ) : null}
          </div>
        )
      }
      detail={
        selectedId ? (
          <ReviewDrawer
            reviewId={selectedId}
            onClose={() => setSelectedId(null)}
            onChanged={() => setReloadTick((n) => n + 1)}
          />
        ) : undefined
      }
      fullPageScroll
    />
  );
}

type Drafts = Record<DimensionKey, Record<string, unknown>>;

function initialDrafts(detail: ReviewDetail): Drafts {
  const out = {} as Drafts;
  for (const key of DIMENSION_ORDER) {
    const stored = (detail.dimensions[key] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...stored };
    for (const f of DIMENSION_FIELDS[key]) {
      if (f.kind === "check" && typeof next[f.key] !== "boolean") next[f.key] = false;
    }
    out[key] = next;
  }
  return out;
}

function ReviewDrawer({
  reviewId,
  onClose,
  onChanged,
}: { reviewId: string; onClose: () => void; onChanged: () => void }): JSX.Element {
  const client = useApiClient();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await client.GET("/api/v1/quality/mortality/{reviewId}", {
      params: { path: { reviewId } },
    });
    if (result.error) {
      setError(readErrorMessage(result.response?.status, "mortality.read"));
      return;
    }
    setError(null);
    setDetail(result.data ?? null);
    setDrafts(result.data ? initialDrafts(result.data) : null);
  }, [client, reviewId]);

  useEffect(() => {
    setDetail(null);
    setDrafts(null);
    setNotice(null);
    void load();
  }, [load]);

  const readOnly = detail?.status === "completed";
  const canComplete = drafts !== null && areAllDimensionsComplete(drafts);

  const setField = (dim: DimensionKey, key: string, value: unknown): void =>
    setDrafts((cur) => (cur ? { ...cur, [dim]: { ...cur[dim], [key]: value } } : cur));

  const writeError = (status: number | undefined): string =>
    status === 403
      ? "Only the assigned reviewer can change this review."
      : status === 409 || status === 422
        ? "The server refused this change — reload and check every required field."
        : readErrorMessage(status, "mortality.write");

  const save = async (): Promise<void> => {
    if (!drafts) return;
    setBusy(true);
    setNotice(null);
    const result = await client.PATCH("/api/v1/quality/mortality/{reviewId}", {
      params: { path: { reviewId } },
      body: { dimensions: drafts },
    });
    if (result.error) setError(writeError(result.response?.status));
    else {
      setError(null);
      setNotice("Draft saved.");
      await load();
      onChanged();
    }
    setBusy(false);
  };

  const complete = async (): Promise<void> => {
    if (!drafts) return;
    setBusy(true);
    setNotice(null);
    const result = await client.POST("/api/v1/quality/mortality/{reviewId}/complete", {
      params: { path: { reviewId } },
      body: { dimensions: drafts },
    });
    if (result.error) setError(writeError(result.response?.status));
    else {
      setError(null);
      setNotice("Review completed.");
      await load();
      onChanged();
    }
    setBusy(false);
  };

  return (
    <RightDetailPanel title="Mortality review" onClose={onClose} hideScrollbar>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {error ? (
          <div role="alert" style={errorBannerStyle}>
            {error}
          </div>
        ) : null}
        {notice ? <output style={{ fontSize: "0.85rem" }}>{notice}</output> : null}
        {!detail && !error ? <LoadingSpinner label="Loading review" /> : null}
        {detail && drafts ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <StatusPill
                tone={toneOf(MORTALITY_STATUS_TONE, detail.status)}
                label={statusLabel(detail.status)}
              />
              {isOverdue(detail) ? <StatusPill tone="error" label="Overdue" /> : null}
            </div>
            {detail.assignedToMembershipId ? null : (
              <div role="alert" style={errorBannerStyle}>
                No reviewer assigned - ask an administrator
              </div>
            )}
            <DetailField label="Patient" value={patientLabel(detail)} />
            <DetailField label="Date of death" value={formatDate(detail.dateOfDeath)} />
            <DetailField label="Due" value={formatDate(detail.targetCompletionAt)} />
            {detail.completedAt ? (
              <DetailField label="Completed" value={formatDate(detail.completedAt)} />
            ) : null}
            {DIMENSION_ORDER.map((dim) => (
              <fieldset key={dim} style={fieldsetStyle} disabled={readOnly || busy}>
                <legend style={legendStyle}>{DIMENSION_TITLES[dim]}</legend>
                {DIMENSION_FIELDS[dim].map((f) => (
                  <FieldInput
                    key={f.key}
                    field={f}
                    dim={dim}
                    value={drafts[dim][f.key]}
                    onChange={(v) => setField(dim, f.key, v)}
                  />
                ))}
              </fieldset>
            ))}
            {readOnly ? null : (
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                <Button size="sm" tone="secondary" disabled={busy} onClick={() => void save()}>
                  Save draft
                </Button>
                <Button size="sm" disabled={busy || !canComplete} onClick={() => void complete()}>
                  Complete review
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </RightDetailPanel>
  );
}

function FieldInput({
  field,
  dim,
  value,
  onChange,
}: {
  field: FieldDef;
  dim: DimensionKey;
  value: unknown;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const id = `mr-${dim}-${field.key}`;
  if (field.kind === "check") {
    return (
      <label htmlFor={id} style={fieldRowStyle}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label
        htmlFor={id}
        style={{ ...fieldRowStyle, flexDirection: "column", alignItems: "stretch" }}
      >
        <span style={detailLabelStyle}>
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <select
          id={id}
          className="wx-select"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          style={selectStyle}
        >
          <option value="">Select…</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label
      htmlFor={id}
      style={{ ...fieldRowStyle, flexDirection: "column", alignItems: "stretch" }}
    >
      <span style={detailLabelStyle}>{field.label}</span>
      <textarea
        id={id}
        rows={3}
        maxLength={4000}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function DetailField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={detailLabelStyle}>{label}</span>
      <span style={{ color: "var(--color-on-surface)" }}>{value}</span>
    </div>
  );
}

function statusLabel(status: ReviewRow["status"]): string {
  return status === "created" ? "Pending" : humanize(status);
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * D19 — the patient shown for a review: "First L. (MRN ...1234)" when the server returned the display name (only for
 * a caller holding `mortality.read_with_patient`), else the short patient id.
 */
export function patientLabel(r: {
  patientId: string;
  patientDisplayName?: string;
  patientMrnSuffix?: string | null;
}): string {
  if (!r.patientDisplayName) return shortId(r.patientId);
  return r.patientMrnSuffix
    ? `${r.patientDisplayName} (MRN ...${r.patientMrnSuffix})`
    : r.patientDisplayName;
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
const toolbarEyebrowStyle = { color: "var(--color-on-surface-variant)", fontSize: "0.75rem" };
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};
const tableWrapStyle = { width: "100%", overflowX: "auto" as const, padding: "0 1.5rem 1.5rem" };
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
};
const thStyle = { padding: "0.625rem 1rem", fontWeight: 600, fontSize: "0.75rem" };
const tdStyle = { padding: "0.75rem 1rem", verticalAlign: "middle" as const };
const detailLabelStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.6875rem",
  fontWeight: 650,
};
const fieldsetStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  borderRadius: "var(--radius-md)",
  padding: "0.75rem",
};
const legendStyle = { fontWeight: 600, padding: "0 0.25rem" };
const fieldRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
