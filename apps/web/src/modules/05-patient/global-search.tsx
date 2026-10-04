import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  setSearchTerm,
  useApiClient,
  useSearchTerm,
} from "@wardenx/ui";
import type { StatusTone } from "@wardenx/ui";
// apps/web/src/modules/05-patient — Global Search Results (cross-cutting; M5 owns it, M5→M2 edge).
// Spec: docs/design/screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md — "Use Work Queue."
// Matched to the P0 Pencil frame (wardenx-P0-foundation.pen `Cp053`): a centered results column of
// per-scope No-Line cards, each a list of rows (avatar + name + meta + status + chevron) that
// navigate straight to the record. FB-T11 (partial): the live facets are the M5 **patient** facet
// (GET /api/v1/patients?q=) and the M2 **staff** facet (GET /api/v1/orgs/:id/members?q=). Later
// scopes (documents/orders/visits/commands) render as honest "available when <module> ships" rows —
// visible, never fabricated. The server stays the only enforcement point: patient hits are
// RLS/caseload-scoped, the staff facet is behind member.manage (a 403 degrades to a clear note). The
// patient list carries no SSN/MBI, so the spec's "SSN never shown / MBI masked" holds by construction.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../02-identity/auth-client";
import { STATUS_TONE, statusLabel } from "./patient-status";

type Facet = "all" | "patient" | "staff";

interface PatientHit {
  id: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}
interface StaffHit {
  membershipId: string;
  userId: string;
  status: string;
  isAdmin: boolean;
}

interface SearchRow {
  kind: "patient" | "staff";
  id: string;
  title: string;
  meta: JSX.Element | string;
  initials: string;
  status: string;
  tone: StatusTone;
}

// Scopes the merged data layer can't serve yet — shown so the search's reach is honest, not fabricated.
const FUTURE_FACETS = [
  { label: "Documents", blocked: "M22 Documents" },
  { label: "Orders & claims", blocked: "M16 Orders" },
  { label: "Visits / encounters", blocked: "M19 Encounters" },
  { label: "Navigation & commands", blocked: "the command palette" },
] as const;
const SEARCH_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

// Recent search terms carry PHI (patient names / MRNs), so they MUST NOT be persisted — no
// localStorage/sessionStorage, which would survive in browser storage long after the session and
// leak through a shared/forensic device. They live in process memory only (this module-scoped
// array), so they vanish on reload/navigation away. Capped at 6, most-recent-first.
//
// GAP-080 closed the OTHER door into the same exposure: the needle also used to round-trip through
// `?q=` in the visible URL, which is browser storage by another name (history entry, omnibox
// autocomplete, on-disk session restore) and, unlike this array, survives a reload. The term is now
// handed over in memory via `@wardenx/ui`'s `useSearchTerm`, on exactly the posture this array has.
const recentTerms: string[] = [];

function readRecent(): string[] {
  return [...recentTerms];
}

function pushRecent(term: string): string[] {
  const next = [term, ...recentTerms.filter((t) => t !== term)].slice(0, 6);
  recentTerms.length = 0;
  recentTerms.push(...next);
  return next;
}

function initialsOf(...parts: string[]): string {
  const words = parts.flatMap((p) => p.split(/[\s,]+/)).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "S"
  ).slice(0, 2);
}

