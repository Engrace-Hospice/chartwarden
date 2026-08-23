import {
  AdminSplitLayout,
  Button,
  EmptyState,
  FilterBar,
  Glyph,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the RULE-CONFIG OVERLAY editor (R2,
// §5.1 admin / §4.1 #18-21). The tenant validation-rule overlay library: the platform §11.A registry
// snapshot + the tenant overlays, presented as a selectable rule list (left rail) over a per-rule editor
// (matrix). A `regulatoryRequiredSnapshot` rule is REGULATORY-LOCKED (D5) — it shows a non-toggleable
// GuardChip and its disable / delete affordances are inert; the server is the authoritative enforcer (the
// §4.7 `regulatory_required_rule_protected` predicate → 403). Non-regulatory overlays may be toggled,
// re-severitied, re-parameterized (PATCH), reverted to the platform default (DELETE), or a tenant CUSTOM
// rule may be added (POST .../custom). Every mutation carries the §2.5 If-Match version + an Idempotency-Key
// (§4.1.1); a 412 surfaces inline ("reopen to retry"), a 403 as "regulatory-protected", a 503 as a seam
// notice — never a toast. Lantern: AdminSplitLayout, No-Line rail, §6.6 StatusPills via billing-status.ts,
// CSS-var tokens only. openapi emits no schemas for billing, so reads are cast and the mutation paths are
// driven through `as never` inits (the server stays the authoritative parser).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { statusLabel, validationSeverityTone } from "./billing-status";

type Severity = "error" | "warn" | "info";
const SEVERITIES: Severity[] = ["error", "warn", "info"];

interface RuleConfigView {
  ruleConfigId: string;
  ruleKey: string;
  ruleVersion: number;
  isCustom: boolean;
  enabled: boolean;
  severity: Severity;
  overrideRoleRequired: string | null;
  parameters: Record<string, unknown>;
  regulatoryRequiredSnapshot: boolean;
  predicateDsl: unknown;
  setReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RuleConfigPage {
  items: RuleConfigView[];
  nextCursor: string | null;
  hasMore: boolean;
}

// A fresh idempotency key per mutation (§4.1.1 presence guard; the M1 middleware does the 24h replay cache).
function idemKey(): string {
  return crypto.randomUUID();
}

function mutationError(status: number | undefined): string {
  if (status === 412) return "This rule changed since you opened it — reopen to retry.";
  if (status === 403) return "This rule is regulatory-required and cannot be changed.";
  if (status === 422) return "The overlay was rejected — review the rule parameters.";
  if (status === 503) return "Billing write seam unavailable — try again shortly.";
  return "The change could not be saved.";
}

export function RuleConfigEditor(): JSX.Element {
  const client = useApiClient();
  const [rules, setRules] = useState<RuleConfigView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"" | Severity>("");
  const [stateFilter, setStateFilter] = useState<"" | "enabled" | "disabled" | "locked" | "custom">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/billing/rule-configs", {
      params: { query: { limit: 200 } },
    } as never);
    if (err) {
      setError(
        "Rule-config library unavailable — the billing read seam is not bound, or you lack scope.",
      );
      setLoading(false);
      return;
    }
    const items = ((data as unknown as RuleConfigPage)?.items ?? []) as RuleConfigView[];
    setRules(items);
    setSelectedId((cur) => cur ?? items[0]?.ruleConfigId ?? null);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = rules.find((r) => r.ruleConfigId === selectedId) ?? null;
  const filteredRules = rules.filter((rule) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      rule.ruleKey.toLowerCase().includes(q) ||
      rule.ruleConfigId.toLowerCase().includes(q) ||
      (rule.setReason ?? "").toLowerCase().includes(q);
    const matchesSeverity = !severityFilter || rule.severity === severityFilter;
    const matchesState =
      !stateFilter ||
      (stateFilter === "enabled" && rule.enabled) ||
      (stateFilter === "disabled" && !rule.enabled) ||
      (stateFilter === "locked" && rule.regulatoryRequiredSnapshot) ||
      (stateFilter === "custom" && rule.isCustom);
    return matchesSearch && matchesSeverity && matchesState;
  });
  const activeFilterCount = [searchQuery, severityFilter, stateFilter].filter(Boolean).length;

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <AdminSplitLayout
      header={
        <PageHeader
          title="Validation Rule Config"
          breadcrumb="Billing / Medicare / Overlay library"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <a href="/billing" style={ghostButtonStyle}>
                AR dashboard
              </a>
              <button type="button" onClick={() => setAdding(true)} style={primaryButtonStyle}>
                Add custom rule
              </button>
            </div>
          }
        >
          <div style={{ color: t.onSurfaceVariant, fontSize: "0.875rem" }}>
            Manage tenant validation overlays while regulatory-required rules stay locked server-side.
          </div>
        </PageHeader>
      }
      list={
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <FilterBar
            activeFilterCount={activeFilterCount}
            onClear={() => {
              setSearchQuery("");
              setSeverityFilter("");
              setStateFilter("");
            }}
            actions={
              <span style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem" }}>
                {filteredRules.length} of {rules.length}
              </span>
            }
          >
            <div style={{ position: "relative", minWidth: "13rem" }}>
              <input
                type="search"
                aria-label="Search validation rules"
                placeholder="Search rules..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                style={{ ...inputStyle, width: "100%", height: "2.25rem", paddingLeft: "2rem" }}
              />
              <div style={inputIconStyle}>
                <Glyph name="search" size={14} />
              </div>
            </div>
            <select
              aria-label="Filter by severity"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value as "" | Severity)}
              style={{ ...selectStyle, height: "2.25rem" }}
            >
              <option value="">Severity: All</option>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {statusLabel(severity)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by rule status"
              value={stateFilter}
              onChange={(event) =>
                setStateFilter(event.target.value as "" | "enabled" | "disabled" | "locked" | "custom")
              }
              style={{ ...selectStyle, height: "2.25rem" }}
            >
              <option value="">Status: All</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
              <option value="locked">Locked</option>
              <option value="custom">Custom</option>
            </select>
          </FilterBar>
          <RuleRail rules={filteredRules} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      }
    >
      {adding ? (
        <AddCustomRule
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : selected ? (
        <RuleDetail key={selected.ruleConfigId} rule={selected} onChanged={() => void load()} />
      ) : (
        <EmptyState
          title="No rule selected"
          description="Pick a rule from the library to edit its overlay."
        />
      )}
    </AdminSplitLayout>
  );
}

