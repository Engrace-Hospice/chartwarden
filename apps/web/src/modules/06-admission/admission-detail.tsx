import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Admission Detail (M6 §5.2.4 + §5.2.5 activation gate, Track B).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Detail Page."
// Reads the admission aggregate from GET /api/v1/admissions/:id (which carries the R-AC-01 activation
// gate — the SAME server-truth gate route 14 enforces, so the §5.2.5 checklist can never diverge),
// plus the election-periods and compliance-windows sub-lists. Reads only; the server is the only
// enforcement point (ADR-0030). Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";

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
        <PageHeader title={`Admission ${admission.id}`} breadcrumb={`State: ${admission.state}`} />
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
        <RowList rows={windows} empty="No open compliance windows." />
      </Section>
    </DetailPageLayout>
  );
}

function ActivationChecklist({
  gate,
}: { gate: AdmissionDetailView["activationGate"] }): JSX.Element {
  return (
    <div>
      <p style={{ fontSize: "0.85rem", color: gate.ready ? "#15803d" : "#b45309" }}>
        {gate.ready ? "All preconditions met — ready to activate." : "Activation blocked."}
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "0.85rem" }}>
        {GATE_ROWS.map((row) => {
          const missing = gate.missing.includes(row.code);
          return (
            <li
              key={row.code}
              style={{ padding: "0.35rem 0", color: missing ? "#b91c1c" : "#15803d" }}
            >
              <span aria-hidden style={{ marginRight: "0.5rem" }}>
                {missing ? "✗" : "✓"}
              </span>
              {row.label}
            </li>
          );
        })}
      </ul>
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

function RowList({ rows, empty }: { rows: SummaryRow[]; empty: string }): JSX.Element {
  if (rows.length === 0) return <p style={{ fontSize: "0.85rem", color: "#6b7280" }}>{empty}</p>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: "1px solid #f3f4f6" }}>
            <td style={{ padding: "0.4rem 0.5rem" }}>{r.id}</td>
            <td style={{ padding: "0.4rem 0.5rem" }}>{r.state}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
