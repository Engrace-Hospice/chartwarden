import {
  ageYears,
  cardSurface,
  EmptyState,
  ghostBorder,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — patient eMAR (M13 §4.1/§6.1 #1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Patient Workspace + MAR Grid".
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `ANbhv`): a Patient Workspace (banner + module
// rail) over the Medication Administration Record GRID (one row per medication order, one column per dose
// time, each cell the dose's §2.2 status) | a right "Administer" rail (five-rights scaffold) | a recent-
// administrations strip. The SERVER owns the §2.2 lifecycle, §2.5 late-entry tier, and §7.2 SUD read gate
// (SUD rows skipped without a Part 2 release — never a frontend hide). Reads GET /api/v1/scheduled-doses?
// patient + /api/v1/administrations?patient (+ the patient summary for the banner). Honest gaps: the dose
// rows carry the medication ORDER id, not the drug/dose text the frame shows (no fabricated drug name); the
// single-dose / PRN / witness administration WRITE paths aren't built, so the Administer panel's Record
// action is an inert scaffold naming the write path.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ADMIN_STATUS_TONE, DOSE_TONE, lateEntryTone, stateLabel } from "./emar-status";

interface ScheduledDoseRow {
  id: string;
  patientId: string;
  medicationOrderId: string;
  dueAt: string;
  status: string;
}
interface AdministrationRow {
  id: string;
  patientId: string;
  medicationOrderId: string;
  mode: string;
  status: string;
  actorKind: string;
  administeredAt: string;
  lateEntryTier: string;
  isControlledSubstance: boolean;
  requiresRnReview: boolean;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");
const slotOf = (iso: string): string => iso.slice(11, 16); // HH:MM
const FIVE_RIGHTS = ["Right patient", "Right drug", "Right dose", "Right route", "Right time"] as const;

export function PatientEmar(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [doses, setDoses] = useState<ScheduledDoseRow[]>([]);
  const [admins, setAdmins] = useState<AdministrationRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [selectedDoseId, setSelectedDoseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [d, a, p] = await Promise.all([
      client.GET("/api/v1/scheduled-doses", { params: { query: { patient: patientId } } }),
      client.GET("/api/v1/administrations", { params: { query: { patient: patientId } } }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (p.data) setPatient(p.data as PatientSummary);
    if (d.error || a.error) {
      setError("Could not load the eMAR for this patient.");
      setLoading(false);
      return;
    }
    setDoses((d.data ?? []) as ScheduledDoseRow[]);
    setAdmins((a.data ?? []) as AdministrationRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The MAR grid: rows = distinct medication orders, columns = distinct dose times, cells = the dose.
  const grid = useMemo(() => {
    const meds = [...new Set(doses.map((d) => d.medicationOrderId))].sort();
    const slots = [...new Set(doses.map((d) => slotOf(d.dueAt)))].sort();
    const at = (med: string, slot: string) =>
      doses.find((d) => d.medicationOrderId === med && slotOf(d.dueAt) === slot) ?? null;
    return { meds, slots, at };
  }, [doses]);

  const recent = useMemo(
    () => [...admins].sort((a, b) => Date.parse(b.administeredAt) - Date.parse(a.administeredAt)),
    [admins],
  );
  const selectedDose = doses.find((d) => d.id === selectedDoseId) ?? null;

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill label={stateLabel(patient.status)} tone={ADMIN_STATUS_TONE[patient.status] ?? "neutral"} />
        </>
      }
    />
  ) : (
    <PatientBanner name="eMAR" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="medications" />

        {/* Center — the MAR grid + recent administrations */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <h1 style={{ margin: "0 0 1rem", fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1.375rem", color: t.onSurface }}>
            Medication Administration Record
          </h1>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && doses.length === 0 ? (
            <LoadingSpinner />
          ) : grid.meds.length === 0 ? (
            <EmptyState title="No doses scheduled" description="No scheduled doses in this window." />
          ) : (
            <section style={{ ...cardSurface, padding: "1rem 1.25rem", overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.82rem" }}>
                <thead>
                  <tr>
                    <th style={{ ...gridHead, textAlign: "left" }}>Medication order</th>
                    {grid.slots.map((s) => (
                      <th key={s} style={gridHead} className="tabular-nums">{s}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.meds.map((med) => (
                    <tr key={med}>
                      <td style={{ ...gridCell, textAlign: "left", fontFamily: t.fontMono, color: t.onSurface }}>
                        {med.slice(0, 10)}
                      </td>
                      {grid.slots.map((s) => {
                        const dose = grid.at(med, s);
                        return (
                          <td key={s} style={gridCell}>
                            {dose ? (
                              <button
                                type="button"
                                onClick={() => setSelectedDoseId(dose.id)}
                                aria-pressed={dose.id === selectedDoseId}
                                style={{ border: "none", background: dose.id === selectedDoseId ? t.primaryTint : "transparent", borderRadius: "9999px", padding: "0.1rem", cursor: "pointer" }}
                              >
                                <StatusPill label={stateLabel(dose.status)} tone={DOSE_TONE[dose.status] ?? "neutral"} />
                              </button>
                            ) : (
                              <span style={{ color: t.muted }}>—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Recent administrations (real) */}
          {recent.length > 0 ? (
            <section style={{ marginTop: "1.5rem" }}>
              <h2 style={sectionTitle}>Recent administrations</h2>
              <div style={{ ...cardSurface, padding: "0 1.25rem" }}>
                {recent.slice(0, 12).map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => navigate(`/patients/${patientId}/administrations/${a.id}`)}
                    style={{ ...adminRow, borderTop: i === 0 ? "none" : ghostBorder }}
                  >
                    <span className="tabular-nums" style={{ flex: 1, minWidth: 0, textAlign: "left", color: t.onSurface }}>
                      {ts(a.administeredAt)}
                      <span style={dateMeta}> · {stateLabel(a.mode)}</span>
                    </span>
                    <StatusPill label={stateLabel(a.status)} tone={ADMIN_STATUS_TONE[a.status] ?? "neutral"} />
                    {a.requiresRnReview ? <StatusPill label="RN review" tone="warning" /> : null}
                    <StatusPill label={stateLabel(a.lateEntryTier)} tone={lateEntryTone(a.lateEntryTier)} />
                    {a.isControlledSubstance ? <StatusPill label="Controlled" tone="critical" glyph="alert" /> : null}
                    <Glyph name="arrow-right" size={16} />
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* Right rail — Administer (five-rights scaffold) */}
        <aside style={rightRail}>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>Administer</h2>
            {selectedDose ? (
              <>
                <dl style={detailGrid}>
                  <dt style={dt}>Order</dt>
                  <dd style={{ ...dd, fontFamily: t.fontMono }}>{selectedDose.medicationOrderId.slice(0, 10)}</dd>
                  <dt style={dt}>Due</dt>
                  <dd style={{ ...dd }} className="tabular-nums">{ts(selectedDose.dueAt)}</dd>
                  <dt style={dt}>Status</dt>
                  <dd style={dd}><StatusPill label={stateLabel(selectedDose.status)} tone={DOSE_TONE[selectedDose.status] ?? "neutral"} /></dd>
                </dl>
                <span style={{ ...sectionTitle, display: "block", marginTop: "0.875rem" }}>Five rights</span>
                <ul style={{ listStyle: "none", padding: 0, margin: "0.4rem 0 0", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {FIVE_RIGHTS.map((r) => (
                    <li key={r} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", color: t.onSurfaceVariant }}>
                      <Glyph name="check-circle" size={14} /> {r}
                    </li>
                  ))}
                </ul>
                <button type="button" disabled style={recordBtn}>Record administration</button>
                <p style={meta}>
                  Recording a dose (single-dose / PRN / witness, with the barcode + five-rights ceremony)
                  arrives with the M13 administration write path.
                </p>
              </>
            ) : (
              <p style={meta}>Select a dose in the grid to verify the five rights and record it.</p>
            )}
          </div>
        </aside>
      </div>
    </PatientWorkspaceLayout>
  );
}

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return <span style={{ fontFamily: t.fontMono, fontSize: "0.78rem", color: t.onSurfaceVariant, background: t.surfaceContainer, borderRadius: "9999px", padding: "0.15rem 0.55rem" }}>{children}</span>;
}

const rightRail: CSSProperties = { width: "19rem", flexShrink: 0, overflow: "auto", padding: "1.5rem", background: t.surfaceLow };
const railTitle: CSSProperties = { margin: "0 0 0.625rem", fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1rem", color: t.onSurface };
const sectionTitle: CSSProperties = { fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: t.muted, margin: "0 0 0.5rem" };
const gridHead: CSSProperties = { padding: "0.5rem 0.5rem", textAlign: "center", fontWeight: 600, color: t.onSurfaceVariant, borderBottom: ghostBorder, whiteSpace: "nowrap" };
const gridCell: CSSProperties = { padding: "0.6rem 0.5rem", textAlign: "center", borderBottom: ghostBorder, whiteSpace: "nowrap" };
const adminRow: CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem", width: "100%", padding: "0.7rem 0", border: "none", background: "transparent", cursor: "pointer", color: t.muted, fontSize: "0.82rem" };
const dateMeta: CSSProperties = { color: t.muted };
const detailGrid: CSSProperties = { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: "0.5rem 1rem", margin: 0, fontSize: "0.8rem" };
const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };
const dd: CSSProperties = { margin: 0, color: t.onSurface };
const recordBtn: CSSProperties = { marginTop: "1rem", width: "100%", padding: "0.55rem 1rem", borderRadius: "9999px", background: t.surfaceContainer, color: t.muted, fontSize: "0.8125rem", fontWeight: 600, border: "none", cursor: "not-allowed" };
const meta: CSSProperties = { fontSize: "0.78rem", color: t.onSurfaceVariant, margin: "0.5rem 0 0" };
