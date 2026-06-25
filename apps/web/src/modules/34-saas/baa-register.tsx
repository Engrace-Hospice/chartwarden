import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/34-saas — Platform-tenant BAA register (M34, §3.8 / D11, platform-ops surface).
// Spec: docs/design/screens — M34 §5.1 screen inventory. "Use Work Queue."
// Lists the platform→tenant Business Associate Agreement records across tenants (DISTINCT from M40's
// tenant→external register) via GET /api/v1/platform/baa-register, by tenant / addendum version /
// status / expiration, with BAA-status pills. Read-only here; execution/attestation are separate
// command surfaces. Imports only leaves (@wardenx/ui) + the shared M34 tone maps.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { PLATFORM_BAA_TONE, statusLabel } from "./saas-status";

// §3.8 wire enum (platform-typebox `BAA_STATUS`) — the UI owns its copy.
const BAA_STATUSES = ["executed", "pending", "terminated", "missing"] as const;
type BaaStatus = (typeof BAA_STATUSES)[number];

// The `BaaRecordViewSchema` read shape the route serves (CursorPageOf<BaaRecordView>).
interface BaaRecordView {
  id: string;
  organizationId: string;
  tenantAccountId: string;
  addendumVersion: string;
  baaStatus: BaaStatus;
  executedOn: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  documentId: string | null;
  attestedAt: string | null;
}
interface BaaRegisterPage {
  items: BaaRecordView[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Expiration as a plain calendar comparison — the register carries date-only `expiresOn`.
const isExpired = (r: BaaRecordView): boolean =>
  r.expiresOn !== null && new Date(r.expiresOn).getTime() < Date.now();

export function BaaRegister(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<BaaStatus | "">("");
  const [tenantFilter, setTenantFilter] = useState("");
  const [records, setRecords] = useState<BaaRecordView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BaaRecordView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: Record<string, string | number> = { limit: 50 };
    if (status) query.status = status;
    if (tenantFilter.trim()) query.tenantAccountId = tenantFilter.trim();
    const { data, error: err } = await client.GET("/api/v1/platform/baa-register", {
      params: { query } as never,
    });
    if (err) {
      setError("Could not load the BAA register.");
      setLoading(false);
      return;
    }
    const page = data as BaaRegisterPage | undefined;
    setRecords(page?.items ?? []);
    setLoading(false);
  }, [client, status, tenantFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="BAA Register" />}
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          }
        >
          <select
            aria-label="BAA status"
            value={status}
            onChange={(e) => setStatus(e.target.value as BaaStatus | "")}
          >
            <option value="">All statuses</option>
            {BAA_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <input
            aria-label="Filter by tenant account id"
            placeholder="Tenant account id (optional)"
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
          />
        </FilterBar>
      }
      table={
        <RegisterTable
          items={records}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      }
      detail={
        selected ? <RecordDetail record={selected} onClose={() => setSelected(null)} /> : undefined
      }
    />
  );
}

function RegisterTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: BaaRecordView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (r: BaaRecordView) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No BAA records" description="No agreements match this filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Tenant account</th>
            <th>Addendum</th>
            <th>Status</th>
            <th>Effective</th>
            <th>Expires</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const expired = isExpired(r);
            return (
              <tr
                key={r.id}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                aria-pressed={r.id === selectedId}
                onClick={() => onSelect(r)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(r);
                  }
                }}
                style={{
                  cursor: "pointer",
                  background: r.id === selectedId ? "var(--color-primary-tint)" : undefined,
                }}
              >
                <td className="wx-data-md">{r.tenantAccountId}</td>
                <td className="wx-data-md">{r.addendumVersion}</td>
                <td>
                  <StatusPill
                    label={statusLabel(r.baaStatus)}
                    tone={PLATFORM_BAA_TONE[r.baaStatus] ?? "neutral"}
                  />
                </td>
                <td className="tabular-nums">{r.effectiveOn ?? "—"}</td>
                <td className="tabular-nums">
                  {r.expiresOn ? (
                    <span style={{ color: expired ? "var(--color-error)" : undefined }}>
                      {r.expiresOn}
                      {expired ? " (expired)" : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordDetail({
  record,
  onClose,
}: {
  record: BaaRecordView;
  onClose: () => void;
}): JSX.Element {
  const row = (label: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
      <div
        style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}
      >
        {value}
      </div>
    </div>
  );
  return (
    <RightDetailPanel title={`Addendum ${record.addendumVersion}`} onClose={onClose}>
      {row("Tenant account", <span className="wx-data-md">{record.tenantAccountId}</span>)}
      {row("Organization", <span className="wx-data-md">{record.organizationId}</span>)}
      {row(
        "Status",
        <StatusPill
          label={statusLabel(record.baaStatus)}
          tone={PLATFORM_BAA_TONE[record.baaStatus] ?? "neutral"}
        />,
      )}
      {row("Executed", <span className="tabular-nums">{record.executedOn ?? "—"}</span>)}
      {row("Effective", <span className="tabular-nums">{record.effectiveOn ?? "—"}</span>)}
      {row(
        "Expires",
        record.expiresOn ? (
          <span
            className="tabular-nums"
            style={{ color: isExpired(record) ? "var(--color-error)" : undefined }}
          >
            {record.expiresOn}
            {isExpired(record) ? " (expired)" : ""}
          </span>
        ) : (
          "—"
        ),
      )}
      {row(
        "Document",
        record.documentId ? (
          <span className="wx-data-md">{record.documentId}</span>
        ) : (
          "— (none linked)"
        ),
      )}
      {row(
        "Attested",
        record.attestedAt ? (
          <span className="tabular-nums">{new Date(record.attestedAt).toLocaleString()}</span>
        ) : (
          "— (not attested)"
        ),
      )}
    </RightDetailPanel>
  );
}
