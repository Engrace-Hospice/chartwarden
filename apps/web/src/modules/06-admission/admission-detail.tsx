import {
  DetailPageLayout,
  EmptyState,
  type GateItem,
  GateStepper,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Admission Detail (M6 §5.2.4 + §5.2.5 activation gate, Track B).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Detail Page."
// Reads the admission aggregate from GET /api/v1/admissions/:id (which carries the R-AC-01 activation
// gate — the SAME server-truth gate route 14 enforces, so the §5.2.5 checklist can never diverge),
// plus the election-periods and compliance-windows sub-lists. Reconciled to Lantern (R1): the §5.2.5
// activation gate renders as a Guardrail GateStepper (blockers-first, alert glyphs) under a GuardChip
// summary; states are §6.6 status pills. Reads only; the server is the only enforcement point (ADR-0030).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { ADMISSION_TONE, WINDOW_TONE, stateLabel } from "./admission-status";

interface SummaryRow {
  id: string;
  state: string;
  version: number;
}
interface AdmissionDetailView extends SummaryRow {
  activationGate: { ready: boolean; missing: string[] };
}

// §5.2.5 — the four activation preconditions, in checklist order; the server's `missing[]` codes drive
// which rows pulse red. Kept verbatim from computeActivationGate so the UI renders server truth.
const GATE_ROWS: { code: string; label: string }[] = [
  { code: "election_signed", label: "Election statement signed (period 1)" },
  { code: "nor_acknowledged", label: "Notice of Rights acknowledged" },
  { code: "cti_signed", label: "CTI signed by hospice medical director" },
  { code: "attending_signed", label: "CTI signed by attending physician (period 1)" },
];

export function AdmissionDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [admission, setAdmission] = useState<AdmissionDetailView | null>(null);
  const [periods, setPeriods] = useState<SummaryRow[]>([]);
  const [windows, setWindows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admissions/{id}", {
      params: { path: { id } },
    });
    if (err || !data) {
      setError("Admission not found or not visible to you.");
      setLoading(false);
      return;
    }
    setAdmission(data);
    const [p, w] = await Promise.all([
      client.GET("/api/v1/admissions/{id}/election-periods", { params: { path: { id } } }),
      client.GET("/api/v1/admissions/{id}/compliance-windows", { params: { path: { id } } }),
    ]);
    setPeriods(p.data?.items ?? []);
    setWindows(w.data?.items ?? []);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !admission)
    return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`Admission ${admission.id}`}
          actions={
            <StatusPill
              label={stateLabel(admission.state)}
              tone={ADMISSION_TONE[admission.state] ?? "neutral"}
            />
          }
        />
      }
      aside={
        <RightDetailPanel title="Activation gate">
          <ActivationChecklist gate={admission.activationGate} />
        </RightDetailPanel>
      }
    >
      <Section title="Election periods">
        <RowList rows={periods} empty="No election periods yet." />
      </Section>
      <Section title="Compliance windows">
        <RowList rows={windows} empty="No open compliance windows." toneFor={WINDOW_TONE} />
      </Section>
    </DetailPageLayout>
  );
}

// §5.2.5 activation gate as a Guardrail treatment: a blocked GuardChip summary (or a success pill when
// ready) over a GateStepper whose rows render server-truth — each unmet precondition is `blocked`
// (alert glyph, error tint, surfaced first), each met one `complete` (check, struck through).
function ActivationChecklist({
  gate,
}: { gate: AdmissionDetailView["activationGate"] }): JSX.Element {
  const items: GateItem[] = GATE_ROWS.map((row) => ({
    id: row.code,
    label: row.label,
    status: gate.missing.includes(row.code) ? "blocked" : "complete",
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {gate.ready ? (
        <StatusPill tone="success" label="Ready to activate" />
      ) : (
        <GuardChip
          tone="error"
          reason={`${gate.missing.length} precondition${gate.missing.length === 1 ? "" : "s"} block activation`}
        />
      )}
      <GateStepper items={items} ariaLabel="Activation preconditions" />
    </div>
  );
}

function Section({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section style={{ marginBottom: "1.5rem" }}>
      <h3 style={{ fontSize: "0.95rem", fontWeight: 600, margin: "0 0 0.5rem" }}>{title}</h3>
      {children}
    </section>
  );
}

function RowList({
  rows,
  empty,
  toneFor,
}: {
  rows: SummaryRow[];
  empty: string;
  toneFor?: Record<string, StatusTone>;
}): JSX.Element {
  if (rows.length === 0)
    return <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>{empty}</p>;
  return (
    <table>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="wx-data-md">{r.id}</td>
            <td>
              <StatusPill label={stateLabel(r.state)} tone={toneFor?.[r.state] ?? "neutral"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
