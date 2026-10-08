import { StatusPill, useApiClient, useRequestGuard } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.7 evaluation runs (`/admin/ai-platform/evaluations`,
// `ai.capability.read`). D10's evidence ledger: which run backs which lifecycle gate.
//
// `stage` IS THE POINT, not decoration. An `ai_evaluation_run` is evidence for a specific §2.2 edge
// (`stage_3_evaluation`, `stage_4_pilot`, `reapproval`, `drift_response`, `post_incident`), and the
// transition dialog on the capability detail asks for a `linkedEvaluationRunId`. So the stage column
// sits beside the status column: "passed" alone does not tell an operator what it licences.
//
// SUMMARY METRICS ARE OPAQUE by contract (`Record<string, unknown>` — each capability's metric set is
// its own, §2.5). They are rendered as sorted key/value pairs rather than mapped onto assumed
// precision/recall/F1 columns, which would silently drop any metric a capability actually reports.
//
// NOT BUILT: §5.1.7's "Trigger run" button (R26) and the per-run sample-level results table. R26 takes a
// completed run's `mlflowRunId` and `summaryMetrics` — it RECORDS a run performed elsewhere rather than
// starting one, so a "Trigger run" button here would be a lie about what the platform does. The
// sample-level table has no route at all.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { evalTone } from "./status";
import { EmptyListState, ErrorState, LoadingState, PageHead, cap, formatDate } from "./ui";

type EvaluationPage =
  operations["getApiV1AiEvaluations"]["responses"][200]["content"]["application/json"];
type Run = EvaluationPage["runs"][number];
type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];

const STATUSES = ["pending", "in_progress", "passed", "failed", "aborted"] as const;

/** Duration between two instants, or an em dash when either is missing (a pending run has neither). */
export function duration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Render an opaque metric bag as sorted `key: value` text — no assumed metric names. */
export function summarizeMetrics(metrics: unknown): string {
  if (metrics === null || typeof metrics !== "object") return "—";
  const entries = Object.entries(metrics as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  if (entries.length === 0) return "—";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(3) : String(v)}`)
    .join(" · ");
}

export interface EvaluationRunsProps {
  /** When set, the list is pre-filtered to one capability (the detail screen does not use this today). */
  capabilityId?: string;
}

export function EvaluationRuns({ capabilityId }: EvaluationRunsProps = {}): JSX.Element {
  const client = useApiClient();
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState("");
  const [capabilityKeys, setCapabilityKeys] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const query: Record<string, string> = {};
    if (capabilityId) query.capabilityId = capabilityId;
    if (status) query.status = status;
    const [r, caps] = await Promise.all([
      client.GET("/api/v1/ai/evaluations", { params: { query } }),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (!isCurrent()) return;
    if (r.error || caps.error) {
      setError("Evaluation runs unavailable.");
      setLoading(false);
      return;
    }
    setRuns(r.data.runs);
    const page = caps.data as CapabilityPage;
    setCapabilityKeys(new Map(page.capabilities.map((c) => [c.id, c.capabilityKey])));
    setLoading(false);
  }, [client, guard, capabilityId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <PageHead
          title="Evaluation runs"
          description="The evidence ledger: which evaluation run backs which lifecycle gate."
        >
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </select>
        </PageHead>
        {loading && runs.length === 0 ? (
          <LoadingState label="Loading evaluation runs…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : runs.length === 0 ? (
          <EmptyListState
            glyph="clipboard-check"
            title="No evaluation runs"
            description="No run has been recorded for these filters."
          />
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table wx-list-table-static">
              <caption className="wx-sr-only">Evaluation runs</caption>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Golden set</th>
                  <th scope="col">Metrics</th>
                  <th scope="col">MLflow</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link
                        className="wx-data-md"
                        to={`/admin/ai-platform/capabilities/${r.capabilityId}`}
                      >
                        {capabilityKeys.get(r.capabilityId) ?? r.capabilityId}
                      </Link>
                    </td>
                    <td>{cap(r.stage)}</td>
                    <td>
                      <StatusPill label={cap(r.status)} tone={evalTone(r.status)} />
                    </td>
                    <td className="wx-nums">{formatDate(r.startedAt)}</td>
                    <td className="wx-nums">
                      {duration(r.startedAt ?? null, r.completedAt ?? null)}
                    </td>
                    <td className="wx-data-md">{r.datasetVersionRef}</td>
                    <td className="text-xs">{summarizeMetrics(r.summaryMetrics)}</td>
                    <td className="wx-data-md">{r.mlflowRunId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
