import {
  Button,
  CursorPagination,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
  useToast,
} from "@wardenx/ui";
// apps/web/src/modules/04-audit — Legal Holds (GAP-003, M4 spec §4.2/§10.6).
// List + apply + release, over the real routes GET/POST /api/v1/legal-holds,
// POST /api/v1/legal-holds/:id/release via the generated typed client. Imports only leaves.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";

// Wire shape mirrored from apps/backend/.../audit-typebox.ts LegalHoldSchema (UI owns its copy).
interface LegalHold {
  id: string;
  name: string;
  criteria: {
    patientIds?: string[];
    dateRange?: { from: string; to: string };
    resourceKinds?: string[];
    channelIds?: string[];
    userIds?: string[];
  };
  status: "active" | "released";
  reason: string;
  appliedBy: string | null;
  appliedAt: string;
  releasedAt: string | null;
}

const STATUS_TONE: Record<LegalHold["status"], StatusTone> = {
  active: "warning",
  released: "neutral",
};
// Apply and release need a fresh step-up (WP 5.6): what the user typed survives the /step-up round trip.
const CREATE_DRAFT_KEY = "legal-hold-create";
const RELEASE_DRAFT_KEY = "legal-hold-release";
interface CreateDraft {
  name: string;
  reason: string;
  patientIds: string;
  resourceKinds: string;
  from: string;
  to: string;
}
interface ReleaseDraft {
  holdId: string;
  reason: string;
}
const LEGAL_HOLD_PAGE_SIZES = [25, 50, 100] as const;

