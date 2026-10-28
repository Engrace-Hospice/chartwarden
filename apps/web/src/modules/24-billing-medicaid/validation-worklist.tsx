import {
  Button,
  EmptyState,
  FilterBar,
  Glyph,
  GuardChip,
  LoadingSpinner,
  Modal,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
// apps/web/src/modules/24-billing-medicaid — M24, the PER-CLAIM VALIDATION WORKLIST (R2, §5.1 #5 scoped to
// one claim, + the #6 override modal). A run selector over GET /api/v1/medicaid-claims/{id}/validation-runs,
// the selected run's per-rule results from GET /api/v1/medicaid-validation-runs/{id}, and an Override
// affordance on each FAILED rule. Regulatory-required rules (from the tenant rule overlay, read best-effort)
// carry a shield glyph and an error-toned GuardChip in the modal — those overrides are reported on survey.
// The override POST is §4.7 role-eligibility + §D12 step-up + §8.6 AI-actor-reject gated SERVER-side; a
// 401/403/422 surfaces inline (role="alert"), never a toast. Lantern: WorkQueueLayout + No-Line table.
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import { VALIDATION_OUTCOME_TONE, humanize, shortId, toneOf } from "./medicaid-status";
import {
  Field,
  SummaryGrid,
  alertStyle,
  iconButtonStyle,
  linkStyle,
  modalTitleStyle,
  mutedStyle,
  rowLine,
  selectStyle,
  tableStyle,
  td,
  tdMono,
  textareaStyle,
  th,
} from "./medicaid-ui";

type OverrideRole = "billing_manager" | "compliance_officer" | "medical_director" | "org_admin";

const OVERRIDE_ROLES: { value: OverrideRole; label: string }[] = [
  { value: "billing_manager", label: "Billing Manager" },
  { value: "compliance_officer", label: "Compliance Officer" },
  { value: "medical_director", label: "Medical Director" },
  { value: "org_admin", label: "Org Admin" },
];

const REASON_MIN = 40;

interface ValidationResult {
  id: string;
  medicaidValidationRunId: string;
  ruleKey: string;
  ruleVersion: number;
  outcome: string;
  remediationSummary: string | null;
  remediationFixAction: string | null;
  at: string;
}

interface ValidationRun {
  id: string;
  medicaidClaimId: string;
  ruleRegistryVersion: string;
  triggeredBy: string;
  claimStateAtTrigger: string;
  at: string;
  completedAt: string | null;
  totalResults: number;
  failedResults: number;
  warnedResults: number;
  results?: ValidationResult[];
}

interface RuleConfig {
  ruleKey: string;
  regulatoryRequired: boolean;
  /** The role the server requires for an override; null = not overridable. Absent on an older API. */
  overrideRoleRequired?: OverrideRole | null;
}

const roleLabel = (role: OverrideRole): string =>
  OVERRIDE_ROLES.find((r) => r.value === role)?.label ?? role;

/** Map the structured remediation fixAction → the human label of its deep-link CTA (§4.5). */
function fixActionLabel(action: string | null): string {
  switch (action) {
    case "edit_in_m6":
      return "Edit in Admission";
    case "cosign_in_m8":
      return "Cosign encounter";
    case "resolve_in_m18":
      return "Resolve EVV visit";
    case "refresh_eligibility":
      return "Refresh eligibility";
    case "review_rb_days":
      return "Review R&B days";
    default:
      return "Open";
  }
}

/** The in-app destination for a remediation action (PHI-free; the target module owns the fix). */
function fixActionHref(action: string | null): string | null {
  switch (action) {
    case "refresh_eligibility":
      return "/medicaid/billing/eligibility";
    case "review_rb_days":
      return "/medicaid/billing/rb-arrangements";
    case "resolve_in_m18":
      return "/evv/exceptions";
    default:
      return null;
  }
}

export function MedicaidValidationWorklist(): JSX.Element {
  const client = useApiClient();
  const { claimId } = useParams<{ claimId: string }>();
  const [runs, setRuns] = useState<ValidationRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ValidationRun | null>(null);
  const [ruleConfigs, setRuleConfigs] = useState<Map<string, RuleConfig>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<ValidationResult | null>(null);
  const [ruleFilter, setRuleFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");

  const loadRuns = useCallback(async () => {
    if (!claimId) return;
    setLoading(true);
    setError(null);
    const [runRes, ruleRes] = await Promise.all([
      client.GET("/api/v1/medicaid-claims/{id}/validation-runs", {
        params: { path: { id: claimId } },
      }),
      client.GET("/api/v1/medicaid-rule-config", {}),
    ]);
    if (runRes.error) {
      setError(
        "The validation history is unavailable — you may lack billing visibility for this claim.",
      );
      setLoading(false);
      return;
    }
    const list = (runRes.data as unknown as ValidationRun[]) ?? [];
    setRuns(list);
    setActiveRunId((prev) => prev ?? list[0]?.id ?? null);
    // Best-effort: a biller may hold validation.read_run without rule_config.read — then the GuardChip
    // falls back to the generic "overriding is audited" message rather than the regulatory escalation.
    if (!ruleRes.error) {
      const items = (ruleRes.data as unknown as RuleConfig[]) ?? [];
      setRuleConfigs(new Map(items.map((r) => [r.ruleKey, r])));
    }
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const loadDetail = useCallback(async () => {
    if (!activeRunId) {
      setDetail(null);
      return;
    }
    const { data, error: err } = await client.GET("/api/v1/medicaid-validation-runs/{id}", {
      params: { path: { id: activeRunId } },
    });
    setDetail(err ? null : (data as unknown as ValidationRun));
  }, [client, activeRunId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const sorted = useMemo(() => {
    const order: Record<string, number> = {
      fail: 0,
      warn: 1,
      info: 2,
      pass: 3,
      skip_not_applicable: 4,
    };
    const q = ruleFilter.trim().toLowerCase();
    return [...(detail?.results ?? [])]
      .filter((result) => {
        const matchesOutcome = outcomeFilter === "" || result.outcome === outcomeFilter;
        const matchesRule = q.length === 0 || result.ruleKey.toLowerCase().includes(q);
        return matchesOutcome && matchesRule;
      })
      .sort((a, b) => (order[a.outcome] ?? 9) - (order[b.outcome] ?? 9));
  }, [detail, ruleFilter, outcomeFilter]);

  if (!claimId) return <EmptyState title="No claim" description="No claim was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (runs.length === 0)
    return (
      <EmptyState
        title="No validation runs"
        description="This claim has not been validated yet. Run validation from the claim editor to produce a run."
      />
    );

  const active = runs.find((r) => r.id === activeRunId) ?? null;
  const activeFilterCount = (ruleFilter.trim() ? 1 : 0) + (outcomeFilter ? 1 : 0);

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Validation Worklist"
            actions={
              <>
                <a href="/medicaid/billing/claims" style={linkButtonStyle}>
                  Claim workbench
                </a>
                <a href={`/medicaid/billing/claims/${claimId}`} style={primaryLinkButtonStyle}>
                  Open claim
                </a>
              </>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review per-rule validation results and apply audited overrides when permitted.
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <MedicaidBillingTabs />
            </div>
          </PageHeader>
        }
        filters={
          <FilterBar
            activeFilterCount={activeFilterCount}
            onClear={
              activeFilterCount > 0
                ? () => {
                    setRuleFilter("");
                    setOutcomeFilter("");
                  }
                : undefined
            }
          >
            <select
              aria-label="Validation run"
              value={activeRunId ?? ""}
              onChange={(e) => setActiveRunId(e.target.value)}
              style={selectStyle}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.failedResults} failed / {r.warnedResults} warn · registry{" "}
                  {r.ruleRegistryVersion} · {r.at.slice(0, 16).replace("T", " ")}
                </option>
              ))}
            </select>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                aria-label="Filter by rule key"
                value={ruleFilter}
                onChange={(event) => setRuleFilter(event.target.value)}
                placeholder="Search rule key..."
              />
            </label>
            <label className="wx-filter-field">
              <span>Outcome</span>
              <select
                className="wx-select"
                aria-label="Filter by outcome"
                value={outcomeFilter}
                onChange={(event) => setOutcomeFilter(event.target.value)}
                style={selectStyle}
              >
                <option value="">All</option>
                <option value="fail">Fail</option>
                <option value="warn">Warn</option>
                <option value="info">Info</option>
                <option value="pass">Pass</option>
                <option value="skip_not_applicable">Skip not applicable</option>
              </select>
            </label>
            {active ? (
              <StatusPill
                label={
                  active.failedResults > 0
                    ? "Failing"
                    : active.warnedResults > 0
                      ? "Warnings"
                      : "Clean"
                }
                tone={
                  active.failedResults > 0
                    ? "error"
                    : active.warnedResults > 0
                      ? "warning"
                      : "success"
                }
              />
            ) : null}
          </FilterBar>
        }
        table={
          !detail ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : sorted.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No results"
                description={
                  activeFilterCount > 0
                    ? "No validation results match the current filters."
                    : "This run produced no per-rule results."
                }
                action={
                  activeFilterCount > 0 ? (
                    <Button
                      size="sm"
                      tone="secondary"
                      onClick={() => {
                        setRuleFilter("");
                        setOutcomeFilter("");
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <table style={{ ...tableStyle, fontSize: "0.875rem" }}>
                <thead>
                  <tr style={headRowStyle}>
                    <th style={th}>Rule</th>
                    <th style={th}>Outcome</th>
                    <th style={th}>Remediation</th>
                    <th style={{ ...th, textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const failed = r.outcome === "fail";
                    const regReq = ruleConfigs.get(r.ruleKey)?.regulatoryRequired === true;
                    const href = fixActionHref(r.remediationFixAction);
                    return (
                      <tr key={r.id} style={enhancedRowLine}>
                        <td style={tdMono}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            {r.ruleKey}
                            <span style={mutedStyle}>v{r.ruleVersion}</span>
                            {regReq ? (
                              <span title="Regulatory-required rule">
                                <Glyph name="shield" size={13} label="regulatory-required" />
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td style={td}>
                          <StatusPill
                            label={humanize(r.outcome)}
                            tone={toneOf(VALIDATION_OUTCOME_TONE, r.outcome)}
                          />
                        </td>
                        <td style={{ ...td, maxWidth: "26rem" }}>
                          {r.remediationSummary ? (
                            <div
                              style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
                            >
                              <span>{r.remediationSummary}</span>
                              {href ? (
                                <a href={href} style={linkStyle}>
                                  {fixActionLabel(r.remediationFixAction)} →
                                </a>
                              ) : null}
                            </div>
                          ) : (
                            <span style={mutedStyle}>—</span>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>
                          {failed ? (
                            <Button
                              size="sm"
                              tone="secondary"
                              onClick={() => setOverrideTarget(r)}
                              aria-label={`Override rule ${r.ruleKey}`}
                            >
                              Override
                            </Button>
                          ) : (
                            <span style={mutedStyle}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
        detail={
          active ? (
            <RightDetailPanel title="Run Summary" hideScrollbar>
              <RunSummary run={active} resultCount={detail?.results?.length ?? 0} />
            </RightDetailPanel>
          ) : null
        }
        fullPageScroll
      />
      {overrideTarget ? (
        <OverrideModal
          result={overrideTarget}
          regulatoryRequired={ruleConfigs.get(overrideTarget.ruleKey)?.regulatoryRequired}
          requiredRole={ruleConfigs.get(overrideTarget.ruleKey)?.overrideRoleRequired}
          onClose={() => setOverrideTarget(null)}
          onApplied={() => {
            setOverrideTarget(null);
            void loadDetail();
            void loadRuns();
          }}
        />
      ) : null}
    </>
  );
}

// ── override modal (§5.1 #6) — ≥40-char rationale + claimed role; GuardChip surfaces regulatory posture ──
function OverrideModal({
  result,
  regulatoryRequired,
  requiredRole,
  onClose,
  onApplied,
}: {
  result: ValidationResult;
  regulatoryRequired: boolean | undefined;
  /** undefined = unknown (rule config unreadable): fall back to a free pick, the server still enforces. */
  requiredRole: OverrideRole | null | undefined;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState("");
  const [pickedRole, setPickedRole] = useState<OverrideRole>("billing_manager");
  const role = requiredRole ?? pickedRole;
  const notOverridable = requiredRole === null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = reason.trim().length < REASON_MIN;
  const remaining = REASON_MIN - reason.trim().length;
  const errorId = "m24-override-reason-error";

  const apply = useCallback(async () => {
    if (tooShort || notOverridable) return;
    setBusy(true);
    setError(null);
    const { error: err, response } = (await client.POST(
      "/api/v1/medicaid-validation-results/{id}/override",
      {
        params: { path: { id: result.id } },
        body: { reason: reason.trim(), overrideRoleClaimed: role },
      } as never,
    )) as { error?: { error?: { code?: string } }; response?: Response };
    setBusy(false);
    if (err) {
      setError(overrideErrorMessage(err?.error?.code, response?.status, requiredRole));
      return;
    }
    onApplied();
  }, [client, result, reason, role, tooShort, notOverridable, requiredRole, onApplied]);

  return (
    <Modal open onClose={onClose} ariaLabel="Override validation rule" width="34rem">
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={modalTitleStyle}>Override validation rule</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={iconButtonStyle}>
            <Glyph name="close" size={16} label="" />
          </button>
        </div>

        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          Rule{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-on-surface)" }}>
            {result.ruleKey}
          </span>{" "}
          (v{result.ruleVersion}) · run {shortId(result.medicaidValidationRunId)}
        </p>

        {regulatoryRequired === true ? (
          <GuardChip
            tone="error"
            reason="Regulatory-required rule — overriding is recorded to the M4 audit trail and reported on survey."
          />
        ) : (
          <GuardChip
            tone="warning"
            reason="Overriding a failed validation rule is recorded to the M4 audit trail."
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface)" }}>Acting role</span>
          {requiredRole !== undefined ? (
            <span data-testid="override-acting-role" style={fixedRoleStyle}>
              {requiredRole ? roleLabel(requiredRole) : "None — this rule cannot be overridden"}
            </span>
          ) : (
            <select
              aria-label="Override role"
              value={pickedRole}
              onChange={(e) => setPickedRole(e.target.value as OverrideRole)}
              style={selectStyle}
            >
              {OVERRIDE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface)" }}>
            Override rationale (≥ {REASON_MIN} characters)
          </span>
          <textarea
            aria-label="Override rationale"
            aria-describedby={tooShort ? errorId : undefined}
            aria-invalid={tooShort}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            style={textareaStyle}
          />
          {tooShort ? (
            <span id={errorId} style={{ fontSize: "0.75rem", color: "var(--color-error)" }}>
              {remaining} more character{remaining === 1 ? "" : "s"} required.
            </span>
          ) : null}
        </label>

        {error ? (
          <p role="alert" style={alertStyle}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void apply()}
            disabled={tooShort || notOverridable || busy}
            loading={busy}
          >
            {busy ? "Applying…" : "Apply override"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RunSummary({
  run,
  resultCount,
}: { run: ValidationRun; resultCount: number }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <StatusPill
        label={run.failedResults > 0 ? "Failing" : run.warnedResults > 0 ? "Warnings" : "Clean"}
        tone={run.failedResults > 0 ? "error" : run.warnedResults > 0 ? "warning" : "success"}
      />
      <SummaryGrid>
        <Field label="Registry" value={run.ruleRegistryVersion} mono />
        <Field label="Triggered by" value={humanize(run.triggeredBy)} />
        <Field label="Claim state" value={humanize(run.claimStateAtTrigger)} />
        <Field label="Results loaded" value={resultCount.toLocaleString()} />
        <Field label="Failed" value={run.failedResults.toLocaleString()} />
        <Field label="Warnings" value={run.warnedResults.toLocaleString()} />
        <Field label="Started" value={run.at.slice(0, 16).replace("T", " ")} />
        <Field
          label="Completed"
          value={run.completedAt ? run.completedAt.slice(0, 16).replace("T", " ") : "Pending"}
        />
      </SummaryGrid>
      <p style={{ ...mutedStyle, margin: 0 }}>
        Regulatory-required rules show a shield and may require higher authority or be
        non-overridable.
      </p>
    </div>
  );
}

const inputStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
} as const;
const headRowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const enhancedRowLine = {
  ...rowLine,
  borderTop: "none",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const fixedRoleStyle = {
  padding: "0.4rem 0.6rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const linkButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
};
const primaryLinkButtonStyle = {
  ...linkButtonStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
};

/** Map the override error envelope (§4.7 / §D12) to a precise, PHI-free inline message. */
function overrideErrorMessage(
  code: string | undefined,
  status: number | undefined,
  requiredRole: OverrideRole | null | undefined,
): string {
  switch (code) {
    case "OVERRIDE_ROLE_NOT_ELIGIBLE":
      return "Your role is not eligible to override this rule.";
    case "RULE_REGULATORY_REQUIRED":
      return "This rule is regulatory-required and cannot be overridden.";
    case "STEP_UP_REQUIRED":
      return "Re-authentication (step-up) is required before applying an override.";
    default:
      if (status === 403 && requiredRole)
        return `This rule can only be overridden by a ${roleLabel(requiredRole)}, and your account may not hold that role.`;
      if (status === 401 || status === 403)
        return "Re-authentication (step-up) or a higher role is required to override this rule.";
      if (status === 422) return "The rationale did not meet the minimum length — add more detail.";
      if (status === 409) return "This result is no longer failing — reopen the worklist to retry.";
      if (status === 503) return "The override service is unavailable — try again shortly.";
      return "The override could not be applied.";
  }
}