// ── selectable rule rail (No-Line; regulatory rules carry a lock chip) ────────────────────────────────
function RuleRail({
  rules,
  selectedId,
  onSelect,
}: {
  rules: RuleConfigView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  if (rules.length === 0)
    return (
      <div style={{ padding: "1rem" }}>
        <EmptyState title="No rules" description="No validation rules match the current filters." />
      </div>
    );
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, overflow: "auto" }}>
      {rules.map((r) => {
        const active = r.ruleConfigId === selectedId;
        return (
          <li key={r.ruleConfigId}>
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(r.ruleConfigId)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.3rem",
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                border: "none",
                background: active ? t.primaryTint : "transparent",
                padding: "0.7rem 0.9rem",
                borderBottom: ghostBorder,
                transition: "background 0.15s ease",
              }}
              className="wx-data-row-interactive"
            >
              <span
                style={{
                  fontFamily: t.fontMono,
                  fontSize: "0.78rem",
                  color: t.onSurface,
                  overflowWrap: "anywhere",
                }}
              >
                {r.ruleKey}
              </span>
              <span
                style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", alignItems: "center" }}
              >
                <StatusPill
                  label={statusLabel(r.severity)}
                  tone={validationSeverityTone(r.severity)}
                />
                <StatusPill
                  label={r.enabled ? "Enabled" : "Disabled"}
                  tone={r.enabled ? "success" : "neutral"}
                />
                {r.isCustom ? <StatusPill label="Custom" tone="progress" /> : null}
                {r.regulatoryRequiredSnapshot ? (
                  <StatusPill label="Locked" tone="warning" glyph="lock" />
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── per-rule overlay editor (the matrix surface) ──────────────────────────────────────────────────────
function RuleDetail({
  rule,
  onChanged,
}: { rule: RuleConfigView; onChanged: () => void }): JSX.Element {
  const client = useApiClient();
  const [severity, setSeverity] = useState<Severity>(rule.severity);
  const [enabled, setEnabled] = useState<boolean>(rule.enabled);
  const [params, setParams] = useState<string>(JSON.stringify(rule.parameters ?? {}, null, 2));
  const [setReason, setSetReason] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const locked = rule.regulatoryRequiredSnapshot;

  const save = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    let parsedParams: Record<string, unknown> | undefined;
    if (params.trim().length > 0) {
      try {
        parsedParams = JSON.parse(params) as Record<string, unknown>;
      } catch {
        setActionError("Parameters must be valid JSON.");
        setBusy(false);
        return;
      }
    }
    const init = {
      params: {
        path: { id: rule.ruleConfigId },
        header: { "If-Match": String(rule.version), "Idempotency-Key": idemKey() },
      },
      body: {
        enabled,
        severity,
        parameters: parsedParams,
        ...(setReason.trim().length >= 20 ? { setReason: setReason.trim() } : {}),
      },
    };
    const { error: err, response } = (await client.PATCH(
      "/api/v1/billing/rule-configs/{id}",
      init as never,
    )) as { error?: unknown; response?: Response };
    if (err) {
      setActionError(mutationError(response?.status));
      setBusy(false);
      return;
    }
    setBusy(false);
    onChanged();
  }, [client, rule.ruleConfigId, rule.version, enabled, severity, params, setReason, onChanged]);

  const revert = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const init = {
      params: {
        path: { id: rule.ruleConfigId },
        header: { "If-Match": String(rule.version), "Idempotency-Key": idemKey() },
      },
    };
    const { error: err, response } = (await client.DELETE(
      "/api/v1/billing/rule-configs/{id}",
      init as never,
    )) as { error?: unknown; response?: Response };
    if (err) {
      setActionError(mutationError(response?.status));
      setBusy(false);
      return;
    }
    setBusy(false);
    onChanged();
  }, [client, rule.ruleConfigId, rule.version, onChanged]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "40rem" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <h2
          style={{
            margin: 0,
            fontFamily: t.fontMono,
            fontSize: "1rem",
            color: t.onSurface,
            overflowWrap: "anywhere",
          }}
        >
          {rule.ruleKey}
        </h2>
        <span style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: t.onSurfaceVariant }}>
            v{rule.ruleVersion} · {rule.isCustom ? "tenant custom" : "platform overlay"}
          </span>
          {locked ? (
            <GuardChip reason="Regulatory-required — cannot be disabled, re-severitied, or deleted" />
          ) : null}
        </span>
      </header>

      <div style={fieldRow}>
        <label htmlFor="rc-enabled" style={labelStyle}>
          Enabled
        </label>
        <input
          id="rc-enabled"
          type="checkbox"
          checked={enabled}
          disabled={locked || busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </div>

      <div style={fieldCol}>
        <label htmlFor="rc-severity" style={labelStyle}>
          Severity
        </label>
        <select
          id="rc-severity"
          value={severity}
          disabled={locked || busy}
          onChange={(e) => setSeverity(e.target.value as Severity)}
          style={selectStyle}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </div>

      <div style={fieldCol}>
        <label htmlFor="rc-params" style={labelStyle}>
          Parameters (JSON)
        </label>
        <textarea
          id="rc-params"
          value={params}
          disabled={busy}
          onChange={(e) => setParams(e.target.value)}
          rows={6}
          spellCheck={false}
          style={{ ...inputStyle, fontFamily: t.fontMono, resize: "vertical" }}
        />
      </div>

      <div style={fieldCol}>
        <label htmlFor="rc-reason" style={labelStyle}>
          Change reason (≥ 20 chars, optional)
        </label>
        <input
          id="rc-reason"
          value={setReason}
          disabled={busy}
          placeholder="Why is this overlay changing…"
          onChange={(e) => setSetReason(e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <Button
          type="button"
          tone="primary"
          disabled={busy || locked}
          onClick={() => void save()}
        >
          Save overlay
        </Button>
        <Button
          type="button"
          tone="secondary"
          disabled={busy || locked}
          onClick={() => void revert()}
        >
          Revert to platform default
        </Button>
      </div>

      {actionError ? (
        <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: t.error }}>
          {actionError}
        </p>
      ) : null}
    </section>
  );
}

