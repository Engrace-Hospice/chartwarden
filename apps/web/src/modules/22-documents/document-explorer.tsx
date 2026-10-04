import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — Documents explorer (M22, Track B / ADR-0030; 2026-09-25 redesign,
// matching the patient Documents tab from mockup "Documents"). Every document in the organization the
// actor can see: category tabs over the document type, a filter bar (type · retention · status · source),
// and a table of name · patient · category · date · source · status. GET /api/v1/documents pages by cursor
// (200 at a time, "Load more"); patient names come from the patient read for the loaded rows. Uploads
// happen on a patient's or referral's Documents tab, so this page links there; the one upload offered here
// (#91) files a document with NO patient linkage — a compliance or operational record that belongs to the
// agency, not a chart — through the checksum-enforced `DocumentUploadDialog`. The
// server enforces every scope (ADR-0030); Part 2 records only appear for actors cleared to see them.
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { DocumentUploadDialog } from "./document-upload-dialog";
import { lifecycleTone } from "./lantern";

interface DocumentRow {
  id: string;
  patientId: string | null;
  retentionClass: string;
  aggregateType: string;
  aggregateId: string | null;
  title: string;
  patientFacing?: boolean;
  metadata?: { documentType?: string; sourceChannel?: string } | null;
  status: string;
  version: number;
  versionsCount?: number;
  updatedAt: string;
}
interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
  mrn?: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  code_status_directive: "POLST",
  consent_record: "Consent form",
  notice_of_rights: "Notice of Rights",
  election_statement: "Election Statement",
  cti: "Certification of Terminal Illness",
  referral: "Referral document",
  intake_source: "Intake document",
  other: "Other",
};
const RETENTION_LABEL: Record<string, string> = {
  compliance: "Compliance",
  clinical_record: "Clinical record",
  bereavement: "Bereavement",
  operational: "Operational",
  intake_artifact: "Intake",
  compliance_42cfr_part2: "Part 2 / SUD",
};
const SOURCE_LABEL: Record<string, string> = {
  email: "Email",
  fax: "Fax",
  scanned_physical: "Scanned physical copy",
  manual_upload: "Manual upload",
  portal: "Portal",
  api: "API",
};
type Category = "clinical" | "administrative" | "other";
const CATEGORY_OF: Record<string, Category> = {
  code_status_directive: "clinical",
  cti: "clinical",
  consent_record: "administrative",
  notice_of_rights: "administrative",
  election_statement: "administrative",
  referral: "administrative",
  intake_source: "administrative",
};
const CATEGORY_LABEL: Record<Category, string> = {
  clinical: "Clinical",
  administrative: "Administrative",
  other: "Other",
};
const TABS = [
  { key: "", label: "All" },
  { key: "clinical", label: "Clinical" },
  { key: "administrative", label: "Administrative" },
  { key: "other", label: "Other" },
  { key: "portal", label: "Patient Portal" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const typeOf = (d: DocumentRow): string => d.metadata?.documentType ?? d.aggregateType;
const categoryOf = (d: DocumentRow): Category => CATEGORY_OF[typeOf(d)] ?? "other";
const labelize = (v: string): string =>
  v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const typeLabel = (v: string): string => TYPE_LABEL[v] ?? labelize(v);
const usDate = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
};
const inTab = (d: DocumentRow, tab: Tab): boolean =>
  tab === "" ? true : tab === "portal" ? Boolean(d.patientFacing) : categoryOf(d) === tab;

const PAGE_SIZES = [10, 20, 50] as const;
const ICON_TINT: Record<Category, string> = {
  clinical: "var(--color-viz-blue)",
  administrative: "var(--color-viz-violet)",
  other: "var(--color-muted)",
};

export function DocumentExplorer(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [patients, setPatients] = useState<Map<string, PatientName>>(new Map());

  const [tab, setTab] = useState<Tab>("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [retentionFilter, setRetentionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Retry".
  useEffect(() => {
    let active = true;
    setItems(null);
    setError(false);
    void client
      .GET("/api/v1/documents", { params: { query: { limit: 200 } } } as never)
      .then((r) => {
        if (!active) return;
        if (r.error) return setError(true);
        const data = r.data as {
          items?: DocumentRow[];
          nextCursor?: string | null;
          hasMore?: boolean;
        };
        setItems(data?.items ?? []);
        setCursor(data?.hasMore ? (data.nextCursor ?? null) : null);
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [client, retryKey]);

  async function loadMore(): Promise<void> {
    if (!cursor || !items) return;
    setLoadingMore(true);
    const r = await client
      .GET("/api/v1/documents", { params: { query: { limit: 200, cursor } } } as never)
      .catch(() => ({ data: undefined, error: true }));
    setLoadingMore(false);
    if (r.error) return;
    const data = r.data as unknown as
      | { items?: DocumentRow[]; nextCursor?: string | null; hasMore?: boolean }
      | undefined;
    setItems([...items, ...(data?.items ?? [])]);
    setCursor(data?.hasMore ? (data.nextCursor ?? null) : null);
  }

  // Patient names for the loaded documents.
  useEffect(() => {
    if (!items) return;
    const missing = [
      ...new Set(items.map((d) => d.patientId).filter((id): id is string => Boolean(id))),
    ]
      .filter((id) => !patients.has(id))
      .slice(0, 60);
    if (missing.length === 0) return;
    let active = true;
    void Promise.all(
      missing.map((id) =>
        client
          .GET("/api/v1/patients/{id}", { params: { path: { id } } })
          .then((r) => [id, (r.data ?? {}) as PatientName] as const)
          .catch(() => [id, {} as PatientName] as const),
      ),
    ).then((rows) => {
      if (active) setPatients((prev) => new Map([...prev, ...rows]));
    });
    return () => {
      active = false;
    };
  }, [client, items, patients]);

  const patientName = (id: string | null): string | null => {
    if (!id) return null;
    const p = patients.get(id);
    if (!p) return "…";
    return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.mrn || "Patient";
  };

  const all = items ?? [];
  const options = useMemo(() => {
    const all = items ?? [];
    return {
      types: [...new Set(all.map(typeOf))].sort(),
      retention: [...new Set(all.map((d) => d.retentionClass))].sort(),
      status: [...new Set(all.map((d) => d.status))].sort(),
      source: [
        ...new Set(
          all.map((d) => d.metadata?.sourceChannel).filter((s): s is string => Boolean(s)),
        ),
      ].sort(),
    };
  }, [items]);

  const q = search.trim().toLowerCase();
  const visible = all
    .filter(
      (d) =>
        inTab(d, tab) &&
        (!typeFilter || typeOf(d) === typeFilter) &&
        (!retentionFilter || d.retentionClass === retentionFilter) &&
        (!statusFilter || d.status === statusFilter) &&
        (!sourceFilter || d.metadata?.sourceChannel === sourceFilter) &&
        (!q ||
          d.title.toLowerCase().includes(q) ||
          typeLabel(typeOf(d)).toLowerCase().includes(q) ||
          (patientName(d.patientId) ?? "").toLowerCase().includes(q)),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pages);
  const rows = visible.slice((current - 1) * pageSize, current * pageSize);
  const filtersActive = Boolean(q || typeFilter || retentionFilter || statusFilter || sourceFilter);
  const reset = (): void => {
    setSearch("");
    setTypeFilter("");
    setRetentionFilter("");
    setStatusFilter("");
    setSourceFilter("");
    setPage(1);
  };
  const filterChange = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };

  return (
    <div className="wx-reports">
      <header className="wx-page-head">
        <div>
          <h1 style={{ fontSize: "1.875rem" }}>Documents</h1>
          <p>Clinical, administrative and patient documents across the organization.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button type="button" className="wx-btn-secondary" onClick={() => setUploading(true)}>
            <Glyph name="upload" size={16} /> Upload document
          </button>
          <Link to="/patients" className="wx-btn-primary">
            <Glyph name="upload" size={16} /> Upload to a Patient
          </Link>
        </div>
      </header>
      <DocumentUploadDialog
        open={uploading}
        onClose={() => setUploading(false)}
        onDone={() => setRetryKey((k) => k + 1)}
      />

      <fieldset className="wx-seg">
        <legend className="wx-sr-only">Document category</legend>
        {TABS.map((c) => (
          <button
            key={c.key || "all"}
            type="button"
            aria-pressed={tab === c.key}
            className={tab === c.key ? "is-selected" : undefined}
            onClick={() => {
              setTab(c.key);
              setPage(1);
            }}
          >
            {c.label}
            <span className="wx-seg-count wx-nums">
              {all.filter((d) => inTab(d, c.key)).length}
            </span>
          </button>
        ))}
      </fieldset>

      <div className="wx-filter-panel">
        <label className="wx-search-field">
          <Glyph name="search" size={16} />
          <input
            type="search"
            aria-label="Search documents"
            placeholder="Search by name, type or patient…"
            value={search}
            onChange={(e) => filterChange(setSearch)(e.target.value)}
          />
        </label>
        <Filter label="Type" value={typeFilter} onChange={filterChange(setTypeFilter)}>
          <option value="">All</option>
          {options.types.map((v) => (
            <option key={v} value={v}>
              {typeLabel(v)}
            </option>
          ))}
        </Filter>
        <Filter
          label="Retention"
          value={retentionFilter}
          onChange={filterChange(setRetentionFilter)}
        >
          <option value="">All</option>
          {options.retention.map((v) => (
            <option key={v} value={v}>
              {RETENTION_LABEL[v] ?? labelize(v)}
            </option>
          ))}
        </Filter>
        <Filter label="Source" value={sourceFilter} onChange={filterChange(setSourceFilter)}>
          <option value="">All</option>
          {options.source.map((v) => (
            <option key={v} value={v}>
              {SOURCE_LABEL[v] ?? labelize(v)}
            </option>
          ))}
        </Filter>
        <Filter label="Status" value={statusFilter} onChange={filterChange(setStatusFilter)}>
          <option value="">All</option>
          {options.status.map((v) => (
            <option key={v} value={v}>
              {labelize(v)}
            </option>
          ))}
        </Filter>
        {filtersActive ? (
          <button type="button" className="wx-btn-secondary" onClick={reset}>
            Reset
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="wx-list-state">
          <EmptyState
            title="Documents unavailable"
            description="The document list could not be loaded."
          />
          <button
            type="button"
            className="wx-btn-secondary"
            onClick={() => setRetryKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      ) : items === null ? (
        <div className="wx-list-state">
          <LoadingSpinner />
        </div>
      ) : visible.length === 0 ? (
        <div className="wx-list-state">
          <EmptyState
            title={all.length === 0 ? "No documents yet" : "No matching documents"}
            description={
              all.length === 0
                ? "Documents uploaded on a patient's or referral's Documents tab appear here."
                : "Try another category, search or filter."
            }
          />
        </div>
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Organization documents</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Patient</th>
                <th>Category</th>
                <th>Date</th>
                <th>Source</th>
                <th>Status</th>
                <th>
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const category = categoryOf(d);
                const tint = ICON_TINT[category];
                const name = patientName(d.patientId);
                const open = d.patientId
                  ? `/patients/${d.patientId}/documents`
                  : d.aggregateType === "referral" && d.aggregateId
                    ? `/referrals/${d.aggregateId}`
                    : `/documents/${d.id}/versions`;
                return (
                  <tr key={d.id}>
                    <td>
                      <div className="wx-doc-name">
                        <span
                          className="wx-stat-icon"
                          style={{
                            width: "2rem",
                            height: "2rem",
                            color: tint,
                            background: `color-mix(in srgb, ${tint} 12%, ${t.surfaceLowest})`,
                          }}
                        >
                          <Glyph name="file-text" size={16} />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <Link to={open} className="wx-row-title">
                            {d.title}
                          </Link>
                          <div className="wx-row-sub">
                            {typeLabel(typeOf(d))} • v{d.version}
                            {d.retentionClass === "compliance_42cfr_part2" ? " • Part 2" : ""}
                            {d.patientFacing ? " • In portal" : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {d.patientId ? (
                        <Link to={`/patients/${d.patientId}`}>{name}</Link>
                      ) : (
                        <span className="wx-row-sub">
                          {d.aggregateType === "referral" ? "Referral (unmatched)" : "Not linked"}
                        </span>
                      )}
                    </td>
                    <td>{CATEGORY_LABEL[category]}</td>
                    <td className="wx-nums">{usDate(d.updatedAt)}</td>
                    <td>
                      {d.metadata?.sourceChannel
                        ? (SOURCE_LABEL[d.metadata.sourceChannel] ??
                          labelize(d.metadata.sourceChannel))
                        : "Not recorded"}
                    </td>
                    <td>
                      <StatusPill label={labelize(d.status)} tone={lifecycleTone(d.status)} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        to={`/documents/${d.id}/versions`}
                        className="wx-icon-link"
                        aria-label={`Version history for ${d.title}`}
                        title="Version history"
                      >
                        <Glyph name="rotate-ccw" size={17} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <OffsetPagination
            page={current}
            pageSize={pageSize}
            totalItems={visible.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={PAGE_SIZES}
            noun="documents"
          />
          {cursor ? (
            <div className="wx-table-footer">
              <span>More documents are available.</span>
              <button
                type="button"
                className="wx-btn-secondary wx-btn-sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="wx-filter-field">
      <span>{label}</span>
      <select
        className="wx-select"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
