import {
  EmptyState,
  Glyph,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the VALIDATION RULE CONFIG (R2, §5.1 #14). The compliance
// officer's per-tenant overlay on the platform rule floor: each rule's enabled state, severity, override
// role, and the applicable states from the platform default. A REGULATORY-REQUIRED rule shows a lock glyph
// and cannot be disabled — the toggle is not rendered for it, and the server rejects the write regardless
// (the client is a courtesy, not the enforcement point; ADR-0030). Backed by GET /api/v1/medicaid-rule-config
// + PATCH /api/v1/medicaid-rule-config/{ruleKey}. Custom-rule authoring (the §11 predicate DSL) is a
// deliberate follow-up — the surface links to it rather than shipping a half DSL editor. Lantern:
// WorkQueueLayout + No-Line table (§6.7) + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { humanize } from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./medicaid-ui";

interface RuleConfig {
  ruleKey: string;
  enabled: boolean;
  isCustom: boolean;
  customSeverity: string | null;
  customOverrideRole: string | null;
  regulatoryRequired: boolean;
  version: number | null;
  platformDefault?: {
    title: string;
    category: string;
    severity: string;
    regulatoryRequired: boolean;
    applicableStates: readonly string[];
  };
}

const SHOW_OPTIONS = [
  { value: "", label: "All rules" },
  { value: "enabled", label: "Enabled only" },
  { value: "disabled", label: "Disabled only" },
  { value: "regulatory", label: "Regulatory-required" },
  { value: "custom", label: "Tenant custom" },
];

export function MedicaidRuleConfig(): JSX.Element {
  const client = useApiClient();
  const [rules, setRules] = useState<RuleConfig[]>([]);
  const [show, setShow] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/medicaid-rule-config", {});
    if (res.error) {
      setError(
        "The rule overlay is unavailable — you may lack compliance access for this organization.",
      );
      setLoading(false);
      return;
    }
    setRules((res.data as unknown as RuleConfig[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (rule: RuleConfig) => {
      if (rule.regulatoryRequired) return;
      setPendingKey(rule.ruleKey);
      setActionError(null);
      const { error: err, response } = (await client.PATCH(
        "/api/v1/medicaid-rule-config/{ruleKey}",
        {
          params: {
            path: { ruleKey: rule.ruleKey },
            header: rule.version == null ? {} : { "If-Match": String(rule.version) },
          },
          body: { enabled: !rule.enabled },
        } as never,
      )) as { error?: unknown; response?: Response };
      setPendingKey(null);
      if (err) {
        setActionError(configErrorMessage(response?.status));
        return;
      }
      void load();
    },
    [client, load],
  );

  const filtered = useMemo(() => {
    switch (show) {
      case "enabled":
        return rules.filter((r) => r.enabled);
      case "disabled":
        return rules.filter((r) => !r.enabled);
      case "regulatory":
        return rules.filter((r) => r.regulatoryRequired);
      case "custom":
        return rules.filter((r) => r.isCustom);
      default:
        return rules;
    }
  }, [rules, show]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const regulatoryCount = rules.filter((r) => r.regulatoryRequired).length;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Validation Rules"
          breadcrumb="Billing — Medicaid · per-tenant rule overlay"
        />
      }
      filters={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <FilterRow>
            <SelectFilter label="Show" value={show} options={SHOW_OPTIONS} onChange={setShow} />
            <span style={mutedStyle}>
              {rules.length} rule{rules.length === 1 ? "" : "s"} · {regulatoryCount}{" "}
              regulatory-required
            </span>
          </FilterRow>
          <GuardChip
            tone="warning"
            reason="Disabling a rule changes what every future claim is validated against — the change is audited."
          />
          {actionError ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
              {actionError}
            </p>
          ) : null}
        </div>
      }
      table={
        filtered.length === 0 ? (
          <EmptyState title="No rules" description="No validation rule matches this filter." />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Rule</th>
                <th style={th}>Title</th>
                <th style={th}>Category</th>
                <th style={th}>Severity</th>
                <th style={th}>Override role</th>
                <th style={th}>States</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const severity = r.customSeverity ?? r.platformDefault?.severity ?? "—";
                const states = r.platformDefault?.applicableStates ?? [];
                const pending = pendingKey === r.ruleKey;
                return (
                  <tr key={r.ruleKey} style={rowLine}>
                    <td style={tdMono}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        {r.ruleKey}
                        {r.regulatoryRequired ? (
                          <span title="Regulatory-required — cannot be disabled">
                            <Glyph name="lock" size={13} label="regulatory-required" />
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td style={td}>
                      {r.platformDefault?.title ?? (r.isCustom ? "Tenant custom rule" : "—")}
                    </td>
                    <td style={td}>{humanize(r.platformDefault?.category ?? null)}</td>
                    <td style={td}>{humanize(severity)}</td>
                    <td style={td}>{humanize(r.customOverrideRole)}</td>
                    <td style={td}>
                      {states.length === 0 ? (
                        <span style={mutedStyle}>All states</span>
                      ) : (
                        states.join(", ")
                      )}
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={r.enabled ? "Enabled" : "Disabled"}
                        tone={r.enabled ? "success" : "neutral"}
                      />
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {r.regulatoryRequired ? (
                        <span style={mutedStyle}>Locked</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void toggle(r)}
                          disabled={pending}
                          aria-label={`${r.enabled ? "Disable" : "Enable"} rule ${r.ruleKey}`}
                          style={pending ? disabledButtonStyle : ghostButtonStyle}
                        >
                          {pending ? "Saving…" : r.enabled ? "Disable" : "Enable"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
      detail={
        <span style={mutedStyle}>
          Rule parameters and custom predicate authoring are edited through the compliance API —
          this surface governs which rules run.
        </span>
      }
    />
  );
}

/** Map a rule-overlay write status code to a precise inline message (§5.4). */
function configErrorMessage(status: number | undefined): string {
  if (status === 409) return "This rule is regulatory-required and cannot be disabled.";
  if (status === 412) return "The rule overlay changed since you loaded it — reload and retry.";
  if (status === 401 || status === 403) return "You lack permission to edit the rule overlay.";
  return "The rule could not be updated.";
}
