import { Button, StatusPill, useApiClient, useRequestGuard } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Dunning (`/admin/dunning`, dunning.admin.read +
// dunning.admin.override). Subscriptions currently in an OPEN dunning stage over GET /api/admin/dunning
// (M35A-T03, the screen's only data source), filterable by stage. Per-subscription overrides — skip_stage /
// reset (dunning.admin.override, step-up + Idempotency-Key) — are applied one row at a time; there is no bulk.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  DUNNING_STAGES,
  cap,
  dunningTone,
  formatDate,
  idempotencyKey,
  isCriticalDunningStage,
  orgLabel,
} from "./status";
import {
  LoadMore,
  type Outcome,
  OutcomeBanner,
  StateEmpty,
  StateError,
  StateLoading,
  failureOutcome,
} from "./ui";

type DunningPage =
  operations["getApiAdminDunning"]["responses"][200]["content"]["application/json"];
type DunningRow = DunningPage["items"][number];

export function Dunning(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DunningRow[]>([]);
  const [stage, setStage] = useState<string>("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const isCurrent = guard();
      setLoading(true);
      setError(null);
      const query: Record<string, string> = {};
      if (stage) query.stage = stage;
      if (nextCursor) query.cursor = nextCursor;
      const res = await client.GET("/api/admin/dunning", { params: { query } });
      if (!isCurrent()) return;
      if (res.error) {
        setError("Dunning queue unavailable.");
        setLoading(false);
        return;
      }
      const page = res.data;
      setRows((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setLoading(false);
    },
    [client, stage, guard],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const override = useCallback(
    async (subscriptionId: string, action: "skip_stage" | "reset") => {
      setBusyId(subscriptionId);
      setOutcome(null);
      const path =
        action === "skip_stage"
          ? "/api/admin/dunning/{subscriptionId}/skip_stage"
          : "/api/admin/dunning/{subscriptionId}/reset";
      const res = await client.POST(path, {
        params: { path: { subscriptionId } },
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      if (res.error) {
        setOutcome(failureOutcome(res.error, `Could not ${action.replace("_", " ")}.`));
      } else {
        setOutcome({
          ok: true,
          message: action === "reset" ? "Dunning reset." : "Dunning stage skipped.",
        });
        await load(null, false);
      }
      setBusyId(null);
    },
    [client, load],
  );

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Dunning</h1>
            <p>
              Subscriptions in an open dunning stage. Overrides apply one subscription at a time.
            </p>
          </div>
          <div className="wx-list-toolbar-end">
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              aria-label="Filter by stage"
            >
              <option value="">All stages</option>
              {DUNNING_STAGES.map((s) => (
                <option key={s} value={s}>
                  {cap(s)}
                </option>
              ))}
            </select>
          </div>
        </header>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        {loading && rows.length === 0 ? (
          <StateLoading label="Loading dunning queue…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load(null, false)} />
        ) : rows.length === 0 ? (
          <StateEmpty>No subscriptions in dunning. Every subscription is current.</StateEmpty>
        ) : (
          <>
            <DunningTable
              rows={rows}
              busyId={busyId}
              onOverride={(id, action) => void override(id, action)}
            />
            <LoadMore hasMore={hasMore} loading={loading} onMore={() => void load(cursor, true)} />
          </>
        )}
      </div>
    </div>
  );
}

function DunningTable({
  rows,
  busyId,
  onOverride,
}: {
  rows: readonly DunningRow[];
  busyId: string | null;
  onOverride: (subscriptionId: string, action: "skip_stage" | "reset") => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Subscriptions in dunning</caption>
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Stage</th>
            <th scope="col">Entered</th>
            <th scope="col">Next attempt</th>
            <th scope="col">
              <span className="wx-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.subscriptionId}
              {...(isCriticalDunningStage(r.stage) ? { role: "alert" } : {})}
            >
              <td>
                <span className="wx-row-title">
                  {orgLabel(r.organizationName, r.organizationId)}
                </span>
                <span className="wx-row-sub">{r.planName}</span>
              </td>
              <td>
                <StatusPill label={cap(r.stage)} tone={dunningTone(r.stage)} />
              </td>
              <td className="wx-nums">{formatDate(r.enteredAt)}</td>
              <td className="wx-nums">{formatDate(r.nextAttemptAt)}</td>
              <td>
                <div className="flex justify-end gap-2">
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => onOverride(r.subscriptionId, "skip_stage")}
                    disabled={busyId === r.subscriptionId}
                  >
                    Skip stage
                  </Button>
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => onOverride(r.subscriptionId, "reset")}
                    disabled={busyId === r.subscriptionId}
                  >
                    Reset
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
