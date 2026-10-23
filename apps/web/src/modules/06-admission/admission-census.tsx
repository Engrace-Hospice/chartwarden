// apps/web/src/modules/06-admission — Admissions (M6 §5.2.12 entry, Track B / ADR-0030; 2026-09-25
// redesign, mockup "Admissions"). Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ADMISSIONS_REFERRAL_INTAKE.md.
// KPI cards, a labeled filter bar, the admissions table (patient · MRN · admission date · status ·
// source · hospice physician) and a right drawer for the selected admission: its intake workflow and
// task checklist from the M6 readiness read, and its key facts. The list route carries only
// id/state/patient identity, so each loaded row's admission date, referral link and physician come from the
// admission detail read; DOB for age still comes from the patient read. Admission type, assigned nurse and payer
// eligibility are not on these reads, so they are not drawn. The server enforces every scope
// (ADR-0030 — no authz on the frontend).
import { formatMrn } from "@chartwarden/types";
import {
  EmptyState,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  OffsetPagination,
  StatusPill,
  interactiveRowProps,
  t,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ADMISSION_TONE, stateLabel as enumLabel } from "./admission-status";
import { AdmissionsTabs, Avatar, Filter, Stat } from "./admissions-chrome";

// Short labels for the pills; the long lifecycle names crowd the table.
const SHORT_STATE: Record<string, string> = { notice_of_rights_acknowledged: "NOR Acknowledged" };
const stateLabel = (s: string): string => SHORT_STATE[s] ?? enumLabel(s);

interface AdmissionRow {
  id: string;
  state: string;
  version: number;
  patientId?: string | null;
  patient: { id: string; firstName: string; lastName: string; mrn: string } | null;
}

interface AdmissionDetail {
  id: string;
  referralId?: string | null;
  admissionAt?: string | null;
  activatedAt?: string | null;
  serviceAddressSnapshot?: { city: string; state: string | null } | null;
  hospicePhysician?: { displayName: string } | null;
}

interface PatientSummary {
  id: string;
  mrn?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dob?: string | null;
}

interface Requirement {
  code: string;
  label: string;
  status: string;
  blocking: boolean;
  message?: string;
}
interface Readiness {
  status: "blocked" | "action_required" | "ready";
  canActivate: boolean;
  completed: number;
  blockingRemaining: number;
  requirements: Requirement[];
}

const ADMISSION_PAGE_SIZES = [10, 25, 50] as const;
const PENDING = ["referred", "pending", "notice_of_rights_acknowledged"];
const ENDED = ["discharged", "bereavement", "closed"];
const DONE = ["complete", "not_applicable"];
const DAY = 86_400_000;

// The intake stepper groups the readiness requirements into the mockup's four stages.
const STEPS: { label: string; codes: string[] }[] = [
  { label: "Referral", codes: ["patient_identity", "admission_details"] },
  { label: "Consents", codes: ["patient_privacy", "notice_of_rights"] },
  { label: "Election", codes: ["election_statement"] },
  { label: "Certification", codes: ["cti", "f2f"] },
];

function patientDisplayName(patient: PatientSummary | null, patientId?: string | null): string {
  const name = [patient?.firstName, patient?.lastName].filter(Boolean).join(" ").trim();
  return name || patient?.mrn || patientId || "Unresolved";
}

