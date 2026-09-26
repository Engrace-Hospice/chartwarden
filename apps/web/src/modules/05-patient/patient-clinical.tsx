import {
  CountBadge,
  Glyph,
  type GlyphName,
  InfoRows,
  Panel,
  StatusPill,
  ageYears,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/05-patient — the patient chart's Clinical tab (2026-09-25 redesign, mockup
// "Patient Chart — Clinical"). Every panel reads a real endpoint: diagnoses from the M7 plan of care,
// PPS + ESAS-r from the M9 scale timeline, vitals + note text from the M8 encounter detail, open
// significant-change events (M9) as clinical alerts, and advance-directive consents + the active
// healthcare DPOA (M17). Nothing the platform does not capture (POLST, last BM, orientation) is drawn.
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PatientSummaryPanel, medicareTail } from "../../shell/patient-context";
import {
  EmptyLine,
  Loading,
  PanelLink,
  type PatientChartData,
  type PatientSummary,
  RailAlert,
  activePeriod,
  fmtDate,
  fmtTime,
  maskTail,
  memberName,
  sexLabel,
  titleCase,
} from "./patient-overview";

// ---------- data ----------

interface ScaleAssessment {
  id: string;
  scaleType: string;
  data: Record<string, unknown>;
  score: number | null;
  scoreInterpretation: string | null;
  capturedAt: string;
}
interface SeriesPoint {
  capturedAt: string;
  score: number | null;
}
interface SignificantChange {
  id: string;
  ruleId: string;
  status: string;
  severity: string;
}
interface Vitals {
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperature: string | null;
  temperatureUnit: string | null;
  spo2: number | null;
  weight: string | null;
  weightUnit: string | null;
  capturedAt: string;
}
interface EncounterDetail {
  id: string;
  serviceDate: string;
  encounterType: string | null;
  discipline: string | null;
  status: string | null;
  authoredByUserId: string;
  finalDocumentation: string | null;
  vitals: Vitals | null;
}
interface Consent {
  id: string;
  typeKey: string;
  status: string;
  signedAt: string | null;
  effectiveAt: string | null;
}
interface Dpoa {
  agentName: string;
  agentRelationship: string;
  scopeKind: string;
}

export interface ClinicalData {
  pps?: SeriesPoint[];
  ppsLatest?: ScaleAssessment | null;
  esas?: ScaleAssessment[];
  changes?: SignificantChange[];
  notes?: EncounterDetail[];
  consents?: Consent[];
  dpoa?: Dpoa | null;
}

type Client = ReturnType<typeof useApiClient>;

async function settle<T>(p: Promise<{ data?: unknown; error?: unknown }>): Promise<T | undefined> {
  try {
    const r = await p;
    return r.error ? undefined : (r.data as T);
  } catch {
    return undefined;
  }
}

const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * The Clinical tab's own sources, fetched in parallel; the encounter details follow the chart's list.
 * Called once by the chart (the tab and its rail share it) and idle until the tab is shown.
 */
