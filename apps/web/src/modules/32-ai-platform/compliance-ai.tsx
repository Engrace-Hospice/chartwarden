import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/web/src/modules/32-ai-platform — M32 §5.2 Compliance Officer view (`/compliance/ai`,
// `ai.invocation.read`). GAP-049.
//
// Three sections, all org-scoped by the routes themselves (this is the tenant app; RLS and the ABAC
// guard pin the org — nothing here passes an organization id):
//   • Tenant invocation log — the §164.528 disclosure ledger for THIS organization, PHI masked.
//   • Tenant opt-in audit — which capabilities this org enabled, with the BAA / ZDR / clinical-review
//     acknowledgments captured at enrolment, plus revocations.
//   • Hallucination report archive — reports filed inside this org with their triage outcomes.
//
// PHI. The invocation projection carries no prompt, response or chart-context field at all, and this
// console binds no reveal affordance. The banner states that plainly and names the M2 elevated-access
// route, because "the column is empty" and "you may not see this column" are different facts and an
// officer reviewing disclosures needs to know which one they are looking at.
//
// NOT BUILT: §5.2's per-month evidence-pack export. It is described as an async job queued on
// `ai:invocations:async` producing a ZIP of five artifacts; there is no route, no job binding and no
// object-store handshake for it. A button that silently did nothing — or worse, produced a partial pack
// an officer then filed as evidence — is worse than its absence, so the section says what is missing.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

type InvocationPage =
  operations["getApiV1AiInvocations"]["responses"][200]["content"]["application/json"];
type Invocation = InvocationPage["rows"][number];
type OptInPage =
  operations["getApiV1AiTenantoptin"]["responses"][200]["content"]["application/json"];
type OptIn = OptInPage["optIns"][number];
type ReportPage =
  operations["getApiV1AiHallucinationreports"]["responses"][200]["content"]["application/json"];
type Report = ReportPage["reports"][number];
type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];

const cap = (s: string): string => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

const cellStyle: CSSProperties = { padding: "0.6rem 0.75rem" };
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};
const headRow: CSSProperties = { textAlign: "left", color: "var(--color-on-surface-variant)" };
const rowStyle: CSSProperties = { borderTop: "1px solid var(--color-outline-variant)" };
const sectionStyle: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-lg, 0.75rem)",
  background: "var(--color-surface)",
  padding: "1rem 1.1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const INVOCATION_TONE: Record<string, "success" | "error" | "warning" | "critical" | "neutral"> = {
  completed: "success",
  failed: "error",
  timed_out: "error",
  killed: "critical",
  capability_unavailable: "warning",
};
const TRIAGE_TONE: Record<
  string,
  "success" | "error" | "warning" | "critical" | "progress" | "neutral"
> = {
  open: "error",
  investigating: "progress",
  root_cause_identified: "progress",
  mitigated: "warning",
  closed: "success",
  escalated_to_clinical_safety: "critical",
};