// ── add a tenant custom rule (regulatory-required forbidden server-side) ──────────────────────────────
function AddCustomRule({
  onCancel,
  onCreated,
}: { onCancel: () => void; onCreated: () => void }): JSX.Element {
  const client = useApiClient();
  const [ruleKey, setRuleKey] = useState("");
  const [severity, setSeverity] = useState<Severity>("warn");
  const [params, setParams] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    if (ruleKey.trim().length === 0) {
      setActionError("A rule key is required.");
      setBusy(false);
      return;
    }
    let parsedParams: Record<string, unknown> | undefined;
    if (params.trim().length > 0) {
      try {
        parsedParams = JSON.parse(params) as Record<string, unknown>;
      } catch {
        setActionError("Parameters must be valid JSON.");
        setBusy(false);
        return;
      }
    }
    const init = {
      params: { header: { "Idempotency-Key": idemKey() } },
      body: { ruleKey: ruleKey.trim(), severity, parameters: parsedParams },
    };
    const { error: err, response } = (await client.POST(
      "/api/v1/billing/rule-configs/custom",
      init as never,
    )) as { error?: unknown; response?: Response };
    if (err) {
      setActionError(
        response?.status === 422
          ? "Rejected — a regulatory-required key cannot be created as a custom rule."
          : response?.status === 503
            ? "Billing write seam unavailable — try again shortly."
            : "The custom rule could not be created.",
      );
      setBusy(false);
      return;
    }
    setBusy(false);
    onCreated();
  }, [client, ruleKey, severity, params, onCreated]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "40rem" }}>
      <h2 style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.25rem", color: t.onSurface }}>
        Add custom validation rule
      </h2>
      <div style={fieldCol}>
        <label htmlFor="ac-key" style={labelStyle}>
          Rule key
        </label>
        <input
          id="ac-key"
          value={ruleKey}
          onChange={(e) => setRuleKey(e.target.value)}
          placeholder="e.g. tenant.claim.line_count_ceiling"
          style={{ ...inputStyle, fontFamily: t.fontMono }}
        />
      </div>
      <div style={fieldCol}>
        <label htmlFor="ac-severity" style={labelStyle}>
          Severity
        </label>
        <select
          id="ac-severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as Severity)}
          style={selectStyle}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div style={fieldCol}>
        <label htmlFor="ac-params" style={labelStyle}>
          Parameters (JSON)
        </label>
        <textarea
          id="ac-params"
          value={params}
          onChange={(e) => setParams(e.target.value)}
          rows={5}
          spellCheck={false}
          style={{ ...inputStyle, fontFamily: t.fontMono, resize: "vertical" }}
        />
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void create()}
          style={busy ? disabledButtonStyle : primaryButtonStyle}
        >
          Create rule
        </button>
        <button type="button" disabled={busy} onClick={onCancel} style={ghostButtonStyle}>
          Cancel
        </button>
      </div>
      {actionError ? (
        <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: t.error }}>
          {actionError}
        </p>
      ) : null}
    </section>
  );
}

const fieldRow = { display: "flex", alignItems: "center", gap: "0.6rem" };
const fieldCol = { display: "flex", flexDirection: "column" as const, gap: "0.3rem" };
const labelStyle = { fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant };
const selectStyle = {
  padding: "0.4rem 0.5rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
  maxWidth: "16rem",
};
const inputStyle = {
  padding: "0.5rem 0.6rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
};
const inputIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: t.onSurfaceVariant,
  pointerEvents: "none" as const,
};
const primaryButtonStyle = {
  padding: "0.45rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8rem",
  fontWeight: 600,
};
const ghostButtonStyle = {
  ...cardSurface,
  padding: "0.45rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.8rem",
  fontWeight: 600,
  boxShadow: "none",
};
const disabledButtonStyle = { ...ghostButtonStyle, cursor: "not-allowed", opacity: 0.5 };