export function useClinicalData(
  patientId: string,
  chart: PatientChartData,
  enabled: boolean,
): ClinicalData {
  const client: Client = useApiClient();
  const [data, setData] = useState<ClinicalData>({});
  const alive = useRef(true);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    const merge = (patch: ClinicalData): void => {
      if (alive.current) setData((d) => ({ ...d, ...patch }));
    };
    const path = { patientId };
    void settle<{ points: SeriesPoint[] }>(
      client.GET("/api/v1/patients/{patientId}/scales/{scaleType}/series", {
        params: {
          path: { patientId, scaleType: "pps" },
          query: { from: daysAgo(30), to: daysAgo(-1) },
        },
      }),
    ).then((r) => merge({ pps: r?.points ?? [] }));
    void settle<ScaleAssessment>(
      client.GET("/api/v1/patients/{patientId}/scales/{scaleType}/latest", {
        params: { path: { patientId, scaleType: "pps" } },
      }),
    ).then((r) => merge({ ppsLatest: r ?? null }));
    void settle<{ assessments: ScaleAssessment[] }>(
      client.GET("/api/v1/patients/{patientId}/assessments", {
        params: { path, query: { scaleType: "esas_r", from: daysAgo(30), limit: 30 } },
      }),
    ).then((r) =>
      merge({
        esas: [...(r?.assessments ?? [])].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
      }),
    );
    void settle<{ events: SignificantChange[] }>(
      client.GET("/api/v1/patients/{patientId}/significant-changes", { params: { path } }),
    ).then((r) => merge({ changes: (r?.events ?? []).filter((e) => e.status !== "acknowledged") }));
    void settle<{ data: Consent[] }>(
      client.GET("/api/v1/patients/{patientId}/consents", { params: { path } }),
    ).then((r) => merge({ consents: (r?.data ?? []).filter((c) => c.status === "active") }));
    void settle<{ data: Dpoa | null }>(
      client.GET("/api/v1/patients/{patientId}/dpoa/active-primary", { params: { path } }),
    ).then((r) => merge({ dpoa: r?.data ?? null }));
    return () => {
      alive.current = false;
    };
  }, [client, patientId, enabled]);

  // Vitals and note text live only on the encounter detail — read the few most recent ones.
  const encounters = chart.encounters;
  useEffect(() => {
    if (!enabled || encounters === undefined) return;
    let active = true;
    const recent = [...encounters]
      .filter((e) => e.status !== "voided")
      .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate))
      .slice(0, 4);
    void Promise.all(
      recent.map((e) =>
        settle<EncounterDetail>(
          client.GET("/api/v1/encounters/{encounterId}", {
            params: { path: { encounterId: e.id } },
          }),
        ),
      ),
    ).then((rows) => {
      if (active) {
        setData((d) => ({ ...d, notes: rows.filter((r): r is EncounterDetail => Boolean(r)) }));
      }
    });
    return () => {
      active = false;
    };
  }, [client, encounters, enabled]);

  return data;
}

// ---------- helpers ----------

const muted = { color: t.onSurfaceVariant, fontSize: "0.8125rem" } as const;

const PPS_SELF_CARE: Record<string, string> = {
  full: "Independent",
  occasional_assist: "Occasional assistance",
  considerable_assist: "Requires assistance",
  mainly_assist: "Mainly assisted",
  total_care: "Total care",
};
const PPS_CONSCIOUSNESS: Record<string, string> = {
  full: "Full",
  full_or_confusion: "Full or confused",
  full_or_drowsy_or_confusion: "Drowsy or confused",
  drowsy_or_coma: "Drowsy or unresponsive",
};

const CHANGE_LABEL: Record<string, { title: string; detail: string }> = {
  pps_drop_20_in_14d: { title: "Functional decline", detail: "PPS dropped ≥20 in 14 days" },
  kps_drop_20_in_14d: { title: "Functional decline", detail: "KPS dropped ≥20 in 14 days" },
  esas_total_increase_20_in_7d: {
    title: "Symptom burden rising",
    detail: "ESAS-r total +20 in 7 days",
  },
  esas_symptom_ge_7: { title: "Severe symptom", detail: "An ESAS-r symptom scored ≥ 7" },
  painad_ge_4: { title: "High pain score", detail: "PAINAD ≥ 4" },
  nyha_class_iv: { title: "NYHA class IV", detail: "Symptoms at rest" },
  braden_le_12: { title: "Pressure injury risk", detail: "Braden ≤ 12" },
  morse_ge_51: { title: "Fall risk", detail: "Morse fall scale ≥ 51" },
  meld_ge_30: { title: "MELD ≥ 30", detail: "Advanced liver disease" },
  fast_progression_30d: { title: "FAST progression", detail: "Dementia stage advanced in 30 days" },
  gds_progression_30d: { title: "GDS progression", detail: "Stage advanced in 30 days" },
  flacker_increase: { title: "Behavioral pain rising", detail: "FLACC-R increased" },
  aims_emergent_dyskinesia: { title: "Emergent dyskinesia", detail: "AIMS flagged" },
};