export function GlobalSearchResults(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  // The active needle lives in memory (GAP-080) — never in the URL. `useSearchParams` is retained
  // only to SCRUB a legacy `?q=`: nothing in this app writes one any more, so one can now only
  // arrive from OUTSIDE (a bookmark or a pasted link made before this change, or a hand-typed URL).
  // Such a link is honored once, and the query string is stripped from the history entry in the same
  // tick with `replace: true` so it is not left in the back/forward stack.
  const [params, setParams] = useSearchParams();
  const staged = useSearchTerm();
  const legacyUrlQuery = params.get("q")?.trim() ?? "";
  useEffect(() => {
    if (!legacyUrlQuery) return;
    setSearchTerm(legacyUrlQuery);
    setParams({}, { replace: true });
  }, [legacyUrlQuery, setParams]);
  const activeQuery = staged || legacyUrlQuery;

  const [term, setTerm] = useState(activeQuery);
  const [facet, setFacet] = useState<Facet>("all");
  const [patients, setPatients] = useState<PatientHit[] | null>(null);
  const [staff, setStaff] = useState<StaffHit[] | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [patientError, setPatientError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Resolve the active org once (for the staff facet path); null when no org is bound.
  const orgRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    void authClient.getSession().then(({ data }) => {
      orgRef.current = data?.session?.activeOrganizationId ?? null;
    });
  }, []);

  const runSearch = useCallback(
    async (q: string) => {
      const needle = q.trim();
      setPage(1);
      if (!needle) {
        setPatients(null);
        setStaff(null);
        return;
      }
      setLoading(true);
      setPatientError(null);
      setStaffError(null);

      const patientReq = client
        .GET("/api/v1/patients", { params: { query: { q: needle, limit: 25 } } })
        .then(({ data, error }) => {
          if (error) {
            setPatientError("Patient search is unavailable.");
            setPatients([]);
            return;
          }
          setPatients((data?.items ?? []) as PatientHit[]);
        });

      const org = orgRef.current;
      const staffReq =
        org == null
          ? Promise.resolve().then(() => {
              setStaff([]);
              setStaffError(
                org === null ? "Staff search needs an organization-bound session." : null,
              );
            })
          : client
              .GET("/api/v1/orgs/{id}/members", {
                params: { path: { id: org }, query: { q: needle } },
              })
              .then(({ data, error }) => {
                if (error) {
                  setStaff([]);
                  setStaffError("Staff search needs the member-management permission.");
                  return;
                }
                setStaff((data?.members ?? []) as StaffHit[]);
              });

      await Promise.all([patientReq, staffReq]);
      setLoading(false);
      setRecent(pushRecent(needle));
    },
    [client],
  );

  useEffect(() => {
    setTerm(activeQuery);
    void runSearch(activeQuery);
  }, [activeQuery, runSearch]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    setSearchTerm(term);
  }

  const patientRows = useMemo(
    () =>
      (patients ?? []).map<SearchRow>((patient) => ({
        kind: "patient",
        id: patient.id,
        title: `${patient.lastName}, ${patient.firstName}`,
        meta: (
          <>
            MRN <span className="wx-data-md">{patient.mrn}</span> · DOB{" "}
            <span className="tabular-nums">{patient.dob}</span>
          </>
        ),
        initials: initialsOf(patient.firstName, patient.lastName),
        status: statusLabel(patient.status),
        tone: STATUS_TONE[patient.status] ?? "neutral",
      })),
    [patients],
  );
  const staffRows = useMemo(
    () =>
      (staff ?? []).map<SearchRow>((member) => ({
        kind: "staff",
        id: member.membershipId,
        title: member.userId.slice(0, 8),
        meta: member.isAdmin ? "Org admin" : "Member",
        initials: initialsOf(member.userId),
        status: statusLabel(member.status),
        tone: member.status === "active" ? "success" : "neutral",
      })),
    [staff],
  );
  const visibleRows = useMemo(() => {
    if (facet === "patient") return patientRows;
    if (facet === "staff") return staffRows;
    return [...patientRows, ...staffRows];
  }, [facet, patientRows, staffRows]);

  const hasQuery = activeQuery.length > 0;
  const total = visibleRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = visibleRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const patientCount = patients?.length ?? 0;
  const staffCount = staff?.length ?? 0;

  const chooseFacet = (next: Facet): void => {
    setFacet(next);
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Search" breadcrumb="Workspace">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Search patients by name or MRN, and staff in your organization.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {patientError || staffError ? (
            <output style={noticeStyle}>
              <Glyph name="alert" size={16} />
              <span>{[patientError, staffError].filter(Boolean).join(" ")}</span>
            </output>
          ) : null}
          <div style={toolbarStyle}>
            <form onSubmit={submit} className="wx-search-field" style={{ maxWidth: "none" }}>
              <Glyph name="search" size={16} />
              <input
                aria-label="Search patients and staff"
                placeholder="Search patients, MRNs, staff..."
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
              <Button type="submit" tone="primary">
                Search
              </Button>
            </form>

            <div className="wx-subtabs wx-subtabs-inline" role="tablist" aria-label="Result scope">
              {(["all", "patient", "staff"] as Facet[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={facet === f}
                  onClick={() => chooseFacet(f)}
                >
                  {f === "all"
                    ? `All (${patientCount + staffCount})`
                    : f === "patient"
                      ? `Patients (${patientCount})`
                      : `Staff (${staffCount})`}
                </button>
              ))}
            </div>
          </div>
        </div>
      }
      table={
        !hasQuery ? (
          <EmptyQuery recent={recent} onPick={setSearchTerm} />
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={`No results for "${activeQuery}".`}
              description="Search is scoped to the records this session is permitted to read."
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headRowStyle}>
                  <th style={{ ...thStyle, width: "18%" }}>Scope</th>
                  <th style={{ ...thStyle, width: "42%" }}>Result</th>
                  <th style={{ ...thStyle, width: "20%" }}>Status</th>
                  <th style={{ ...thStyle, width: "20%", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => (
                  <tr key={`${row.kind}-${row.id}`} style={rowStyle}>
                    <td style={tdStyle}>
                      <StatusPill
                        label={row.kind === "patient" ? "Patient" : "Staff"}
                        tone="neutral"
                      />
                    </td>
                    <td style={tdStyle}>
                      <ResultCell row={row} />
                    </td>
                    <td style={tdStyle}>
                      <StatusPill label={row.status} tone={row.tone} />
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <Button
                        size="sm"
                        tone="secondary"
                        onClick={() =>
                          row.kind === "patient"
                            ? navigate(`/patients/${row.id}`)
                            : navigate("/admin/staff")
                        }
                      >
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={visibleRows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={SEARCH_PAGE_SIZES}
              noun="results"
            />
            <FutureFacets />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function EmptyQuery({
  recent,
  onPick,
}: {
  recent: string[];
  onPick: (term: string) => void;
}): JSX.Element {
  return (
    <div style={emptyQueryStyle}>
      <EmptyState
        title="Search across your workspace"
        description="Use a patient name, MRN, or staff identifier. Recent searches stay in memory only."
      />
      {recent.length > 0 ? (
        <section style={recentStyle}>
          <h2 style={sectionHeadStyle}>Recent searches</h2>
          <div style={chipRowStyle}>
            {recent.map((term) => (
              <button key={term} type="button" onClick={() => onPick(term)} style={chipStyle}>
                {term}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ResultCell({ row }: { row: SearchRow }): JSX.Element {
  return (
    <div style={resultCellStyle}>
      <div style={avatarStyle} aria-hidden>
        {row.initials}
      </div>
      <div style={cellTextStyle}>
        <span className={row.kind === "staff" ? "wx-data-md" : undefined} style={primaryTextStyle}>
          {row.title}
        </span>
        <span style={secondaryTextStyle}>{row.meta}</span>
      </div>
    </div>
  );
}

function FutureFacets(): JSX.Element {
  return (
    <section style={futurePanelStyle}>
      <h2 style={sectionHeadStyle}>Other scopes</h2>
      <div style={futureGridStyle}>
        {FUTURE_FACETS.map((facet) => (
          <div key={facet.label} style={futureItemStyle}>
            <span style={futureLabelStyle}>{facet.label}</span>
            <span style={futureDetailStyle}>available when {facet.blocked} ships</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const noticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};
const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};
const headRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle",
};
const resultCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};
const avatarStyle: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 600,
  fontSize: "0.85rem",
  flexShrink: 0,
};
const cellTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
};
const primaryTextStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const secondaryTextStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};
const emptyQueryStyle: CSSProperties = {
  padding: "2rem 1.5rem",
  maxWidth: "52rem",
};
const recentStyle: CSSProperties = {
  marginTop: "1rem",
};
const sectionHeadStyle: CSSProperties = {
  margin: "0 0 0.5rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 600,
};
const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
};
const chipStyle: CSSProperties = {
  padding: "0.35rem 0.75rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
  borderRadius: "9999px",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  cursor: "pointer",
  fontSize: "0.85rem",
};
const futurePanelStyle: CSSProperties = {
  marginTop: "1rem",
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};
const futureGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const futureItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
};
const futureLabelStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const futureDetailStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
};
