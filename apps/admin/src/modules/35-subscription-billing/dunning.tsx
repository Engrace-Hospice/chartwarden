import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Dunning (`/admin/dunning`, dunning.admin.read +
// dunning.admin.override). Subscriptions currently in an OPEN dunning stage over GET /api/admin/dunning
// (M35A-T03, the screen's only data source), filterable by stage. Per-subscription overrides — skip_stage /
// reset (dunning.admin.override, step-up + Idempotency-Key) — are applied one row at a time; there is no bulk.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { actionButtonStyle, bodyRow, cell, inputStyle, LoadMore, tableStyle, theadRow } from "./ui";
import { cap, dunningTone, DUNNING_STAGES, formatDate, idempotencyKey, isCriticalDunningStage, orgLabel } from "./status";

interface DunningRow {
  subscriptionId: string;
  organizationId: string;
  organizationName: string;
  planName: string;
  subscriptionStatus: string;
  stage: string;
  enteredAt: string;
  nextAttemptAt: string | null;
}

export function Dunning(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DunningRow[]>([]);
  const [stage, setStage] = useState<string>("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string> = {};
      if (stage) query.stage = stage;
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/dunning", { params: { query } });
      if (res.error) {
        setError("Dunning queue unavailable.");
        setLoading(false);
        return;
      }
      const page = res.data as unknown as { items: DunningRow[]; nextCursor: string | null; hasMore: boolean };
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLoading(false);
    },
    [client, stage],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const override = useCallback(
    async (subscriptionId: string, action: "skip_stage" | "reset") => {
      setBusyId(subscriptionId);
      setOutcome(null);
      const path = action === "skip_stage" ? "/api/admin/dunning/{subscriptionId}/skip_stage" : "/api/admin/dunning/{subscriptionId}/reset";
      const res = await client.POST(path, { params: { path: { subscriptionId } }, headers: { "Idempotency-Key": idempotencyKey() } });
      if (res.error) {
        const c = (res.error as { code?: string })?.code;
        setOutcome({ ok: false, message: c === "STEP_UP_REQUIRED" ? "Step-up required — re-verify and retry." : `Could not ${action.replace("_", " ")}.` });
      } else {
        setOutcome({ ok: true, message: action === "reset" ? "Dunning reset." : "Dunning stage skipped." });
        await load(null, false);
      }
      setBusyId(null);
    },
    [client, load],
  );

  return (
    <div style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <PageHeader
        title="Dunning"
        breadcrumb="Platform Ops"
        actions={
          <select value={stage} onChange={(e) => setStage(e.target.value)} style={inputStyle} aria-label="Filter by stage">
            <option value="">All stages</option>
            {DUNNING_STAGES.map((s) => (
              <option key={s} value={s}>{cap(s)}</option>
            ))}
          </select>
        }
      />
      {outcome ? (
        <div role="status" aria-live="polite">
          <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
        </div>
      ) : null}
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : rows.length === 0 ? (
        <EmptyState title="No subscriptions in dunning" description="Every subscription is current." />
      ) : (
        <>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Organization</th>
                <th style={cell}>Plan</th>
                <th style={cell}>Stage</th>
                <th style={cell}>Entered</th>
                <th style={cell}>Next attempt</th>
                <th style={cell} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.subscriptionId} style={bodyRow} {...(isCriticalDunningStage(r.stage) ? { role: "alert" } : {})}>
                  <td style={cell}>{orgLabel(r.organizationName, r.organizationId)}</td>
                  <td style={cell}>{r.planName}</td>
                  <td style={cell}><StatusPill label={cap(r.stage)} tone={dunningTone(r.stage)} /></td>
                  <td style={cell} className="tabular-nums">{formatDate(r.enteredAt)}</td>
                  <td style={cell} className="tabular-nums">{formatDate(r.nextAttemptAt)}</td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button type="button" onClick={() => void override(r.subscriptionId, "skip_stage")} disabled={busyId === r.subscriptionId} style={actionButtonStyle(false, busyId === r.subscriptionId)}>Skip stage</button>
                      <button type="button" onClick={() => void override(r.subscriptionId, "reset")} disabled={busyId === r.subscriptionId} style={actionButtonStyle(false, busyId === r.subscriptionId)}>Reset</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
        </>
      )}
    </div>
  );
}