const ENCOUNTER_LABEL: Record<string, string> = {
  routine_visit: "SN Visit",
  admission_visit: "Admission Visit",
  recert_visit: "Recert Visit",
  face_to_face: "Face-to-Face",
  telephonic: "Phone Call",
  lpn_visit: "LPN Visit",
  chha_visit: "HHA Visit",
  msw_assessment: "MSW Assessment",
  msw_followup: "MSW Visit",
  chaplain_assessment: "Chaplain Assessment",
  chaplain_visit: "Chaplain Visit",
  volunteer_visit: "Volunteer Visit",
  bereavement_contact: "Bereavement",
  idg_followup: "IDG Follow-up",
};

const DX_DOTS = ["var(--color-viz-rose)", "var(--color-viz-teal)", "var(--color-viz-yellow)", "var(--color-viz-orange)", "var(--color-error)", "var(--color-viz-violet)"];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function IconTile({
  icon,
  color,
  size = 2.5,
}: {
  icon: GlyphName;
  color: string;
  size?: number;
}): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}rem`,
        height: `${size}rem`,
        borderRadius: t.radiusSm,
        background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})`,
        color,
        flexShrink: 0,
      }}
    >
      <Glyph name={icon} size={Math.round(size * 9)} strokeWidth={1.75} />
    </span>
  );
}

/** Tiny trend line for a symptom card — decorative; the card's number is the reading. The y-range
 *  hugs the series (±2 points of headroom, clamped to 0–10) so small week-to-week moves stay visible. */
