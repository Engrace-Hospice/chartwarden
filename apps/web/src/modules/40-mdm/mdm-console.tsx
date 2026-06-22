import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/40-mdm — Master Data Management console (M40, Track A).
// Spec: docs/ui/screens/admin/WARDENX_UI_MASTER_DATA_MDM.md — "Use Work Queue."
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
                {k.replace(/_/g, " ")}
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
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Name</th>
            <th style={th}>Identifier</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              onClick={() => onSelect(r)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(r);
                }
              }}
              style={{
                cursor: "pointer",
                background: r.id === selectedId ? "#eff6ff" : undefined,
                borderTop: "1px solid #f3f4f6",
              }}
            >
              <td style={td}>{r.canonical.displayName}</td>
              <td style={td}>
                {r.canonical.identifierValue ? (
                  `${r.canonical.identifierType}: ${r.canonical.identifierValue}`
                ) : (
                  <span style={{ color: "#9ca3af" }}>provisional</span>
                )}
              </td>
              <td style={td}>{r.status}</td>
            </tr>
          ))}
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
  const row = (label: string, value: string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: "0.85rem", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
  return (
    <RightDetailPanel title={entity.canonical.displayName} onClose={onClose}>
      {row("Kind", kind.replace(/_/g, " "))}
      {row("Canonical id", entity.canonical.id)}
      {row(
        "Identifier",
        entity.canonical.identifierValue
          ? `${entity.canonical.identifierType}: ${entity.canonical.identifierValue}`
          : "— (provisional)",
      )}
      {row("Status", entity.status)}
    </RightDetailPanel>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
