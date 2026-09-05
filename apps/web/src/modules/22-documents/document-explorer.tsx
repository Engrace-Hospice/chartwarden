import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  StatusPill,
  lifecycleTone,
} from "./lantern";

interface DocumentRow {
  id: string;
  patientId: string | null;
  retentionClass: string;
  aggregateType: string;
  title: string;
  status: string;
  version: number;
  updatedAt: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  compliance: "Compliance",
  clinical_record: "Clinical",
  bereavement: "Bereavement",
  operational: "Operational",
  intake_artifact: "Intake",
  compliance_42cfr_part2: "Part 2 / SUD",
};

const DOC_PAGE_SIZES = [
  5, 10, 15, 20, 30, 50,
] as const;

export function DocumentExplorer(): JSX.Element {
  const client = useApiClient();

  const [items, setItems] = useState<DocumentRow[]>(
    [],
  );

  const [searchQuery, setSearchQuery] =
    useState("");
  const [retentionFilter, setRetentionFilter] =
    useState("");
  const [typeFilter, setTypeFilter] =
    useState("");
  const [statusFilter, setStatusFilter] =
    useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] =
    useState(10);

  const [loading, setLoading] =
    useState(true);
  const [error, setError] =
    useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data, error: err } =
      await client.GET(
        "/api/v1/documents",
        {
          params: {
            query: retentionFilter
              ? {
                  retentionClass:
                    retentionFilter,
                }
              : {},
          },
        },
      );

    if (err) {
      setError(
        "Could not load documents. Try again or change the filters.",
      );
      setLoading(false);
      return;
    }

    setItems(
      (data?.items ?? []) as DocumentRow[],
    );

    setLoading(false);
  }, [client, retentionFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeOptions = useMemo(
    () =>
      [
        ...new Set(
          items
            .map(
              (document) =>
                document.aggregateType,
            )
            .filter(Boolean),
        ),
      ].sort(),
    [items],
  );

  const statusOptions = useMemo(
    () =>
      [
        ...new Set(
          items
            .map(
              (document) =>
                document.status,
            )
            .filter(Boolean),
        ),
      ].sort(),
    [items],
  );

  const counts = useMemo(
    () => ({
      total: items.length,

      clinical: items.filter(
        (document) =>
          document.retentionClass ===
          "clinical_record",
      ).length,

      part2: items.filter(
        (document) =>
          document.retentionClass ===
          "compliance_42cfr_part2",
      ).length,

      intake: items.filter(
        (document) =>
          document.retentionClass ===
          "intake_artifact",
      ).length,
    }),
    [items],
  );

  const rows = useMemo(() => {
    const query = searchQuery
      .trim()
      .toLowerCase();

    const visible = items.filter(
      (document) => {
        const matchesRetention =
          !retentionFilter ||
          document.retentionClass ===
            retentionFilter;

        const matchesType =
          !typeFilter ||
          document.aggregateType ===
            typeFilter;

        const matchesStatus =
          !statusFilter ||
          document.status ===
            statusFilter;

        const matchesSearch =
          !query ||
          document.id
            .toLowerCase()
            .includes(query) ||
          (document.patientId
            ?.toLowerCase()
            .includes(query) ??
            false) ||
          document.title
            .toLowerCase()
            .includes(query) ||
          document.retentionClass
            .toLowerCase()
            .includes(query) ||
          document.aggregateType
            .toLowerCase()
            .includes(query) ||
          document.status
            .toLowerCase()
            .includes(query);

        return (
          matchesRetention &&
          matchesType &&
          matchesStatus &&
          matchesSearch
        );
      },
    );

    return [...visible].sort(
      (a, b) =>
        Date.parse(b.updatedAt) -
        Date.parse(a.updatedAt),
    );
  }, [
    items,
    retentionFilter,
    searchQuery,
    statusFilter,
    typeFilter,
  ]);

  const activeFilters = [
    searchQuery.trim() !== "",
    retentionFilter !== "",
    typeFilter !== "",
    statusFilter !== "",
  ].filter(Boolean).length;

  const pageCount = Math.max(
    1,
    Math.ceil(rows.length / pageSize),
  );

  const activePage = Math.min(
    page,
    pageCount,
  );

  const pagedRows = rows.slice(
    (activePage - 1) * pageSize,
    activePage * pageSize,
  );

  const clearFilters = (): void => {
    setSearchQuery("");
    setRetentionFilter("");
    setTypeFilter("");
    setStatusFilter("");
    setPage(1);
  };

  const setRetention = (
    retentionClass: string,
  ): void => {
    setRetentionFilter(
      retentionFilter === retentionClass
        ? ""
        : retentionClass,
    );
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Documents"
          breadcrumb="Records / Documents"
        >
          <p style={pageDescription}>
            Search and review organization-wide
            documents by patient, category,
            retention class and status.
          </p>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="All documents"
            value={
              loading || error
                ? "—"
                : counts.total
            }
            detail="Available records"
            tone="info"
            accentColor="var(--color-primary)"
            selected={
              !retentionFilter &&
              !typeFilter &&
              !statusFilter
            }
            onSelect={clearFilters}
          />

          <KpiCard
            label="Clinical"
            value={
              loading || error
                ? "—"
                : counts.clinical
            }
            detail="Clinical records"
            tone="neutral"
            accentColor="var(--color-primary)"
            selected={
              retentionFilter ===
              "clinical_record"
            }
            onSelect={() =>
              setRetention(
                "clinical_record",
              )
            }
          />

          <KpiCard
            label="From intake"
            value={
              loading || error
                ? "—"
                : counts.intake
            }
            detail="Intake artifacts"
            tone={
              counts.intake > 0
                ? "success"
                : "neutral"
            }
            accentColor={
              counts.intake > 0
                ? "var(--color-success)"
                : "var(--color-outline-variant)"
            }
            selected={
              retentionFilter ===
              "intake_artifact"
            }
            onSelect={() =>
              setRetention(
                "intake_artifact",
              )
            }
          />

          <KpiCard
            label="Part 2 / SUD"
            value={
              loading || error
                ? "—"
                : counts.part2
            }
            detail="Restricted records"
            tone={
              counts.part2 > 0
                ? "warning"
                : "neutral"
            }
            accentColor={
              counts.part2 > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
            selected={
              retentionFilter ===
              "compliance_42cfr_part2"
            }
            onSelect={() =>
              setRetention(
                "compliance_42cfr_part2",
              )
            }
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div
              role="alert"
              style={errorBannerStyle}
            >
              <span>{error}</span>

              <button
                type="button"
                onClick={() =>
                  setError(null)
                }
                style={dismissButtonStyle}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          ) : null}

          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span
                style={toolbarEyebrowStyle}
              >
                Document library
              </span>

              <strong>
                {rows.length}{" "}
                {rows.length === 1
                  ? "matching document"
                  : "matching documents"}
              </strong>
            </div>

            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <SearchIcon />

                <input
                  type="search"
                  placeholder="Search document, patient or ID..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(
                      event.target.value,
                    );
                    setPage(1);
                  }}
                  aria-label="Search documents"
                  style={searchInputStyle}
                />

                {searchQuery ? (
                  <button
                    type="button"
                    style={searchClearStyle}
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchQuery("");
                      setPage(1);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>

              <select
                aria-label="Retention class"
                value={retentionFilter}
                onChange={(event) => {
                  setRetentionFilter(
                    event.target.value,
                  );
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">
                  Retention: All
                </option>

                {Object.entries(
                  CATEGORY_LABEL,
                ).map(([key, label]) => (
                  <option
                    key={key}
                    value={key}
                  >
                    {label}
                  </option>
                ))}
              </select>

              <select
                aria-label="Document type"
                value={typeFilter}
                onChange={(event) => {
                  setTypeFilter(
                    event.target.value,
                  );
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">
                  Type: All
                </option>

                {typeOptions.map(
                  (option) => (
                    <option
                      key={option}
                      value={option}
                    >
                      {stateLabel(option)}
                    </option>
                  ),
                )}
              </select>

              <select
                aria-label="Document status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
                    event.target.value,
                  );
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">
                  Status: All
                </option>

                {statusOptions.map(
                  (option) => (
                    <option
                      key={option}
                      value={option}
                    >
                      {stateLabel(option)}
                    </option>
                  ),
                )}
              </select>

              {activeFilters > 0 ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  onClick={clearFilters}
                >
                  Reset filters
                </Button>
              ) : null}
            </div>
          </div>

          {activeFilters > 0 ? (
            <div style={activeFilterSummary}>
              <span>
                {activeFilters} active{" "}
                {activeFilters === 1
                  ? "filter"
                  : "filters"}
              </span>

              <button
                type="button"
                style={clearFiltersLink}
                onClick={clearFilters}
              >
                Clear all
              </button>
            </div>
          ) : null}
        </div>
      }
      table={
        error ? (
          <div style={stateWrapStyle}>
            <EmptyState
              title="Documents unavailable"
              description={error}
              action={
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={() =>
                    void load()
                  }
                >
                  Try again
                </Button>
              }
            />
          </div>
        ) : loading &&
          items.length === 0 ? (
          <div style={loadingWrapStyle}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={stateWrapStyle}>
            <EmptyState
              title={
                activeFilters > 0
                  ? "No matching documents"
                  : "No documents"
              }
              description={
                activeFilters > 0
                  ? "Try adjusting or clearing the filters."
                  : "No documents are available for this organization."
              }
              action={
                activeFilters > 0 ? (
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th
                    style={{
                      ...thStyle,
                      width: "34%",
                    }}
                  >
                    Document
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      width: "18%",
                    }}
                  >
                    Category
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      width: "16%",
                    }}
                  >
                    Patient
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      width: "9%",
                    }}
                  >
                    Version
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      width: "12%",
                    }}
                  >
                    Status
                  </th>

                  <th
                    style={{
                      ...thStyle,
                      width: "11%",
                      textAlign: "right",
                    }}
                  >
                    Updated
                  </th>
                </tr>
              </thead>

              <tbody>
                {pagedRows.map(
                  (document) => (
                    <tr
                      key={document.id}
                      style={rowStyle}
                    >
                      <td style={tdStyle}>
                        <div
                          style={
                            documentCellStyle
                          }
                        >
                          <DocumentIcon
                            type={
                              document.aggregateType
                            }
                          />

                          <div
                            style={
                              primaryCellStyle
                            }
                          >
                            <span
                              style={
                                primaryTextStyle
                              }
                            >
                              {
                                document.title
                              }
                            </span>

                            <div
                              style={
                                idMetaStyle
                              }
                            >
                              <span>
                                {
                                  stateLabel(
                                    document.aggregateType,
                                  )
                                }
                              </span>

                              <span>·</span>

                              <code
                                className="wx-data-md"
                                style={
                                  codeStyle
                                }
                              >
                                {shortId(
                                  document.id,
                                )}
                              </code>
                            </div>
                          </div>
                        </div>
                      </td>

                      <td style={tdStyle}>
                        <CategoryPill
                          value={
                            document.retentionClass
                          }
                        />
                      </td>

                      <td style={tdStyle}>
                        {document.patientId ? (
                          <code
                            className="wx-data-md"
                            style={
                              patientCodeStyle
                            }
                          >
                            {shortId(
                              document.patientId,
                            )}
                          </code>
                        ) : (
                          <span
                            style={
                              emptyValueStyle
                            }
                          >
                            Not linked
                          </span>
                        )}
                      </td>

                      <td
                        style={{
                          ...tdStyle,
                          fontVariantNumeric:
                            "tabular-nums",
                        }}
                      >
                        <span
                          style={
                            versionPillStyle
                          }
                        >
                          v
                          {
                            document.version
                          }
                        </span>
                      </td>

                      <td style={tdStyle}>
                        <StatusPill
                          tone={lifecycleTone(
                            document.status,
                          )}
                        >
                          {stateLabel(
                            document.status,
                          )}
                        </StatusPill>
                      </td>

                      <td
                        style={{
                          ...tdStyle,
                          textAlign: "right",
                          fontVariantNumeric:
                            "tabular-nums",
                        }}
                      >
                        <span
                          style={
                            dateTextStyle
                          }
                        >
                          {formatDateTime(
                            document.updatedAt,
                          )}
                        </span>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>

            <div style={paginationShell}>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={rows.length}
                onPageChange={setPage}
                onPageSizeChange={(
                  nextPageSize,
                ) => {
                  setPageSize(
                    nextPageSize,
                  );
                  setPage(1);
                }}
                pageSizeOptions={
                  DOC_PAGE_SIZES
                }
                noun="documents"
              />
            </div>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function SearchIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      aria-hidden="true"
      fill="none"
    >
      <circle
        cx="11"
        cy="11"
        r="6.5"
        stroke="currentColor"
        strokeWidth="1.7"
      />

      <path
        d="m16 16 4 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DocumentIcon({
  type,
}: {
  type: string;
}): JSX.Element {
  return (
    <span style={documentIconStyle(type)}>
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        fill="none"
      >
        <path
          d="M7 3.5h6.5L18 8v12.5H7v-17Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />

        <path
          d="M13.5 3.5V8H18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function CategoryPill({
  value,
}: {
  value: string;
}): JSX.Element {
  return (
    <span style={categoryPillStyle(value)}>
      {CATEGORY_LABEL[value] ?? value}
    </span>
  );
}

function stateLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) =>
      character.toUpperCase(),
    );
}

