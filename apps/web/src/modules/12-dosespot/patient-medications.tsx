import {
  CountBadge,
  EmptyState,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  interactiveRowProps,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — the patient chart's Medications tab (2026-09-25 redesign, mockup
// "Medications"): KPI cards, status chips with counts, the medication list with a colored class bar,
// and an inline detail card for the selected order; the right rail carries Patient Summary, the
// controlled-substance ("High Risk") list, and the medication actions. Every value comes from the M12
// medication-order route — dose/route/frequency/PRN reason from the order's structured sig. F-238: the
// M5 allergy list (unverified entries shown, labelled) and the outside medication list to reconcile sit
// above the orders (chart-allergies-outside-meds.tsx); drug-allergy interaction checking is not modeled.
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  HOSPICE_COVERAGE_LABEL,
  type HospiceCoverage,
  HospiceCoverageBadge,
  isNotCovered,
} from "../../shell/hospice-coverage";
import {
  ChartBanner,
  PatientSummaryPanel,
  fmtDate,
  useChartIdentity,
} from "../../shell/patient-context";
import { AllergyBanner, OutsideMedicationList } from "./chart-allergies-outside-meds";
import {
  MED_ORDER_TONE,
  advisoryNote,
  controlledLabel,
  isHighRisk,
  stateLabel,
} from "./medication-status";
import { ATTENTION_STATUSES } from "./medication-workspace";
import { loadPatientAdmissions } from "./medications-api";
import { PrescribeModal } from "./prescribe-modal";

interface Sig {
  doseQuantity?: number | string;
  doseUnit?: string;
  route?: string;
  frequencyCode?: string;
  asNeeded?: boolean;
  asNeededReasonCode?: string;
}
interface MedRow {
  id: string;
  patientId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  doseForm: string;
  route: string;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  refillsAuthorized: number;
  refillsRemaining: number;
  cosignRequired: boolean;
  cosignStatus: string | null;
  prescriberDiscipline: string | null;
  createdAt: string;
  signedAt: string | null;
  discontinuedAt: string | null;
  discontinuationReason: string | null;
  /** COP27 — the hospice coverage determination (absent on an older server ⇒ treated as covered). */
  hospiceCoverage?: HospiceCoverage;
  coverageReason?: string | null;
  data: { sigStructured?: Sig; sigFreeText?: string; daysSupply?: number } | null;
}

type Chip = "all" | "active" | "discontinued" | "pending" | "prn" | "needs_attention";

const PENDING = [
  "draft",
  "pending_signature",
  "verbal_pending",
  "epcs_identity_pending",
  "signed",
  "queued_for_transmission",
  "transmitted",
  "ack_received",
];
const ENDED = ["discontinued", "completed", "expired_unsigned"];

const sigOf = (m: MedRow): Sig => m.data?.sigStructured ?? {};
const isPrn = (m: MedRow): boolean => sigOf(m).asNeeded === true;
const isActive = (m: MedRow): boolean => m.status === "active";

function matches(chip: Chip, m: MedRow): boolean {
  if (chip === "all") return true;
  if (chip === "active") return isActive(m);
  if (chip === "discontinued") return ENDED.includes(m.status);
  if (chip === "pending") return PENDING.includes(m.status);
  if (chip === "prn") return isPrn(m) && !ENDED.includes(m.status);
  return (ATTENTION_STATUSES as readonly string[]).includes(m.status);
}

/** URL `?status=` → chip; the older status values still land somewhere sensible. */
function chipFrom(value: string | null): Chip {
  if (value === "active" || value === "discontinued" || value === "prn") return value;
  if (value === "needs_attention") return "needs_attention";
  if (value && (PENDING.includes(value) || value === "pending")) return "pending";
  if (value === "completed") return "discontinued";
  return "all";
}

function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function usDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

function doseText(m: MedRow): string {
  const s = sigOf(m);
  if (s.doseQuantity != null && s.doseQuantity !== "") {
    return `${s.doseQuantity}${s.doseUnit ? ` ${s.doseUnit}` : ""}`;
  }
  return m.strength || "—";
}
function routeText(m: MedRow): string {
  return (sigOf(m).route || m.route || "—").toUpperCase();
}
function frequencyText(m: MedRow): string {
  const s = sigOf(m);
  const f = s.frequencyCode ?? "";
  return [f, s.asNeeded ? "PRN" : ""].filter(Boolean).join(" ") || "—";
}
function indicationText(m: MedRow): string {
  return humanize(sigOf(m).asNeededReasonCode);
}
const startOf = (m: MedRow): string => m.signedAt ?? m.createdAt;

