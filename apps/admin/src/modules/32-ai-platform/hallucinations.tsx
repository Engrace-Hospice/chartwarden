import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.5 hallucination triage queue
// (`/admin/ai-platform/hallucinations`, `ai.hallucination.triage`). D9's queue, keyed on
// `ai_hallucination_triage_status`: a count per triage column, then one list in column order, and a right
// drawer (`?report=<id>`) that triages the selected report.
//
// COLUMN (AND ROW) ORDER IS NOT THE ENUM ORDER. `escalated_to_clinical_safety` leads (status.ts
// `TRIAGE_COLUMNS`), then `open`, then the working states, then `closed`. A clinical-safety escalation
// that sorts to the bottom of the list (or the far right of a board) is one scroll away from being missed.
//
// NO NARRATIVE SNIPPET ON THE ROW. §5.1.5 asks for "first 200 chars of reporter narrative, PHI-redacted
// server-side". The list projection (R19) carries no narrative field at all — deliberately, per the route
// notes: the reporter's free text is the field most likely to contain the very PHI the report is about,
// and no server-side redactor is bound. So the row shows the structured facts (kind, severity, reporter
// role, age) and the drawer triages from those. Rendering an unredacted snippet because the spec asked
// for a redacted one is the one thing not to do here.
//
// THE SLA BADGE runs from `reportedAt` while the report is UNCLOSED — acknowledging a report does not
// stop the clock a clinician started (status.ts `slaBreach`).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TRIAGE_COLUMNS, severityTone, slaBreach, triageTone } from "./status";
import {
  EmptyListState,
  ErrorState,
  LoadingState,
  OutcomeBanner,
  PageHead,
  StandingNotice,
  cap,
  formatDate,
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
const SELECTED_PARAM = "report";

export function HallucinationQueue(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(SELECTED_PARAM);
  const [reports, setReports] = useState<Report[]>([]);
  const [capabilityKeys, setCapabilityKeys] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const [rep, caps] = await Promise.all([
      client.GET("/api/v1/ai/hallucination-reports", { params: { query: {} } }),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (!isCurrent()) return;
    if (rep.error || caps.error) {
      setError("Triage queue unavailable.");
      setLoading(false);
      return;
    }
    setReports(rep.data.reports);
    const page = caps.data as CapabilityPage;
    setCapabilityKeys(new Map(page.capabilities.map((c) => [c.id, c.capabilityKey])));
    setLoading(false);
  }, [client, guard]);

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
  // One list in column order: the clinical-safety escalations first, `closed` last.
  const ordered = useMemo(() => columns.flatMap((c) => c.items), [columns]);
  const selected = reports.find((r) => r.id === selectedId) ?? null;
  const keyOf = (id: string): string => capabilityKeys.get(id) ?? id;

  const breaching = reports.filter((r) => slaBreach(r.reportedAt, r.closedAt, now) !== null).length;

  return (
    <div className={`wx-list-drawer${selectedId ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <PageHead
          title="Hallucination triage"
          description="Clinician-filed hallucination reports, clinical-safety escalations first."
        >
          <Button tone="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </PageHead>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
        {breaching > 0 ? (
          <StandingNotice tone="warning" urgent>
            {`${breaching} report${breaching === 1 ? "" : "s"} past the 48h triage SLA`}
          </StandingNotice>
        ) : null}
        {loading && reports.length === 0 ? (
          <LoadingState label="Loading triage queue…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : reports.length === 0 ? (
          <EmptyListState
            title="No reports filed"
            description="Clinicians have filed no hallucination reports."
          />
        ) : (
          <>
            <div className="wx-stat-grid" aria-label="Triage summary">
              {columns.map(({ status, items }) => (
                <div key={status} className="wx-stat-card">
                  <div>
                    <span className="wx-stat-label">{cap(status)}</span>
                    <span className="wx-stat-value wx-nums">{items.length}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <caption className="wx-sr-only">Hallucination reports</caption>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Triage status</th>
                    <th scope="col">Severity</th>
                    <th scope="col">SLA</th>
                    <th scope="col">Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((r) => {
                    const sla = slaBreach(r.reportedAt, r.closedAt, now);
                    const isSelected = r.id === selectedId;
                    const open = (): void => setParams({ [SELECTED_PARAM]: r.id });
                    return (
                      <tr
                        key={r.id}
                        className={
                          isSelected
                            ? "is-selected wx-data-row-interactive"
                            : "wx-data-row-interactive"
                        }
                        {...interactiveRowProps(open, isSelected)}
                      >
                        <td>
                          <span className="wx-row-title wx-data-md">{keyOf(r.capabilityId)}</span>
                          <span className="wx-row-sub">{cap(r.hallucinationKind)}</span>
                        </td>
                        <td>
                          <StatusPill
                            label={cap(r.triageStatus)}
                            tone={triageTone(r.triageStatus)}
                          />
                        </td>
                        <td>
                          <StatusPill label={cap(r.severity)} tone={severityTone(r.severity)} />
                        </td>
                        <td>{sla ? <StatusPill label={sla.label} tone={sla.tone} /> : "—"}</td>
                        <td>
                          <span className="wx-nums">{formatDate(r.reportedAt)}</span>
                          <span className="wx-row-sub">{r.reporterRole}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {selectedId ? (
        <TriageDrawer
          key={selectedId}
          id={selectedId}
          report={selected}
          capabilityKey={selected ? keyOf(selected.capabilityId) : null}
          loading={loading}
          onClose={() => setParams({})}
          onDone={(message, ok) => {
            setOutcome({ ok, message });
            if (ok) {
              setParams({});
              void load();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** The selected report in the right drawer, with R20 — record a triage decision. */
function TriageDrawer({
  id,
  report,
  capabilityKey,
  loading,
  onClose,
  onDone,
}: {
  id: string;
  report: Report | null;
  capabilityKey: string | null;
  loading: boolean;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" aria-label="Triage hallucination report" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="alert-circle" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>Triage report</h2>
          <span className="wx-row-sub wx-data-md">{capabilityKey ?? id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        {report === null ? (
          loading ? (
            <LoadingSpinner label="Loading report…" />
          ) : (
            <InlineAlert tone="info">This report is not in the triage queue.</InlineAlert>
          )
        ) : (
          <>
            <section className="wx-drawer-card">
              <div className="wx-drawer-card-head">
                <h3>Report</h3>
                <StatusPill
                  label={cap(report.triageStatus)}
                  tone={triageTone(report.triageStatus)}
                />
              </div>
              <dl className="wx-kv">
                <dt>Capability</dt>
                <dd>
                  <Link
                    className="wx-data-md"
                    to={`/admin/ai-platform/capabilities/${report.capabilityId}`}
                  >
                    {capabilityKey}
                  </Link>
                </dd>
                <dt>Kind</dt>
                <dd>{cap(report.hallucinationKind)}</dd>
                <dt>Reported by</dt>
                <dd>{report.reporterRole}</dd>
                <dt>Reported at</dt>
                <dd className="wx-nums">{formatDate(report.reportedAt)}</dd>
                <dt>Reporter severity</dt>
                <dd>{cap(report.severity)}</dd>
                <dt>Linked invocation</dt>
                <dd className={report.invocationId ? "wx-data-md break-all" : undefined}>
                  {report.invocationId ?? "None — provenance broken"}
                </dd>
              </dl>
            </section>
            {/* The reporter narrative is intentionally absent — see the file header. */}
            <TriageForm report={report} onDone={onDone} />
          </>
        )}
      </div>
    </aside>
  );
}

function TriageForm({
  report,
  onDone,
}: {
  report: Report;
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
    <section className="wx-drawer-card">
      <h3>Triage decision</h3>
      <SelectField
        id="tr-status"
        label="Move to"
        value={toStatus}
        onChange={(e) => setToStatus(e.target.value)}
        options={TRIAGE_COLUMNS.map((s) => ({ value: s, label: cap(s) }))}
      />
      <SelectField
        id="tr-severity"
        label="Re-classified severity"
        value={severity}
        onChange={(e) => setSeverity(e.target.value)}
        options={SEVERITIES.map((s) => ({ value: s, label: cap(s) }))}
      />
      <SelectField
        id="tr-disposition"
        label="Disposition"
        value={disposition}
        onChange={(e) => setDisposition(e.target.value)}
        options={[
          { value: "", label: "Not yet determined" },
          ...DISPOSITIONS.map((d) => ({ value: d, label: cap(d) })),
        ]}
      />
      <TextField
        id="tr-action"
        label="Mitigation reference"
        value={actionRef}
        onChange={(e) => setActionRef(e.target.value)}
        placeholder="Ticket / PR / incident id"
      />
      <div className="wx-drawer-actions">
        <Button onClick={() => void submit()} loading={busy} disabled={busy}>
          {busy ? "Saving…" : "Record triage"}
        </Button>
      </div>
    </section>
  );
}
