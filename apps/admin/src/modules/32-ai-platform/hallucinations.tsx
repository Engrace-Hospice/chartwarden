import {
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.5 hallucination triage queue
// (`/admin/ai-platform/hallucinations`, `ai.hallucination.triage`). D9's queue as a kanban board keyed
// on `ai_hallucination_triage_status`.
//
// COLUMN ORDER IS NOT THE ENUM ORDER. `escalated_to_clinical_safety` leads (status.ts
// `TRIAGE_COLUMNS`), then `open`, then the working states, then `closed`. A clinical-safety escalation
// that sorts to the far right of a six-column board is one horizontal scroll away from being missed.
//
// NO NARRATIVE SNIPPET ON THE CARD. §5.1.5 asks for "first 200 chars of reporter narrative, PHI-redacted
// server-side". The list projection (R19) carries no narrative field at all — deliberately, per the route
// notes: the reporter's free text is the field most likely to contain the very PHI the report is about,
// and no server-side redactor is bound. So the card shows the structured facts (kind, severity, reporter
// role, age) and the drawer triages from those. Rendering an unredacted snippet because the spec asked
// for a redacted one is the one thing not to do here.
//
// THE SLA BADGE runs from `reportedAt` while the report is UNCLOSED — acknowledging a report does not
// stop the clock a clinician started (status.ts `slaBreach`).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { TRIAGE_COLUMNS, severityTone, slaBreach, triageTone } from "./status";
import {
  Field,
  Kv,
  OutcomeBanner,
  actionButtonStyle,
  cap,
  cardStyle,
  formatDate,
  inputStyle,
  pageStyle,
} from "./ui";

type ReportPage =
  operations["getApiV1AiHallucinationreports"]["responses"][200]["content"]["application/json"];
type Report = ReportPage["reports"][number];
type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];

