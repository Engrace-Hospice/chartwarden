import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/05-patient — Global Search Results (cross-cutting; M5 owns it, M5→M2 edge).
// Spec: docs/design/screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md — "Use Work Queue."
// FB-T11 (partial): the live facets are the M5 **patient** facet (GET /api/v1/patients?q=) and the
// M2 **staff** facet (GET /api/v1/orgs/:id/members?q=). Later facets (documents/orders/visits/commands)
// render as labeled "available when <module> ships" rows — visible, never fabricated. The server stays
// the only enforcement point: patient hits are RLS/caseload-scoped, the staff facet is behind
// member.manage (a 403 degrades to a clear note). The patient list carries no SSN/MBI, so the spec's
// "SSN never shown / MBI masked" holds by construction. Imports leaves (@wardenx/ui) + the M2 auth
// client for the active org (M5 dependsOn M2 — a declared edge; this is an HTTP-only read, no schema).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
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
type Selection = { kind: "patient"; hit: PatientHit } | { kind: "staff"; hit: StaffHit } | null;

// Facets the merged data layer can't serve yet — shown so the scope is honest, not fabricated.
const FUTURE_FACETS = [
  { label: "Documents", blocked: "M22 Documents" },
  { label: "Orders", blocked: "M16 Orders" },
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
  const [selected, setSelected] = useState<Selection>(null);

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
        setSelected(null);
        return;
      }
      setLoading(true);
      setPatientError(null);
      setStaffError(null);
      setSelected(null);

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
    <WorkQueueLayout
      header={<PageHeader title={hasQuery ? `Results for “${urlQuery}”` : "Search"} />}
      filters={
        <div style={controls}>
          <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem", flex: 1 }}>
            <input
              aria-label="Search patients and staff"
              placeholder="Search patients (name / MRN) and staff…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              style={field}
            />
            <button type="submit" style={primaryBtn}>
              Search
            </button>
          </form>
          <div role="tablist" aria-label="Result type" style={{ display: "flex", gap: "0.25rem" }}>
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
        </div>
      }
      table={
        !hasQuery ? (
          <EmptyQuery recent={recent} onPick={(t) => setParams({ q: t })} />
        ) : loading ? (
          <LoadingSpinner />
        ) : total === 0 ? (
          <EmptyState
            title={`No results for “${urlQuery}”.`}
            description="Searching your caseload and organization. Try a different name or MRN."
          />
        ) : (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            {showPatients ? (
              <PatientGroup
                hits={patients}
                error={patientError}
                onSelect={(hit) => setSelected({ kind: "patient", hit })}
              />
            ) : null}
            {showStaff ? (
              <StaffGroup
                hits={staff}
                error={staffError}
                onSelect={(hit) => setSelected({ kind: "staff", hit })}
              />
            ) : null}
            <FutureFacets />
          </div>
        )
      }
      detail={
        selected ? (
          <PreviewPane selection={selected} onOpen={navigate} onClose={() => setSelected(null)} />
        ) : undefined
      }
    />
  );
}