export function LegalHolds(): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [status, setStatus] = useState<"" | LegalHold["status"]>("active");
  const [items, setItems] = useState<LegalHold[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LegalHold | null>(null);
  const [showCreate, setShowCreate] = useState(() => peekStepUpDraft(CREATE_DRAFT_KEY) !== null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: pageSize };
      if (status) query.status = status;
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/legal-holds", { params: { query } });
      if (err) {
        setError("Could not load legal holds.");
        setLoading(false);
        return;
      }
      const page = (data?.items ?? []) as LegalHold[];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      const resume = peekStepUpDraft<ReleaseDraft>(RELEASE_DRAFT_KEY);
      const resumed = resume ? page.find((h) => h.id === resume.holdId) : undefined;
      if (resumed) setSelected(resumed);
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, status, pageSize],
  );

  useEffect(() => {
    setSelected(null);
    void load();
  }, [load]);

  const handleReleased = useCallback(
    (id: string, restoredRecordCount: number) => {
      setItems((prev) => prev.filter((h) => h.id !== id));
      setSelected(null);
      toast.show(`Hold released — ${restoredRecordCount} record(s) restored.`, { tone: "success" });
    },
    [toast],
  );

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Legal Holds"
            breadcrumb="Compliance / Records"
            actions={
              <Button tone="primary" onClick={() => setShowCreate(true)}>
                New Hold
              </Button>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Apply and release preservation locks across patient records, audit artifacts, and
              regulated retention classes.
            </div>
          </PageHeader>
        }
        filters={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              padding: "0 1.5rem 0.75rem",
            }}
          >
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

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <div className="wx-subtabs wx-subtabs-inline" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={status === "active"}
                  onClick={() => setStatus("active")}
                >
                  Active
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={status === "released"}
                  onClick={() => setStatus("released")}
                >
                  Released
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={status === ""}
                  onClick={() => setStatus("")}
                >
                  All
                </button>
              </div>

              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
              >
                <select
                  aria-label="Legal holds per page"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  {LEGAL_HOLD_PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} per page
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        }
        table={
          <HoldsTable
            items={items}
            loading={loading}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
            status={status}
          />
        }
        detail={
          selected ? (
            <HoldDetail
              hold={selected}
              onClose={() => {
                clearStepUpDraft(RELEASE_DRAFT_KEY);
                setSelected(null);
              }}
              onReleased={handleReleased}
            />
          ) : null
        }
        fullPageScroll
      />
      {showCreate ? (
        <CreateHoldModal
          onClose={() => {
            clearStepUpDraft(CREATE_DRAFT_KEY);
            setShowCreate(false);
          }}
          onCreated={(count) => {
            setShowCreate(false);
            toast.show(`Hold applied — ${count} record(s) matched.`, { tone: "success" });
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function HoldsTable({
  items,
  loading,
  selectedId,
  onSelect,
  onLoadMore,
  status,
}: {
  items: LegalHold[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (h: LegalHold) => void;
  onLoadMore?: () => void;
  status: "" | LegalHold["status"];
}): JSX.Element {
  if (loading && items.length === 0)
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  if (items.length === 0)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="No legal holds"
          description={
            status
              ? `No ${status} legal holds match the current view.`
              : "No legal holds match the current view."
          }
        />
      </div>
    );
  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
      <table
        style={{
          display: "table",
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.875rem",
        }}
      >
        <thead>
          <tr style={tableHeaderRowStyle}>
            <th style={{ ...thStyle, width: "28%" }}>Hold</th>
            <th style={{ ...thStyle, width: "12%" }}>Status</th>
            <th style={{ ...thStyle, width: "18%" }}>Applied</th>
            <th style={{ ...thStyle, width: "18%" }}>Criteria</th>
            <th style={{ ...thStyle, width: "24%" }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {items.map((h) => (
            <tr
              key={h.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={h.id === selectedId}
              onClick={() => onSelect(h)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(h);
                }
              }}
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                cursor: "pointer",
                background: h.id === selectedId ? "var(--color-primary-tint)" : undefined,
                transition: "background 0.15s ease",
              }}
              className="wx-data-row-interactive"
            >
              <td style={tdStyle}>
                <div style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>{h.name}</div>
                <div className="wx-data-md" style={mutedCodeStyle}>
                  {h.id}
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={h.status === "active" ? "Active" : "Released"}
                  tone={STATUS_TONE[h.status]}
                />
              </td>
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {formatDateTime(h.appliedAt)}
              </td>
              <td style={tdStyle}>
                <CriteriaSummary hold={h} />
              </td>
              <td style={tdStyle}>
                <div style={reasonPreviewStyle}>{h.reason}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CursorPagination
        loadedCount={items.length}
        hasNextPage={Boolean(onLoadMore)}
        onNextPage={onLoadMore}
        loading={loading}
        noun="legal holds"
      />
    </div>
  );
}

function CriteriaSummary({ hold }: { hold: LegalHold }): JSX.Element {
  const parts = [
    hold.criteria.patientIds?.length ? `${hold.criteria.patientIds.length} patients` : null,
    hold.criteria.resourceKinds?.length
      ? `${hold.criteria.resourceKinds.length} resource kinds`
      : null,
    hold.criteria.dateRange ? "date range" : null,
  ].filter(Boolean);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
      {parts.length ? (
        parts.map((part) => (
          <span key={part} style={criteriaChipStyle}>
            {part}
          </span>
        ))
      ) : (
        <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8rem" }}>—</span>
      )}
    </div>
  );
}

function HoldDetail({
  hold,
  onClose,
  onReleased,
}: {
  hold: LegalHold;
  onClose: () => void;
  onReleased: (id: string, restoredRecordCount: number) => void;
}): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [releaseReason, setReleaseReason] = useState(() => {
    const draft = peekStepUpDraft<ReleaseDraft>(RELEASE_DRAFT_KEY);
    return draft?.holdId === hold.id ? draft.reason : "";
  });
  const [busy, setBusy] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const release = useCallback(async () => {
    if (releaseReason.trim().length < 10) {
      setReleaseError("Release reason must be at least 10 characters.");
      return;
    }
    setBusy(true);
    setReleaseError(null);
    const { data, error: err } = await client.POST("/api/v1/legal-holds/{id}/release", {
      params: { path: { id: hold.id } },
      body: { reason: releaseReason.trim() },
    });
    setBusy(false);
    const stepUp = err ? stepUpRedirectFor(err, `${location.pathname}${location.search}`) : null;
    if (stepUp) {
      stashStepUpDraft(RELEASE_DRAFT_KEY, { holdId: hold.id, reason: releaseReason });
      navigate(stepUp);
      return;
    }
    if (err || !data) {
      setReleaseError(err?.error?.message ?? "The hold could not be released.");
      toast.show("Could not release hold.", { tone: "error" });
      return;
    }
    clearStepUpDraft(RELEASE_DRAFT_KEY);
    onReleased(hold.id, data.restoredRecordCount);
  }, [client, hold.id, releaseReason, onReleased, toast, navigate, location]);

  const row = (fieldLabel: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
        {fieldLabel}
      </div>
      <div
        style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}
      >
        {value}
      </div>
    </div>
  );

  return (
    <RightDetailPanel title="Legal hold detail" onClose={onClose} hideScrollbar>
      <div
        style={{ display: "flex", flexDirection: "column", gap: "1.25rem", paddingTop: "0.5rem" }}
      >
        <div style={detailHeaderStyle}>
          <div style={holdIconStyle}>
            <Glyph name="lock" size={20} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "1.05rem", color: "var(--color-on-surface)" }}>
              {hold.name}
            </div>
            <div className="wx-data-md" style={mutedCodeStyle}>
              {hold.id}
            </div>
            <div style={{ marginTop: "0.4rem" }}>
              <StatusPill
                label={hold.status === "active" ? "Active" : "Released"}
                tone={STATUS_TONE[hold.status]}
              />
            </div>
          </div>
        </div>

        <div style={detailSectionStyle}>
          {row("Name", hold.name)}
          {row(
            "Status",
            <StatusPill
              label={hold.status === "active" ? "Active" : "Released"}
              tone={STATUS_TONE[hold.status]}
            />,
          )}
          {row(
            "Applied",
            <span className="tabular-nums">{new Date(hold.appliedAt).toLocaleString()}</span>,
          )}
          {hold.releasedAt
            ? row(
                "Released",
                <span className="tabular-nums">{new Date(hold.releasedAt).toLocaleString()}</span>,
              )
            : null}
          {row("Reason", hold.reason)}
          {hold.criteria.patientIds?.length
            ? row("Patients", `${hold.criteria.patientIds.length} patient(s)`)
            : null}
          {hold.criteria.resourceKinds?.length
            ? row("Resource kinds", hold.criteria.resourceKinds.join(", "))
            : null}
          {hold.criteria.channelIds?.length
            ? row("Channels", `${hold.criteria.channelIds.length} channel(s)`)
            : null}
          {hold.criteria.userIds?.length
            ? row("People", `${hold.criteria.userIds.length} person(s)`)
            : null}
          {hold.criteria.dateRange
            ? row(
                "Date range",
                `${new Date(hold.criteria.dateRange.from).toLocaleDateString()} – ${new Date(hold.criteria.dateRange.to).toLocaleDateString()}`,
              )
            : null}
        </div>
        {hold.status === "active" ? (
          <div style={releaseSectionStyle}>
            <h4 style={sectionHeadingStyle}>Release Hold</h4>
            <label htmlFor="release-reason" style={fieldLabelStyle}>
              Release reason
            </label>
            <textarea
              id="release-reason"
              value={releaseReason}
              onChange={(e) => setReleaseReason(e.target.value)}
              rows={3}
              style={{ width: "100%", marginTop: "0.25rem", resize: "vertical" }}
            />
            {releaseError ? (
              <p style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>{releaseError}</p>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.75rem" }}>
              <Button type="button" tone="danger" size="sm" onClick={release} disabled={busy}>
                {busy ? "Releasing..." : "Release hold"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </RightDetailPanel>
  );
}

function CreateHoldModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (matchedRecordCount: number) => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft] = useState(() => peekStepUpDraft<CreateDraft>(CREATE_DRAFT_KEY));
  const [name, setName] = useState(draft?.name ?? "");
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [patientIds, setPatientIds] = useState(draft?.patientIds ?? "");
  const [resourceKinds, setResourceKinds] = useState(draft?.resourceKinds ?? "");
  const [from, setFrom] = useState(draft?.from ?? "");
  const [to, setTo] = useState(draft?.to ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    if (name.trim().length === 0) {
      setError("Name is required.");
      return;
    }
    if (reason.trim().length < 10) {
      setError("Reason must be at least 10 characters.");
      return;
    }
    const patientIdList = patientIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const resourceKindList = resourceKinds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const dateRange =
      from && to
        ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
        : undefined;
    if (patientIdList.length === 0 && resourceKindList.length === 0 && !dateRange) {
      setError("Specify at least one of patients, resource kinds, or a date range.");
      return;
    }
    setBusy(true);
    const { data, error: err } = await client.POST("/api/v1/legal-holds", {
      body: {
        name: name.trim(),
        reason: reason.trim(),
        criteria: {
          ...(patientIdList.length ? { patientIds: patientIdList } : {}),
          ...(resourceKindList.length ? { resourceKinds: resourceKindList } : {}),
          ...(dateRange ? { dateRange } : {}),
        },
      },
    });
    setBusy(false);
    const stepUp = err ? stepUpRedirectFor(err, `${location.pathname}${location.search}`) : null;
    if (stepUp) {
      stashStepUpDraft(CREATE_DRAFT_KEY, { name, reason, patientIds, resourceKinds, from, to });
      navigate(stepUp);
      return;
    }
    if (err || !data) {
      setError(err?.error?.message ?? "The hold could not be applied.");
      return;
    }
    clearStepUpDraft(CREATE_DRAFT_KEY);
    onCreated(data.matchedRecordCount);
  }, [client, name, reason, patientIds, resourceKinds, from, to, onCreated, navigate, location]);

  return (
    <Modal open onClose={onClose} ariaLabel="Apply a legal hold">
      <div style={modalContentStyle}>
        <div>
          <h2 style={modalTitleStyle}>Apply a legal hold</h2>
          <p style={modalDescriptionStyle}>
            Define the records that must be preserved from retention jobs and destructive workflows.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <label style={fieldLabelStyle}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
          </label>
          <label style={fieldLabelStyle}>
            Reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={{ ...fieldInputStyle, resize: "vertical" }}
            />
          </label>
          <label style={fieldLabelStyle}>
            Patient IDs
            <input
              value={patientIds}
              onChange={(e) => setPatientIds(e.target.value)}
              placeholder="Comma-separated UUIDs"
              style={fieldInputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            Resource kinds
            <input
              value={resourceKinds}
              onChange={(e) => setResourceKinds(e.target.value)}
              placeholder="patient, document, audit_event"
              style={fieldInputStyle}
            />
          </label>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <label style={{ ...fieldLabelStyle, flex: "1 1 10rem" }}>
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={fieldInputStyle}
              />
            </label>
            <label style={{ ...fieldLabelStyle, flex: "1 1 10rem" }}>
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={fieldInputStyle}
              />
            </label>
          </div>
        </div>

        {error ? (
          <div role="alert" style={modalErrorStyle}>
            {error}
          </div>
        ) : null}

        <div style={modalActionsStyle}>
          <Button type="button" tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" tone="primary" onClick={submit} disabled={busy}>
            {busy ? "Applying..." : "Apply hold"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const tableHeaderRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
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

const reasonPreviewStyle = {
  maxWidth: "24rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface)",
};

const criteriaChipStyle = {
  padding: "0.15rem 0.4rem",
  borderRadius: "9999px",
  fontSize: "0.75rem",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
};

const detailHeaderStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.875rem",
  paddingBottom: "1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const holdIconStyle = {
  width: "2.75rem",
  height: "2.75rem",
  borderRadius: "9999px",
  background: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
  color: "var(--color-warning)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const detailSectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const releaseSectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  paddingTop: "1rem",
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const sectionHeadingStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};

const fieldLabelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.375rem",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const fieldInputStyle = {
  width: "100%",
  padding: "0.5rem 0.75rem",
};

const modalContentStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1.25rem",
  padding: "1.5rem",
};

const modalTitleStyle = {
  margin: 0,
  fontSize: "1.125rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const modalDescriptionStyle = {
  margin: "0.35rem 0 0",
  fontSize: "0.875rem",
  color: "var(--color-on-surface-variant)",
};

const modalErrorStyle = {
  padding: "0.625rem 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 28%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};

const modalActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  paddingTop: "0.5rem",
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};