const DISPOSITIONS = [
  "prompt_iteration_required",
  "model_rollback_required",
  "edge_case_acknowledged",
  "false_alarm",
] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export function HallucinationQueue(): JSX.Element {
  const client = useApiClient();
  const [reports, setReports] = useState<Report[]>([]);
  const [capabilityKeys, setCapabilityKeys] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [selected, setSelected] = useState<Report | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [rep, caps] = await Promise.all([
      client.GET("/api/v1/ai/hallucination-reports", { params: { query: {} } }),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (rep.error || caps.error) {
      setError("Triage queue unavailable.");
      setLoading(false);
      return;
    }
    setReports(rep.data.reports);
    const page = caps.data as CapabilityPage;
    setCapabilityKeys(new Map(page.capabilities.map((c) => [c.id, c.capabilityKey])));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = new Date();
  const columns = useMemo(
    () =>
      TRIAGE_COLUMNS.map((status) => ({
        status,
        items: reports.filter((r) => r.triageStatus === status),
      })),
    [reports],
  );

  const breaching = reports.filter((r) => slaBreach(r.reportedAt, r.closedAt, now) !== null).length;

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Hallucination triage"
        breadcrumb="AI Platform"
        actions={
          <button type="button" onClick={() => void load()} style={actionButtonStyle(false)}>
            Refresh
          </button>
        }
      />
      {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
      {breaching > 0 ? (
        <output aria-live="polite">
          <StatusPill
            label={`${breaching} report${breaching === 1 ? "" : "s"} past the 48h triage SLA`}
            tone="warning"
          />
        </output>
      ) : null}
      {loading && reports.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : reports.length === 0 ? (
        <EmptyState
          title="No reports filed"
          description="Clinicians have filed no hallucination reports."
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${columns.length}, minmax(15rem, 1fr))`,
            gap: "0.9rem",
            overflowX: "auto",
          }}
        >
          {columns.map(({ status, items }) => (
            <section
              key={status}
              style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
            >
              <h2 style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                <StatusPill label={`${cap(status)} · ${items.length}`} tone={triageTone(status)} />
              </h2>
              {items.map((r) => {
                const sla = slaBreach(r.reportedAt, r.closedAt, now);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r)}
                    style={{ ...cardStyle, textAlign: "left", cursor: "pointer", gap: "0.4rem" }}
                  >
                    <code style={{ fontSize: "0.8rem" }}>
                      {capabilityKeys.get(r.capabilityId) ?? r.capabilityId}
                    </code>
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                      <StatusPill label={cap(r.severity)} tone={severityTone(r.severity)} />
                      {sla ? <StatusPill label={sla.label} tone={sla.tone} /> : null}
                    </div>
                    <span style={{ fontSize: "0.78rem", color: "var(--color-on-surface-variant)" }}>
                      {cap(r.hallucinationKind)}
                    </span>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-on-surface-variant)" }}>
                      {r.reporterRole} · {formatDate(r.reportedAt)}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {selected ? (
        <TriageDrawer
          report={selected}
          capabilityKey={capabilityKeys.get(selected.capabilityId) ?? selected.capabilityId}
          onClose={() => setSelected(null)}
          onDone={(message, ok) => {
            setSelected(null);
            setOutcome({ ok, message });
            if (ok) void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** R20 — record a triage decision. */
function TriageDrawer({
  report,
  capabilityKey,
  onClose,
  onDone,
}: {
  report: Report;
  capabilityKey: string;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [toStatus, setToStatus] = useState<string>("investigating");
  const [disposition, setDisposition] = useState<string>("");
  const [severity, setSeverity] = useState<string>(report.severity);
  const [actionRef, setActionRef] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.POST("/api/v1/ai/hallucination-reports/{reportId}/triage", {
      params: { path: { reportId: report.id } },
      body: {
        toStatus: toStatus as never,
        // The route takes `null`, not an omitted key — "no disposition yet" is a real state on the
        // early edges (`open` → `investigating`), distinct from failing to send the field.
        disposition: (disposition === "" ? null : disposition) as never,
        mitigationActionRef: actionRef.trim() === "" ? null : actionRef.trim(),
        severity: severity as never,
      },
    });
    setBusy(false);
    onDone(res.error ? "Triage refused." : `Report moved to ${cap(toStatus)}.`, !res.error);
  }

  return (
    <Modal open ariaLabel="Triage hallucination report" onClose={onClose} width="38rem">
      <div style={{ ...cardStyle, border: "none" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Triage report</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem" }}>
          <Kv label="Capability">
            <Link to={`/admin/ai-platform/capabilities/${report.capabilityId}`}>
              <code>{capabilityKey}</code>
            </Link>
          </Kv>
          <Kv label="Kind">{cap(report.hallucinationKind)}</Kv>
          <Kv label="Reported by">{report.reporterRole}</Kv>
          <Kv label="Reported at">{formatDate(report.reportedAt)}</Kv>
          <Kv label="Reporter severity">{cap(report.severity)}</Kv>
          <Kv label="Linked invocation">
            {report.invocationId ? <code>{report.invocationId}</code> : "None — provenance broken"}
          </Kv>
        </div>
        {/* The reporter narrative is intentionally absent — see the file header. */}
        <Field label="Move to" htmlFor="tr-status">
          <select
            id="tr-status"
            value={toStatus}
            onChange={(e) => setToStatus(e.target.value)}
            style={inputStyle}
          >
            {TRIAGE_COLUMNS.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Re-classified severity" htmlFor="tr-severity">
          <select
            id="tr-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            style={inputStyle}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Disposition" htmlFor="tr-disposition">
          <select
            id="tr-disposition"
            value={disposition}
            onChange={(e) => setDisposition(e.target.value)}
            style={inputStyle}
          >
            <option value="">Not yet determined</option>
            {DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {cap(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mitigation reference" htmlFor="tr-action">
          <input
            id="tr-action"
            value={actionRef}
            onChange={(e) => setActionRef(e.target.value)}
            style={inputStyle}
            placeholder="Ticket / PR / incident id"
          />
        </Field>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            style={actionButtonStyle(true, busy)}
          >
            {busy ? "Saving…" : "Record triage"}
          </button>
          <button type="button" onClick={onClose} style={actionButtonStyle(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