function Sparkline({ values }: { values: number[] }): JSX.Element {
  const w = 120;
  const h = 26;
  if (values.length < 2) {
    return <div style={{ height: h }} aria-hidden="true" />;
  }
  const lo = Math.max(0, Math.min(...values) - 2);
  const hi = Math.min(10, Math.max(...values) + 2);
  const range = Math.max(hi - lo, 1);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - lo) / range) * (h - 6)}`)
    .join(" ");
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={t.primary}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ---------- tab ----------

export function ClinicalTab({
  patient,
  data,
  clinical,
}: {
  patient: PatientSummary;
  data: PatientChartData;
  clinical: ClinicalData;
}): JSX.Element {
  return (
    <div className="wx-overview-grid">
      <ClinicalOverviewPanel patientId={patient.id} data={data} className="wx-c15" />
      <ClinicalStatusPanel clinical={clinical} className="wx-c9" />
      <SymptomsPanel clinical={clinical} className="wx-c24" />
      <VitalsPanel patientId={patient.id} clinical={clinical} className="wx-c10" />
      <FunctionalPanel clinical={clinical} className="wx-c14" />
      <ClinicalNotesPanel
        patientId={patient.id}
        data={data}
        clinical={clinical}
        className="wx-c13"
      />
      <RecentDocumentsPanel patientId={patient.id} data={data} className="wx-c11" />
    </div>
  );
}

function ClinicalOverviewPanel({
  patientId,
  data,
  className,
}: {
  patientId: string;
  data: PatientChartData;
  className?: string;
}): JSX.Element {
  const problems = data.problems;
  const primary = problems?.find((p) => p.kind === "terminal") ?? problems?.[0];
  const related = (problems ?? []).filter((p) => p !== primary);
  return (
    <Panel
      title="Clinical Overview"
      icon="clipboard-check"
      description="Key clinical information, diagnoses, and current status."
      className={className}
      action={
        <Link to={`/patients/${patientId}/care-plan`} className="wx-btn-secondary wx-btn-sm">
          View all diagnoses{problems ? ` (${problems.length})` : ""}
        </Link>
      }
    >
      {problems === undefined ? (
        <Loading />
      ) : !primary ? (
        <EmptyLine>No active diagnoses on the plan of care.</EmptyLine>
      ) : (
        <div className="wx-dx-split">
          <div className="wx-subcard">
            <div className="wx-subcard-head">
              <strong>Primary Diagnosis</strong>
              {primary.icd10Code ? <span className="wx-code-chip">{primary.icd10Code}</span> : null}
            </div>
            <div style={{ display: "flex", gap: "0.875rem", alignItems: "flex-start" }}>
              <IconTile icon="heart-pulse" color={t.error} size={3} />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "1.0625rem",
                    fontWeight: 700,
                    lineHeight: 1.3,
                    color: t.onSurface,
                  }}
                >
                  {primary.description}
                </div>
                <div style={{ ...muted, marginTop: "0.375rem" }}>
                  {primary.kind === "terminal" ? "Terminal diagnosis" : titleCase(primary.kind)}
                  {primary.onsetAt ? ` · since ${fmtDate(primary.onsetAt)}` : ""}
                </div>
              </div>
            </div>
          </div>
          <div className="wx-subcard">
            <div className="wx-subcard-head">
              <strong>Related Diagnoses</strong>
            </div>
            {related.length === 0 ? (
              <EmptyLine>None recorded.</EmptyLine>
            ) : (
              <ul className="wx-dx-list">
                {related.slice(0, 5).map((p, i) => (
                  <li key={p.id}>
                    <span
                      aria-hidden
                      className="wx-dx-dot"
                      style={{ background: DX_DOTS[i % DX_DOTS.length] }}
                    />
                    <span className="wx-dx-code">{p.icd10Code ?? "—"}</span>
                    <span className="wx-dx-desc">{p.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function StatusRow({
  icon,
  label,
  value,
  strong,
}: {
  icon: GlyphName;
  label: string;
  value: ReactNode;
  strong?: boolean;
}): JSX.Element {
  return (
    <li>
      <span style={{ color: t.primary }}>
        <Glyph name={icon} size={16} strokeWidth={1.75} />
      </span>
      <span style={{ flex: 1, color: t.onSurfaceVariant }}>{label}</span>
      <span className="wx-nums" style={{ fontWeight: strong ? 700 : 500, color: t.onSurface }}>
        {value}
      </span>
    </li>
  );
}

function ClinicalStatusPanel({
  clinical,
  className,
}: {
  clinical: ClinicalData;
  className?: string;
}): JSX.Element {
  const pps = clinical.ppsLatest;
  const esas = clinical.esas?.at(-1);
  const vitals = clinical.notes?.find((n) => n.vitals)?.vitals ?? null;
  const open = clinical.changes;
  const loading = pps === undefined || clinical.esas === undefined;
  const pain = num(esas?.data.pain);
  const dyspnea = num(esas?.data.shortnessOfBreath);
  return (
    <Panel
      title="Clinical Status"
      icon="settings"
      className={className}
      action={
        open === undefined ? null : open.length === 0 ? (
          <StatusPill label="No open changes" tone="success" />
        ) : (
          <StatusPill
            label={`${open.length} change${open.length === 1 ? "" : "s"} flagged`}
            tone="warning"
          />
        )
      }
    >
      {loading ? (
        <Loading />
      ) : (
        <ul className="wx-status-rows">
          <StatusRow
            icon="bar-chart"
            label="PPS"
            value={pps?.score != null ? `${pps.score}%` : "—"}
            strong
          />
          <StatusRow
            icon="user"
            label="Self-care"
            value={PPS_SELF_CARE[String(pps?.data.selfCare)] ?? "—"}
          />
          <StatusRow
            icon="globe"
            label="Consciousness"
            value={PPS_CONSCIOUSNESS[String(pps?.data.consciousness)] ?? "—"}
          />
          <StatusRow
            icon="zap"
            label="Pain (ESAS-r)"
            value={pain != null ? `${pain} / 10` : "—"}
            strong
          />
          <StatusRow
            icon="lungs"
            label="Dyspnea (ESAS-r)"
            value={dyspnea != null ? `${dyspnea} / 10` : "—"}
            strong
          />
          <StatusRow
            icon="calendar"
            label="Last assessed"
            value={fmtDate([pps?.capturedAt, esas?.capturedAt].filter(Boolean).sort().at(-1))}
          />
          <StatusRow
            icon="scale"
            label="Weight"
            value={vitals?.weight ? `${vitals.weight} ${vitals.weightUnit ?? ""}`.trim() : "—"}
          />
        </ul>
      )}
    </Panel>
  );
}

const SYMPTOMS: { key: string; label: string; icon: GlyphName; color: string }[] = [
  { key: "pain", label: "Pain", icon: "zap", color: "var(--color-viz-orange)" },
  { key: "shortnessOfBreath", label: "Dyspnea", icon: "lungs", color: "var(--color-viz-rose)" },
  { key: "nausea", label: "Nausea", icon: "frown", color: "var(--color-viz-amber)" },
  { key: "anxiety", label: "Anxiety", icon: "brain", color: "var(--color-viz-violet)" },
  { key: "tiredness", label: "Fatigue", icon: "battery", color: "var(--color-error)" },
  { key: "lackOfAppetite", label: "Appetite", icon: "utensils", color: "var(--color-viz-green)" },
];

function SymptomsPanel({
  clinical,
  className,
}: {
  clinical: ClinicalData;
  className?: string;
}): JSX.Element {
  const list = clinical.esas;
  const latest = list?.at(-1);
  // Trend window: the week ending at the latest capture.
  const windowStart = latest ? new Date(latest.capturedAt).getTime() - 7 * 86_400_000 : 0;
  const week = (list ?? []).filter((a) => new Date(a.capturedAt).getTime() >= windowStart);
  const recent = latest
    ? Date.now() - new Date(latest.capturedAt).getTime() < 7 * 86_400_000
    : false;
  return (
    <Panel
      title="Current Symptoms"
      icon="activity"
      className={className}
      action={
        latest ? (
          <span style={muted}>
            {recent ? "Last 7 days" : `As of ${fmtDate(latest.capturedAt)}`}
          </span>
        ) : null
      }
    >
      {list === undefined ? (
        <Loading />
      ) : !latest ? (
        <EmptyLine>No ESAS-r symptom assessment in the last 30 days.</EmptyLine>
      ) : (
        <div className="wx-symptom-grid">
          {SYMPTOMS.map((s) => {
            const v = num(latest.data[s.key]);
            const series = week
              .map((a) => num(a.data[s.key]))
              .filter((x): x is number => x != null);
            return (
              <div key={s.key} className="wx-symptom-card">
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span style={{ color: s.color }}>
                    <Glyph name={s.icon} size={16} strokeWidth={1.75} />
                  </span>
                  <span style={{ fontSize: "0.8125rem", color: t.onSurface }}>{s.label}</span>
                </div>
                <div className="wx-symptom-value wx-nums">{v != null ? `${v}/10` : "—"}</div>
                <Sparkline values={series} />
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function VitalsPanel({
  patientId,
  clinical,
  className,
}: {
  patientId: string;
  clinical: ClinicalData;
  className?: string;
}): JSX.Element {
  const source = clinical.notes?.find((n) => n.vitals);
  const v = source?.vitals ?? null;
  const tiles: {
    icon: GlyphName;
    color: string;
    label: string;
    value: string | null;
    unit: string;
  }[] = v
    ? [
        {
          icon: "heart-pulse",
          color: "var(--color-viz-green)",
          label: "BP",
          value:
            v.bpSystolic != null && v.bpDiastolic != null
              ? `${v.bpSystolic}/${v.bpDiastolic}`
              : null,
          unit: "mmHg",
        },
        {
          icon: "heart",
          color: "var(--color-viz-rose)",
          label: "HR",
          value: v.heartRate?.toString() ?? null,
          unit: "bpm",
        },
        {
          icon: "lungs",
          color: t.primary,
          label: "RR",
          value: v.respiratoryRate?.toString() ?? null,
          unit: "/min",
        },
        {
          icon: "thermometer",
          color: t.primary,
          label: "Temp",
          value: v.temperature
            ? `${v.temperature} °${(v.temperatureUnit ?? "F").slice(0, 1).toUpperCase()}`
            : null,
          unit: "",
        },
        {
          icon: "droplet",
          color: t.primary,
          label: "SpO₂",
          value: v.spo2 != null ? `${v.spo2}%` : null,
          unit: "",
        },
        {
          icon: "scale",
          color: t.primary,
          label: "Weight",
          value: v.weight,
          unit: v.weightUnit ?? "",
        },
      ]
    : [];
  return (
    <Panel
      title={
        <span
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: "0.625rem",
            flexWrap: "wrap",
          }}
        >
          Vital Signs
          {v ? (
            <span style={{ ...muted, fontWeight: 400 }}>
              Latest: {fmtDate(v.capturedAt)} {fmtTime(v.capturedAt)}
            </span>
          ) : null}
        </span>
      }
      icon="heart-pulse"
      className={className}
      action={
        source ? (
          <Link
            to={`/patients/${patientId}/encounters/${source.id}`}
            className="wx-btn-secondary wx-btn-sm"
          >
            View visit
          </Link>
        ) : null
      }
    >
      {clinical.notes === undefined ? (
        <Loading />
      ) : !v ? (
        <EmptyLine>No vitals captured on recent visits.</EmptyLine>
      ) : (
        <div className="wx-vitals-grid">
          {tiles.map((tile) => (
            <div key={tile.label} className="wx-vital-tile">
              <IconTile icon={tile.icon} color={tile.color} size={2} />
              <div style={{ minWidth: 0 }}>
                <div style={muted}>{tile.label}</div>
                <div className="wx-nums" style={{ fontSize: "1.0625rem", fontWeight: 700 }}>
                  {tile.value ?? "—"}
                </div>
                {tile.unit && tile.value ? <div style={muted}>{tile.unit}</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** PPS trend over 30 days — an area line chart with a 0–100% axis. */
function PpsChart({ points }: { points: { at: number; score: number }[] }): JSX.Element {
  const W = 520;
  const H = 150;
  const L = 34;
  const B = 20;
  const min = points[0]!.at;
  const max = points.at(-1)!.at;
  const span = Math.max(max - min, 1);
  const x = (at: number): number => L + 14 + ((at - min) / span) * (W - L - 36);
  const y = (s: number): number => 6 + (1 - s / 100) * (H - B - 6);
  const line = points.map((p) => `${x(p.at)},${y(p.score)}`).join(" ");
  const area = `${x(min)},${y(0)} ${line} ${x(max)},${y(0)}`;
  const ticks = [0, 25, 50, 75, 100];
  const labels =
    points.length > 5 ? points.filter((_, i) => i % Math.ceil(points.length / 5) === 0) : points;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="PPS trend, last 30 days">
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={L} x2={W} y1={y(tk)} y2={y(tk)} stroke={t.cardBorder} strokeWidth="1" />
          <text x={L - 6} y={y(tk) + 3} textAnchor="end" fontSize="9" fill={t.onSurfaceVariant}>
            {tk}%
          </text>
        </g>
      ))}
      <polygon points={area} fill={t.primary} opacity="0.1" />
      <polyline points={line} fill="none" stroke={t.primary} strokeWidth="2" />
      {points.map((p) => (
        <circle key={p.at} cx={x(p.at)} cy={y(p.score)} r="3.5" fill={t.primary} />
      ))}
      {labels.map((p) => (
        <text
          key={p.at}
          x={x(p.at)}
          y={H - 4}
          textAnchor="middle"
          fontSize="9"
          fill={t.onSurfaceVariant}
        >
          {fmtDate(new Date(p.at).toISOString()).replace(/, \d{4}$/, "")}
        </text>
      ))}
    </svg>
  );
}

function FunctionalPanel({
  clinical,
  className,
}: {
  clinical: ClinicalData;
  className?: string;
}): JSX.Element {
  const points = (clinical.pps ?? [])
    .filter((p): p is SeriesPoint & { score: number } => p.score != null)
    .map((p) => ({ at: new Date(p.capturedAt).getTime(), score: p.score }))
    .sort((a, b) => a.at - b.at);
  const current = clinical.ppsLatest?.score;
  return (
    <Panel
      title="Functional Assessment"
      icon="file-text"
      description="PPS trend (last 30 days)"
      className={className}
      action={
        current != null ? (
          <span className="wx-kpi-chip">
            <span>Current PPS</span>
            <strong className="wx-nums">{current}%</strong>
          </span>
        ) : null
      }
    >
      {clinical.pps === undefined ? (
        <Loading />
      ) : points.length === 0 ? (
        <EmptyLine>No PPS captured in the last 30 days.</EmptyLine>
      ) : (
        <PpsChart points={points} />
      )}
    </Panel>
  );
}

function noteSummary(text: string | null): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 88)}…` : flat;
}

