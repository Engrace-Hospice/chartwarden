import {
  EmptyState,
  Glyph,
  GuardChip,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the PER-CLAIM VALIDATION WORKLIST (R2, §5.1 #5 scoped to
// one claim, + the #6 override modal). A run selector over GET /api/v1/medicaid-claims/{id}/validation-runs,
// the selected run's per-rule results from GET /api/v1/medicaid-validation-runs/{id}, and an Override
// affordance on each FAILED rule. Regulatory-required rules (from the tenant rule overlay, read best-effort)
// carry a shield glyph and an error-toned GuardChip in the modal — those overrides are reported on survey.
// The override POST is §4.7 role-eligibility + §D12 step-up + §8.6 AI-actor-reject gated SERVER-side; a
// 401/403/422 surfaces inline (role="alert"), never a toast. Lantern: WorkQueueLayout + No-Line table.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { VALIDATION_OUTCOME_TONE, humanize, shortId, toneOf } from "./medicaid-status";
import {
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  iconButtonStyle,
  linkStyle,
  modalTitleStyle,
  mutedStyle,
  primaryButtonStyle,
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
}

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
  const [regulatory, setRegulatory] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<ValidationResult | null>(null);

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
      setRegulatory(new Map(items.map((r) => [r.ruleKey, r.regulatoryRequired])));
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
    return [...(detail?.results ?? [])].sort(
      (a, b) => (order[a.outcome] ?? 9) - (order[b.outcome] ?? 9),
    );
  }, [detail]);

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

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Validation Worklist"
            breadcrumb="Billing — Medicaid · claim validation"
            actions={
              <a href={`/medicaid/billing/claims/${claimId}`} style={linkStyle}>
                ← Back to claim
              </a>
            }
          />
        }
        filters={
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={mutedStyle}>Validation run</span>
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
          </label>
        }
        table={
          !detail ? (
            <LoadingSpinner />
          ) : sorted.length === 0 ? (
            <EmptyState title="No results" description="This run produced no per-rule results." />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Rule</th>
                  <th style={th}>Outcome</th>
                  <th style={th}>Remediation</th>
                  <th style={{ ...th, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const failed = r.outcome === "fail";
                  const regReq = regulatory.get(r.ruleKey) === true;
                  const href = fixActionHref(r.remediationFixAction);
                  return (
                    <tr key={r.id} style={rowLine}>
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
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
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
                          <button
                            type="button"
                            onClick={() => setOverrideTarget(r)}
                            aria-label={`Override rule ${r.ruleKey}`}
                            style={ghostButtonStyle}
                          >
                            Override
                          </button>
                        ) : (
                          <span style={mutedStyle}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        }
      />
      {overrideTarget ? (
        <OverrideModal
          result={overrideTarget}
          regulatoryRequired={regulatory.get(overrideTarget.ruleKey)}
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
  onClose,
  onApplied,
}: {
  result: ValidationResult;
  regulatoryRequired: boolean | undefined;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState("");
  const [role, setRole] = useState<OverrideRole>("billing_manager");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = reason.trim().length < REASON_MIN;
  const remaining = REASON_MIN - reason.trim().length;
  const errorId = "m24-override-reason-error";

  const apply = useCallback(async () => {
    if (tooShort) return;
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
      setError(overrideErrorMessage(err?.error?.code, response?.status));
      return;
    }
    onApplied();
  }, [client, result, reason, role, tooShort, onApplied]);

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

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface)" }}>Acting role</span>
          <select
            aria-label="Override role"
            value={role}
            onChange={(e) => setRole(e.target.value as OverrideRole)}
            style={selectStyle}
          >
            {OVERRIDE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

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
          <button type="button" onClick={onClose} style={ghostButtonStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={tooShort || busy}
            aria-disabled={tooShort || busy}
            style={tooShort || busy ? disabledButtonStyle : primaryButtonStyle}
          >
            {busy ? "Applying…" : "Apply override"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Map the override error envelope (§4.7 / §D12) to a precise, PHI-free inline message. */
function overrideErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case "OVERRIDE_ROLE_NOT_ELIGIBLE":
      return "Your role is not eligible to override this rule.";
    case "RULE_REGULATORY_REQUIRED":
      return "This rule is regulatory-required and cannot be overridden.";
    case "STEP_UP_REQUIRED":
      return "Re-authentication (step-up) is required before applying an override.";
    default:
      if (status === 401 || status === 403)
        return "Re-authentication (step-up) or a higher role is required to override this rule.";
      if (status === 422) return "The rationale did not meet the minimum length — add more detail.";
      if (status === 409) return "This result is no longer failing — reopen the worklist to retry.";
      if (status === 503) return "The override service is unavailable — try again shortly.";
      return "The override could not be applied.";
  }
}