// Each drug gets a stable accent bar; controlled substances always read red, ended orders purple-grey.
const BAR_TINTS = [
  "var(--color-viz-blue)",
  "var(--color-viz-teal)",
  "var(--color-viz-green)",
  "var(--color-viz-yellow)",
  "var(--color-viz-cyan)",
  "var(--color-viz-violet)",
];
function barColor(m: MedRow): string {
  if (m.isControlledSubstance) return t.error;
  if (ENDED.includes(m.status)) return "var(--color-viz-violet)";
  if (PENDING.includes(m.status)) return "var(--color-viz-yellow)";
  let h = 0;
  for (const c of m.drugName) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BAR_TINTS[h % BAR_TINTS.length]!;
}

export function PatientMedications(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const [items, setItems] = useState<MedRow[]>([]);
  const chip = chipFrom(searchParams.get("status"));
  const setChip = (next: Chip) => setSearchParams(next === "all" ? {} : { status: next });
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "start">("name");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [prescribing, setPrescribing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // #91 — the admission a new prescription is documented against. An OPEN one, newest first; a patient
  // with only discharged admissions is not currently under care and prescribing into one would be wrong.
  useEffect(() => {
    let active = true;
    setAdmissionId(null);
    if (!patientId) return;
    void loadPatientAdmissions(client, patientId)
      .then((rows) => {
        if (active) setAdmissionId(rows.find((a) => a.dischargedAt == null)?.id ?? null);
      })
      .catch(() => {
        if (active) setAdmissionId(null);
      });
    return () => {
      active = false;
    };
  }, [client, patientId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Try again".
  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    setError(null);
    if (!patientId) {
      setError("Patient ID is missing.");
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void (async () => {
      try {
        // One read of every order; the chips and KPI cards are counted from the same list.
        const { data, error: requestError } = await client.GET("/api/v1/medication-orders", {
          params: { query: { patientId } },
        });
        if (!active) return;
        if (requestError) throw new Error("Request failed");
        setItems((data?.orders ?? []) as MedRow[]);
      } catch {
        if (active) setError("Could not load medications for this patient.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, retryKey]);

  const counts = useMemo(() => {
    const c = (k: Chip) => items.filter((m) => matches(k, m)).length;
    return {
      all: items.length,
      active: c("active"),
      discontinued: c("discontinued"),
      pending: c("pending"),
      prn: c("prn"),
      needs_attention: c("needs_attention"),
    } satisfies Record<Chip, number>;
  }, [items]);

  const kpis = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const changed = (v: string | null) => (v ? new Date(v).getTime() >= weekAgo : false);
    return {
      active: counts.active,
      highRisk: items.filter((m) => isHighRisk(m) && !ENDED.includes(m.status)).length,
      prn: items.filter((m) => isPrn(m) && isActive(m)).length,
      recent: items.filter((m) => changed(m.createdAt) || changed(m.discontinuedAt)).length,
    };
  }, [items, counts.active]);

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return items
      .filter((m) => matches(chip, m))
      .filter(
        (m) =>
          !needle ||
          `${m.drugName} ${m.strength} ${m.doseForm} ${m.route} ${indicationText(m)}`
            .toLocaleLowerCase()
            .includes(needle),
      )
      .sort((a, b) =>
        sortBy === "name"
          ? a.drugName.localeCompare(b.drugName)
          : startOf(b).localeCompare(startOf(a)),
      );
  }, [items, chip, search, sortBy]);

  const selected = rows.find((m) => m.id === selectedId) ?? null;
  const chips: { key: Chip; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "discontinued", label: "Discontinued" },
    { key: "pending", label: "Pending" },
    { key: "prn", label: "PRN" },
    ...(counts.needs_attention > 0
      ? [{ key: "needs_attention" as Chip, label: "Needs attention" }]
      : []),
  ];

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            nameAsHeading
            identity={identity}
            actions={
              <>
                <Link
                  to={`/patients/${patientId}/medications/reconciliation`}
                  className="wx-btn-secondary"
                >
                  Reconcile
                </Link>
                {admissionId ? (
                  <button
                    type="button"
                    className="wx-btn-secondary"
                    onClick={() => setPrescribing(true)}
                  >
                    Prescribe
                  </button>
                ) : null}
                <button
                  type="button"
                  className="wx-btn-primary"
                  onClick={() => navigate(`/patients/${patientId}/medications/new`)}
                  disabled={!patientId}
                >
                  <Glyph name="plus" size={16} /> New Medication
                </button>
              </>
            }
          />
        ) : (
          <div className="wx-patient-banner" aria-busy="true" style={{ minHeight: "6.25rem" }} />
        )
      }
      rail={
        patientId ? (
          <MedicationsRail patientId={patientId} identity={identity} items={items} />
        ) : undefined
      }
    >
      {patientId && admissionId ? (
        <PrescribeModal
          open={prescribing}
          patientId={patientId}
          admissionId={admissionId}
          onClose={() => setPrescribing(false)}
          onCreated={(order) => navigate(`/medication-orders/${order.id}`)}
        />
      ) : null}
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="medications" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "1.125rem 1.5rem 1.5rem", minWidth: 0 }}>
          {patientId ? (
            <div style={{ display: "grid", gap: "0.875rem", marginBottom: "0.875rem" }}>
              {/* F-238 — allergies (unverified shown, labelled) + the outside med list to reconcile. */}
              <AllergyBanner patientId={patientId} />
              <OutsideMedicationList patientId={patientId} />
            </div>
          ) : null}
          <section className="wx-chart-section" aria-label="Medications" aria-busy={loading}>
            <div className="wx-stat-grid" aria-label="Medication summary">
              <StatCard icon="pill" label="Active Medications" value={kpis.active} />
              <StatCard
                icon="alert"
                tone="danger"
                label="High Risk Medications"
                value={kpis.highRisk}
              />
              <StatCard icon="clock" label="PRN Medications" value={kpis.prn} />
              <StatCard
                icon="rotate-ccw"
                label="Recent Changes"
                value={kpis.recent}
                hint="in last 7 days"
              />
            </div>

            <div className="wx-list-toolbar">
              <fieldset className="wx-seg">
                <legend className="wx-sr-only">Medication status</legend>
                {chips.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={chip === c.key}
                    className={chip === c.key ? "is-selected" : undefined}
                    onClick={() => setChip(c.key)}
                  >
                    {c.label}
                    <span className="wx-seg-count wx-nums">{counts[c.key]}</span>
                  </button>
                ))}
              </fieldset>
              <div className="wx-list-toolbar-end">
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    aria-label="Search medications"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search medications…"
                  />
                </label>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setSortBy((s) => (s === "name" ? "start" : "name"))}
                  aria-label={`Sort by ${sortBy === "name" ? "start date" : "name"}`}
                >
                  <Glyph name="filter" size={15} /> Sort:{" "}
                  {sortBy === "name" ? "Name" : "Start date"}
                </button>
              </div>
            </div>

            {loading ? (
              <LoadingSpinner />
            ) : error ? (
              <div className="wx-list-state">
                <EmptyState title="Medications unavailable" description={error} />
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setRetryKey((k) => k + 1)}
                >
                  Try again
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title={search ? "No matching medications" : "No medication orders"}
                  description={
                    search
                      ? "Try a different drug name, strength, route or indication."
                      : "There are no medication orders in this view."
                  }
                />
                {search ? (
                  <button type="button" className="wx-btn-secondary" onClick={() => setSearch("")}>
                    Clear search
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table">
                  <caption className="wx-sr-only">Medications for this patient</caption>
                  <thead>
                    <tr>
                      <th scope="col">Medication</th>
                      <th scope="col">Dose</th>
                      <th scope="col">Route</th>
                      <th scope="col">Frequency</th>
                      <th scope="col">Indication</th>
                      <th scope="col">Start date</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="wx-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr
                        key={m.id}
                        className={
                          m.id === selectedId
                            ? "is-selected wx-data-row-interactive"
                            : "wx-data-row-interactive"
                        }
                        {...interactiveRowProps(
                          () => setSelectedId(m.id === selectedId ? null : m.id),
                          m.id === selectedId,
                          true,
                        )}
                      >
                        <td>
                          <span
                            className="wx-row-bar"
                            style={{ background: barColor(m) }}
                            aria-hidden
                          />
                          <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <span style={{ minWidth: 0 }}>
                              <button
                                type="button"
                                className="wx-row-title"
                                aria-expanded={m.id === selectedId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedId(m.id === selectedId ? null : m.id);
                                }}
                              >
                                {m.drugName || "Unnamed medication"}
                              </button>
                              <span className="wx-row-sub">
                                {[m.strength, m.doseForm].filter(Boolean).join(" ") || "—"}
                              </span>
                            </span>
                            {m.isControlledSubstance ? (
                              <span
                                style={{ color: t.error }}
                                title={controlledLabel(m.deaSchedule)}
                              >
                                <Glyph
                                  name="alert"
                                  size={15}
                                  label={controlledLabel(m.deaSchedule)}
                                />
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="wx-nums">{doseText(m)}</td>
                        <td>{routeText(m)}</td>
                        <td>{frequencyText(m)}</td>
                        <td>{indicationText(m)}</td>
                        <td className="wx-nums">{usDate(startOf(m))}</td>
                        <td>
                          <span className="wx-coverage-cell">
                            <StatusPill
                              label={stateLabel(m.status)}
                              tone={MED_ORDER_TONE[m.status] ?? "neutral"}
                            />
                            <HospiceCoverageBadge coverage={m.hospiceCoverage} />
                          </span>
                        </td>
                        <td>
                          <Link
                            to={`/medication-orders/${m.id}`}
                            className="wx-icon-link"
                            aria-label={`Open ${m.drugName} order`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Glyph name="more-horizontal" size={18} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selected && patientId ? (
              <MedicationDetailCard
                order={selected}
                patientId={patientId}
                onClose={() => setSelectedId(null)}
              />
            ) : null}
          </section>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: GlyphName;
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "danger";
}): JSX.Element {
  const color = tone === "danger" ? t.error : t.primary;
  return (
    <div className="wx-stat-card">
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{ color, background: `color-mix(in srgb, ${color} 10%, ${t.surfaceLowest})` }}
      >
        <Glyph name={icon} size={24} strokeWidth={1.6} />
      </span>
      <div>
        <div className="wx-stat-label">{label}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
          <strong className="wx-stat-value wx-nums">{value}</strong>
          {hint ? <span className="wx-stat-label">{hint}</span> : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="wx-detail-field">
      <div>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function MedicationDetailCard({
  order: m,
  patientId,
  onClose,
}: {
  order: MedRow;
  patientId: string;
  onClose: () => void;
}): JSX.Element {
  const sig = sigOf(m);
  const ref = useRef<HTMLElement>(null);
  // Bring the card into view when a row is picked (it renders below the list).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run per selected order.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [m.id]);
  const warnings = [
    m.isControlledSubstance ? `Controlled substance — ${controlledLabel(m.deaSchedule)}` : null,
    m.isControlledSubstance && m.deaSchedule === "II" ? "No refills permitted (Schedule II)" : null,
    sig.asNeeded ? `PRN — ${indicationText(m).toLowerCase()}` : null,
    m.cosignRequired
      ? `Co-signature ${m.cosignStatus ? humanize(m.cosignStatus).toLowerCase() : "required"}`
      : null,
    (ATTENTION_STATUSES as readonly string[]).includes(m.status)
      ? `Needs attention: ${stateLabel(m.status)}`
      : null,
  ].filter((w): w is string => Boolean(w));
  return (
    <section ref={ref} className="wx-detail-card" aria-label={`${m.drugName} details`}>
      <header>
        {m.isControlledSubstance ? (
          <span style={{ color: t.error }}>
            <Glyph name="alert-circle" size={20} />
          </span>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{m.drugName}</h3>
          <div className="wx-row-sub">{[m.strength, m.doseForm].filter(Boolean).join(" ")}</div>
        </div>
        <StatusPill label={stateLabel(m.status)} tone={MED_ORDER_TONE[m.status] ?? "neutral"} />
        <HospiceCoverageBadge coverage={m.hospiceCoverage} />
        {m.status === "draft" ? (
          <Link to={`/medication-orders/${m.id}/edit`} className="wx-btn-secondary wx-btn-sm">
            <Glyph name="pencil" size={14} /> Edit
          </Link>
        ) : null}
        <button type="button" className="wx-icon-link" aria-label="Close details" onClick={onClose}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <nav className="wx-detail-tabs" aria-label="Medication detail views">
        <span aria-current="page">Details</span>
        <Link to={`/medication-orders/${m.id}`}>History</Link>
        <Link to={`/patients/${patientId}/emar`}>Administration (eMAR)</Link>
        <Link to={`/patients/${patientId}/orders`}>Related Orders</Link>
      </nav>
      <div className="wx-detail-body">
        <div className="wx-detail-grid">
          <Field label="Dose">{doseText(m)}</Field>
          <Field label="Route">{routeText(m)}</Field>
          <Field label="Frequency">{frequencyText(m)}</Field>
          <Field label="Indication">{indicationText(m)}</Field>
          <Field label="Start date">{usDate(startOf(m))}</Field>
          <Field label="End date">{usDate(m.discontinuedAt)}</Field>
          <Field label="Prescriber">{m.prescriberDiscipline?.toUpperCase() ?? "—"}</Field>
          <Field label="Order class">{humanize(m.medClass)}</Field>
          <Field label="PRN reason">{sig.asNeeded ? indicationText(m) : "—"}</Field>
          <Field label="Days supply">{m.data?.daysSupply ?? "—"}</Field>
          <Field label="Controlled substance">
            {m.isControlledSubstance ? (
              <span className="wx-danger-chip">Yes ({controlledLabel(m.deaSchedule)})</span>
            ) : (
              (advisoryNote(m) ?? "No")
            )}
          </Field>
          <Field label="Refills">
            {m.refillsRemaining} of {m.refillsAuthorized}
          </Field>
          <Field label="Hospice coverage">
            {HOSPICE_COVERAGE_LABEL[m.hospiceCoverage ?? "covered_related"]}
          </Field>
        </div>
        <div style={{ display: "grid", gap: "0.75rem", alignContent: "start" }}>
          {m.data?.sigFreeText ? (
            <div className="wx-note-box">
              <strong>Directions</strong>
              <p>{m.data.sigFreeText}</p>
            </div>
          ) : null}
          {m.hospiceCoverage && isNotCovered(m.hospiceCoverage) && m.coverageReason ? (
            <div className="wx-note-box">
              <strong>Not covered by hospice</strong>
              <p>{m.coverageReason}</p>
            </div>
          ) : null}
          {m.discontinuationReason ? (
            <div className="wx-note-box">
              <strong>Discontinued</strong>
              <p>
                {m.discontinuationReason} · {fmtDate(m.discontinuedAt)}
              </p>
            </div>
          ) : null}
          {warnings.length > 0 ? (
            <div className="wx-note-box wx-note-box-danger">
              <strong>
                <Glyph name="alert-circle" size={16} /> Safety / Warnings
              </strong>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function MedicationsRail({
  patientId,
  identity,
  items,
}: {
  patientId: string;
  identity: ReturnType<typeof useChartIdentity>;
  items: MedRow[];
}): JSX.Element {
  const highRisk = items.filter((m) => isHighRisk(m) && !ENDED.includes(m.status));
  const actions: { label: string; icon: GlyphName; to: string }[] = [
    {
      label: "Reconcile Medications",
      icon: "rotate-ccw",
      to: `/patients/${patientId}/medications/reconciliation`,
    },
    { label: "Add Medication", icon: "plus", to: `/patients/${patientId}/medications/new` },
    { label: "View eMAR", icon: "clipboard-check", to: `/patients/${patientId}/emar` },
    { label: "Missed Doses", icon: "clock", to: `/patients/${patientId}/missed-doses` },
    { label: "Signature Inbox", icon: "pencil", to: "/prescribing/sign-inbox" },
  ];
  const related: { label: string; icon: GlyphName; to: string }[] = [
    { label: "Active Orders", icon: "file-check", to: `/patients/${patientId}/orders` },
    { label: "Clinical Summary", icon: "activity", to: `/patients/${patientId}?view=clinical` },
    { label: "Care Plan", icon: "clipboard-list", to: `/patients/${patientId}/care-plan` },
    { label: "Recent Visits", icon: "stethoscope", to: `/patients/${patientId}/encounters` },
  ];
  return (
    <>
      <PatientSummaryPanel identity={identity} />
      <Panel
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
            High Risk {highRisk.length > 0 ? <CountBadge count={highRisk.length} /> : null}
          </span>
        }
        icon="alert"
        tone={highRisk.length > 0 ? "danger" : "default"}
      >
        {highRisk.length === 0 ? (
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
            No active controlled substances.
          </p>
        ) : (
          <ul className="wx-contact-list">
            {highRisk.map((m) => (
              <li key={m.id}>
                <span className="wx-ring-dot" aria-hidden />
                <div>
                  <Link
                    to={`/medication-orders/${m.id}`}
                    style={{ fontWeight: 600, color: t.onSurface }}
                  >
                    {m.drugName}
                  </Link>
                  <div style={{ color: t.onSurfaceVariant }}>{controlledLabel(m.deaSchedule)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <RailLinks title="Medication Actions" icon="heart" links={actions} />
      <RailLinks title="Related Information" icon="shield-check" links={related} />
    </>
  );
}

function RailLinks({
  title,
  icon,
  links,
}: {
  title: string;
  icon: GlyphName;
  links: { label: string; icon: GlyphName; to: string }[];
}): JSX.Element {
  return (
    <Panel title={title} icon={icon} flush>
      <ul className="wx-rail-links">
        {links.map((l) => (
          <li key={l.label}>
            <Link to={l.to}>
              <span style={{ color: t.primary }}>
                <Glyph name={l.icon} size={17} strokeWidth={1.75} />
              </span>
              <span style={{ flex: 1 }}>{l.label}</span>
              <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
