// apps/admin/src/modules/36-messaging/settings — M36 §4.2 alert rules (`GET /api/v1/alert-rules`, alert.rules.read;
// `PATCH /api/v1/alert-rules/:id`, alert.rules.manage). Lists tenant + inherited platform rules; enable,
// severity floor and recipient resolver are editable. Edits are optimistic: the row changes at once and rolls
// back with a banner if the server refuses (e.g. SYSTEM_LOCKED when disabling a locked rule). A first edit of a
// platform default clones it server-side, so the row adopts the id the PATCH returns. Locked rules are read-only.
import { StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { type ApiResult, toResult, useLoad } from "./api";
import { type Banner, BannerView, PageHead, StateEmpty, renderLoadFallback } from "./ui";

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

const SELECT_CLASS = "min-h-11 rounded-lg border px-2 focus-visible:outline-2";

export function AlertRules(): JSX.Element {
  const client = useApiClient();
  const load = useCallback(async (): Promise<ApiResult<AlertRule[]>> => {
    const res = await client.GET("/api/v1/alert-rules");
    const result = toResult(res, "Alert rules unavailable.");
    return result.ok ? { ok: true, data: result.data.rules } : result;
  }, [client]);
  const { state, reload, setData } = useLoad(load);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [banner, setBanner] = useState<Banner | null>(null);

  const patchRule = async (
    rules: AlertRule[],
    rule: AlertRule,
    patch: RulePatch,
  ): Promise<void> => {
    const swap = (next: AlertRule): AlertRule[] =>
      rules.map((r) => (r.ruleId === rule.ruleId ? next : r));
    setData(swap({ ...rule, ...patch }));
    setPending((p) => new Set(p).add(rule.ruleId));
    setBanner(null);
    const res = await client.PATCH("/api/v1/alert-rules/{id}", {
      params: { path: { id: rule.ruleId } },
      body: patch,
    });
    const result = toResult(res, "Could not update the rule.");
    setPending((p) => {
      const next = new Set(p);
      next.delete(rule.ruleId);
      return next;
    });
    if (result.ok) {
      setData(swap(result.data));
      setBanner({ ok: true, message: `Updated ${humanize(rule.eventType)}.` });
    } else {
      setData(rules);
      setBanner({ ok: false, message: `${result.message} The change was undone.` });
    }
  };

  const fallback = renderLoadFallback(state, {
    loadingLabel: "Loading alert rules…",
    what: "alert rules",
    onRetry: reload,
  });
  return (
    <div className="wx-list-drawer-main">
      <PageHead
        title="Alert rules"
        sub="Which events raise alerts, how severe, and who is notified."
      />
      <BannerView banner={banner} />
      {fallback ??
        (state.status === "ready" && state.data.length === 0 ? (
          <StateEmpty>No alert rules are configured.</StateEmpty>
        ) : state.status === "ready" ? (
          <RulesTable
            rules={state.data}
            pending={pending}
            onPatch={(rule, patch) => void patchRule(state.data, rule, patch)}
          />
        ) : null)}
    </div>
  );
}

function RulesTable({
  rules,
  pending,
  onPatch,
}: {
  rules: AlertRule[];
  pending: ReadonlySet<string>;
  onPatch: (rule: AlertRule, patch: RulePatch) => void;
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
          {rules.map((rule) => {
            const name = humanize(rule.eventType);
            const readOnly = rule.systemLocked || pending.has(rule.ruleId);
            return (
              <tr key={rule.ruleId} aria-busy={pending.has(rule.ruleId) || undefined}>
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
                      disabled={readOnly}
                      aria-label={`${name} enabled`}
                      onChange={(e) => onPatch(rule, { enabled: e.target.checked })}
                    />
                    <span>{rule.enabled ? "On" : "Off"}</span>
                  </label>
                </td>
                <td>
                  <select
                    className={SELECT_CLASS}
                    aria-label={`${name} severity floor`}
                    value={rule.severityFloor}
                    disabled={readOnly}
                    onChange={(e) =>
                      onPatch(rule, {
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
                    disabled={readOnly}
                    onChange={(e) =>
                      onPatch(rule, {
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
