import {
  cardSurface,
  EmptyState,
  ghostBorder,
  Glyph,
  LoadingSpinner,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
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
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
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

// Scopes the merged data layer can't serve yet — shown so the search's reach is honest, not fabricated.
const FUTURE_FACETS = [
  { label: "Documents", blocked: "M22 Documents" },
  { label: "Orders & claims", blocked: "M16 Orders" },
  { label: "Visits / encounters", blocked: "M19 Encounters" },
  { label: "Navigation & commands", blocked: "the command palette" },
] as const;

const RECENT_KEY = "wardenx.search.recent";

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function pushRecent(term: string): string[] {
  const next = [term, ...readRecent().filter((t) => t !== term)].slice(0, 6);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode / no storage — recents are best-effort */
  }
  return next;
}

// Initials for a result avatar (No-Line tinted circle, §3.3). Falls back to the first 2 chars.
function initialsOf(...parts: string[]): string {
  const words = parts.flatMap((p) => p.split(/[\s,]+/)).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "·").slice(0, 2);
}

export function GlobalSearchResults(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get("q")?.trim() ?? "";

  const [term, setTerm] = useState(urlQuery);
  const [facet, setFacet] = useState<Facet>("all");
  const [patients, setPatients] = useState<PatientHit[] | null>(null);
  const [staff, setStaff] = useState<StaffHit[] | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [patientError, setPatientError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());

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
      if (!needle) {
        setPatients(null);
        setStaff(null);
        return;
      }
      setLoading(true);
      setPatientError(null);
      setStaffError(null);

      // Patient facet — RLS/caseload-scoped server-side.
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

      // Staff facet — needs an org-bound session + member.manage; degrade clearly otherwise.
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

  // Run whenever the URL query changes (deep-link from the shell top-nav search).
  useEffect(() => {
    setTerm(urlQuery);
    void runSearch(urlQuery);
  }, [urlQuery, runSearch]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const next = term.trim();
    setParams(next ? { q: next } : {}, { replace: false });
  }

  const showPatients = facet === "all" || facet === "patient";
  const showStaff = facet === "all" || facet === "staff";
  const hasQuery = urlQuery.length > 0;
  const total =
    (showPatients ? (patients?.length ?? 0) : 0) + (showStaff ? (staff?.length ?? 0) : 0);

  return (
    // Centered results column on warm paper (frame `Cp053`): a narrow reading width, not full-bleed.
    <div style={{ height: "100%", overflow: "auto", background: t.background }}>
      <div style={{ maxWidth: "52rem", margin: "0 auto", padding: "1.75rem 1.5rem 3rem" }}>
        <form onSubmit={submit} style={searchForm}>
          <input
            aria-label="Search patients and staff"
            placeholder="Search patients (name / MRN) and staff…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            style={searchInput}
          />
          <button type="submit" style={primaryBtn}>
            Search
          </button>
        </form>

        <div role="tablist" aria-label="Result scope" style={facetRow}>
          {(["all", "patient", "staff"] as Facet[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={facet === f}
              onClick={() => setFacet(f)}
              style={facet === f ? facetOn : facetOff}
            >
              {f === "all" ? "All" : f === "patient" ? "Patients" : "Staff"}
            </button>
          ))}
        </div>

        {!hasQuery ? (
          <EmptyQuery recent={recent} onPick={(t) => setParams({ q: t })} />
        ) : loading ? (
          <LoadingSpinner />
        ) : total === 0 ? (
          <EmptyState
            title={`No results for “${urlQuery}”.`}
            description="Searching your caseload and organization. Try a different name or MRN."
          />
        ) : (
          <>
            <p style={summaryLine}>
              {total} result{total === 1 ? "" : "s"} for “{urlQuery}” · across patients, staff,
              documents, orders
            </p>
            {showPatients ? (
              <PatientGroup
                hits={patients}
                error={patientError}
                onOpen={(id) => navigate(`/patients/${id}`)}
              />
            ) : null}
            {showStaff ? (
              <StaffGroup
                hits={staff}
                error={staffError}
                onOpen={() => navigate("/admin/staff")}
              />
            ) : null}
            <FutureFacets />
          </>
        )}
      </div>
    </div>
  );
}