function EmptyQuery({
  recent,
  onPick,
}: { recent: string[]; onPick: (t: string) => void }): JSX.Element {
  return (
    <div style={{ padding: "1.5rem" }}>
      <p style={{ color: "var(--color-on-surface-variant)", marginTop: 0 }}>
        Search patients by name or MRN, and staff in your organization. Results are scoped to what
        you are permitted to see.
      </p>
      {recent.length > 0 ? (
        <section style={{ marginTop: "1rem" }}>
          <h2 style={groupHead}>Recent searches</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {recent.map((t) => (
              <button key={t} type="button" onClick={() => onPick(t)} style={chip}>
                {t}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PatientGroup({
  hits,
  error,
  onSelect,
}: {
  hits: PatientHit[] | null;
  error: string | null;
  onSelect: (hit: PatientHit) => void;
}): JSX.Element {
  return (
    <section style={{ marginBottom: "1.25rem" }}>
      <h2 style={groupHead}>Patients {hits ? `(${hits.length})` : ""}</h2>
      {error ? (
        <p style={mutedNote}>{error}</p>
      ) : hits && hits.length > 0 ? (
        <ul style={list}>
          {hits.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onSelect(p)} style={rowBtn}>
                <span style={rowTop}>
                  <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                    {p.lastName}, {p.firstName}
                  </span>
                  <StatusPill
                    label={statusLabel(p.status)}
                    tone={STATUS_TONE[p.status] ?? "neutral"}
                  />
                </span>
                <span style={meta}>
                  MRN <span className="wx-data-md">{p.mrn}</span> · DOB{" "}
                  <span className="tabular-nums">{p.dob}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p style={mutedNote}>No patient matches.</p>
      )}
    </section>
  );
}

function StaffGroup({
  hits,
  error,
  onSelect,
}: {
  hits: StaffHit[] | null;
  error: string | null;
  onSelect: (hit: StaffHit) => void;
}): JSX.Element {
  return (
    <section style={{ marginBottom: "1.25rem" }}>
      <h2 style={groupHead}>Staff {hits ? `(${hits.length})` : ""}</h2>
      {error ? (
        <p style={mutedNote}>{error}</p>
      ) : hits && hits.length > 0 ? (
        <ul style={list}>
          {hits.map((m) => (
            <li key={m.membershipId}>
              <button type="button" onClick={() => onSelect(m)} style={rowBtn}>
                <span style={rowTop}>
                  <span className="wx-data-md" style={{ fontWeight: 600 }}>
                    {m.userId.slice(0, 8)}
                  </span>
                  <StatusPill
                    label={statusLabel(m.status)}
                    tone={m.status === "active" ? "success" : "neutral"}
                  />
                </span>
                <span style={meta}>{m.isAdmin ? "Org admin" : "Member"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p style={mutedNote}>
          No staff matches. Name &amp; email search arrives with the staff-roster enrichment
          (FB-T12).
        </p>
      )}
    </section>
  );
}

function FutureFacets(): JSX.Element {
  return (
    <section
      style={{
        borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
        paddingTop: "0.75rem",
      }}
    >
      {FUTURE_FACETS.map((f) => (
        <div
          key={f.label}
          style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
        >
          <span style={{ color: "var(--color-muted)" }}>{f.label}</span>
          <span style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>
            available when {f.blocked} ships
          </span>
        </div>
      ))}
    </section>
  );
}

function PreviewPane({
  selection,
  onOpen,
  onClose,
}: {
  selection: NonNullable<Selection>;
  onOpen: (to: string) => void;
  onClose: () => void;
}): JSX.Element {
  if (selection.kind === "patient") {
    const p = selection.hit;
    return (
      <RightDetailPanel title={`${p.lastName}, ${p.firstName}`} onClose={onClose}>
        <div style={fieldStack}>
          <StatusPill label={statusLabel(p.status)} tone={STATUS_TONE[p.status] ?? "neutral"} />
          <Field label="MRN">
            <span className="wx-data-md">{p.mrn}</span>
          </Field>
          <Field label="DOB">
            <span className="tabular-nums">{p.dob}</span>
          </Field>
          <button type="button" onClick={() => onOpen(`/patients/${p.id}`)} style={primaryBtn}>
            Open chart
          </button>
        </div>
      </RightDetailPanel>
    );
  }
  const m = selection.hit;
  return (
    <RightDetailPanel title={m.isAdmin ? "Org admin" : "Member"} onClose={onClose}>
      <div style={fieldStack}>
        <StatusPill
          label={statusLabel(m.status)}
          tone={m.status === "active" ? "success" : "neutral"}
        />
        <Field label="User">
          <span className="wx-data-md" style={{ wordBreak: "break-all" }}>
            {m.userId}
          </span>
        </Field>
        <button type="button" onClick={() => onOpen("/admin/staff")} style={primaryBtn}>
          Open staff management
        </button>
      </div>
    </RightDetailPanel>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={fieldLabel}>{label}</span>
      <span style={{ color: "var(--color-on-surface)" }}>{children}</span>
    </div>
  );
}

// No-Line Lantern tokens (DESIGN.md §10): ghost borders at ~15% + tonal surfaces, zero hardcoded hex.
const ghost = "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)";
const controls = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
  padding: "0 1.5rem 0.75rem",
  flexWrap: "wrap" as const,
} as const;
// Input borders/padding/radius come from the global element styles (index.css); only layout here.
const field = { flex: 1, minWidth: "16rem" } as const;
const primaryBtn = {
  padding: "0.5rem 1rem",
  border: "none",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
const facetOn = {
  padding: "0.35rem 0.75rem",
  border: "1px solid var(--color-primary)",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
const facetOff = {
  padding: "0.35rem 0.75rem",
  border: ghost,
  borderRadius: "9999px",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
const groupHead = {
  fontSize: "0.8rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.03em",
  color: "var(--color-on-surface-variant)",
  margin: "0 0 0.5rem",
} as const;
const list = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
} as const;
const rowBtn = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "stretch",
  width: "100%",
  textAlign: "left" as const,
  gap: "0.2rem",
  padding: "0.5rem 0.6rem",
  border: ghost,
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  cursor: "pointer",
} as const;
const rowTop = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
} as const;
const meta = { color: "var(--color-on-surface-variant)", fontSize: "0.8rem" } as const;
const mutedNote = {
  color: "var(--color-muted)",
  margin: "0.25rem 0",
  fontSize: "0.85rem",
} as const;
const chip = {
  padding: "0.3rem 0.7rem",
  border: ghost,
  borderRadius: "9999px",
  background: "var(--color-surface-low)",
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
const fieldStack = { display: "flex", flexDirection: "column" as const, gap: "0.85rem" } as const;
const fieldLabel = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
} as const;
