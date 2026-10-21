// apps/admin/src/modules/36-messaging/settings — M36 §4.2 alert rules (`GET /api/v1/alert-rules`, alert.rules.read;
// `PATCH /api/v1/alert-rules/:id`, alert.rules.manage). Lists tenant + inherited platform rules; enable,
// severity floor and recipient resolver are editable. Edits are optimistic: the row changes at once and rolls
// back with a banner if the server refuses (e.g. SYSTEM_LOCKED when disabling a locked rule). A first edit of a
// platform default clones it server-side, so the row adopts the id the PATCH returns. Locked rules are read-only.
// Rows carry a stable client `key` so adopting a new ruleId neither remounts the row (focus) nor mis-targets a
// concurrent edit; every state change is a functional update touching only the edited row.
import { StatusPill, useApiClient } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { type ReadResult, StateEmpty, renderLoadFallback, useLoad } from "../ui";
import { asRead, toResult } from "./api";
import { type Banner, BannerView, PageHead } from "./ui";

export type AlertRule =
  operations["getApiV1Alertrules"]["responses"][200]["content"]["application/json"]["rules"][number];
type RulePatch = Partial<Pick<AlertRule, "enabled" | "severityFloor" | "recipientResolver">>;

const SEVERITIES: readonly AlertRule["severityFloor"][] = ["info", "warn", "critical"];
const RESOLVERS: readonly AlertRule["recipientResolver"][] = [
  "care_team",
  "on_call",
  "discipline",
  "role_set",
  "tenant_admins",
  "user_list",
  "broadcast",
];

/** "clinical_urgent" -> "Clinical urgent". */
export const humanize = (value: string): string => {
  const text = value.replace(/[_.]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** A rule plus the stable key it keeps even when a clone changes its server id. */
interface RuleRow {
  readonly key: string;
  readonly rule: AlertRule;
}

const SELECT_CLASS = "min-h-11 rounded-lg border px-2 focus-visible:outline-2";

export function AlertRules(): JSX.Element {
  const client = useApiClient();
  const load = useCallback(async (): Promise<ReadResult<RuleRow[]>> => {
    const res = await client.GET("/api/v1/alert-rules");
    const result = toResult(res, "Alert rules unavailable.");
    return asRead(
      result.ok
        ? { ok: true, data: result.data.rules.map((rule) => ({ key: rule.ruleId, rule })) }
        : result,
    );
  }, [client]);
  const { state, reload, setData } = useLoad(load);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [banner, setBanner] = useState<Banner | null>(null);

  const patchRule = async ({ key, rule }: RuleRow, patch: RulePatch): Promise<void> => {
    const put = (next: AlertRule): void =>
      setData((rows) => rows.map((r) => (r.key === key ? { key, rule: next } : r)));
    put({ ...rule, ...patch });
    setPending((p) => new Set(p).add(key));
    if (pending.size === 0) setBanner(null);
    const res = await client.PATCH("/api/v1/alert-rules/{id}", {
      params: { path: { id: rule.ruleId } },
      body: patch,
    });
    const result = toResult(res, "Could not update the rule.");
    setPending((p) => {
      const next = new Set(p);
      next.delete(key);
      return next;
    });
    if (result.ok) {
      put(result.data);
      setBanner((b) =>
        b && !b.ok ? b : { ok: true, message: `Updated ${humanize(rule.eventType)}.` },
      );
    } else {
      put(rule);
      setBanner({ ok: false, message: `${result.message} The change was undone.` });
    }
  };

  const fallback = renderLoadFallback(state, {
    loading: "Loading alert rules…",
    error: "Alert rules unavailable.",
    noAccess: "alert rules",
    retry: reload,
  });
  return (
    <div className="wx-list-drawer-main">
      <PageHead
        title="Alert rules"
        sub="Which events raise alerts, how severe, and who is notified."
      />
      <BannerView banner={banner} />
      {fallback ??
        (state.kind === "ok" && state.data.length === 0 ? (
          <StateEmpty>No alert rules are configured.</StateEmpty>
        ) : state.kind === "ok" ? (
          <RulesTable
            rows={state.data}
            pending={pending}
            onPatch={(row, patch) => void patchRule(row, patch)}
          />
        ) : null)}
    </div>
  );
}

function RulesTable({
  rows,
  pending,
  onPatch,
}: {
  rows: readonly RuleRow[];
  pending: ReadonlySet<string>;
  onPatch: (row: RuleRow, patch: RulePatch) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Alert rules</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Enabled</th>
            <th scope="col">Severity floor</th>
            <th scope="col">Recipients</th>
            <th scope="col">Scope</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { rule } = row;
            const name = humanize(rule.eventType);
            // A pending row is aria-disabled, not disabled: a disabled control drops keyboard focus.
            const busy = pending.has(row.key);
            const patchRow = (patch: RulePatch): void => {
              if (!busy) onPatch(row, patch);
            };
            return (
              <tr key={row.key} aria-busy={busy || undefined}>
                <td>
                  <span className="wx-row-title">{name}</span>
                  <span className="wx-row-sub">{humanize(rule.category)}</span>
                </td>
                <td>
                  <label className="inline-flex min-h-11 min-w-11 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-5 focus-visible:outline-2"
                      checked={rule.enabled}
                      disabled={rule.systemLocked}
                      aria-disabled={busy || undefined}
                      aria-label={`${name} enabled`}
                      onChange={(e) => patchRow({ enabled: e.target.checked })}
                    />
                    <span>{rule.enabled ? "On" : "Off"}</span>
                  </label>
                </td>
                <td>
                  <select
                    className={SELECT_CLASS}
                    aria-label={`${name} severity floor`}
                    value={rule.severityFloor}
                    disabled={rule.systemLocked}
                    aria-disabled={busy || undefined}
                    onChange={(e) =>
                      patchRow({
                        severityFloor: e.target.value as AlertRule["severityFloor"],
                      })
                    }
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className={SELECT_CLASS}
                    aria-label={`${name} recipients`}
                    value={rule.recipientResolver}
                    disabled={rule.systemLocked}
                    aria-disabled={busy || undefined}
                    onChange={(e) =>
                      patchRow({
                        recipientResolver: e.target.value as AlertRule["recipientResolver"],
                      })
                    }
                  >
                    {RESOLVERS.map((r) => (
                      <option key={r} value={r}>
                        {humanize(r)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {rule.systemLocked ? (
                    <StatusPill tone="warning" label="Locked" />
                  ) : (
                    <StatusPill
                      tone="neutral"
                      label={rule.organizationId === null ? "Platform default" : "Custom"}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
