import {
  EmptyState,
  FilterBar,
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

// Wire shape mirrored from apps/backend/.../audit-typebox.ts LegalHoldSchema (UI owns its copy).
interface LegalHold {
  id: string;
  name: string;
  criteria: {
    patientIds?: string[];
    dateRange?: { from: string; to: string };
    resourceKinds?: string[];
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

export function LegalHolds(): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [status, setStatus] = useState<"" | LegalHold["status"]>("active");
  const [items, setItems] = useState<LegalHold[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LegalHold | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: 50 };
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
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, status],
  );

  useEffect(() => {
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
            actions={
              <button type="button" onClick={() => setShowCreate(true)}>
                New Hold
              </button>
            }
          />
        }
        filters={
          <FilterBar>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as "" | LegalHold["status"])}
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="released">Released</option>
            </select>
          </FilterBar>
        }
        table={
          <HoldsTable
            items={items}
            loading={loading}
            error={error}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
          />
        }
        detail={
          selected ? (
            <HoldDetail hold={selected} onClose={() => setSelected(null)} onReleased={handleReleased} />
          ) : undefined
        }
      />
      {showCreate ? (
        <CreateHoldModal
          onClose={() => setShowCreate(false)}
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
  error,
  selectedId,
  onSelect,
  onLoadMore,
}: {
  items: LegalHold[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (h: LegalHold) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No legal holds" description="No holds match the current filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Reason</th>
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
                cursor: "pointer",
                background: h.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td>{h.name}</td>
              <td>
                <StatusPill
                  label={h.status === "active" ? "Active" : "Released"}
                  tone={STATUS_TONE[h.status]}
                />
              </td>
              <td className="tabular-nums">{new Date(h.appliedAt).toLocaleString()}</td>
              <td style={{ maxWidth: "24rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                {h.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onLoadMore ? (
        <div style={{ marginTop: "1rem", textAlign: "center" }}>
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
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
  const [releaseReason, setReleaseReason] = useState("");
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
    if (err || !data) {
      setReleaseError(err?.error?.message ?? "The hold could not be released.");
      toast.show("Could not release hold.", { tone: "error" });
      return;
    }
    onReleased(hold.id, data.restoredRecordCount);
  }, [client, hold.id, releaseReason, onReleased, toast]);

  const row = (fieldLabel: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
        {fieldLabel}
      </div>
      <div style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}>
        {value}
      </div>
    </div>
  );

  return (
    <RightDetailPanel title="Legal hold detail" onClose={onClose}>
      {row("Name", hold.name)}
      {row(
        "Status",
        <StatusPill
          label={hold.status === "active" ? "Active" : "Released"}
          tone={STATUS_TONE[hold.status]}
        />,
      )}
      {row("Applied", <span className="tabular-nums">{new Date(hold.appliedAt).toLocaleString()}</span>)}
      {hold.releasedAt
        ? row("Released", <span className="tabular-nums">{new Date(hold.releasedAt).toLocaleString()}</span>)
        : null}
      {row("Reason", hold.reason)}
      {hold.criteria.patientIds?.length
        ? row("Patients", `${hold.criteria.patientIds.length} patient(s)`)
        : null}
      {hold.criteria.resourceKinds?.length
        ? row("Resource kinds", hold.criteria.resourceKinds.join(", "))
        : null}
      {hold.criteria.dateRange
        ? row(
            "Date range",
            `${new Date(hold.criteria.dateRange.from).toLocaleDateString()} – ${new Date(hold.criteria.dateRange.to).toLocaleDateString()}`,
          )
        : null}
      {hold.status === "active" ? (
        <div style={{ marginTop: "1rem", borderTop: "1px solid var(--color-outline)", paddingTop: "1rem" }}>
          <label htmlFor="release-reason" style={{ fontSize: "0.8rem" }}>
            Release reason
          </label>
          <textarea
            id="release-reason"
            value={releaseReason}
            onChange={(e) => setReleaseReason(e.target.value)}
            rows={3}
            style={{ width: "100%", marginTop: "0.25rem" }}
          />
          {releaseError ? (
            <p style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>{releaseError}</p>
          ) : null}
          <button type="button" onClick={release} disabled={busy} style={{ marginTop: "0.5rem" }}>
            {busy ? "Releasing…" : "Release hold"}
          </button>
        </div>
      ) : null}
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
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [patientIds, setPatientIds] = useState("");
  const [resourceKinds, setResourceKinds] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
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
    const dateRange = from && to ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : undefined;
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
    if (err || !data) {
      setError(err?.error?.message ?? "The hold could not be applied.");
      return;
    }
    onCreated(data.matchedRecordCount);
  }, [client, name, reason, patientIds, resourceKinds, from, to, onCreated]);

  return (
    <Modal open onClose={onClose} ariaLabel="Apply a legal hold">
      <h2 style={{ marginTop: 0 }}>Apply a legal hold</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>
          Reason (min. 10 characters)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={{ width: "100%" }} />
        </label>
        <label>
          Patient ids (comma-separated, optional)
          <input value={patientIds} onChange={(e) => setPatientIds(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>
          Resource kinds (comma-separated, optional)
          <input value={resourceKinds} onChange={(e) => setResourceKinds(e.target.value)} style={{ width: "100%" }} />
        </label>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <label style={{ flex: 1 }}>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "100%" }} />
          </label>
        </div>
        {error ? <p style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>{error}</p> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy}>
            {busy ? "Applying…" : "Apply hold"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