function formatDateTime(
  iso: string | null,
): string {
  if (!iso) return "—";

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string): string {
  return id.length > 18
    ? `${id.slice(0, 8)}…${id.slice(-6)}`
    : id;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const pageDescription: CSSProperties = {
  margin: "0.25rem 0 0",
  color:
    "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
  lineHeight: 1.45,
};

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
  padding: "0 1.5rem 0.85rem",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.35rem 0",
};

const toolbarTitleStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.12rem",
  color: "var(--color-on-surface)",
  fontSize: "0.84rem",
};

const toolbarEyebrowStyle: CSSProperties = {
  color:
    "var(--color-on-surface-variant)",
  fontSize: "0.68rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.055em",
};

const controlGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  flexWrap: "wrap",
};

const searchWrapStyle: CSSProperties = {
  width: "min(22rem, 100%)",
  height: "2.35rem",
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  border:
    "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  padding: "0 0.7rem",
  color:
    "var(--color-on-surface-variant)",
  background: "var(--color-surface)",
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: "100%",
  border: 0,
  outline: 0,
  background: "transparent",
  color: "var(--color-on-surface)",
  font: "inherit",
  fontSize: "0.82rem",
};

const searchClearStyle: CSSProperties = {
  border: 0,
  background: "transparent",
  color:
    "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: "1rem",
};