function EmptyQuery({
  recent,
  onPick,
}: { recent: string[]; onPick: (t: string) => void }): JSX.Element {
  return (
    <div style={{ paddingTop: "0.5rem" }}>
      <p style={{ color: t.onSurfaceVariant, marginTop: 0 }}>
        Search patients by name or MRN, and staff in your organization. Results are scoped to what
        you are permitted to see.
      </p>
      {recent.length > 0 ? (
        <section style={{ marginTop: "1rem" }}>
          <h2 style={groupHead}>Recent searches</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {recent.map((term) => (
              <button key={term} type="button" onClick={() => onPick(term)} style={chip}>
                {term}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// A §6.2 Lantern card grouping one search scope's rows (No-Line; rows divided by ghost hairlines).
function GroupCard({
  label,
  count,
  children,
}: { label: string; count?: number; children: ReactNode }): JSX.Element {
  return (
    <section style={{ marginBottom: "1.5rem" }}>
      <h2 style={groupHead}>
        {label}
        {count != null ? ` · ${count}` : ""}
      </h2>
      <div style={{ ...cardSurface, padding: "0 1rem" }}>{children}</div>
    </section>
  );
}

// One result row: tinted-initials avatar + name/meta column + optional status pill + a go chevron.
function ResultRow({
  first,
  initials,
  title,
  titleMono,
  meta,
  pill,
  onClick,
}: {
  first: boolean;
  initials: string;
  title: ReactNode;
  titleMono?: boolean;
  meta: ReactNode;
  pill?: ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...rowBtn, borderTop: first ? "none" : ghostBorder }}
    >
      <span style={avatar} aria-hidden>
        {initials}
      </span>
      <span style={rowText}>
        <span style={rowTitle} className={titleMono ? "wx-data-md" : undefined}>
          {title}
        </span>
        <span style={rowMeta}>{meta}</span>
      </span>
      {pill}
      <span style={{ color: t.muted, display: "inline-flex" }}>
        <Glyph name="arrow-right" size={18} />
      </span>
    </button>
  );
}

function PatientGroup({
  hits,
  error,
  onOpen,
}: {
  hits: PatientHit[] | null;
  error: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <GroupCard label="Patients" count={error ? undefined : (hits?.length ?? 0)}>
      {error ? (
        <p style={mutedRow}>{error}</p>
      ) : hits && hits.length > 0 ? (
        hits.map((p, i) => (
          <ResultRow
            key={p.id}
            first={i === 0}
            initials={initialsOf(p.firstName, p.lastName)}
            title={`${p.lastName}, ${p.firstName}`}
            meta={
              <>
                MRN <span className="wx-data-md">{p.mrn}</span> · DOB{" "}
                <span className="tabular-nums">{p.dob}</span>
              </>
            }
            pill={
              <StatusPill label={statusLabel(p.status)} tone={STATUS_TONE[p.status] ?? "neutral"} />
            }
            onClick={() => onOpen(p.id)}
          />
        ))
      ) : (
        <p style={mutedRow}>No patient matches.</p>
      )}
    </GroupCard>
  );
}

function StaffGroup({
  hits,
  error,
  onOpen,
}: {
  hits: StaffHit[] | null;
  error: string | null;
  onOpen: () => void;
}): JSX.Element {
  return (
    <GroupCard label="Staff" count={error ? undefined : (hits?.length ?? 0)}>
      {error ? (
        <p style={mutedRow}>{error}</p>
      ) : hits && hits.length > 0 ? (
        hits.map((m, i) => (
          <ResultRow
            key={m.membershipId}
            first={i === 0}
            initials={initialsOf(m.userId)}
            title={m.userId.slice(0, 8)}
            titleMono
            meta={m.isAdmin ? "Org admin" : "Member"}
            pill={
              <StatusPill
                label={statusLabel(m.status)}
                tone={m.status === "active" ? "success" : "neutral"}
              />
            }
            onClick={onOpen}
          />
        ))
      ) : (
        <p style={mutedRow}>
          No staff matches. Name &amp; email search arrives with the staff-roster enrichment (FB-T12).
        </p>
      )}
    </GroupCard>
  );
}

// The not-yet-searchable scopes, listed honestly (the frame shows Documents / Orders & Claims groups;
// ours name the owning module instead of inventing rows).
function FutureFacets(): JSX.Element {
  return (
    <GroupCard label="Other scopes">
      {FUTURE_FACETS.map((f, i) => (
        <div key={f.label} style={{ ...futureRow, borderTop: i === 0 ? "none" : ghostBorder }}>
          <span style={{ color: t.onSurfaceVariant }}>{f.label}</span>
          <span style={{ color: t.muted, fontSize: "0.8rem" }}>available when {f.blocked} ships</span>
        </div>
      ))}
    </GroupCard>
  );
}

const searchForm = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.5rem 0.75rem",
  background: t.surfaceLow,
  borderRadius: t.radiusLg,
  marginBottom: "0.75rem",
} as const;
const searchInput = {
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "transparent",
  outline: "none",
  fontSize: "0.95rem",
  color: t.onSurface,
} as const;
const primaryBtn = {
  padding: "0.5rem 1rem",
  border: "none",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  cursor: "pointer",
  fontWeight: 600,
} as const;
const facetRow = { display: "flex", gap: "0.25rem", marginBottom: "1.25rem" } as const;
const facetOn = {
  padding: "0.3rem 0.8rem",
  border: "none",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600,
} as const;
const facetOff = {
  padding: "0.3rem 0.8rem",
  border: "none",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
const summaryLine = {
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
  margin: "0 0 1rem",
} as const;
const groupHead = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: t.muted,
  margin: "0 0 0.5rem 0.25rem",
} as const;
const rowBtn = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  width: "100%",
  textAlign: "left" as const,
  padding: "0.75rem 0.25rem",
  border: "none",
  background: "transparent",
  cursor: "pointer",
} as const;
const avatar = {
  width: "2rem",
  height: "2rem",
  flexShrink: 0,
  borderRadius: "9999px",
  background: t.primaryTint,
  color: t.primary,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "0.8rem",
} as const;
const rowText = { display: "flex", flexDirection: "column" as const, gap: "0.1rem", flex: 1, minWidth: 0 } as const;
const rowTitle = { fontWeight: 600, color: t.onSurface } as const;
const rowMeta = { color: t.onSurfaceVariant, fontSize: "0.8rem" } as const;
const futureRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.6rem 0.25rem",
} as const;
const mutedRow = { color: t.muted, margin: 0, padding: "0.75rem 0.25rem", fontSize: "0.85rem" } as const;
const chip = {
  padding: "0.3rem 0.7rem",
  border: ghostBorder,
  borderRadius: "9999px",
  background: t.surfaceLow,
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
