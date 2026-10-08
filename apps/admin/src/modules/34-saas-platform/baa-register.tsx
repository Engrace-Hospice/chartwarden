import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDebouncedValue,
  useDrawerA11y,
  useRequestGuard,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — Platform-tenant BAA register (M34, §3.8 / D11, platform-ops surface).
// Spec: docs/design/screens — M34 §5.1 screen inventory. "Use Work Queue."
// Lists the platform→tenant Business Associate Agreement records across tenants (DISTINCT from M40's
// tenant→external register) via GET /api/v1/platform/baa-register, by tenant / addendum version /
// status / expiration, with BAA-status pills. Read-only here; execution/attestation are separate
// command surfaces. Imports only leaves (@wardenx/ui) + the shared M34 tone maps. Laid out as the
// redesign's list + right drawer (outbox is the reference).
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { PLATFORM_BAA_TONE, statusLabel } from "./saas-status";

// §3.8 wire enum (platform-typebox `BAA_STATUS`) — the UI owns its copy.
const BAA_STATUSES = ["executed", "pending", "terminated", "missing"] as const;
type BaaStatus = (typeof BAA_STATUSES)[number];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  ...BAA_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
];

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

const filterKey = (select: string, text: string): string => `${select}\u0000${text.trim()}`;

export function BaaRegister(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<BaaStatus | "">("");
  const [tenantFilter, setTenantFilter] = useState("");
  // Typing must not refetch per keystroke; Enter applies the raw text immediately.
  const debouncedTenant = useDebouncedValue(tenantFilter);
  const guard = useRequestGuard();
  const [records, setRecords] = useState<BaaRecordView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BaaRecordView | null>(null);

  // The filter the list was last fetched with: Enter/Apply/Refresh load the typed text at once, and the debounced value then
  // catches up to the same text — without this the effect would fetch the identical query a second time.
  const loadedKey = useRef<string | null>(null);

  const load = useCallback(
    async (tenant: string = debouncedTenant) => {
      const isCurrent = guard();
      loadedKey.current = filterKey(status, tenant);
      setLoading(true);
      setError(null);
      const query: NonNullable<
        paths["/api/v1/platform/baa-register"]["get"]["parameters"]["query"]
      > = { limit: 50 };
      if (status) query.status = status as typeof query.status;
      if (tenant.trim()) query.tenantAccountId = tenant.trim();
      const { data, error: err } = await client.GET("/api/v1/platform/baa-register", {
        params: { query },
      });
      if (!isCurrent()) return;
      if (err) {
        setError("Could not load the BAA register.");
        setLoading(false);
        return;
      }
      const page = data as BaaRegisterPage | undefined;
      setRecords(page?.items ?? []);
      setLoading(false);
    },
    [client, guard, status, debouncedTenant],
  );

  useEffect(() => {
    if (loadedKey.current === filterKey(status, debouncedTenant)) return;
    void load();
  }, [load, status, debouncedTenant]);

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>BAA register</h1>
            <p>Platform-to-tenant business associate agreements, by addendum, status and expiry.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button tone="secondary" onClick={() => void load(tenantFilter)}>
              <Glyph name="rotate-ccw" size={15} /> Refresh
            </Button>
          </div>
        </header>

        <div className="wx-list-toolbar">
          <div className="grid w-full gap-3 md:grid-cols-2">
            <SelectField
              label="BAA status"
              value={status}
              options={STATUS_OPTIONS}
              onChange={(e) => setStatus(e.target.value as BaaStatus | "")}
            />
            <TextField
              label="Tenant account id"
              placeholder="Optional"
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load(tenantFilter);
              }}
            />
          </div>
        </div>

        <RegisterTable
          items={records}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onRetry={() => void load()}
        />
      </div>
      {selected ? <RecordDrawer record={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

/** A date-only expiry, flagged in the error colour once it has passed. */
function ExpiresOn({ record }: { record: BaaRecordView }): JSX.Element {
  if (!record.expiresOn) return <>—</>;
  const expired = isExpired(record);
  return (
    <span className={expired ? "wx-nums text-[var(--color-error)]" : "wx-nums"}>
      {record.expiresOn}
      {expired ? " (expired)" : ""}
    </span>
  );
}

function RegisterTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: BaaRecordView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (r: BaaRecordView) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading the BAA register…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="file-check" size={24} />
        <span>No agreements match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Business associate agreements</caption>
        <thead>
          <tr>
            <th scope="col">Tenant account</th>
            <th scope="col">Status</th>
            <th scope="col">Effective</th>
            <th scope="col">Expires</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const isSelected = r.id === selectedId;
            const open = (): void => onSelect(r);
            return (
              <tr
                key={r.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(open, isSelected)}
              >
                <td>
                  <span className="wx-row-title wx-data-md">{r.tenantAccountId}</span>
                  <span className="wx-row-sub">
                    Addendum <span className="wx-data-md">{r.addendumVersion}</span>
                  </span>
                </td>
                <td>
                  <StatusPill
                    label={statusLabel(r.baaStatus)}
                    tone={PLATFORM_BAA_TONE[r.baaStatus] ?? "neutral"}
                  />
                </td>
                <td className="wx-nums">{r.effectiveOn ?? "—"}</td>
                <td>
                  <ExpiresOn record={r} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordDrawer({
  record,
  onClose,
}: {
  record: BaaRecordView;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" aria-label="BAA record" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="file-check" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>Addendum {record.addendumVersion}</h2>
          <span className="wx-row-sub wx-data-md">{record.tenantAccountId}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Agreement</h3>
            <StatusPill
              label={statusLabel(record.baaStatus)}
              tone={PLATFORM_BAA_TONE[record.baaStatus] ?? "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Tenant account</dt>
            <dd className="wx-data-md break-words">{record.tenantAccountId}</dd>
            <dt>Organization</dt>
            <dd className="wx-data-md break-words">{record.organizationId}</dd>
            <dt>Executed</dt>
            <dd className="wx-nums">{record.executedOn ?? "—"}</dd>
            <dt>Effective</dt>
            <dd className="wx-nums">{record.effectiveOn ?? "—"}</dd>
            <dt>Expires</dt>
            <dd>
              <ExpiresOn record={record} />
            </dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Evidence</h3>
          <dl className="wx-kv">
            <dt>Document</dt>
            <dd className={record.documentId ? "wx-data-md break-words" : undefined}>
              {record.documentId ?? "— (none linked)"}
            </dd>
            <dt>Attested</dt>
            <dd className={record.attestedAt ? "wx-nums" : undefined}>
              {record.attestedAt
                ? new Date(record.attestedAt).toLocaleString()
                : "— (not attested)"}
            </dd>
          </dl>
        </section>
      </div>
    </aside>
  );
}