const selectStyle: CSSProperties = {
  height: "2.35rem",
  border:
    "1px solid var(--color-outline-variant)",
  borderRadius: "9px",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  padding: "0 1.8rem 0 0.65rem",
  font: "inherit",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const activeFilterSummary: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  color:
    "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
};

const clearFiltersLink: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  fontSize: "0.72rem",
  fontWeight: 700,
  cursor: "pointer",
  padding: 0,
};

const errorBannerStyle: CSSProperties = {
  padding: "0.65rem 0.85rem",
  borderRadius: "9px",
  background:
    "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  border:
    "1px solid color-mix(in srgb, var(--color-error) 28%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.82rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const dismissButtonStyle: CSSProperties = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontSize: "1.1rem",
};

const stateWrapStyle: CSSProperties = {
  padding: "2.5rem 1.5rem",
};

const loadingWrapStyle: CSSProperties = {
  padding: "3.5rem 1.5rem",
  textAlign: "center",
};

const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.84rem",
};

const headerRowStyle: CSSProperties = {
  textAlign: "left",
  color:
    "var(--color-on-surface-variant)",
  borderBottom:
    "1px solid var(--color-outline-variant)",
  background:
    "var(--color-surface-low, var(--color-surface-container-low))",
};

const rowStyle: CSSProperties = {
  borderBottom:
    "1px solid color-mix(in srgb, var(--color-outline-variant) 62%, transparent)",
};

