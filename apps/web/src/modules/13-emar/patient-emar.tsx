import {
  Button,
  ConfirmDialog,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — patient eMAR (M13 §4.1/§6.1 #1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Patient Workspace + MAR Grid".
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `ANbhv`): a Patient Workspace (banner + module
// rail) over the Medication Administration Record GRID (one row per medication order, one column per dose
// time, each cell the dose's §2.2 status) | a right "Administer" rail | a recent-administrations strip. The
// SERVER owns the §2.2 lifecycle, §2.5 late-entry tier, and §7.2 SUD read gate (SUD rows skipped without a
// Part 2 release — never a frontend hide).
//
// F-031 — the Administer panel's Record action used to be a DISABLED button naming the write path it would
// one day call. It calls it now: single-dose / PRN / controlled-substance-with-witness / refusal, plus the
// §2.5 intentional hold on a scheduled cell. An eMAR that renders a dose grid and cannot record a dose is
// not an incomplete screen, it is a hazard — a clinician can reasonably read it as a working MAR.
//
// TWO THINGS THIS SCREEN NOW SAYS OUT LOUD, BECAUSE BOTH WERE INVISIBLE BEFORE.
//
//   • The grid is empty for every patient, and that is not a data problem. `scheduled_dose` rows are
//     materialized by the `m12.medication_order.active` -> `m13.materialize-schedule` consumer, which is
//     DECLARED and UNBOUND (scripts/outbox-deferred-consumers.ts). Nothing writes that table in
//     production. So the Administer panel is driven by the patient's ACTIVE MEDICATION ORDERS — a grid
//     cell, when there is one, only pre-selects. Hanging the whole write surface off a cell click would
//     have been a control wired to a table that never has rows.
//   • The grid names the DRUG. It used to print a truncated medication-order UUID, because M13's dose DTO
//     carries only the order id; the names come from M12's `/patients/{id}/medications/active`, joined
//     here. A caller without `prescribing.read` still sees the id — degraded, never fabricated.
//
// The picker reads `GET /api/v1/medication-orders?patientId=` rather than `/medications/active`, and
// keeps the statuses M13 may administer against — `active` PLUS `verbal_pending`, because M12 §2.3 says a
// verbal order "is active for clinical execution during this window" and `/medications/active` filters
// `status = 'active'`, which would hide exactly the 2 AM verbal order the module exists for. Each option
// is labelled with its lifecycle status so the clinician can see what they are giving against; the
// SERVER's §2.9 D6 gate is the enforcement. See ADMINISTRABLE_ORDER_STATUSES in emar-api.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { type AdministerIntent, AdministerModal } from "./administer-modal";
import {
  type ActiveMedicationOrder,
  type AdministrationView,
  type ScheduledDoseView,
  errorMessage,
  intentionalHold,
  listAdministrations,
  listPatientMedicationOrders,
  listScheduledDoses,
} from "./emar-api";
import { ADMIN_STATUS_TONE, DOSE_TONE, lateEntryTone, stateLabel } from "./emar-status";
import { IvSegmentModal } from "./iv-segment-modal";
import { WitnessAttestModal } from "./witness-attest-modal";

interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");
const slotOf = (iso: string): string => iso.slice(11, 16); // HH:MM

export function PatientEmar(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [doses, setDoses] = useState<ScheduledDoseView[]>([]);
  const [admins, setAdmins] = useState<AdministrationView[]>([]);
  const [orders, setOrders] = useState<ActiveMedicationOrder[]>([]);
  const [ordersUnavailable, setOrdersUnavailable] = useState(false);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [selectedDoseId, setSelectedDoseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<AdministerIntent | null>(null);
  const [witnessOpen, setWitnessOpen] = useState(false);
  const [ivStartOrderId, setIvStartOrderId] = useState<string | null>(null);
  const [holdDoseId, setHoldDoseId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [d, a, p, m] = await Promise.all([
      listScheduledDoses(client, { patient: patientId }),
      listAdministrations(client, { patient: patientId }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
      listPatientMedicationOrders(client, patientId),
    ]);
    if (p.data) setPatient(p.data as PatientSummary);
    if (d.error || a.error) {
      setError("Could not load the eMAR for this patient.");
      setLoading(false);
      return;
    }
    setDoses(d.doses);
    setAdmins(a.administrations);
    // A caller without `prescribing.read` still gets the eMAR; they just get order ids instead of drug
    // names, and the picker degrades to a typed id. The read is never a precondition for recording.
    setOrders(m.orders);
    setOrdersUnavailable(m.error !== null);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** §2.5 — hold a scheduled dose deliberately, so the miss detector records a decision, not a lapse. */
  const holdDose = useCallback(async () => {
    if (!holdDoseId) return;
    setBusy(true);
    setActionError(null);
    const { error: err } = await intentionalHold(client, holdDoseId, {});
    setBusy(false);
    setHoldDoseId(null);
    if (err) {
      setActionError(errorMessage(err, "The hold could not be recorded."));
      return;
    }
    void load();
  }, [client, holdDoseId, load]);

  /** The DRUG for a medication order id, from M12. Falls back to the truncated id — the pre-F-031 display —
   *  rather than inventing a name for an order this caller cannot read. */
  const drugLabel = useCallback(
    (medicationOrderId: string): string => {
      const order = orders.find((o) => o.id === medicationOrderId);
      return order ? `${order.drugName} ${order.strength}` : medicationOrderId.slice(0, 10);
    },
    [orders],
  );

  /** The D7 ceremony only has meaning for a controlled substance — the witness action stays hidden
   *  otherwise rather than offering an attestation the route would refuse. */
  const controlledOrders = useMemo(() => orders.filter((o) => o.isControlledSubstance), [orders]);

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
          <StatusPill
            label={stateLabel(patient.status)}
            tone={ADMIN_STATUS_TONE[patient.status] ?? "neutral"}
          />
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
          <h1
            style={{
              margin: "0 0 1rem",
              fontFamily: t.fontDisplay,
              fontWeight: 500,
              fontSize: "1.375rem",
              color: t.onSurface,
            }}
          >
            Medication Administration Record
          </h1>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && doses.length === 0 ? (
            <LoadingSpinner />
          ) : grid.meds.length === 0 ? (
            <EmptyState
              title="No doses scheduled"
              description="No scheduled doses in this window. Doses are materialized from active medication orders by a background consumer that is not yet wired, so this grid stays empty — record against the medication order in the Administer panel."
            />
          ) : (
            <section style={{ ...cardSurface, padding: "1rem 1.25rem", overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.82rem" }}>
                <thead>
                  <tr>
                    <th style={{ ...gridHead, textAlign: "left" }}>Medication order</th>
                    {grid.slots.map((s) => (
                      <th key={s} style={gridHead} className="tabular-nums">
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.meds.map((med) => (
                    <tr key={med}>
                      <td
                        style={{
                          ...gridCell,
                          textAlign: "left",
                          color: t.onSurface,
                        }}
                      >
                        {drugLabel(med)}
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
                                style={{
                                  border: "none",
                                  background:
                                    dose.id === selectedDoseId ? t.primaryTint : "transparent",
                                  borderRadius: "9999px",
                                  padding: "0.1rem",
                                  cursor: "pointer",
                                }}
                              >
                                <StatusPill
                                  label={stateLabel(dose.status)}
                                  tone={DOSE_TONE[dose.status] ?? "neutral"}
                                />
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
                    onClick={() =>
                      navigate(
                        a.ivSessionId
                          ? `/patients/${patientId}/iv-sessions/${a.ivSessionId}`
                          : `/patients/${patientId}/administrations/${a.id}`,
                      )
                    }
                    style={{ ...adminRow, borderTop: i === 0 ? "none" : ghostBorder }}
                  >
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left", color: t.onSurface }}>
                      <span className="tabular-nums">{ts(a.administeredAt)}</span>
                      <span style={dateMeta}>
                        {" · "}
                        {drugLabel(a.medicationOrderId)} · {stateLabel(a.mode)}
                      </span>
                    </span>
                    <StatusPill
                      label={stateLabel(a.status)}
                      tone={ADMIN_STATUS_TONE[a.status] ?? "neutral"}
                    />
                    {a.requiresRnReview ? <StatusPill label="RN review" tone="warning" /> : null}
                    <StatusPill
                      label={stateLabel(a.lateEntryTier)}
                      tone={lateEntryTone(a.lateEntryTier)}
                    />
                    {a.isControlledSubstance ? (
                      <StatusPill label="Controlled" tone="critical" glyph="alert" />
                    ) : null}
                    <Glyph name="arrow-right" size={16} />
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* Right rail — Administer. Driven by the ACTIVE ORDERS, not by a grid selection: nothing
            materializes scheduled doses in production, so a cell is a shortcut, never the entry point. */}
        <aside style={rightRail}>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>Administer</h2>

            {selectedDose ? (
              <dl style={detailGrid}>
                <dt style={dt}>Selected dose</dt>
                <dd style={dd}>{drugLabel(selectedDose.medicationOrderId)}</dd>
                <dt style={dt}>Due</dt>
                <dd style={{ ...dd }} className="tabular-nums">
                  {ts(selectedDose.dueAt)}
                </dd>
                <dt style={dt}>Status</dt>
                <dd style={dd}>
                  <StatusPill
                    label={stateLabel(selectedDose.status)}
                    tone={DOSE_TONE[selectedDose.status] ?? "neutral"}
                  />
                </dd>
              </dl>
            ) : (
              <p style={meta}>
                Records against one of this patient&rsquo;s active medication orders. Select a dose
                in the grid to pre-fill it.
              </p>
            )}

            <div style={railActions}>
              <Button tone="primary" onClick={() => setCeremony("administer")}>
                Record administration
              </Button>
              <Button tone="secondary" onClick={() => setCeremony("refuse")}>
                Record refusal
              </Button>
              {selectedDose && selectedDose.status === "pending" ? (
                <Button tone="tertiary" onClick={() => setHoldDoseId(selectedDose.id)}>
                  Hold this dose
                </Button>
              ) : null}
              {orders.length > 0 ? (
                <Button
                  tone="tertiary"
                  onClick={() =>
                    setIvStartOrderId(selectedDose?.medicationOrderId ?? orders[0]!.id)
                  }
                >
                  Start IV infusion
                </Button>
              ) : null}
              {controlledOrders.length > 0 ? (
                <Button tone="tertiary" onClick={() => setWitnessOpen(true)}>
                  Witness a controlled substance
                </Button>
              ) : null}
            </div>

            {actionError ? (
              <p role="alert" style={{ ...meta, color: t.error }}>
                {actionError}
              </p>
            ) : null}
          </div>
        </aside>

        <AdministerModal
          open={ceremony !== null}
          intent={ceremony ?? "administer"}
          patientId={patientId ?? ""}
          orders={orders}
          ordersUnavailable={ordersUnavailable}
          {...(selectedDose ? { initialOrderId: selectedDose.medicationOrderId } : {})}
          {...(selectedDose ? { scheduledDoseId: selectedDose.id } : {})}
          onClose={() => setCeremony(null)}
          onRecorded={() => {
            setCeremony(null);
            setSelectedDoseId(null);
            void load();
          }}
        />
        {ivStartOrderId ? (
          // §2.11 — starting an infusion MINTS the session, so the ceremony hands back its id and this
          // screen follows it: the segment sequence lives on the session surface, not in the MAR grid.
          <IvSegmentModal
            open
            mode="iv_continuous_start"
            medicationOrderId={ivStartOrderId}
            medClass={orders.find((o) => o.id === ivStartOrderId)?.medClass ?? "standard"}
            onClose={() => setIvStartOrderId(null)}
            onRecorded={(sessionId) => {
              setIvStartOrderId(null);
              if (sessionId) navigate(`/patients/${patientId}/iv-sessions/${sessionId}`);
              else void load();
            }}
          />
        ) : null}
        <WitnessAttestModal
          open={witnessOpen}
          patientId={patientId ?? ""}
          orders={controlledOrders}
          onClose={() => setWitnessOpen(false)}
        />
        <ConfirmDialog
          open={holdDoseId !== null}
          title="Hold this dose?"
          description="Recorded as an intentional hold before the grace window closes, so the dose reads as a clinical decision rather than a miss."
          confirmLabel="Record hold"
          pending={busy}
          onConfirm={() => void holdDose()}
          onCancel={() => setHoldDoseId(null)}
        />
      </div>
    </PatientWorkspaceLayout>
  );
}

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: t.fontMono,
        fontSize: "0.78rem",
        color: t.onSurfaceVariant,
        background: t.surfaceContainer,
        borderRadius: "9999px",
        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}

const rightRail: CSSProperties = {
  width: "19rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  background: t.surfaceLow,
};
const railTitle: CSSProperties = {
  margin: "0 0 0.625rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const sectionTitle: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: t.muted,
  margin: "0 0 0.5rem",
};
const gridHead: CSSProperties = {
  padding: "0.5rem 0.5rem",
  textAlign: "center",
  fontWeight: 600,
  color: t.onSurfaceVariant,
  borderBottom: ghostBorder,
  whiteSpace: "nowrap",
};
const gridCell: CSSProperties = {
  padding: "0.6rem 0.5rem",
  textAlign: "center",
  borderBottom: ghostBorder,
  whiteSpace: "nowrap",
};
const adminRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  width: "100%",
  padding: "0.7rem 0",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: t.muted,
  fontSize: "0.82rem",
};
const dateMeta: CSSProperties = { color: t.muted };
const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  alignItems: "center",
  gap: "0.5rem 1rem",
  margin: 0,
  fontSize: "0.8rem",
};
const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };
const dd: CSSProperties = { margin: 0, color: t.onSurface };
const railActions: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  marginTop: "1rem",
};
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.5rem 0 0",
};
