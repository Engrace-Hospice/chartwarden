import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/40-mdm — Master Data Management console (M40, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_MASTER_DATA_MDM.md — "Use Work Queue."
// Search a kind's canonical set, view a result's detail. Backed by GET /api/v1/mdm/:kind/search via
// the generated typed client. Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

// The closed MDM entity kinds (§2.3) — UI owns its copy of the wire enum.
const KINDS = [
  "physician",
  "facility",
  "payer",
  "pharmacy",
  "referral_source",
  "dme_vendor",
  "funeral_home",
] as const;
type Kind = (typeof KINDS)[number];

interface MdmResolvedSummary {
  id: string;
  status: "active" | "deactivated" | "provisional";
  canonical: {
    id: string;
    identifierType: string;
    identifierValue: string | null;
    displayName: string;
  };
}

// §6.6 canonical-record status → tone (the server owns the resolved status).
const STATUS_TONE: Record<MdmResolvedSummary["status"], StatusTone> = {
  active: "success",
  provisional: "warning",
  deactivated: "neutral",
};
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());
const kindLabel = (k: Kind): string => k.replace(/_/g, " ");
const identifier = (c: MdmResolvedSummary["canonical"]): string | null =>
  c.identifierValue ? `${c.identifierType}: ${c.identifierValue}` : null;

export function MdmConsole(): JSX.Element {
  const client = useApiClient();
  const [kind, setKind] = useState<Kind>("physician");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<MdmResolvedSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MdmResolvedSummary | null>(null);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(null);
    const query: Record<string, string | number> = { limit: 25 };
    if (q.trim()) query.q = q.trim();
    const { data, error: err } = await client.GET("/api/v1/mdm/{kind}/search", {
      params: { path: { kind }, query },
    });
    if (err) {
      setError("Search failed.");
      setLoading(false);
      return;
    }
    setResults((data?.results ?? []) as MdmResolvedSummary[]);
    setLoading(false);
  }, [client, kind, q]);

  // Load on mount + when the kind changes; the text query applies on submit (Enter / Search).
  useEffect(() => {
    void search();
  }, [search]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Master Data Management" />}
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => void search()}>
              Search
            </button>
          }
        >
          <select
            aria-label="Entity kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
          <input
            aria-label="Search name or identifier"
            placeholder="Name or identifier"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
          />
        </FilterBar>
      }
      table={
        <ResultsTable
          items={results}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      }
      detail={
        selected ? (
          <EntityDetail entity={selected} kind={kind} onClose={() => setSelected(null)} />
        ) : undefined
      }
    />
  );
}

function ResultsTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: MdmResolvedSummary[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (e: MdmResolvedSummary) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No matches" description="No canonical records match this search." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Identifier</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const id = identifier(r.canonical);
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
                <td>{r.canonical.displayName}</td>
                <td className="wx-data-md">
                  {id ?? (
                    <span style={{ color: "var(--color-on-surface-variant)" }}>provisional</span>
                  )}
                </td>
                <td>
                  <StatusPill label={cap(r.status)} tone={STATUS_TONE[r.status] ?? "neutral"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EntityDetail({
  entity,
  kind,
  onClose,
}: { entity: MdmResolvedSummary; kind: Kind; onClose: () => void }): JSX.Element {
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
  const id = identifier(entity.canonical);
  return (
    <RightDetailPanel title={entity.canonical.displayName} onClose={onClose}>
      {row("Kind", kindLabel(kind))}
      {row("Canonical id", <span className="wx-data-md">{entity.canonical.id}</span>)}
      {row("Identifier", id ? <span className="wx-data-md">{id}</span> : "— (provisional)")}
      {row(
        "Status",
        <StatusPill label={cap(entity.status)} tone={STATUS_TONE[entity.status] ?? "neutral"} />,
      )}
    </RightDetailPanel>
  );
}
