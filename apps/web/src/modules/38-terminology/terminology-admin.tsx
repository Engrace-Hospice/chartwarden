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
// apps/web/src/modules/38-terminology — Terminology Admin (M38, Track A).
// Spec: docs/design/screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md — "Use Work Queue."
// Search concepts within a code system; view a concept's detail. Backed by
// GET /api/v1/terminology/:system/search via the generated typed client. Imports only leaves.
import { useState } from "react";
import type { JSX } from "react";

// Phase-1 code systems (§7.8: cpt deliberately absent) — UI owns its copy of the wire enum.
const SYSTEMS = [
  "icd10cm",
  "icd10pcs",
  "snomed",
  "loinc",
  "rxnorm",
  "ndc",
  "hcpcs",
  "cvx",
  "revenue",
  "carc",
  "rarc",
] as const;
type System = (typeof SYSTEMS)[number];

interface Concept {
  systemId: string;
  code: string;
  display: string;
  status: "active" | "deprecated" | "retired";
  effectiveDate: string;
  endDate: string | null;
}

// §6.6 concept-status taxonomy → tone (the server owns the as-of-resolved status).
const STATUS_TONE: Record<string, StatusTone> = {
  active: "success",
  deprecated: "warning",
  retired: "neutral",
};
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

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
        <FilterBar
          actions={
            <button type="button" onClick={() => void search()}>
              Search
            </button>
          }
        >
          <select
            aria-label="Code system"
            value={system}
            onChange={(e) => setSystem(e.target.value as System)}
          >
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
      detail={
        selected ? (
          <ConceptDetail concept={selected} onClose={() => setSelected(null)} />
        ) : undefined
      }
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
  if (results === null)
    return (
      <EmptyState
        title="Search a code system"
        description="Pick a system and enter a code or term."
      />
    );
  if (results.length === 0)
    return <EmptyState title="No concepts" description="No concepts match this search." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Display</th>
            <th>Status</th>
            <th>Effective</th>
          </tr>
        </thead>
        <tbody>
          {results.map((c) => (
            <tr
              key={`${c.systemId}:${c.code}`}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={c.code === selectedCode}
              onClick={() => onSelect(c)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(c);
                }
              }}
              style={{
                cursor: "pointer",
                background: c.code === selectedCode ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td className="wx-data-md">{c.code}</td>
              <td>{c.display}</td>
              <td>
                <StatusPill label={cap(c.status)} tone={STATUS_TONE[c.status] ?? "neutral"} />
              </td>
              <td className="tabular-nums">{c.effectiveDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConceptDetail({
  concept,
  onClose,
}: { concept: Concept; onClose: () => void }): JSX.Element {
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
    <RightDetailPanel title={<span className="wx-data-md">{concept.code}</span>} onClose={onClose}>
      {row("System", concept.systemId)}
      {row("Display", concept.display)}
      {row(
        "Status",
        <StatusPill label={cap(concept.status)} tone={STATUS_TONE[concept.status] ?? "neutral"} />,
      )}
      {row("Effective", <span className="tabular-nums">{concept.effectiveDate}</span>)}
      {row("End", concept.endDate ? <span className="tabular-nums">{concept.endDate}</span> : "—")}
    </RightDetailPanel>
  );
}