function ageOf(dob?: string | null): number | null {
  const m = dob ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob) : null;
  if (!m) return null;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  const month = now.getMonth() + 1;
  if (month < Number(m[2]) || (month === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
  return age;
}

const maskMrn = (mrn?: string | null): string => (mrn ? `…${mrn.slice(-4)}` : "—");

function usDate(value?: string | null): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  if (value.length === 10) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(value);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

const sourceOf = (d?: AdmissionDetail): string =>
  d ? (d.referralId ? "Referral" : "Direct intake") : "…";

export function AdmissionCensus(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<AdmissionRow[]>([]);
  const [patientsById, setPatientsById] = useState<Record<string, PatientSummary>>({});
  const [details, setDetails] = useState<Record<string, AdmissionDetail>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const [state, setState] = useState("");
  const [source, setSource] = useState("");
  const [range, setRange] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Try again".
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const query: { state?: string; cursor?: string; limit?: number } = { limit: 50 };
      if (state) query.state = state;
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/admissions", { params: { query } });
      if (!active) return;
      if (err) {
        setError("Could not load the admission census.");
        setLoading(false);
        return;
      }
      const rows = (data?.items ?? []) as AdmissionRow[];
      setItems((prev) => (cursor ? [...prev, ...rows] : rows));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);

      const patientIds = [
        ...new Set(rows.map((r) => r.patientId).filter((id): id is string => !!id)),
      ];
      void Promise.all(
        patientIds.map((id) =>
          client
            .GET("/api/v1/patients/{id}", { params: { path: { id } } })
            .then((r) => [id, r.data as PatientSummary | undefined] as const)
            .catch(() => [id, undefined] as const),
        ),
      ).then((pairs) => {
        if (!active) return;
        setPatientsById((prev) => {
          const next = { ...prev };
          for (const [id, p] of pairs) if (p) next[id] = p;
          return next;
        });
      });
      void Promise.all(
        rows.map((r) =>
          client
            .GET("/api/v1/admissions/{id}", { params: { path: { id: r.id } } })
            .then((res) => [r.id, res.data as AdmissionDetail | undefined] as const)
            .catch(() => [r.id, undefined] as const),
        ),
      ).then((pairs) => {
        if (!active) return;
        setDetails((prev) => {
          const next = { ...prev };
          for (const [id, d] of pairs) if (d) next[id] = d;
          return next;
        });
      });
    })();
    return () => {
      active = false;
    };
  }, [client, state, cursor, retryKey]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const cutoff = range === "all" ? 0 : Date.now() - Number(range) * DAY;
    return items.filter((a) => {
      const patient = a.patient;
      const d = details[a.id];
      if (source && sourceOf(d) !== source) return false;
      if (cutoff) {
        const at = d?.admissionAt ? Date.parse(d.admissionAt) : Number.NaN;
        if (Number.isNaN(at) || at < cutoff) return false;
      }
      return (
        !q ||
        a.id.toLowerCase().includes(q) ||
        a.state.toLowerCase().includes(q) ||
        patientDisplayName(patient, a.patientId).toLowerCase().includes(q) ||
        (patient?.mrn ?? "").toLowerCase().includes(q) ||
        (d?.hospicePhysician?.displayName ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, details, searchQuery, source, range]);

  const kpis = useMemo(() => {
    const now = new Date();
    const thisMonth = items.filter((a) => {
      const at = details[a.id]?.admissionAt;
      if (!at) return false;
      const d = new Date(at);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    return {
      total: items.length,
      pending: items.filter((a) => PENDING.includes(a.state)).length,
      thisMonth,
      active: items.filter((a) => a.state === "active").length,
      onHold: items.filter((a) => a.state === "on_hold").length,
      ended: items.filter((a) => ENDED.includes(a.state)).length,
    };
  }, [items, details]);

  const hasActiveFilters = searchQuery !== "" || state !== "" || source !== "" || range !== "all";
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);
  const selected =
    filtered.find((a) => a.id === selectedId) ?? (selectedId ? null : (pagedItems[0] ?? null));

  function clearFilters(): void {
    setSearchQuery("");
    setState("");
    setSource("");
    setRange("all");
    setCursor(undefined);
    setPage(1);
  }

  return (
    <div className={`wx-admissions${drawerOpen && selected ? " has-drawer" : ""}`}>
      <div className="wx-admissions-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Admissions</h1>
            <p>Manage hospice admissions, pending referrals, and the intake workflow.</p>
          </div>
          <Link to="/admissions/new" className="wx-btn-primary">
            <Glyph name="plus" size={16} /> New Admission
          </Link>
        </header>

        <AdmissionsTabs current="/admissions" />

        <div className="wx-stat-grid" aria-label="Admissions summary">
          <Stat
            icon="file-text"
            value={kpis.total}
            label="Total Admissions"
            hint="Loaded records"
          />
          <Stat
            icon="clock"
            value={kpis.pending}
            label="Pending Intake"
            hint="In progress"
            color="var(--color-viz-violet)"
          />
          <Stat
            icon="calendar"
            value={kpis.thisMonth}
            label="This Month"
            hint="By admission date"
          />
          <Stat
            icon="check-circle"
            value={kpis.active}
            label="Active"
            hint={`${kpis.onHold} on hold · ${kpis.ended} closed`}
            color={t.success}
          />
        </div>

        <div className="wx-filter-panel">
          <label className="wx-search-field">
            <Glyph name="search" size={16} />
            <input
              type="search"
              placeholder="Search by name, MRN, physician…"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setPage(1);
              }}
              aria-label="Search admissions"
            />
          </label>
          <Filter
            label="Status"
            value={state}
            onChange={(v) => {
              setState(v);
              setCursor(undefined);
              setPage(1);
            }}
            ariaLabel="Admission state"
          >
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="notice_of_rights_acknowledged">Notice acknowledged</option>
            <option value="active">Active</option>
            <option value="on_hold">On hold</option>
            <option value="discharged">Discharged</option>
            <option value="bereavement">Bereavement</option>
            <option value="closed">Closed</option>
          </Filter>
          <Filter
            label="Source"
            value={source}
            onChange={(v) => {
              setSource(v);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="Referral">Referral</option>
            <option value="Direct intake">Direct intake</option>
          </Filter>
          <Filter
            label="Admission date"
            value={range}
            onChange={(v) => {
              setRange(v);
              setPage(1);
            }}
          >
            <option value="all">Any time</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </Filter>
          {hasActiveFilters ? (
            <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
              <Glyph name="filter" size={15} /> Clear
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Admissions unavailable" description={error} />
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => setRetryKey((k) => k + 1)}
            >
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : filtered.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title={hasActiveFilters ? "No matching admissions found" : "No admissions"}
              description={
                hasActiveFilters
                  ? "Try adjusting the search or filters."
                  : "Admissions appear here once intake begins."
              }
            />
            {hasActiveFilters ? (
              <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">Admissions</caption>
              <thead>
                <tr>
                  <th scope="col">Patient</th>
                  <th scope="col">MRN</th>
                  <th scope="col">Admission date</th>
                  <th scope="col">Status</th>
                  <th scope="col">Source</th>
                  <th scope="col">Hospice physician</th>
                  <th scope="col">
                    <span className="wx-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedItems.map((a) => {
                  const patient = a.patient;
                  const name = patientDisplayName(patient, a.patientId);
                  const age = ageOf(a.patientId ? patientsById[a.patientId]?.dob : null);
                  const d = details[a.id];
                  const isSelected = selected?.id === a.id;
                  return (
                    <tr
                      key={a.id}
                      className={
                        isSelected
                          ? "is-selected wx-data-row-interactive"
                          : "wx-data-row-interactive"
                      }
                      {...interactiveRowProps(
                        () => {
                          setSelectedId(a.id);
                          setDrawerOpen(true);
                        },
                        isSelected,
                        true,
                      )}
                    >
                      <td>
                        <span style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
                          <Avatar name={name} />
                          <span style={{ minWidth: 0 }}>
                            {a.patientId && patientsById[a.patientId] ? (
                              <Link
                                to={`/patients/${a.patientId}`}
                                className="wx-row-title"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {name}
                              </Link>
                            ) : (
                              <span className="wx-row-title">{name}</span>
                            )}
                            <span className="wx-row-sub">
                              {age != null ? `${age}y` : patient ? "Age unknown" : "…"}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td
                        className="wx-nums"
                        title={patient?.mrn ? formatMrn(patient.mrn) : undefined}
                      >
                        {maskMrn(patient?.mrn)}
                      </td>
                      <td className="wx-nums">{d ? usDate(d.admissionAt) : "…"}</td>
                      <td>
                        <StatusPill
                          label={stateLabel(a.state)}
                          tone={ADMISSION_TONE[a.state] ?? "neutral"}
                        />
                      </td>
                      <td>{sourceOf(d)}</td>
                      <td>{d ? (d.hospicePhysician?.displayName ?? "—") : "…"}</td>
                      <td>
                        <Link
                          to={`/admissions/${a.id}`}
                          className="wx-icon-link"
                          aria-label={`Open admission for ${name}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Glyph name="more-horizontal" size={18} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={ADMISSION_PAGE_SIZES}
              noun="admissions"
            />
            {nextCursor ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "0 1rem 1rem" }}>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setCursor(nextCursor)}
                  disabled={loading}
                >
                  Load more admissions
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {selected && drawerOpen ? (
        <AdmissionDrawer
          key={selected.id}
          admission={selected}
          patient={selected.patient}
          dob={selected.patientId ? patientsById[selected.patientId]?.dob : null}
          detail={details[selected.id]}
          onClose={() => setDrawerOpen(false)}
          onOpen={() => navigate(`/admissions/${selected.id}`)}
        />
      ) : null}
    </div>
  );
}

function AdmissionDrawer({
  admission: a,
  patient,
  dob,
  detail,
  onClose,
  onOpen,
}: {
  admission: AdmissionRow;
  patient: PatientSummary | null;
  dob?: string | null;
  detail?: AdmissionDetail;
  onClose: () => void;
  onOpen: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const client = useApiClient();
  const [readiness, setReadiness] = useState<Readiness | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/admissions/{id}/readiness", { params: { path: { id: a.id } } })
      .then((r) => {
        if (active) setReadiness(r.error ? null : ((r.data as Readiness | undefined) ?? null));
      })
      .catch(() => active && setReadiness(null));
    return () => {
      active = false;
    };
  }, [client, a.id]);

  const name = patientDisplayName(patient, a.patientId);
  const age = ageOf(dob);
  const reqs = readiness?.requirements ?? [];
  const stepDone = (codes: string[]) => {
    const own = reqs.filter((r) => codes.includes(r.code));
    // F-238 — a non-blocking item (an unreviewed intake detection) does not hold the stage open.
    return own.length > 0 && own.every((r) => DONE.includes(r.status) || !r.blocking);
  };
  const steps = STEPS.map((s) => ({ ...s, done: a.state === "active" || stepDone(s.codes) }));
  const current = steps.findIndex((s) => !s.done);
  const address = detail?.serviceAddressSnapshot;

  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={`Admission for ${name}`}>
      <header className="wx-drawer-head">
        <Avatar name={name} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <h2>{name}</h2>
            <StatusPill label={stateLabel(a.state)} tone={ADMISSION_TONE[a.state] ?? "neutral"} />
          </div>
          <div className="wx-row-sub" style={{ fontSize: "0.8125rem" }}>
            {[age != null ? `${age}y` : null, patient?.mrn ? `MRN: ${maskMrn(patient.mrn)}` : null]
              .filter(Boolean)
              .join(" • ") || "—"}
          </div>
        </div>
        <button type="button" className="wx-icon-link" aria-label="Close details" onClick={onClose}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <nav className="wx-detail-tabs" aria-label="Admission views">
        <span aria-current="page">Overview</span>
        <Link to={`/admissions/${a.id}`}>Intake</Link>
        {a.patientId ? (
          <>
            <Link to={`/patients/${a.patientId}/election-certification`}>Election</Link>
            <Link to={`/patients/${a.patientId}/documents`}>Documents</Link>
          </>
        ) : null}
      </nav>

      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <h3>Admission Workflow</h3>
          {readiness === undefined ? (
            <LoadingSpinner />
          ) : (
            <ol className="wx-stepper">
              {steps.map((s, i) => (
                <li
                  key={s.label}
                  className={s.done ? "is-done" : i === current ? "is-current" : undefined}
                >
                  <span className="wx-step-dot" aria-hidden>
                    {s.done ? <Glyph name="check" size={12} strokeWidth={3} /> : i + 1}
                  </span>
                  <span>{s.label}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Key Information</h3>
            <Link
              to={`/admissions/${a.id}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.25rem",
                fontWeight: 500,
                fontSize: "0.8125rem",
                whiteSpace: "nowrap",
              }}
            >
              <Glyph name="pencil" size={13} /> Edit
            </Link>
          </div>
          <dl className="wx-kv">
            <dt>Admission date</dt>
            <dd className="wx-nums">{detail ? usDate(detail.admissionAt) : "…"}</dd>
            <dt>Activated</dt>
            <dd className="wx-nums">{detail ? usDate(detail.activatedAt) : "…"}</dd>
            <dt>Source</dt>
            <dd>
              {detail?.referralId ? (
                <Link to={`/referrals/${detail.referralId}`}>Referral</Link>
              ) : (
                sourceOf(detail)
              )}
            </dd>
            <dt>Hospice physician</dt>
            <dd>{detail ? (detail.hospicePhysician?.displayName ?? "Not assigned") : "…"}</dd>
            <dt>Service location</dt>
            <dd>
              {address ? [address.city, address.state].filter(Boolean).join(", ") : "Not recorded"}
            </dd>
          </dl>
        </section>

        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>
              Readiness{" "}
              {readiness ? (
                <StatusPill
                  label={
                    readiness.status === "ready"
                      ? "Ready"
                      : readiness.status === "blocked"
                        ? "Blocked"
                        : "Action required"
                  }
                  tone={
                    readiness.status === "ready"
                      ? "success"
                      : readiness.status === "blocked"
                        ? "error"
                        : "warning"
                  }
                />
              ) : null}
            </h3>
            <button
              type="button"
              className="wx-link-button"
              onClick={onOpen}
              style={{ fontSize: "0.8125rem" }}
            >
              View all
            </button>
          </div>
          {readiness === undefined ? (
            <LoadingSpinner />
          ) : readiness === null ? (
            <p className="wx-row-sub">The intake checklist could not be loaded.</p>
          ) : (
            <ul className="wx-checklist">
              {reqs
                .filter((r) => r.status !== "not_applicable")
                .map((r) => {
                  const done = DONE.includes(r.status);
                  return (
                    <li key={r.code} className={done ? "is-done" : undefined}>
                      <span className="wx-check-box" aria-hidden>
                        {done ? <Glyph name="check" size={12} strokeWidth={3} /> : null}
                      </span>
                      <span style={{ flex: 1 }}>
                        {r.label}
                        {!done && r.message ? (
                          <span className="wx-row-sub">{r.message}</span>
                        ) : null}
                      </span>
                      {!done ? (
                        <span className="wx-row-sub" style={{ whiteSpace: "nowrap" }}>
                          {r.blocking ? stateLabel(r.status) : "Review advised"}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
