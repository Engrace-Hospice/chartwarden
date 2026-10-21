import {
  Button,
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
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
      header={
        <PageHeader
          title="Terminology"
          breadcrumb="Admin"
          actions={
            <Button
              type="button"
              tone="secondary"
              onClick={() => void search()}
              loading={loading}
              disabled={!q.trim()}
            >
              Search
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Search clinical and billing code systems, then inspect the selected concept detail.
          </div>
        </PageHeader>
      }
      filters={
        <FilterBar>
          <select
            aria-label="Code system"
            value={system}
            onChange={(e) => setSystem(e.target.value as System)}
            style={selectStyle}
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
            style={inputStyle}
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
        ) : (
          <div style={detailStyle}>
            <section style={railSectionStyle}>
              <h3 style={railTitleStyle}>Systems</h3>
              <p style={railTextStyle}>
                CPT is deliberately absent from the phase-1 terminology surface. Search is scoped to
                the selected system and limited by the backend.
              </p>
            </section>
          </div>
        )
      }
      fullPageScroll
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
  if (error)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="Unavailable" description={error} />
      </div>
    );
  if (loading)
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  if (results === null)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Search a code system"
          description="Pick a system and enter a code or term."
        />
      </div>
    );
  if (results.length === 0)
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="No concepts" description="No concepts match this search." />
      </div>
    );
  return (
    <div style={tableWrapStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Code</th>
            <th style={thStyle}>Display</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Effective</th>
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
                borderTop:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
              }}
            >
              <td className="wx-data-md" style={tdStyle}>
                {c.code}
              </td>
              <td style={tdStyle}>{c.display}</td>
              <td style={tdStyle}>
                <StatusPill label={cap(c.status)} tone={STATUS_TONE[c.status] ?? "neutral"} />
              </td>
              <td className="tabular-nums" style={tdStyle}>
                {c.effectiveDate}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const selectStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
} as const;

const inputStyle = { ...selectStyle, minWidth: "16rem" } as const;

const tableWrapStyle = {
  minWidth: 0,
} as const;

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
} as const;

const thStyle = {
  padding: "0.75rem 1rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
} as const;

const tdStyle = {
  padding: "0.75rem 1rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
} as const;

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
} as const;

const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
} as const;

const railTextStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;

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
