import {
  EmptyState,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/08-encounters — patient encounters / visits (M8 §5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ENCOUNTERS.md — "Use Patient Workspace."
// The per-patient list reached from the patient chart "Encounters / Visits" tab: a Patient Workspace
// (banner + shared module rail) over an encounters table | a right rail with the selected encounter's
// discipline, service date, and §2.2 lifecycle status. The server owns the authoritative status
// (ADR-0030, no frontend authz). Reads GET /api/v1/encounters?patientId (+ the patient summary for the
// banner). Rows label by encounter TYPE + discipline, never fabricated note text — the note body lives
// on the encounter read (/patients/:id/encounters/:encounterId).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";

interface EncounterRow {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  isF2f: boolean;
  signedAt: string | null;
  cosignedAt: string | null;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export function PatientEncounters(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<EncounterRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [eRes, pRes] = await Promise.all([
      client.GET("/api/v1/encounters", { params: { query: { patientId } } }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (pRes.data) setPatient(pRes.data as PatientSummary);
    if (eRes.error) {
      setError("Could not load encounters for this patient.");
      setLoading(false);
      return;
    }
    setItems((eRes.data?.encounters ?? []) as EncounterRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const visible = status ? items.filter((e) => e.status === status) : items;
    return [...visible].sort((a, b) => Date.parse(b.serviceDate) - Date.parse(a.serviceDate));
  }, [items, status]);

  const selected = items.find((e) => e.id === selectedId) ?? null;

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill
            label={stateLabel(patient.status)}
            tone={ENCOUNTER_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
    />
  ) : (
    <PatientBanner name="Encounters" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="encounters" />

        {/* Center — encounters table */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <h1
              style={{
                margin: 0,
                fontFamily: t.fontDisplay,
                fontWeight: 500,
                fontSize: "1.375rem",
                color: t.onSurface,
              }}
            >
              Encounters / Visits
            </h1>
            <select
              aria-label="Encounter status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              style={selectStyle}
            >
              <option value="">Any status</option>
              <option value="draft">Draft</option>
              <option value="finalized">Finalized</option>
              <option value="signed">Signed</option>
              <option value="cosign_pending">Cosign Pending</option>
              <option value="cosigned">Cosigned</option>
              <option value="voided">Voided</option>
            </select>
          </div>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && items.length === 0 ? (
            <LoadingSpinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No encounters"
              description="No encounters match the current filter."
            />
          ) : (
            <section style={{ ...cardSurface, padding: "0 1.25rem" }}>
              <div
                style={{ ...encounterRow, color: t.muted, borderTop: "none", cursor: "default" }}
              >
                <span style={{ flex: 1 }}>Encounter · type</span>
                <span style={col}>Discipline</span>
                <span style={col}>Status</span>
                <span style={colNarrow}>F2F</span>
              </div>
              {rows.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedId(e.id)}
                  aria-pressed={e.id === selectedId}
                  style={{
                    ...encounterRow,
                    borderTop: ghostBorder,
                    background: e.id === selectedId ? t.primaryTint : "transparent",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                      color: t.onSurface,
                      fontWeight: 600,
                    }}
                  >
                    {stateLabel(e.encounterType)}
                    <span style={dateMeta}> · {e.serviceDate.slice(0, 10)}</span>
                  </span>
                  <span style={col}>{stateLabel(e.discipline)}</span>
                  <span style={col}>
                    <StatusPill
                      label={stateLabel(e.status)}
                      tone={ENCOUNTER_TONE[e.status] ?? "neutral"}
                    />
                  </span>
                  <span style={colNarrow}>
                    {e.isF2f ? (
                      <span style={f2fBadge}>F2F</span>
                    ) : (
                      <span style={{ color: t.muted }}>—</span>
                    )}
                  </span>
                </button>
              ))}
            </section>
          )}
        </div>

        {/* Right rail — selected encounter detail */}
        <aside style={rightRail}>
          {selected ? (
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>{stateLabel(selected.encounterType)}</h2>
              <dl style={detailGrid}>
                <dt style={dt}>Status</dt>
                <dd style={dd}>
                  <StatusPill
                    label={stateLabel(selected.status)}
                    tone={ENCOUNTER_TONE[selected.status] ?? "neutral"}
                  />
                </dd>
                <dt style={dt}>Discipline</dt>
                <dd style={dd}>{stateLabel(selected.discipline)}</dd>
                <dt style={dt}>Service date</dt>
                <dd style={dd} className="tabular-nums">
                  {selected.serviceDate.slice(0, 10)}
                </dd>
                <dt style={dt}>Face-to-face</dt>
                <dd style={dd}>{selected.isF2f ? "Yes" : "No"}</dd>
                {selected.signedAt ? (
                  <>
                    <dt style={dt}>Signed</dt>
                    <dd style={dd} className="tabular-nums">
                      {selected.signedAt.slice(0, 16).replace("T", " ")}
                    </dd>
                  </>
                ) : null}
              </dl>
              <button
                type="button"
                onClick={() => navigate(`/patients/${patientId}/encounters/${selected.id}`)}
                style={{ ...primaryBtn, marginTop: "1rem", width: "100%" }}
              >
                Open encounter
              </button>
            </div>
          ) : (
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>Encounter detail</h2>
              <p style={meta}>
                Select an encounter to see its discipline, service date, and lifecycle status here.
              </p>
            </div>
          )}
        </aside>
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
const encounterRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  width: "100%",
  padding: "0.75rem 0",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: "0.85rem",
};
const col: CSSProperties = { width: "8rem", flexShrink: 0, display: "flex", alignItems: "center" };
const colNarrow: CSSProperties = {
  width: "3.5rem",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
};
const dateMeta: CSSProperties = { color: t.muted, fontWeight: 400, fontSize: "0.78rem" };
const f2fBadge: CSSProperties = {
  background: t.primaryTint,
  color: t.primary,
  borderRadius: "9999px",
  padding: "0.05rem 0.45rem",
  fontSize: "0.72rem",
  fontWeight: 600,
};
const selectStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
};
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
const primaryBtn: CSSProperties = {
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};
