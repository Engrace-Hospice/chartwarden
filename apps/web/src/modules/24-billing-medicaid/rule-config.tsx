import {
  Button,
  EmptyState,
  Glyph,
  GuardChip,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
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

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MedicaidRuleConfig(): JSX.Element {
  const client = useApiClient();
  const [rules, setRules] = useState<RuleConfig[]>([]);
  const [show, setShow] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
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
    const base = (() => {
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
    })();
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r) =>
      [
        r.ruleKey,
        r.customSeverity ?? "",
        r.customOverrideRole ?? "",
        r.platformDefault?.title ?? "",
        r.platformDefault?.category ?? "",
        r.platformDefault?.severity ?? "",
        ...(r.platformDefault?.applicableStates ?? []),
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }, [rules, searchQuery, show]);

  const enabledCount = rules.filter((r) => r.enabled).length;
  const disabledCount = rules.length - enabledCount;
  const regulatoryCount = rules.filter((r) => r.regulatoryRequired).length;
  const customCount = rules.filter((r) => r.isCustom).length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRules = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || show !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Validation Rules"
          breadcrumb="Billing — Medicaid · per-tenant rule overlay"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review the active validation floor, tenant overrides, regulatory locks, and audited
            toggles.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Rules"
            value={loading || error ? "—" : rules.length}
            detail="Total loaded"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Enabled"
            value={loading || error ? "—" : enabledCount}
            detail="Run on claims"
            tone="success"
            accentColor="var(--color-success)"
            selected={show === "enabled"}
            onSelect={() => {
              setShow("enabled");
              setPage(1);
            }}
          />
          <KpiCard
            label="Disabled"
            value={loading || error ? "—" : disabledCount}
            detail="Tenant suppressed"
            tone={disabledCount > 0 ? "warning" : "neutral"}
            accentColor={
              disabledCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            selected={show === "disabled"}
            onSelect={() => {
              setShow("disabled");
              setPage(1);
            }}
          />
          <KpiCard
            label="Regulatory"
            value={loading || error ? "—" : regulatoryCount}
            detail="Locked floor"
            tone="warning"
            accentColor="var(--color-warning)"
            selected={show === "regulatory"}
            onSelect={() => {
              setShow("regulatory");
              setPage(1);
            }}
          />
          <KpiCard
            label="Custom"
            value={loading || error ? "—" : customCount}
            detail="Tenant-authored"
            tone={customCount > 0 ? "info" : "neutral"}
            accentColor={customCount > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"}
            selected={show === "custom"}
            onSelect={() => {
              setShow("custom");
              setPage(1);
            }}
          />
        </KpiStrip>
      }
      filters={
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "0 1.5rem 0.75rem",
          }}
        >
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <FilterRow>
            <div style={{ position: "relative", minWidth: "16rem" }}>
              <input
                type="search"
                placeholder="Search rule, category, state, or role..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search validation rules"
                style={{
                  width: "100%",
                  paddingLeft: "2rem",
                  height: "2.25rem",
                  fontSize: "0.85rem",
                }}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <SelectFilter
              label="Show"
              value={show}
              options={SHOW_OPTIONS}
              onChange={(next) => {
                setShow(next);
                setPage(1);
              }}
            />
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setShow("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filtered.length} of {rules.length} rule{rules.length === 1 ? "" : "s"} ·{" "}
              {regulatoryCount} regulatory-required
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
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No rules"
              description={
                hasActiveFilters
                  ? "No validation rule matches these filters."
                  : "No validation rules are available."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setShow("");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...th, width: "18%" }}>Rule</th>
                  <th style={{ ...th, width: "24%" }}>Title</th>
                  <th style={th}>Category</th>
                  <th style={th}>Severity</th>
                  <th style={th}>Override role</th>
                  <th style={th}>States</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pagedRules.map((r) => {
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
                          <Button
                            type="button"
                            size="sm"
                            tone="secondary"
                            onClick={() => void toggle(r)}
                            disabled={pending}
                            aria-label={`${r.enabled ? "Disable" : "Enable"} rule ${r.ruleKey}`}
                          >
                            {pending ? "Saving..." : r.enabled ? "Disable" : "Enable"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="rules"
            />
          </div>
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

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