const thStyle: CSSProperties = {
  padding: "0.62rem 0.85rem",
  fontWeight: 700,
  fontSize: "0.68rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: CSSProperties = {
  padding: "0.78rem 0.85rem",
  verticalAlign: "middle",
};

const documentCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.7rem",
  minWidth: 0,
};

const primaryCellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  minWidth: 0,
};

const primaryTextStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontWeight: 650,
  color: "var(--color-on-surface)",
};

const idMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
  color:
    "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
};

const codeStyle: CSSProperties = {
  display: "inline-block",
  maxWidth: "10rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color:
    "var(--color-on-surface-variant)",
  fontSize: "0.69rem",
};

const patientCodeStyle: CSSProperties = {
  ...codeStyle,
  padding: "0.15rem 0.35rem",
  borderRadius: "5px",
  background:
    "var(--color-surface-container)",
};

const emptyValueStyle: CSSProperties = {
  color: "var(--color-muted)",
  fontSize: "0.78rem",
};

const versionPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "2rem",
  borderRadius: "6px",
  padding: "0.18rem 0.35rem",
  background:
    "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.74rem",
  fontWeight: 650,
};

const dateTextStyle: CSSProperties = {
  color:
    "var(--color-on-surface-variant)",
  fontSize: "0.76rem",
  whiteSpace: "nowrap",
};

const paginationShell: CSSProperties = {
  paddingTop: "0.75rem",
};

function documentIconStyle(
  type: string,
): CSSProperties {
  const compliance =
    type.includes("consent") ||
    type.includes("code_status");

  return {
    width: "2.25rem",
    height: "2.25rem",
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    borderRadius: "8px",
    background: compliance
      ? "color-mix(in srgb, var(--color-primary) 9%, var(--color-surface))"
      : "var(--color-surface-container)",
    color: compliance
      ? "var(--color-primary)"
      : "var(--color-on-surface-variant)",
  };
}

function categoryPillStyle(
  category: string,
): CSSProperties {
  const restricted =
    category ===
    "compliance_42cfr_part2";

  const intake =
    category === "intake_artifact";

  return {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "999px",
    padding: "0.27rem 0.52rem",
    background: restricted
      ? "color-mix(in srgb, var(--color-warning) 11%, var(--color-surface))"
      : intake
        ? "color-mix(in srgb, var(--color-success) 9%, var(--color-surface))"
        : "var(--color-surface-container)",
    color: "var(--color-on-surface)",
    fontSize: "0.7rem",
    fontWeight: 650,
    whiteSpace: "nowrap",
  };
}
