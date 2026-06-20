// apps/web/src/modules/38-terminology — Terminology Admin (M38, Track A).
// Spec: docs/ui/screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md — "Use Work Queue."
// Search concepts within a code system; view a concept's detail. Backed by
// GET /api/v1/terminology/:system/search via the generated typed client. Imports only leaves.
import { useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";

// Phase-1 code systems (§7.8: cpt deliberately absent) — UI owns its copy of the wire enum.
const SYSTEMS = ["icd10cm", "icd10pcs", "snomed", "loinc", "rxnorm", "ndc", "hcpcs", "cvx", "revenue", "carc", "rarc"] as const;
type System = (typeof SYSTEMS)[number];

interface Concept {
  systemId: string;
  code: string;
  display: string;
  status: "active" | "deprecated" | "retired";
  effectiveDate: string;
  endDate: string | null;
}

const statusColor: Record<Concept["status"], string> = {
  active: "#15803d",
  deprecated: "#b45309",
  retired: "#6b7280",
};

export function TerminologyAdmin(): JSX.Element {
  const client = useApiClient();
  const [system, setSystem] = useState<System>("icd10cm");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Concept[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Concept | null>(null);

  async function search(): Promise<void> {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    setSelected(null);
    const { data, error: err } = await client.GET("/api/v1/terminology/{system}/search", {
      params: { path: { system }, query: { q: q.trim(), limit: 50 } },
    });
    if (err) {
      setError("Search failed.");
      setLoading(false);
      return;
    }
    setResults((data?.results ?? []) as Concept[]);
    setLoading(false);
  }

  return (
    <WorkQueueLayout
      header={<PageHeader title="Terminology" />}
      filters={
        <FilterBar actions={<button type="button" onClick={() => void search()}>Search</button>}>
          <select aria-label="Code system" value={system} onChange={(e) => setSystem(e.target.value as System)}>
            {SYSTEMS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            aria-label="Search concepts"
            placeholder="Code or term"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
          />
        </FilterBar>
      }
      table={
        <ConceptTable
          results={results}
          loading={loading}
          error={error}
          selectedCode={selected?.code ?? null}
          onSelect={setSelected}
        />
      }
      detail={selected ? <ConceptDetail concept={selected} onClose={() => setSelected(null)} /> : undefined}
    />
  );
}

function ConceptTable({
  results,
  loading,
  error,
  selectedCode,
  onSelect,
}: {
  results: Concept[] | null;
  loading: boolean;
  error: string | null;
  selectedCode: string | null;
  onSelect: (c: Concept) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (results === null) return <EmptyState title="Search a code system" description="Pick a system and enter a code or term." />;
  if (results.length === 0) return <EmptyState title="No concepts" description="No concepts match this search." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Code</th>
            <th style={th}>Display</th>
            <th style={th}>Status</th>
            <th style={th}>Effective</th>
          </tr>
        </thead>
        <tbody>
          {results.map((c) => (
            <tr key={`${c.systemId}:${c.code}`} onClick={() => onSelect(c)} style={{ cursor: "pointer", background: c.code === selectedCode ? "#eff6ff" : undefined, borderTop: "1px solid #f3f4f6" }}>
              <td style={{ ...td, fontFamily: "monospace" }}>{c.code}</td>
              <td style={td}>{c.display}</td>
              <td style={{ ...td, color: statusColor[c.status] }}>{c.status}</td>
              <td style={td}>{c.effectiveDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConceptDetail({ concept, onClose }: { concept: Concept; onClose: () => void }): JSX.Element {
  const row = (label: string, value: string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: "0.85rem", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
  return (
    <RightDetailPanel title={concept.code} onClose={onClose}>
      {row("System", concept.systemId)}
      {row("Display", concept.display)}
      {row("Status", concept.status)}
      {row("Effective", concept.effectiveDate)}
      {row("End", concept.endDate ?? "—")}
    </RightDetailPanel>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
