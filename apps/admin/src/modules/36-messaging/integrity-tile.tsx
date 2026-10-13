import { Button, StatusPill, type StatusTone, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/36-messaging — Integrity jobs (`/admin/messaging/integrity`): a status tile for the M36
// hash-verify / decrypt-integrity jobs, derived from `m36.*` audit rows (see integrity-status.ts).
import { useMemo } from "react";
import type { JSX } from "react";
import {
  type IntegrityHealth,
  type IntegritySource,
  auditIntegritySource,
  summariseIntegrity,
} from "./integrity-status";
import { renderLoadFallback, useLoad } from "./ui";

const HEALTH: Record<IntegrityHealth, { label: string; tone: StatusTone }> = {
  healthy: { label: "Healthy", tone: "success" },
  attention: { label: "Needs attention", tone: "critical" },
  "no-runs": { label: "No runs recorded", tone: "neutral" },
};

/** `source` is injectable for tests; production reads the audit trail through the typed client. */
export function IntegrityTile({ source }: { source?: IntegritySource }): JSX.Element {
  const client = useApiClient();
  const read = useMemo(() => source ?? auditIntegritySource(client), [source, client]);
  const { state, reload } = useLoad(read);
  const fallback = renderLoadFallback(state, {
    loading: "Loading integrity status…",
    error: "Could not load integrity job status.",
    noAccess: "integrity job status",
    retry: reload,
  });
  const summary = state.kind === "ok" ? summariseIntegrity(state.data) : null;

  return (
    <div className="wx-list-drawer-main">
      <header className="wx-page-head">
        <div>
          <h1>Integrity jobs</h1>
          <p>Latest hash-verification run and any integrity findings, from the audit trail.</p>
        </div>
        <div className="wx-list-toolbar-end">
          <Button tone="secondary" size="lg" onClick={reload}>
            Refresh
          </Button>
        </div>
      </header>
      {fallback ??
        (summary ? (
          <div className="wx-stat-grid" aria-label="Integrity job status">
            <div className="wx-stat-card">
              <div>
                <span className="wx-stat-label">Hash verification</span>
                <StatusPill
                  label={HEALTH[summary.health].label}
                  tone={HEALTH[summary.health].tone}
                />
                <span className="wx-row-sub wx-nums">
                  {summary.lastRunAt
                    ? `Last run ${new Date(summary.lastRunAt).toLocaleString()}`
                    : "The job has not recorded a run."}
                </span>
              </div>
            </div>
            <div className="wx-stat-card">
              <div>
                <span className="wx-stat-label">Open findings</span>
                <span className="wx-stat-value wx-nums">{summary.findings.length}</span>
                {summary.findings.map((f) => (
                  <span key={f.eventType} className="wx-row-sub">
                    {f.eventType} · {new Date(f.createdAt).toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null)}
    </div>
  );
}