function ClinicalNotesPanel({
  patientId,
  data,
  clinical,
  className,
}: {
  patientId: string;
  data: PatientChartData;
  clinical: ClinicalData;
  className?: string;
}): JSX.Element {
  const notes = clinical.notes;
  return (
    <Panel
      title="Recent Clinical Notes"
      icon="file-text"
      flush
      className={className}
      action={<PanelLink to={`/patients/${patientId}/encounters`}>View all</PanelLink>}
    >
      {notes === undefined ? (
        <div style={{ padding: "0 1.125rem" }}>
          <Loading />
        </div>
      ) : notes.length === 0 ? (
        <div style={{ padding: "0 1.125rem 0.75rem" }}>
          <EmptyLine>No documented visits yet.</EmptyLine>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Author</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id}>
                <td className="wx-nums" style={{ whiteSpace: "nowrap" }}>
                  {fmtDate(n.serviceDate)}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Link to={`/patients/${patientId}/encounters/${n.id}`}>
                    {ENCOUNTER_LABEL[n.encounterType ?? ""] ?? "Visit"}
                  </Link>
                </td>
                <td>{memberName(data, n.authoredByUserId) ?? "—"}</td>
                <td style={{ color: t.onSurfaceVariant }}>{noteSummary(n.finalDocumentation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function RecentDocumentsPanel({
  patientId,
  data,
  className,
}: {
  patientId: string;
  data: PatientChartData;
  className?: string;
}): JSX.Element {
  const docs = data.documents;
  return (
    <Panel
      title="Recent Documents"
      icon="folder"
      flush
      className={className}
      action={<PanelLink to={`/patients/${patientId}/documents`}>View all</PanelLink>}
    >
      {docs === undefined ? (
        <div style={{ padding: "0 1.125rem" }}>
          <Loading />
        </div>
      ) : docs.length === 0 ? (
        <div style={{ padding: "0 1.125rem 0.75rem" }}>
          <EmptyLine>No documents filed for this patient.</EmptyLine>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {docs.slice(0, 4).map((d) => (
              <tr key={d.id}>
                <td className="wx-nums" style={{ whiteSpace: "nowrap" }}>
                  {fmtDate(d.createdAt)}
                </td>
                <td>{titleCase(d.aggregateType)}</td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
                    <span style={{ color: t.primary }}>
                      <Glyph name="file-text" size={14} />
                    </span>
                    {d.title}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------- right rail ----------

export function ClinicalRail({
  patient,
  data,
  clinical,
}: {
  patient: PatientSummary;
  data: PatientChartData;
  clinical: ClinicalData;
}): JSX.Element {
  const changes = clinical.changes;
  const contacts = data.careTeam
    ? [...data.careTeam.emergencyContacts].sort((a, b) => a.priority - b.priority).slice(0, 2)
    : undefined;
  const directives = (clinical.consents ?? []).filter(
    (c) => c.typeKey === "advance_directive_acknowledgment" || c.typeKey === "dpoa_healthcare",
  );
  const period = activePeriod(data.election);
  const upcoming: { key: string; icon: GlyphName; title: string; when: string }[] = [
    ...(data.visits ?? []).slice(0, 2).map((v) => ({
      key: v.id,
      icon: "calendar" as GlyphName,
      title: v.visitPurpose ? titleCase(v.visitPurpose) : "Visit",
      when: `${fmtDate(v.scheduledStartedAt)}  ${fmtTime(v.scheduledStartedAt)}`,
    })),
    ...(period?.scheduledEndAt
      ? [
          {
            key: "recert",
            icon: "calendar-check" as GlyphName,
            title: "Recertification",
            when: fmtDate(period.scheduledEndAt),
          },
        ]
      : []),
  ];
  return (
    <>
      <PatientSummaryPanel
        identity={{
          patient,
          sex: sexLabel(data.demographics?.sexAssignedAtBirth),
          medicare: medicareTail(data.identifiers),
        }}
      />
      <Panel
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
            Clinical Alerts
            {changes && changes.length > 0 ? <CountBadge count={changes.length} /> : null}
          </span>
        }
        icon="activity"
        flush
      >
        {changes === undefined ? (
          <div style={{ padding: "0 1.125rem" }}>
            <Loading />
          </div>
        ) : changes.length === 0 ? (
          <div style={{ padding: "0 1.125rem 0.75rem" }}>
            <EmptyLine>No open significant-change alerts.</EmptyLine>
          </div>
        ) : (
          <ul className="wx-rail-list">
            {changes.slice(0, 4).map((c) => {
              const label = CHANGE_LABEL[c.ruleId] ?? { title: titleCase(c.ruleId), detail: "" };
              return (
                <li key={c.id}>
                  <RailAlert
                    tone={c.severity === "high" ? "danger" : "warning"}
                    title={label.title}
                    detail={c.status === "escalated" ? `${label.detail} · escalated` : label.detail}
                    to={`/patients/${patient.id}/assessments`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <Panel
        title="Key Contacts"
        icon="user-circle"
        action={<PanelLink to={`/patients/${patient.id}?view=care-team`}>Edit</PanelLink>}
      >
        {contacts === undefined ? (
          <Loading />
        ) : contacts.length === 0 ? (
          <EmptyLine>No contacts on file.</EmptyLine>
        ) : (
          <ul className="wx-contact-list">
            {contacts.map((c, i) => (
              <li key={c.id}>
                <span style={{ color: t.primary }}>
                  <Glyph name="user" size={18} strokeWidth={1.75} />
                </span>
                <div>
                  <strong>{i === 0 ? "Primary Contact" : "Alternate Contact"}</strong>
                  <div>
                    {c.name}{" "}
                    <span style={{ color: t.onSurfaceVariant }}>({titleCase(c.relationship)})</span>
                  </div>
                  <div className="wx-nums" style={muted}>
                    {c.phone}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title="Advance Directives"
        icon="shield-check"
        action={<PanelLink to={`/patients/${patient.id}?view=privacy`}>Edit</PanelLink>}
      >
        {clinical.consents === undefined || clinical.dpoa === undefined ? (
          <Loading />
        ) : directives.length === 0 && !clinical.dpoa ? (
          <EmptyLine>No advance directive or healthcare DPOA on file.</EmptyLine>
        ) : (
          <ul className="wx-contact-list">
            {directives.map((c) => (
              <li key={c.id}>
                <span style={{ color: t.success }}>
                  <Glyph name="check-circle" size={18} strokeWidth={1.75} />
                </span>
                <div>
                  <strong>
                    {c.typeKey === "dpoa_healthcare"
                      ? "Healthcare DPOA on file"
                      : "Advance directive on file"}
                  </strong>
                  {c.typeKey === "dpoa_healthcare" && clinical.dpoa ? (
                    <div style={muted}>
                      Agent: {clinical.dpoa.agentName} ({titleCase(clinical.dpoa.agentRelationship)}
                      )
                    </div>
                  ) : null}
                  {c.signedAt ? <div style={muted}>Signed {fmtDate(c.signedAt)}</div> : null}
                </div>
              </li>
            ))}
            {clinical.dpoa && !directives.some((c) => c.typeKey === "dpoa_healthcare") ? (
              <li>
                <span style={{ color: t.success }}>
                  <Glyph name="check-circle" size={18} strokeWidth={1.75} />
                </span>
                <div>
                  <strong>Healthcare proxy</strong>
                  <div style={muted}>
                    {clinical.dpoa.agentName} ({titleCase(clinical.dpoa.agentRelationship)})
                  </div>
                </div>
              </li>
            ) : null}
          </ul>
        )}
      </Panel>
      <Panel
        title="Upcoming"
        icon="calendar"
        action={<PanelLink to="/calendar">View all</PanelLink>}
      >
        {data.visits === undefined ? (
          <Loading />
        ) : upcoming.length === 0 ? (
          <EmptyLine>Nothing scheduled.</EmptyLine>
        ) : (
          <ul className="wx-contact-list">
            {upcoming.map((u) => (
              <li key={u.key}>
                <span style={{ color: t.primary }}>
                  <Glyph name={u.icon} size={18} strokeWidth={1.75} />
                </span>
                <div>
                  <strong>{u.title}</strong>
                  <div className="wx-nums" style={{ ...muted, whiteSpace: "pre" }}>
                    {u.when}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