export function ComplianceAiView(): JSX.Element {
  const client = useApiClient();
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [optIns, setOptIns] = useState<OptIn[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [capabilityKeys, setCapabilityKeys] = useState<Map<string, string>>(new Map());
  const [phiMasked, setPhiMasked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [inv, opts, reps, caps] = await Promise.all([
      client.GET("/api/v1/ai/invocations", { params: { query: { limit: 50 } } }),
      client.GET("/api/v1/ai/tenant-opt-in", {}),
      client.GET("/api/v1/ai/hallucination-reports", { params: { query: {} } }),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (inv.error || opts.error || reps.error || caps.error) {
      setError("AI compliance view unavailable.");
      setLoading(false);
      return;
    }
    setInvocations(inv.data.rows);
    setPhiMasked(inv.data.phiMasked);
    setOptIns(opts.data.optIns);
    setReports(reps.data.reports);
    const page = caps.data as CapabilityPage;
    setCapabilityKeys(new Map(page.capabilities.map((c) => [c.id, c.capabilityKey])));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const keyOf = useMemo(() => (id: string) => capabilityKeys.get(id) ?? id, [capabilityKeys]);
  /** The §164.528 subset: calls whose chart context actually reached a cloud vendor. */
  const disclosures = invocations.filter((i) => i.disclosedToVendor);

  if (loading && invocations.length === 0 && optIns.length === 0) return <LoadingSpinner />;
  if (error) return <EmptyState title={error} description="Retry shortly." />;

  return (
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader title="AI compliance" breadcrumb="Compliance" />

      <div role="note" style={{ ...sectionStyle, flexDirection: "row", alignItems: "center" }}>
        <StatusPill
          label={phiMasked ? "PHI masked" : "PHI visible"}
          tone={phiMasked ? "warning" : "critical"}
        />
        <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          {phiMasked
            ? "Prompt, response and chart-context payloads are never returned to this view. Patient identity is masked. Request elevated access through the M2 audit-grade access flow."
            : "This view is serving unmasked patient identity. Every read is audited."}
        </span>
      </div>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>
          Tenant invocation log — {disclosures.length} of {invocations.length} disclosed to a vendor
        </h2>
        {invocations.length === 0 ? (
          <EmptyState
            title="No invocations"
            description="No AI call has been made in this window."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRow}>
                <th style={cellStyle}>Invoked</th>
                <th style={cellStyle}>Capability</th>
                <th style={cellStyle}>Backend</th>
                <th style={cellStyle}>Touched chart</th>
                <th style={cellStyle}>Disclosed</th>
                <th style={cellStyle}>ZDR</th>
                <th style={cellStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {invocations.map((i) => (
                <tr key={i.invocationId} style={rowStyle}>
                  <td style={cellStyle} className="tabular-nums">
                    {formatDate(i.invokedAt)}
                  </td>
                  <td style={cellStyle}>
                    <code>{i.capabilityKey}</code>
                  </td>
                  <td style={cellStyle}>
                    <code>{i.backendKey}</code>
                  </td>
                  <td style={cellStyle}>{i.touchedPatientChart ? "Yes" : "No"}</td>
                  <td style={cellStyle}>
                    {i.disclosedToVendor ? <StatusPill label="Vendor" tone="warning" /> : "No"}
                  </td>
                  {/* A vendor disclosure WITHOUT a confirmed zero-data-retention contract is the row a
                      compliance officer is actually hunting for, so it is called out rather than left
                      as a bare boolean. */}
                  <td style={cellStyle}>
                    {i.disclosedToVendor && !i.zdrConfirmed ? (
                      <StatusPill label="Not confirmed" tone="error" />
                    ) : i.zdrConfirmed ? (
                      "Confirmed"
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={cellStyle}>
                    <StatusPill
                      label={cap(i.status)}
                      tone={INVOCATION_TONE[i.status] ?? "neutral"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>Tenant opt-in audit</h2>
        {optIns.length === 0 ? (
          <EmptyState
            title="No opt-in records"
            description="This organization has not enabled any AI capability."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRow}>
                <th style={cellStyle}>Capability</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}>Routing</th>
                <th style={cellStyle}>Pilot</th>
                <th style={cellStyle}>Opted in</th>
                <th style={cellStyle}>Paused</th>
                <th style={cellStyle}>Revoked</th>
              </tr>
            </thead>
            <tbody>
              {optIns.map((o) => (
                <tr key={o.id} style={rowStyle}>
                  <td style={cellStyle}>
                    <code>{keyOf(o.capabilityId)}</code>
                  </td>
                  <td style={cellStyle}>{cap(o.status)}</td>
                  <td style={cellStyle}>
                    {o.routingPreferenceSnapshot ? cap(o.routingPreferenceSnapshot) : "—"}
                  </td>
                  <td style={cellStyle}>{o.pilotEnrollment ? "Yes" : "No"}</td>
                  <td style={cellStyle} className="tabular-nums">
                    {formatDate(o.optedInAt)}
                  </td>
                  <td style={cellStyle} className="tabular-nums">
                    {formatDate(o.pausedAt)}
                  </td>
                  <td style={cellStyle} className="tabular-nums">
                    {formatDate(o.optedOutAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* The acknowledgments themselves (BAA reference, ZDR contract, clinical-reviewer attestation)
            are recorded on the opt-in row at enrolment, but the read projection does not return them —
            so they are not shown rather than guessed at from the fields that are here. */}
        <p style={{ fontSize: "0.78rem", color: "var(--color-on-surface-variant)" }}>
          The BAA, ZDR and clinical-reviewer acknowledgments captured at enrolment are stored on
          each record for audit but are not returned by this read surface.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>Hallucination report archive</h2>
        {reports.length === 0 ? (
          <EmptyState
            title="No reports"
            description="No clinician in this organization has filed an AI hallucination report."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRow}>
                <th style={cellStyle}>Reported</th>
                <th style={cellStyle}>Capability</th>
                <th style={cellStyle}>Kind</th>
                <th style={cellStyle}>Severity</th>
                <th style={cellStyle}>Triage</th>
                <th style={cellStyle}>Disposition</th>
                <th style={cellStyle}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} style={rowStyle}>
                  <td style={cellStyle} className="tabular-nums">
                    {formatDate(r.reportedAt)}
                  </td>
                  <td style={cellStyle}>
                    <code>{keyOf(r.capabilityId)}</code>
                  </td>
                  <td style={cellStyle}>{cap(r.hallucinationKind)}</td>
                  <td style={cellStyle}>{cap(r.severity)}</td>
                  <td style={cellStyle}>
                    <StatusPill
                      label={cap(r.triageStatus)}
                      tone={TRIAGE_TONE[r.triageStatus] ?? "neutral"}
                    />
                  </td>
                  <td style={cellStyle}>{r.triageDisposition ? cap(r.triageDisposition) : "—"}</td>
                  <td style={cellStyle} className="tabular-nums">
                    {formatDate(r.closedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>Monthly evidence pack</h2>
        <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          The §5.2 per-month evidence-pack export — a ZIP of the masked invocation summary, opt-in
          records, hallucination reports, kill-switch activations and calibration changes — is not
          built. No route, job binding or object-store handshake exists for it yet, and a partial
          pack filed as §164.528 evidence would be worse than none.
        </p>
      </section>
    </div>
  );
}
