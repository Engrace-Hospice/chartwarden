import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, JSX, ReactNode } from "react";
import { lifecycleTone } from "./document-lifecycle-tone";

export type DocumentContext =
  | {
      kind: "patient";
      patientId: string;
      admissionId?: string | null;
    }
  | {
      kind: "referral";
      referralId: string;
      patientId?: string | null;
      admissionId?: string | null;
    };

export interface DocumentRow {
  id: string;
  patientId: string | null;
  admissionId: string | null;
  retentionClass: string;
  aggregateType: string;
  aggregateId: string | null;
  title: string;
  patientFacing: boolean;
  metadata: DocumentMetadata | null;
  status: string;
  version: number;
  versionsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentMetadata {
  documentType?: DocumentTypeValue;
  sourceChannel?: SourceChannel;
  receivedAt?: string;
  originalFilename?: string;
  externalMessageId?: string;
  sender?: string;
  faxReference?: string;
  notes?: string;
}

interface VersionRow {
  id: string;
  documentId: string;
  versionNumber: number;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
  createdAt: string;
}

export type UploadStage = "idle" | "preparing" | "uploading" | "verifying" | "complete";

export type DocumentTypeValue =
  | "code_status_directive"
  | "consent_record"
  | "notice_of_rights"
  | "election_statement"
  | "cti"
  | "referral"
  | "intake_source"
  | "other";

type RetentionClass =
  | "compliance"
  | "clinical_record"
  | "bereavement"
  | "operational"
  | "intake_artifact"
  | "compliance_42cfr_part2";

type AcceptedMime =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "image/jpeg"
  | "image/png"
  | "image/tiff";

export type SourceChannel =
  | "email"
  | "fax"
  | "scanned_physical"
  | "manual_upload"
  | "portal"
  | "api";

const ACCEPTED_MIME = new Map<AcceptedMime, string>([
  ["application/pdf", "PDF"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "DOCX"],
  ["image/jpeg", "JPG"],
  ["image/png", "PNG"],
  ["image/tiff", "TIFF"],
]);

const DOCUMENT_TYPE_OPTIONS: ReadonlyArray<{
  value: DocumentTypeValue;
  label: string;
}> = [
  { value: "code_status_directive", label: "POLST" },
  { value: "consent_record", label: "Consent form" },
  { value: "notice_of_rights", label: "Notice of Rights" },
  { value: "election_statement", label: "Election Statement" },
  { value: "cti", label: "Certification of Terminal Illness" },
  { value: "referral", label: "Referral document" },
  { value: "intake_source", label: "Intake document" },
  { value: "other", label: "Other" },
];

const FILTERS = [
  { value: "", label: "All" },
  { value: "code_status_directive", label: "POLST" },
  { value: "consent_record", label: "Consent forms" },
  { value: "intake_source", label: "Intake" },
  { value: "other", label: "Other" },
] as const;

const SOURCE_OPTIONS: ReadonlyArray<{
  value: SourceChannel;
  label: string;
}> = [
  { value: "email", label: "Email" },
  { value: "fax", label: "Fax" },
  { value: "scanned_physical", label: "Scanned physical copy" },
  { value: "manual_upload", label: "Manual upload" },
];

export function PatientDocumentWorkspace({
  patientId,
  onRowsChange,
}: {
  patientId: string;
  onRowsChange?: (rows: DocumentRow[]) => void;
}): JSX.Element {
  return (
    <DocumentCollection
      context={{ kind: "patient", patientId }}
      title="Documents"
      subtitle="Manage POLST, consent forms, intake files and other patient records."
      emptyTitle="No patient documents yet"
      emptyDescription="Upload a patient document to make it available in the chart."
      defaultDocumentType="code_status_directive"
      showPatientFacing
      onRowsChange={onRowsChange}
    />
  );
}

export function ReferralDocumentsPanel({
  referralId,
  patientId,
  admissionId,
}: {
  referralId: string;
  patientId?: string | null;
  admissionId?: string | null;
}): JSX.Element {
  return (
    <DocumentCollection
      context={{
        kind: "referral",
        referralId,
        patientId,
        admissionId,
      }}
      title="Referral documents"
      subtitle="Files received for this referral remain linked after patient matching."
      emptyTitle="No documents received yet"
      emptyDescription="Upload a fax, email attachment, Word/PDF document or scanned physical copy."
      defaultDocumentType="referral"
      compact
    />
  );
}

function DocumentCollection({
  context,
  title,
  subtitle,
  emptyTitle,
  emptyDescription,
  defaultDocumentType,
  compact = false,
  showPatientFacing = false,
  onRowsChange,
}: {
  context: DocumentContext;
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyDescription: string;
  defaultDocumentType: string;
  compact?: boolean;
  showPatientFacing?: boolean;
  onRowsChange?: (rows: DocumentRow[]) => void;
}): JSX.Element {
  const client = useApiClient();
  // Callers pass the context inline; key it by value so a parent re-render does not reload the list.
  const contextKey = JSON.stringify(context);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by value (contextKey).
  const stableContext = useMemo(() => context, [contextKey]);
  const onRowsChangeRef = useRef(onRowsChange);
  onRowsChangeRef.current = onRowsChange;

  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [versions, setVersions] = useState<Record<string, VersionRow[]>>({});

  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [newVersionFor, setNewVersionFor] = useState<DocumentRow | null>(null);
  const [detail, setDetail] = useState<DocumentRow | null>(null);

  const [preview, setPreview] = useState<{
    doc: DocumentRow;
    version: VersionRow;
    url: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const query =
      stableContext.kind === "patient"
        ? { patientId: stableContext.patientId }
        : {
            aggregateType: "referral",
            aggregateId: stableContext.referralId,
          };

    const { data, error: err } = await client.GET("/api/v1/documents", {
      params: { query },
    });

    if (err) {
      setError(errorMessage(err, "Could not load documents."));
      setLoading(false);
      return;
    }

    const items = ((data?.items ?? []) as DocumentRow[])
      .filter((doc) => Boolean(doc?.id && doc?.title && doc?.aggregateType))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    setRows(items);
    onRowsChangeRef.current?.(items);
    setLoading(false);

    const versionPairs = await Promise.all(
      items.map(async (doc) => {
        const response = await client.GET("/api/v1/documents/{id}/versions", {
          params: {
            path: { id: doc.id },
            query: { limit: 25 },
          },
        });

        return [
          doc.id,
          response.error ? [] : ((response.data?.items ?? []) as VersionRow[]),
        ] as const;
      }),
    );

    setVersions(Object.fromEntries(versionPairs));
  }, [client, stableContext]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const result: Record<string, number> = {
      "": rows.length,
    };

    for (const option of FILTERS) {
      if (!option.value) continue;

      result[option.value] = rows.filter(
        (doc) => displayDocumentTypeValue(doc) === option.value,
      ).length;
    }

    return result;
  }, [rows]);

  const sourceOptions = useMemo(
    () =>
      [
        ...new Set(rows.map((doc) => doc.metadata?.sourceChannel).filter(Boolean)),
      ] as SourceChannel[],
    [rows],
  );

  const statusOptions = useMemo(
    () => [...new Set(rows.map((doc) => doc.status).filter(Boolean))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();

    return rows.filter((doc) => {
      const type = displayDocumentTypeValue(doc);
      const source = doc.metadata?.sourceChannel ?? "";

      const matchesType = !filter || type === filter;
      const matchesSource = !sourceFilter || source === sourceFilter;
      const matchesStatus = !statusFilter || doc.status === statusFilter;

      const matchesSearch =
        !query ||
        doc.title.toLowerCase().includes(query) ||
        displayDocumentType(doc).toLowerCase().includes(query) ||
        provenanceLabel(doc.metadata).toLowerCase().includes(query) ||
        doc.metadata?.originalFilename?.toLowerCase().includes(query) ||
        doc.metadata?.notes?.toLowerCase().includes(query);

      return matchesType && matchesSource && matchesStatus && matchesSearch;
    });
  }, [filter, rows, search, sourceFilter, statusFilter]);

  const activeSecondaryFilters =
    Number(Boolean(search.trim())) + Number(Boolean(sourceFilter)) + Number(Boolean(statusFilter));

  const clearSecondaryFilters = (): void => {
    setSearch("");
    setSourceFilter("");
    setStatusFilter("");
  };

  const clearAllFilters = (): void => {
    setFilter("");
    clearSecondaryFilters();
  };

  const openSigned = async (doc: DocumentRow, mode: "preview" | "download"): Promise<void> => {
    const current = currentVersion(doc, versions[doc.id]);

    if (!current) {
      setError("This document has no current uploaded version yet.");
      return;
    }

    const { data, error: err } = await client.GET(
      "/api/v1/documents/{id}/versions/{versionId}/content",
      {
        params: {
          path: {
            id: doc.id,
            versionId: current.id,
          },
          query: {
            purpose: "treatment",
            ttlSeconds: 300,
          },
        },
      },
    );

    if (err || !data?.url) {
      setError(errorMessage(err, "Signed URL is unavailable."));
      return;
    }

    if (mode === "preview" && canInlinePreview(current.mimeType)) {
      setPreview({
        doc,
        version: current,
        url: data.url,
      });
    } else {
      window.open(data.url, "_blank", "noopener,noreferrer");
    }
  };

  const dialogs = (
    <>
      {uploadOpen ? (
        <DocumentUploadDialog
          context={context}
          defaultDocumentType={defaultDocumentType}
          showPatientFacing={showPatientFacing}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            void load();
          }}
        />
      ) : null}

      {newVersionFor ? (
        <DocumentUploadDialog
          context={context}
          mode="new_version"
          targetDocument={newVersionFor}
          defaultDocumentType={displayDocumentTypeValue(newVersionFor)}
          showPatientFacing={showPatientFacing}
          onClose={() => setNewVersionFor(null)}
          onUploaded={() => {
            setNewVersionFor(null);
            void load();
          }}
        />
      ) : null}

      {detail ? (
        <DocumentDetail
          doc={detail}
          versions={versions[detail.id] ?? []}
          onClose={() => setDetail(null)}
          onOpen={(mode) => void openSigned(detail, mode)}
          onNewVersion={() => {
            setDetail(null);
            setNewVersionFor(detail);
          }}
        />
      ) : null}

      {preview ? <PreviewModal preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );

  if (!compact) {
    return (
      <PatientLibrary
        title={title}
        rows={rows}
        versions={versions}
        loading={loading}
        error={error}
        onDismissError={() => setError(null)}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        typeFilter={filter}
        onTypeFilter={setFilter}
        search={search}
        onSearch={setSearch}
        sourceFilter={sourceFilter}
        onSourceFilter={setSourceFilter}
        sourceOptions={sourceOptions}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        statusOptions={statusOptions}
        onUpload={() => setUploadOpen(true)}
        onDetail={setDetail}
        onView={(doc) => void openSigned(doc, "preview")}
      >
        {dialogs}
      </PatientLibrary>
    );
  }

  return (
    <section style={compact ? referralShell : patientShell}>
      <header style={collectionHeader}>
        <div style={headerCopy}>
          {!compact ? <span style={eyebrow}>Patient record</span> : null}

          <h2 style={compact ? compactTitle : pageTitle}>{title}</h2>

          <p style={muted}>{subtitle}</p>
        </div>

        <Button tone="primary" onClick={() => setUploadOpen(true)}>
          + Upload document
        </Button>
      </header>

      {error ? (
        <div role="alert" style={alert}>
          <span>{error}</span>

          <button
            type="button"
            aria-label="Dismiss error"
            style={dismissAlert}
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div style={libraryShell}>
        <div style={categoryBar}>
          {FILTERS.map((option) => {
            const active = option.value === filter;

            return (
              <button
                key={option.value || "all"}
                type="button"
                style={active ? categoryButtonActive : categoryButton}
                onClick={() => setFilter(option.value)}
              >
                <span>{option.label}</span>

                <span style={active ? categoryCountActive : categoryCount}>
                  {counts[option.value] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div style={toolbar}>
          <div style={searchField}>
            <SearchIcon />

            <input
              type="search"
              aria-label="Search documents"
              placeholder="Search documents..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={searchInput}
            />

            {search ? (
              <button
                type="button"
                aria-label="Clear search"
                style={clearSearch}
                onClick={() => setSearch("")}
              >
                ×
              </button>
            ) : null}
          </div>

          <div style={filterControls}>
            <select
              aria-label="Source"
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              style={select}
            >
              <option value="">Source: All</option>

              {sourceOptions.map((source) => (
                <option key={source} value={source}>
                  {sourceLabel(source)}
                </option>
              ))}
            </select>

            <select
              aria-label="Status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              style={select}
            >
              <option value="">Status: All</option>

              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {labelize(status)}
                </option>
              ))}
            </select>

            {activeSecondaryFilters > 0 ? (
              <button type="button" style={resetButton} onClick={clearSecondaryFilters}>
                Reset
              </button>
            ) : null}
          </div>
        </div>

        <div style={resultSummary}>
          <span>
            <strong>{visible.length}</strong> {visible.length === 1 ? "document" : "documents"}
          </span>

          {filter || activeSecondaryFilters > 0 ? (
            <button type="button" style={clearAllButton} onClick={clearAllFilters}>
              Clear all filters
            </button>
          ) : null}
        </div>

        <div style={contentArea}>
          {loading ? (
            <div style={loadingState}>
              <LoadingSpinner />
            </div>
          ) : visible.length === 0 ? (
            <div style={emptyWrap}>
              <EmptyState
                title={rows.length === 0 ? emptyTitle : "No matching documents"}
                description={
                  rows.length === 0 ? emptyDescription : "Try changing the search or filters."
                }
                action={
                  rows.length === 0 ? (
                    <Button tone="primary" onClick={() => setUploadOpen(true)}>
                      Upload document
                    </Button>
                  ) : (
                    <Button tone="secondary" onClick={clearAllFilters}>
                      Clear filters
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div style={documentList}>
              <div style={listHeader}>
                <span>Document</span>
                <span>Type</span>
                <span>Status</span>
                <span>Updated</span>
                <span aria-hidden="true" />
              </div>

              {visible.map((doc) => {
                const current = currentVersion(doc, versions[doc.id]);

                return (
                  <article key={doc.id} style={documentRow}>
                    <button
                      type="button"
                      style={documentIdentityButton}
                      onClick={() => setDetail(doc)}
                    >
                      <FileIcon type={displayDocumentTypeValue(doc)} />

                      <span style={documentIdentity}>
                        <strong style={rowTitle}>{doc.title}</strong>

                        <span style={rowMeta}>
                          {current ? formatMime(current.mimeType) : "File"}
                          {" · "}v{current?.versionNumber ?? doc.version ?? 1}
                          {current ? ` · ${formatBytes(current.byteSize)}` : ""}
                        </span>

                        <span style={provenanceMeta}>{provenanceLabel(doc.metadata)}</span>
                      </span>
                    </button>

                    <div>
                      <TypePill value={displayDocumentTypeValue(doc)} />
                    </div>

                    <div>
                      <StatusPill label={labelize(doc.status)} tone={lifecycleTone(doc.status)} />
                    </div>

                    <div style={dateCell}>
                      <span>{formatDate(doc.updatedAt)}</span>

                      {doc.admissionId ? (
                        <span style={secondaryMeta}>Admission {shortId(doc.admissionId)}</span>
                      ) : null}
                    </div>

                    <div style={rowActions}>
                      <button
                        type="button"
                        style={viewButton}
                        onClick={() => void openSigned(doc, "preview")}
                      >
                        View
                      </button>

                      <button
                        type="button"
                        aria-label={`More actions for ${doc.title}`}
                        title="Document details and actions"
                        style={moreButton}
                        onClick={() => setDetail(doc)}
                      >
                        •••
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {dialogs}
    </section>
  );
}

// ── patient library (2026-09-25 redesign, mockup "Documents") ─────────────────────────────────────────
// Category tabs over the document type (clinical · administrative · other) plus the portal-visible set,
// a labeled filter bar, and a table of name · category · date · source · status. The documents read has
// no uploader, so the mockup's "Uploaded by" column shows the recorded source channel instead.
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
const categoryOf = (doc: DocumentRow): Category =>
  CATEGORY_OF[displayDocumentTypeValue(doc)] ?? "other";
const CATEGORY_TABS = [
  { key: "", label: "All" },
  { key: "clinical", label: "Clinical" },
  { key: "administrative", label: "Administrative" },
  { key: "other", label: "Other" },
  { key: "portal", label: "Patient Portal" },
] as const;
type CategoryTab = (typeof CATEGORY_TABS)[number]["key"];
const PAGE_SIZE = 10;

function usDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function PatientLibrary({
  title,
  rows,
  versions,
  loading,
  error,
  onDismissError,
  emptyTitle,
  emptyDescription,
  typeFilter,
  onTypeFilter,
  search,
  onSearch,
  sourceFilter,
  onSourceFilter,
  sourceOptions,
  statusFilter,
  onStatusFilter,
  statusOptions,
  onUpload,
  onDetail,
  onView,
  children,
}: {
  title: string;
  rows: DocumentRow[];
  versions: Record<string, VersionRow[]>;
  loading: boolean;
  error: string | null;
  onDismissError: () => void;
  emptyTitle: string;
  emptyDescription: string;
  typeFilter: string;
  onTypeFilter: (v: string) => void;
  search: string;
  onSearch: (v: string) => void;
  sourceFilter: string;
  onSourceFilter: (v: string) => void;
  sourceOptions: SourceChannel[];
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  statusOptions: string[];
  onUpload: () => void;
  onDetail: (doc: DocumentRow) => void;
  onView: (doc: DocumentRow) => void;
  children: ReactNode;
}): JSX.Element {
  const [tab, setTab] = useState<CategoryTab>("");
  const [page, setPage] = useState(1);

  const inTab = (doc: DocumentRow, key: CategoryTab): boolean =>
    key === "" ? true : key === "portal" ? doc.patientFacing : categoryOf(doc) === key;
  const counts = Object.fromEntries(
    CATEGORY_TABS.map((c) => [c.key, rows.filter((d) => inTab(d, c.key)).length]),
  ) as Record<CategoryTab, number>;

  const q = search.trim().toLowerCase();
  const visible = rows.filter(
    (doc) =>
      inTab(doc, tab) &&
      (!typeFilter || displayDocumentTypeValue(doc) === typeFilter) &&
      (!sourceFilter || doc.metadata?.sourceChannel === sourceFilter) &&
      (!statusFilter || doc.status === statusFilter) &&
      (!q ||
        doc.title.toLowerCase().includes(q) ||
        displayDocumentType(doc).toLowerCase().includes(q) ||
        provenanceLabel(doc.metadata).toLowerCase().includes(q) ||
        Boolean(doc.metadata?.originalFilename?.toLowerCase().includes(q)) ||
        Boolean(doc.metadata?.notes?.toLowerCase().includes(q))),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const pageRows = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtersActive = Boolean(q || typeFilter || sourceFilter || statusFilter);
  const reset = (): void => {
    onSearch("");
    onTypeFilter("");
    onSourceFilter("");
    onStatusFilter("");
    setPage(1);
  };

  return (
    <section className="wx-chart-section" aria-label={title} aria-busy={loading}>
      <header className="wx-page-head">
        <div>
          <h2 style={{ margin: 0, fontSize: "1.375rem", fontWeight: 700 }}>{title}</h2>
          <p>Clinical, administrative and patient documents.</p>
        </div>
        <button
          type="button"
          className="wx-btn-primary"
          aria-label="Upload document"
          onClick={onUpload}
        >
          <Glyph name="plus" size={16} /> Upload
        </button>
      </header>

      {error ? (
        <div role="alert" style={alert}>
          <span>{error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            style={dismissAlert}
            onClick={onDismissError}
          >
            ×
          </button>
        </div>
      ) : null}

      <fieldset className="wx-seg">
        <legend className="wx-sr-only">Document category</legend>
        {CATEGORY_TABS.map((c) => (
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
            <span className="wx-seg-count wx-nums">{counts[c.key]}</span>
          </button>
        ))}
      </fieldset>

      <div className="wx-filter-panel">
        <label className="wx-search-field">
          <Glyph name="search" size={16} />
          <input
            type="search"
            aria-label="Search documents"
            placeholder="Search by name, type, source…"
            value={search}
            onChange={(e) => {
              onSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <LibraryFilter
          label="Type"
          value={typeFilter}
          onChange={(v) => {
            onTypeFilter(v);
            setPage(1);
          }}
        >
          <option value="">All types</option>
          {DOCUMENT_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </LibraryFilter>
        <LibraryFilter
          label="Source"
          value={sourceFilter}
          onChange={(v) => {
            onSourceFilter(v);
            setPage(1);
          }}
        >
          <option value="">All sources</option>
          {sourceOptions.map((o) => (
            <option key={o} value={o}>
              {sourceLabel(o)}
            </option>
          ))}
        </LibraryFilter>
        <LibraryFilter
          label="Status"
          value={statusFilter}
          onChange={(v) => {
            onStatusFilter(v);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {statusOptions.map((o) => (
            <option key={o} value={o}>
              {labelize(o)}
            </option>
          ))}
        </LibraryFilter>
        {filtersActive ? (
          <button type="button" className="wx-btn-secondary" onClick={reset}>
            Reset
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="wx-list-state">
          <LoadingSpinner />
        </div>
      ) : visible.length === 0 ? (
        <div className="wx-list-state">
          <EmptyState
            title={rows.length === 0 ? emptyTitle : "No matching documents"}
            description={
              rows.length === 0 ? emptyDescription : "Try changing the category, search or filters."
            }
          />
          {rows.length === 0 ? (
            <button type="button" className="wx-btn-primary" onClick={onUpload}>
              <Glyph name="plus" size={16} /> Upload document
            </button>
          ) : (
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => {
                reset();
                setTab("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Patient documents</caption>
            <thead>
              <tr>
                <th>Name</th>
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
              {pageRows.map((doc) => {
                const v = currentVersion(doc, versions[doc.id]);
                const category = categoryOf(doc);
                return (
                  <tr key={doc.id}>
                    <td>
                      <div className="wx-doc-name">
                        <FileIcon type={displayDocumentTypeValue(doc)} />
                        <div style={{ minWidth: 0 }}>
                          <button
                            type="button"
                            className="wx-row-title wx-link-button"
                            onClick={() => onView(doc)}
                          >
                            {doc.title}
                          </button>
                          <div className="wx-row-sub">
                            {displayDocumentType(doc)}
                            {v
                              ? ` • ${formatMime(v.mimeType)} • v${v.versionNumber} • ${formatBytes(v.byteSize)}`
                              : ""}
                            {doc.patientFacing ? " • In portal" : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {category === "clinical"
                        ? "Clinical"
                        : category === "administrative"
                          ? "Administrative"
                          : "Other"}
                    </td>
                    <td className="wx-nums">{usDate(doc.updatedAt)}</td>
                    <td>
                      {doc.metadata?.sourceChannel
                        ? sourceLabel(doc.metadata.sourceChannel)
                        : "Not recorded"}
                    </td>
                    <td>
                      <StatusPill label={labelize(doc.status)} tone={lifecycleTone(doc.status)} />
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="wx-icon-link"
                        aria-label={`More actions for ${doc.title}`}
                        title="Document details, history and actions"
                        onClick={() => onDetail(doc)}
                      >
                        <Glyph name="more-horizontal" size={18} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="wx-table-footer">
            <span className="wx-nums">
              Showing {(current - 1) * PAGE_SIZE + 1} to{" "}
              {Math.min(current * PAGE_SIZE, visible.length)} of {visible.length} documents
            </span>
            {pages > 1 ? (
              <span style={{ display: "inline-flex", gap: "0.375rem" }}>
                <button
                  type="button"
                  className="wx-btn-secondary wx-btn-sm"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="wx-btn-secondary wx-btn-sm"
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </button>
              </span>
            ) : null}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}

function LibraryFilter({
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

function DocumentUploadDialog({
  context,
  defaultDocumentType,
  showPatientFacing,
  mode = "new_document",
  targetDocument,
  onClose,
  onUploaded,
}: {
  context: DocumentContext;
  defaultDocumentType: string;
  showPatientFacing: boolean;
  mode?: "new_document" | "new_version";
  targetDocument?: DocumentRow;
  onClose: () => void;
  onUploaded: () => void;
}): JSX.Element {
  const client = useApiClient();

  const [documentType, setDocumentType] = useState<DocumentTypeValue>(
    asDocumentType(defaultDocumentType),
  );

  const [sourceChannel, setSourceChannel] = useState<SourceChannel>(
    context.kind === "referral" ? "fax" : "manual_upload",
  );

  const [receivedAt, setReceivedAt] = useState("");

  const [title, setTitle] = useState(targetDocument?.title ?? defaultTitle(defaultDocumentType));

  const [patientFacing, setPatientFacing] = useState(targetDocument?.patientFacing ?? false);

  const [file, setFile] = useState<File | null>(null);

  const [sender, setSender] = useState("");
  const [externalMessageId, setExternalMessageId] = useState("");
  const [faxReference, setFaxReference] = useState("");
  const [notes, setNotes] = useState("");

  const [stage, setStage] = useState<UploadStage>("idle");

  const [error, setError] = useState<string | null>(null);

  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setFile(event.dataTransfer.files[0] ?? null);
  };

  const submit = async (): Promise<void> => {
    if (!file) {
      setError("Choose a PDF, DOCX, JPG, PNG or TIFF file.");
      return;
    }

    setError(null);

    try {
      await verifiedUpload(client, {
        context,
        mode,
        targetDocumentId: targetDocument?.id,
        file,
        title: title.trim() || file.name,
        documentType,
        patientFacing,
        sourceMetadata: prune({
          documentType,
          sourceChannel,
          receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
          originalFilename: file.name,
          sender,
          externalMessageId,
          faxReference,
          notes,
        }),
        onStage: setStage,
      });

      onUploaded();
    } catch (err) {
      setError(errorMessage(err, "The upload could not be completed."));

      if (stage !== "complete") {
        setStage("idle");
      }
    }
  };

  const isVersion = mode === "new_version";
  const busy = stage !== "idle";

  return (
    <Modal
      onClose={onClose}
      title={isVersion ? "Upload new version" : "Upload document"}
      subtitle={
        isVersion
          ? "Add a new version without replacing the document history."
          : "Add a verified file to this record."
      }
    >
      <div style={form}>
        {error ? (
          <div role="alert" style={alert}>
            {error}
          </div>
        ) : null}

        {isVersion && targetDocument ? (
          <div style={versionTarget}>
            <FileIcon type={displayDocumentTypeValue(targetDocument)} />

            <div>
              <div style={versionTargetLabel}>New version of</div>

              <strong>{targetDocument.title}</strong>
            </div>
          </div>
        ) : null}

        {!isVersion ? (
          <FormSection
            title="Document details"
            description="Choose the category and name that staff will see in the chart."
          >
            <div style={twoColumnGrid}>
              <label style={field}>
                <span style={fieldLabelText}>Document type</span>

                <select
                  value={documentType}
                  onChange={(event) => {
                    const next = asDocumentType(event.target.value);

                    setDocumentType(next);

                    if (!title || title === defaultTitle(documentType)) {
                      setTitle(defaultTitle(next));
                    }
                  }}
                  style={input}
                >
                  {DOCUMENT_TYPE_OPTIONS.filter(
                    (option) => context.kind === "referral" || option.value !== "referral",
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label style={field}>
                <span style={fieldLabelText}>Title</span>

                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Document title"
                  style={input}
                />
              </label>
            </div>
          </FormSection>
        ) : null}

        <FormSection
          title="File"
          description="Accepted formats: PDF, DOCX, JPG, PNG or TIFF. Maximum 25 MB."
        >
          <label
            style={file ? dropZoneSelected : dropZone}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
          >
            <input
              type="file"
              accept=".pdf,.docx,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/tiff"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              style={{ display: "none" }}
            />

            <div style={uploadIconWrap}>
              <UploadIcon />
            </div>

            {file ? (
              <>
                <strong style={dropTitle}>{file.name}</strong>

                <span style={dropHelp}>
                  {formatBytes(file.size)} · Click or drop another file to replace
                </span>
              </>
            ) : (
              <>
                <strong style={dropTitle}>Drop a file here</strong>

                <span style={dropHelp}>or click to browse your device</span>
              </>
            )}
          </label>
        </FormSection>

        {context.kind === "referral" ? (
          <FormSection title="Source" description="Record how this referral document was received.">
            <div style={twoColumnGrid}>
              <label style={field}>
                <span style={fieldLabelText}>Source</span>

                <select
                  value={sourceChannel}
                  onChange={(event) => setSourceChannel(asSourceChannel(event.target.value))}
                  style={input}
                >
                  {SOURCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label style={field}>
                <span style={fieldLabelText}>Received at</span>

                <input
                  type="datetime-local"
                  value={receivedAt}
                  onChange={(event) => setReceivedAt(event.target.value)}
                  style={input}
                />
              </label>
            </div>

            <div style={optionalGrid}>
              <label style={field}>
                <span style={fieldLabelText}>Sender</span>

                <input
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  style={input}
                />
              </label>

              <label style={field}>
                <span style={fieldLabelText}>Message ID</span>

                <input
                  value={externalMessageId}
                  onChange={(event) => setExternalMessageId(event.target.value)}
                  style={input}
                />
              </label>

              <label style={field}>
                <span style={fieldLabelText}>Fax reference</span>

                <input
                  value={faxReference}
                  onChange={(event) => setFaxReference(event.target.value)}
                  style={input}
                />
              </label>
            </div>
          </FormSection>
        ) : showPatientFacing ? (
          <div style={portalVisibility}>
            <label style={check}>
              <input
                type="checkbox"
                checked={patientFacing}
                onChange={(event) => setPatientFacing(event.target.checked)}
              />

              <span>
                <strong style={checkTitle}>Visible in patient portal</strong>

                <span style={checkDescription}>
                  Allow the patient to access this document from their portal.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        <FormSection title="Notes" description="Optional internal context about this document.">
          <label style={field}>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="Add an optional note..."
              style={{
                ...input,
                resize: "vertical",
              }}
            />
          </label>
        </FormSection>

        {busy ? <UploadProgress stage={stage} /> : null}

        <div style={dialogActions}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>

          <Button tone="primary" onClick={() => void submit()} disabled={busy || !file}>
            {busy ? stageLabel(stage) : isVersion ? "Upload new version" : "Upload document"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DocumentDetail({
  doc,
  versions,
  onClose,
  onOpen,
  onNewVersion,
}: {
  doc: DocumentRow;
  versions: VersionRow[];
  onClose: () => void;
  onOpen: (mode: "preview" | "download") => void;
  onNewVersion: () => void;
}): JSX.Element {
  const current = currentVersion(doc, versions);

  return (
    <Modal
      onClose={onClose}
      title={doc.title}
      subtitle={`${displayDocumentType(doc)} · ${
        current ? `v${current.versionNumber}` : `v${doc.version || 1}`
      }`}
    >
      <div style={detailBody}>
        <div style={detailHero}>
          <FileIcon type={displayDocumentTypeValue(doc)} large />

          <div style={detailHeroCopy}>
            <div style={detailPills}>
              <TypePill value={displayDocumentTypeValue(doc)} />

              <StatusPill label={labelize(doc.status)} tone={lifecycleTone(doc.status)} />
            </div>

            <strong style={detailTitle}>{doc.title}</strong>

            <span style={muted}>{provenanceLabel(doc.metadata)}</span>
          </div>
        </div>

        <div style={primaryActions}>
          <Button tone="primary" onClick={() => onOpen("preview")}>
            View document
          </Button>

          <Button tone="secondary" onClick={() => onOpen("download")}>
            Download
          </Button>

          <Button tone="tertiary" onClick={onNewVersion}>
            Upload new version
          </Button>
        </div>

        <section style={detailSection}>
          <h3 style={smallHeading}>Document information</h3>

          <div style={detailGrid}>
            <Field label="Uploaded" value={formatDateTime(current?.uploadedAt ?? doc.createdAt)} />

            <Field
              label="Current version"
              value={`v${current?.versionNumber ?? doc.version ?? 1}`}
            />

            <Field label="File type" value={current ? formatMime(current.mimeType) : "Unknown"} />

            <Field label="File size" value={current ? formatBytes(current.byteSize) : "Unknown"} />

            <Field label="Patient" value={doc.patientId ? shortId(doc.patientId) : "Not linked"} />

            <Field
              label="Admission"
              value={doc.admissionId ? shortId(doc.admissionId) : "Not linked"}
            />

            <Field
              label="Portal visibility"
              value={doc.patientFacing ? "Visible" : "Not visible"}
            />

            <Field label="Versions" value={String(doc.versionsCount || versions.length || 1)} />
          </div>
        </section>

        {doc.metadata?.notes ? (
          <section style={detailSection}>
            <h3 style={smallHeading}>Notes</h3>

            <div style={notesBox}>{doc.metadata.notes}</div>
          </section>
        ) : null}

        <section style={detailSection}>
          <div style={versionHeading}>
            <div>
              <h3 style={smallHeading}>Version history</h3>

              <p style={sectionDescription}>
                Previous versions remain available for audit and record history.
              </p>
            </div>

            <span style={versionCount}>{versions.length}</span>
          </div>

          {versions.length === 0 ? (
            <div style={noVersions}>No version history available.</div>
          ) : (
            <div style={versionList}>
              {[...versions]
                .sort((a, b) => b.versionNumber - a.versionNumber)
                .map((version) => {
                  const active = version.id === current?.id;

                  return (
                    <div key={version.id} style={versionRow}>
                      <div style={versionNumber}>v{version.versionNumber}</div>

                      <div style={versionMeta}>
                        <strong>{formatMime(version.mimeType)}</strong>

                        <span style={muted}>
                          {formatBytes(version.byteSize)}
                          {" · "}
                          {formatDateTime(version.uploadedAt)}
                        </span>
                      </div>

                      {active ? <span style={currentBadge}>Current</span> : null}
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function PreviewModal({
  preview,
  onClose,
}: {
  preview: {
    doc: DocumentRow;
    version: VersionRow;
    url: string;
  };
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal
      onClose={onClose}
      title={preview.doc.title}
      subtitle={`Preview · v${preview.version.versionNumber}`}
      wide
    >
      <div style={previewFrame}>
        {preview.version.mimeType === "application/pdf" ? (
          <iframe title={preview.doc.title} src={preview.url} style={previewMedia} />
        ) : (
          <img src={preview.url} alt={preview.doc.title} style={previewImage} />
        )}
      </div>
    </Modal>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}): JSX.Element {
  return (
    <div
      style={modalBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <dialog
        open
        aria-modal="true"
        aria-label={title}
        style={{
          ...modal,
          width: wide ? "min(72rem, 100%)" : "min(48rem, 100%)",
        }}
      >
        <header style={modalHeader}>
          <div style={modalHeading}>
            <h2 style={modalTitle}>{title}</h2>

            {subtitle ? <p style={modalSubtitle}>{subtitle}</p> : null}
          </div>

          <button type="button" style={iconButton} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div style={modalContent}>{children}</div>
      </dialog>
    </div>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={formSection}>
      <div style={formSectionHead}>
        <strong style={formSectionTitle}>{title}</strong>

        {description ? <span style={formSectionDescription}>{description}</span> : null}
      </div>

      <div style={formSectionBody}>{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): JSX.Element {
  return (
    <div style={detailField}>
      <div style={fieldLabel}>{label}</div>
      <div style={fieldValue}>{value}</div>
    </div>
  );
}

function UploadProgress({
  stage,
}: {
  stage: UploadStage;
}): JSX.Element {
  const stages: Array<{
    value: UploadStage;
    label: string;
  }> = [
    { value: "preparing", label: "Preparing" },
    { value: "uploading", label: "Uploading" },
    { value: "verifying", label: "Verifying" },
    { value: "complete", label: "Complete" },
  ];

  const currentIndex = stages.findIndex((item) => item.value === stage);

  return (
    <div style={progressShell}>
      <div style={progressTop}>
        <span>{stageLabel(stage)}</span>

        <span style={muted}>Please keep this window open.</span>
      </div>

      <div style={progressSteps}>
        {stages.map((item, index) => (
          <div key={item.value} style={progressStep}>
            <span
              style={{
                ...progressDot,
                ...(index <= currentIndex ? progressDotActive : {}),
              }}
            />

            <span
              style={{
                ...progressLabel,
                ...(index <= currentIndex ? progressLabelActive : {}),
              }}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function UploadIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none">
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15.5V19h14v-3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon({
  type,
  large = false,
}: {
  type: string;
  large?: boolean;
}): JSX.Element {
  return (
    <span
      style={{
        ...fileIcon,
        ...(large ? largeFileIcon : {}),
        ...fileIconTone(type),
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={large ? 25 : 19}
        height={large ? 25 : 19}
        aria-hidden="true"
        fill="none"
      >
        <path
          d="M7 3.5h6.5L18 8v12.5H7v-17Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M13.5 3.5V8H18" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function TypePill({
  value,
}: {
  value: string;
}): JSX.Element {
  return <span style={typePill(value)}>{labelForType(value)}</span>;
}

export async function verifiedUpload(
  client: ApiClient,
  input: {
    context: DocumentContext;
    mode: "new_document" | "new_version";
    targetDocumentId?: string;
    file: File;
    title: string;
    documentType: DocumentTypeValue;
    patientFacing: boolean;
    sourceMetadata: DocumentMetadata;
    onStage: (stage: UploadStage) => void;
  },
): Promise<{ documentId: string; documentVersionId: string; versionNumber: number }> {
  const mimeType = normalizeMime(input.file);

  if (!mimeType) {
    throw new Error("Unsupported file type. Upload PDF, DOCX, JPG, PNG or TIFF.");
  }

  if (input.file.size > 25 * 1024 * 1024) {
    throw new Error("File is too large. Maximum size is 25 MB.");
  }

  input.onStage("preparing");

  const sha256Hex = await sha256(input.file);

  const body = {
    mode: input.mode,
    targetDocumentId: input.targetDocumentId,
    patientId:
      input.context.kind === "patient"
        ? input.context.patientId
        : (input.context.patientId ?? undefined),
    admissionId: input.context.admissionId ?? undefined,
    retentionClass: retentionFor(input.documentType),
    aggregateType: input.context.kind === "referral" ? "referral" : input.documentType,
    aggregateId: input.context.kind === "referral" ? input.context.referralId : undefined,
    title: input.title,
    patientFacing: input.patientFacing,
    mimeType,
    byteSize: input.file.size,
    sha256Hex,
    sourceMetadata: input.sourceMetadata,
  };

  const initiated = await client.POST("/api/v1/document-uploads", { body: body as never });

  if (initiated.error || !initiated.data) {
    throw new Error(errorMessage(initiated.error, "Upload could not be prepared."));
  }

  input.onStage("uploading");

  const uploadId = initiated.data.uploadId;

  try {
    const uploadHeaders = new Headers(initiated.data.requiredHeaders);

    if (!uploadHeaders.has("content-type")) {
      uploadHeaders.set("content-type", mimeType);
    }

    const put = await fetch(initiated.data.uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body: input.file,
    });

    if (!put.ok) {
      throw new Error(storageError(put.status));
    }

    input.onStage("verifying");

    const completed = await client.POST("/api/v1/document-uploads/{id}/complete", {
      params: {
        path: { id: uploadId },
      },
      body: {},
    });

    if (completed.error || !completed.data) {
      throw new Error(
        errorMessage(
          completed.error,
          "Object uploaded, but verification did not complete. Try again or contact support.",
        ),
      );
    }

    input.onStage("complete");
    return {
      documentId: completed.data.documentId,
      documentVersionId: completed.data.versionId,
      versionNumber: completed.data.versionNumber,
    };
  } catch (err) {
    await client
      .DELETE("/api/v1/document-uploads/{id}", {
        params: {
          path: { id: uploadId },
        },
      })
      .catch(() => undefined);

    throw err;
  }
}

async function sha256(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify file integrity.");
  }

  const bytes =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : await new Response(file).arrayBuffer();

  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeMime(file: File): AcceptedMime | "" {
  if (isAcceptedMime(file.type)) {
    return file.type;
  }

  const name = file.name.toLowerCase();

  if (name.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".tif") || name.endsWith(".tiff")) return "image/tiff";

  return "";
}

function isAcceptedMime(value: string): value is AcceptedMime {
  return ACCEPTED_MIME.has(value as AcceptedMime);
}

function displayDocumentType(doc: DocumentRow): string {
  return labelForType(displayDocumentTypeValue(doc));
}

function displayDocumentTypeValue(doc: DocumentRow): string {
  return doc.metadata?.documentType ?? doc.aggregateType;
}

function labelForType(value: string): string {
  return DOCUMENT_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? labelize(value);
}

function asDocumentType(value: string): DocumentTypeValue {
  return DOCUMENT_TYPE_OPTIONS.some((option) => option.value === value)
    ? (value as DocumentTypeValue)
    : "other";
}

function asSourceChannel(value: string): SourceChannel {
  return SOURCE_OPTIONS.some((option) => option.value === value)
    ? (value as SourceChannel)
    : "manual_upload";
}

function sourceLabel(value: SourceChannel): string {
  return SOURCE_OPTIONS.find((option) => option.value === value)?.label ?? labelize(value);
}

function defaultTitle(value: string): string {
  if (value === "code_status_directive") return "Patient POLST";

  if (value === "consent_record") return "Hospice consent";

  if (value === "referral") return "Referral packet";

  if (value === "intake_source") return "Intake document";

  return "Patient document";
}

function retentionFor(documentType: DocumentTypeValue): RetentionClass {
  return documentType === "referral" || documentType === "intake_source"
    ? "intake_artifact"
    : "clinical_record";
}

function currentVersion(doc: DocumentRow, versions: VersionRow[] | undefined): VersionRow | null {
  if (!versions?.length) return null;

  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
}

function provenanceLabel(metadata: DocumentMetadata | null): string {
  if (!metadata?.sourceChannel) {
    return "Source not recorded";
  }

  const source = sourceLabel(metadata.sourceChannel);

  const received = metadata.receivedAt ? ` · Received ${formatDateTime(metadata.receivedAt)}` : "";

  const sender = metadata.sender ? ` · ${metadata.sender}` : "";

  return `${source}${received}${sender}`;
}

function formatMime(mime: string): string {
  return ACCEPTED_MIME.get(mime as AcceptedMime) ?? mime;
}

function canInlinePreview(mime: string): boolean {
  return mime === "application/pdf" || mime === "image/jpeg" || mime === "image/png";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function labelize(value: string | undefined): string {
  if (!value) return "Unknown";

  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function prune(metadata: DocumentMetadata): DocumentMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value != null && value !== ""),
  ) as DocumentMetadata;
}

function errorMessage(err: unknown, fallback: string): string {
  const error = err as {
    error?: {
      message?: string;
      details?: Array<{
        message?: string;
      }>;
    };
    message?: string;
  };

  const message =
    error?.error?.details?.[0]?.message ?? error?.error?.message ?? error?.message ?? fallback;

  if (/mime|unsupported/i.test(message)) {
    return "Unsupported file type. Upload PDF, DOCX, JPG, PNG or TIFF.";
  }

  if (/size|too large/i.test(message)) {
    return "File is too large. Maximum size is 25 MB.";
  }

  if (/sha|checksum|integrity/i.test(message)) {
    return "The upload failed integrity verification. Choose the file again and retry.";
  }

  if (/expired/i.test(message)) {
    return "The upload expired. Start a new upload and try again.";
  }

  if (/referral/i.test(message) && /not found|denied|access/i.test(message)) {
    return "Referral not accessible.";
  }

  if (/patient/i.test(message) && /not found|denied|access/i.test(message)) {
    return "Patient not accessible.";
  }

  if (/VERSION_MISMATCH|412/i.test(message)) {
    return "This document changed since you opened it. Refresh and try again.";
  }

  if (/storage|s3|minio/i.test(message)) {
    return "Document storage is temporarily unavailable.";
  }

  return message;
}

function storageError(status: number): string {
  if (status >= 500) {
    return "Document storage is temporarily unavailable.";
  }

  if (status === 403) {
    return "The upload URL is no longer valid. Start a new upload and try again.";
  }

  return "The file could not be uploaded to document storage.";
}

function stageLabel(stage: UploadStage): string {
  const labels: Record<UploadStage, string> = {
    idle: "Ready",
    preparing: "Preparing upload",
    uploading: "Uploading file",
    verifying: "Verifying file",
    complete: "Complete",
  };

  return labels[stage];
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const patientShell: CSSProperties = {
  width: "100%",
  maxWidth: "1500px",
  margin: "0 auto",
  display: "grid",
  gap: "1.15rem",
};

const referralShell: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "12px",
  background: "var(--color-surface)",
  padding: "1rem",
  display: "grid",
  gap: "1rem",
};

const collectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1.5rem",
  flexWrap: "wrap",
};

const headerCopy: CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  minWidth: 0,
};

const eyebrow: CSSProperties = {
  color: "var(--color-primary)",
  fontSize: "0.72rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const pageTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 650,
  fontSize: "1.55rem",
  lineHeight: 1.2,
  color: t.onSurface,
};

const compactTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 650,
  fontSize: "1.05rem",
  color: "var(--color-on-surface)",
};

const muted: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.84rem",
  lineHeight: 1.45,
};

const alert: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 28%, transparent)",
  borderRadius: "10px",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 7%, var(--color-surface))",
  padding: "0.72rem 0.85rem",
  fontSize: "0.85rem",
};

const dismissAlert: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: "1.25rem",
  lineHeight: 1,
};

const libraryShell: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "14px",
  overflow: "hidden",
  boxShadow: "var(--shadow-soft)",
};

const categoryBar: CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  overflowX: "auto",
  padding: "0.75rem 1rem 0",
  borderBottom: "1px solid var(--color-outline-variant)",
};

const categoryButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.45rem",
  border: 0,
  borderBottom: "2px solid transparent",
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  padding: "0.65rem 0.55rem 0.75rem",
  fontSize: "0.84rem",
  fontWeight: 550,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const categoryButtonActive: CSSProperties = {
  ...categoryButton,
  color: "var(--color-primary)",
  borderBottomColor: "var(--color-primary)",
  fontWeight: 700,
};

const categoryCount: CSSProperties = {
  minWidth: "1.35rem",
  height: "1.35rem",
  display: "inline-grid",
  placeItems: "center",
  borderRadius: "999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  padding: "0 0.3rem",
  fontSize: "0.68rem",
  fontVariantNumeric: "tabular-nums",
};

const categoryCountActive: CSSProperties = {
  ...categoryCount,
  background: "color-mix(in srgb, var(--color-primary) 12%, var(--color-surface))",
  color: "var(--color-primary)",
};

const toolbar: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
  padding: "0.85rem 1rem 0.65rem",
};

const searchField: CSSProperties = {
  minWidth: "15rem",
  flex: "1 1 22rem",
  height: "2.4rem",
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  padding: "0 0.7rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  background: "var(--color-surface-container-low, var(--color-surface))",
  color: "var(--color-on-surface-variant)",
};

const searchInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: "100%",
  border: 0,
  outline: 0,
  background: "transparent",
  color: "var(--color-on-surface)",
  font: "inherit",
  fontSize: "0.85rem",
};

const clearSearch: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: "1rem",
};

const filterControls: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  flexWrap: "wrap",
};

const select: CSSProperties = {
  height: "2.4rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  padding: "0 2rem 0 0.7rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  font: "inherit",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const resetButton: CSSProperties = {
  height: "2.4rem",
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  fontSize: "0.8rem",
  fontWeight: 700,
  cursor: "pointer",
};

const resultSummary: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0 1rem 0.75rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.76rem",
};

const clearAllButton: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  fontSize: "0.76rem",
  fontWeight: 650,
  cursor: "pointer",
};

const contentArea: CSSProperties = {
  borderTop: "1px solid var(--color-outline-variant)",
};

const loadingState: CSSProperties = {
  minHeight: "18rem",
  display: "grid",
  placeItems: "center",
};

const emptyWrap: CSSProperties = {
  padding: "3rem 1.5rem",
};

const documentList: CSSProperties = {
  width: "100%",
};

const listHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(18rem, 1fr) 9rem 8rem 10rem 6.5rem",
  alignItems: "center",
  gap: "1rem",
  padding: "0.6rem 1rem",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.69rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const documentRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(18rem, 1fr) 9rem 8rem 10rem 6.5rem",
  alignItems: "center",
  gap: "1rem",
  minHeight: "5rem",
  padding: "0.75rem 1rem",
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
};

const documentIdentityButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.8rem",
  minWidth: 0,
  width: "100%",
  textAlign: "left",
  padding: 0,
  border: 0,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

const documentIdentity: CSSProperties = {
  display: "grid",
  gap: "0.16rem",
  minWidth: 0,
};

const rowTitle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--color-on-surface)",
  fontSize: "0.88rem",
  fontWeight: 650,
};

const rowMeta: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const provenanceMeta: CSSProperties = {
  ...rowMeta,
  fontSize: "0.72rem",
};

const dateCell: CSSProperties = {
  display: "grid",
  gap: "0.15rem",
  fontSize: "0.79rem",
  color: "var(--color-on-surface)",
};

const secondaryMeta: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
};

const rowActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: "0.25rem",
};

const viewButton: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  fontSize: "0.79rem",
  fontWeight: 700,
  cursor: "pointer",
  padding: "0.4rem",
};

const moreButton: CSSProperties = {
  width: "2rem",
  height: "2rem",
  display: "grid",
  placeItems: "center",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  letterSpacing: "-0.08em",
};

const fileIcon: CSSProperties = {
  width: "2.3rem",
  height: "2.3rem",
  flexShrink: 0,
  display: "grid",
  placeItems: "center",
  borderRadius: "9px",
};

const largeFileIcon: CSSProperties = {
  width: "3rem",
  height: "3rem",
  borderRadius: "11px",
};

function fileIconTone(value: string): CSSProperties {
  if (value === "code_status_directive") {
    return {
      background: "color-mix(in srgb, var(--color-warning) 13%, var(--color-surface))",
      color: "var(--color-warning, var(--color-on-surface))",
    };
  }

  if (value === "consent_record") {
    return {
      background: "color-mix(in srgb, var(--color-primary) 10%, var(--color-surface))",
      color: "var(--color-primary)",
    };
  }

  if (value === "intake_source" || value === "referral") {
    return {
      background:
        "color-mix(in srgb, var(--color-info, var(--color-primary)) 10%, var(--color-surface))",
      color: "var(--color-info, var(--color-primary))",
    };
  }

  return {
    background: "var(--color-surface-container)",
    color: "var(--color-on-surface-variant)",
  };
}

function typePill(value: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    maxWidth: "100%",
    borderRadius: "999px",
    padding: "0.28rem 0.55rem",
    background:
      value === "code_status_directive"
        ? "color-mix(in srgb, var(--color-warning) 11%, var(--color-surface))"
        : value === "consent_record"
          ? "color-mix(in srgb, var(--color-primary) 9%, var(--color-surface))"
          : "var(--color-surface-container)",
    color: "var(--color-on-surface)",
    fontSize: "0.72rem",
    fontWeight: 650,
    whiteSpace: "nowrap",
  };
}

const modalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "grid",
  placeItems: "center",
  padding: "1rem",
  background: "var(--color-scrim)",
  backdropFilter: "blur(2px)",
};

const modal: CSSProperties = {
  // Reset the UA <dialog> box (absolute positioning, auto margin, padding, border, color) so the
  // open dialog lays out as the centred card inside the grid backdrop.
  position: "relative",
  margin: 0,
  padding: 0,
  color: "inherit",
  maxHeight: "92vh",
  overflow: "hidden",
  background: "var(--color-surface)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "14px",
  boxShadow: "var(--shadow-float)",
  display: "flex",
  flexDirection: "column",
};

const modalHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1rem 1.15rem",
  borderBottom: "1px solid var(--color-outline-variant)",
};

const modalHeading: CSSProperties = {
  display: "grid",
  gap: "0.2rem",
  minWidth: 0,
};

const modalTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  color: "var(--color-on-surface)",
  fontSize: "1.1rem",
  fontWeight: 650,
};

const modalSubtitle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
};

const modalContent: CSSProperties = {
  overflow: "auto",
  padding: "1.15rem",
};

const iconButton: CSSProperties = {
  width: "2rem",
  height: "2rem",
  flexShrink: 0,
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: "1.15rem",
};

const form: CSSProperties = {
  display: "grid",
  gap: "1rem",
};

const formSection: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
};

const formSectionHead: CSSProperties = {
  display: "grid",
  gap: "0.1rem",
};

const formSectionTitle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.88rem",
};

const formSectionDescription: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const formSectionBody: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
};

const field: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
};

const fieldLabelText: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.76rem",
  fontWeight: 650,
};

const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  padding: "0.62rem 0.7rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  font: "inherit",
  fontSize: "0.84rem",
  outline: 0,
  minWidth: 0,
};

const twoColumnGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};

const optionalGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.7rem",
};

const dropZone: CSSProperties = {
  minHeight: "8.5rem",
  border: "1.5px dashed var(--color-outline)",
  borderRadius: "11px",
  padding: "1.2rem",
  display: "grid",
  placeItems: "center",
  alignContent: "center",
  textAlign: "center",
  gap: "0.3rem",
  cursor: "pointer",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
};

const dropZoneSelected: CSSProperties = {
  ...dropZone,
  borderColor: "color-mix(in srgb, var(--color-primary) 55%, var(--color-outline))",
  background: "color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))",
};

const uploadIconWrap: CSSProperties = {
  width: "2.8rem",
  height: "2.8rem",
  display: "grid",
  placeItems: "center",
  borderRadius: "999px",
  color: "var(--color-primary)",
  background: "color-mix(in srgb, var(--color-primary) 9%, var(--color-surface))",
  marginBottom: "0.2rem",
};

const dropTitle: CSSProperties = {
  fontSize: "0.86rem",
  color: "var(--color-on-surface)",
};

const dropHelp: CSSProperties = {
  fontSize: "0.74rem",
  color: "var(--color-on-surface-variant)",
};

const portalVisibility: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "10px",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
  padding: "0.75rem",
};

const check: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.65rem",
  cursor: "pointer",
};

const checkTitle: CSSProperties = {
  display: "block",
  fontSize: "0.83rem",
  color: "var(--color-on-surface)",
};

const checkDescription: CSSProperties = {
  display: "block",
  marginTop: "0.12rem",
  fontSize: "0.74rem",
  lineHeight: 1.4,
  color: "var(--color-on-surface-variant)",
};

const versionTarget: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.7rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "10px",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
  padding: "0.7rem",
};

const versionTargetLabel: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  marginBottom: "0.1rem",
};

const dialogActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: "0.5rem",
  paddingTop: "0.25rem",
};

const progressShell: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "10px",
  padding: "0.75rem",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
  display: "grid",
  gap: "0.65rem",
};

const progressTop: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  fontSize: "0.78rem",
  fontWeight: 650,
};

const progressSteps: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "0.4rem",
};

const progressStep: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
  minWidth: 0,
};

const progressDot: CSSProperties = {
  width: "0.45rem",
  height: "0.45rem",
  flexShrink: 0,
  borderRadius: "999px",
  background: "var(--color-outline-variant)",
};

const progressDotActive: CSSProperties = {
  background: "var(--color-primary)",
};

const progressLabel: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.68rem",
};

const progressLabelActive: CSSProperties = {
  color: "var(--color-on-surface)",
  fontWeight: 650,
};

const detailBody: CSSProperties = {
  display: "grid",
  gap: "1.25rem",
};

const detailHero: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.85rem",
};

const detailHeroCopy: CSSProperties = {
  minWidth: 0,
  display: "grid",
  gap: "0.3rem",
};

const detailPills: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  flexWrap: "wrap",
};

const detailTitle: CSSProperties = {
  fontSize: "1rem",
  color: "var(--color-on-surface)",
};

const primaryActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const detailSection: CSSProperties = {
  display: "grid",
  gap: "0.7rem",
  paddingTop: "0.2rem",
};

const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.75rem",
};

const detailField: CSSProperties = {
  minHeight: "4.2rem",
  display: "grid",
  alignContent: "start",
  gap: "0.22rem",
  padding: "0.65rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
};

const fieldLabel: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.67rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.045em",
};

const fieldValue: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.82rem",
  fontWeight: 550,
};

const smallHeading: CSSProperties = {
  margin: 0,
  fontSize: "0.9rem",
  color: "var(--color-on-surface)",
};

const sectionDescription: CSSProperties = {
  margin: "0.15rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.73rem",
};

const notesBox: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  padding: "0.75rem",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
  color: "var(--color-on-surface)",
  fontSize: "0.82rem",
  lineHeight: 1.5,
};

const versionHeading: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const versionCount: CSSProperties = {
  minWidth: "1.5rem",
  height: "1.5rem",
  display: "grid",
  placeItems: "center",
  borderRadius: "999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 700,
};

const versionList: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "10px",
  overflow: "hidden",
};

const versionRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "3rem minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.7rem",
  borderTop: "1px solid var(--color-outline-variant)",
};

const versionNumber: CSSProperties = {
  fontFamily: t.fontMono,
  color: "var(--color-on-surface)",
  fontSize: "0.78rem",
  fontWeight: 700,
};

const versionMeta: CSSProperties = {
  minWidth: 0,
  display: "grid",
  gap: "0.12rem",
  fontSize: "0.78rem",
};

const currentBadge: CSSProperties = {
  display: "inline-flex",
  borderRadius: "999px",
  padding: "0.22rem 0.48rem",
  background: "color-mix(in srgb, var(--color-success) 12%, var(--color-surface))",
  color: "var(--color-success, var(--color-primary))",
  fontSize: "0.67rem",
  fontWeight: 700,
};

const noVersions: CSSProperties = {
  border: "1px dashed var(--color-outline-variant)",
  borderRadius: "9px",
  padding: "1rem",
  textAlign: "center",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};

const previewFrame: CSSProperties = {
  height: "72vh",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "10px",
  overflow: "hidden",
  background: "var(--color-surface-low, var(--color-surface-container-low))",
};

const previewMedia: CSSProperties = {
  width: "100%",
  height: "100%",
  border: 0,
};

const previewImage: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
};
