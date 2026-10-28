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
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the CLAIM VALIDATION WORKLIST (R2,
// §5.1 #5 + #6 override modal). The §11.A worklist: a role="table" of the selected run's per-rule results,
// each with a §6.6 severity StatusPill, a PHI-free remediation hint that deep-links into the owning module's
// editor (Edit in M6 / Cosign in M8 / Refresh Eligibility), and an Override affordance per FAILED rule. The
// override modal captures a ≥40-char rationale (server CHECK-enforced) + the acting override role, and
// surfaces the rule's regulatory-required posture prominently via a GuardChip. A header "Re-run validation"
// action and a successful override BOTH trigger POST /claims/{id}/validate directly — recording an override
// alone never unblocks the claim, since only a fresh run reads `overriddenKeysForClaim` (TASK-021/FLOW-008).
// Backed by the existing routes:
//   GET  /api/v1/claims/{id}/validation-runs                                   → { claimId, runs[] }
//   GET  /api/v1/claims/{id}/validation-runs/{runId}                           → run + per-rule results
//   POST /api/v1/claims/{id}/validate                                          → manual_re_run (202)
//   POST /api/v1/claims/{id}/validation-runs/{runId}/results/{resultId}/override
//   GET  /api/v1/billing/rule-configs (best-effort)  → regulatory-required overlay per ruleKey
// The server is the only authz point (ADR-0030): a 503 (seam unbound) degrades the surface; the override is
// §4.7 override_role_eligible + §D14 step-up + §D13 AI-block gated server-side, so a STEP_UP_REQUIRED denial
// routes to the real /step-up screen (returning here — the in-progress reason/role survive via a
// process-memory draft cache, write-workflow.ts, never browser storage) and a 422 (reason too short) surfaces
// inline (role="alert"), never a toast. Lantern: WorkQueueLayout + No-Line role="table" (§6.7), mono ruleKey,
// CSS-var tokens only; tones via billing-status.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { statusLabel, validationRunTone, validationSeverityTone } from "./billing-status";
import { MissingDischargeDetailsPanel } from "./discharge-attention";
import { missingDischargeDetailOf, normalizeRemediation } from "./validation-remediation";
import { authFailureRedirect, clearDraft, loadDraft, saveDraft } from "./write-workflow";

type ValidationSeverity = "error" | "warn" | "info";
type ValidationResultOutcome = "pass" | "fail" | "warn" | "info";
type OverrideRole = "billing_manager" | "compliance_officer" | "medical_director" | "org_admin";

const OVERRIDE_ROLES: { value: OverrideRole; label: string }[] = [
  { value: "billing_manager", label: "Billing Manager" },
  { value: "compliance_officer", label: "Compliance Officer" },
  { value: "medical_director", label: "Medical Director" },
  { value: "org_admin", label: "Org Admin" },
];

const MIN_REASON_LENGTH = 40;

// TASK-021 — an override in progress survives a step-up round trip (this page → /step-up → back) via the
// write-workflow draft cache (process memory only; never browser storage — the rationale can carry PHI).
interface OverrideDraft {
  resultId: string;
  reason: string;
  overrideRole: OverrideRole;
}
const overrideDraftKey = (claimId: string): string => `claim-override:${claimId}`;

interface ValidationOverrideView {
  overrideId: string;
  reason: string;
  overrideRoleApplied: OverrideRole;
  appliedAt: string;
}

interface ValidationResultView {
  resultId: string;
  validationRunId: string;
  ruleKey: string;
  ruleVersion: number;
  severity: ValidationSeverity;
  outcome: ValidationResultOutcome;
  /** Raw stored jsonb — read through `normalizeRemediation` (two historic shapes). */
  remediation: unknown;
  overridden: boolean;
  override: ValidationOverrideView | null;
  recordedAt: string;
}

interface ValidationRunView {
  validationRunId: string;
  claimId: string;
  trigger: string;
  outcome: string;
  rulesExecuted: number;
  rulesPassed: number;
  rulesFailed: number;
  rulesWarn: number;
  rulesInfo: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface ValidationRunDetailView extends ValidationRunView {
  results: ValidationResultView[];
}

interface RunListResponse {
  claimId: string;
  runs: ValidationRunView[];
}

interface RuleConfigView {
  ruleKey: string;
  regulatoryRequiredSnapshot: boolean;
}

// Map the structured remediation fixAction → the human label of its deep-link CTA (§4.5).
function fixActionLabel(action: string | undefined): string {
  switch (action) {
    case "edit_in_m6":
      return "Edit in Admission";
    case "cosign_in_m8":
      return "Cosign encounter";
    case "refresh_eligibility":
      return "Refresh eligibility";
    case "fix_discharge_details":
      return "Fix discharge details";
    default:
      return "Fix";
  }
}

export function ValidationWorklist(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { claimId } = useParams<{ claimId: string }>();
  const [runs, setRuns] = useState<ValidationRunView[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ValidationRunDetailView | null>(null);
  const [regulatory, setRegulatory] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<ValidationResultView | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [revalidateError, setRevalidateError] = useState<string | null>(null);

  // Load the run list (anchor read) + a best-effort regulatory-required overlay from the rule library.
  const loadRuns = useCallback(async () => {
    if (!claimId) return;
    setLoading(true);
    setError(null);
    const [runRes, ruleRes] = await Promise.all([
      client.GET("/api/v1/claims/{id}/validation-runs", {
        params: { path: { id: claimId } },
      }),
      client.GET("/api/v1/billing/rule-configs"),
    ]);
    if (runRes.error) {
      setError(
        "Validation worklist unavailable — the billing read seam is not bound, or you lack scope.",
      );
      setLoading(false);
      return;
    }
    const list = (runRes.data as unknown as RunListResponse | undefined)?.runs ?? [];
    setRuns(list as ValidationRunView[]);
    setActiveRunId((prev) => prev ?? list[0]?.validationRunId ?? null);
    // Best-effort overlay: a worklist user may lack billing.rule_config.read — then the GuardChip falls back
    // to a generic "overriding is audited" message rather than the regulatory-required escalation.
    if (!ruleRes.error) {
      const items = ((ruleRes.data as unknown as { items?: RuleConfigView[] })?.items ??
        []) as RuleConfigView[];
      setRegulatory(new Map(items.map((r) => [r.ruleKey, r.regulatoryRequiredSnapshot])));
    }
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Load the active run's per-rule results whenever the selection changes.
  const loadDetail = useCallback(async () => {
    if (!claimId || !activeRunId) {
      setDetail(null);
      return;
    }
    const { data, error: err } = await client.GET("/api/v1/claims/{id}/validation-runs/{runId}", {
      params: { path: { id: claimId, runId: activeRunId } },
    });
    setDetail(err ? null : (data as unknown as ValidationRunDetailView));
  }, [client, claimId, activeRunId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // TASK-021 — "Re-run validation" had no UI at all; this is the one place a caller can manually trigger a
  // `manual_re_run` (the route requires no step-up, unlike override/submit/replace/void). Selects the new
  // run when the server returns one so the worklist reflects it immediately, rather than staying pinned to
  // the stale run.
  const revalidate = useCallback(async () => {
    if (!claimId) return;
    setRevalidating(true);
    setRevalidateError(null);
    const {
      data,
      error: err,
      response,
    } = (await client.POST("/api/v1/claims/{id}/validate", {
      params: { path: { id: claimId } },
    } as never)) as {
      data?: { validationRunId?: string };
      error?: { error?: { code?: string } };
      response?: Response;
    };
    setRevalidating(false);
    if (err) {
      const redirect = authFailureRedirect(
        response?.status,
        err?.error?.code,
        window.location.pathname,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      setRevalidateError("Re-validation could not be triggered — try again shortly.");
      return;
    }
    await loadRuns();
    if (data?.validationRunId) setActiveRunId(data.validationRunId);
  }, [client, claimId, navigate, loadRuns]);

  // A resumed override draft (step-up round trip) reopens the modal once the run detail it targets is back.
  useEffect(() => {
    if (!claimId || !detail || overrideTarget) return;
    const draft = loadDraft<OverrideDraft>(overrideDraftKey(claimId));
    if (!draft) return;
    const match = detail.results.find(
      (r) => r.resultId === draft.resultId && r.outcome === "fail" && !r.overridden,
    );
    if (match) setOverrideTarget(match);
  }, [claimId, detail, overrideTarget]);

  const sortedResults = useMemo(() => {
    const order: Record<ValidationResultOutcome, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
    return [...(detail?.results ?? [])].sort((a, b) => order[a.outcome] - order[b.outcome]);
  }, [detail]);

  // The run names a missing place of death / receiving care setting: show the guided fix above the table.
  const missingDetail = detail ? missingDischargeDetailOf(detail.results) : null;

  if (!claimId) return <EmptyState title="No claim" description="No claim was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (runs.length === 0)
    return (
      <EmptyState
        title="No validation runs"
        description="This claim has not been validated yet. Assemble or validate the claim to produce a run."
      />
    );

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Validation Worklist"
            actions={
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                  alignItems: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={() => void revalidate()}
                  disabled={revalidating}
                  style={revalidating ? disabledButtonStyle : primaryButtonStyle}
                >
                  {revalidating ? "Re-validating…" : "Re-run validation"}
                </button>
                {revalidateError ? (
                  <span role="alert" style={{ fontSize: "0.75rem", color: "var(--color-error)" }}>
                    {revalidateError}
                  </span>
                ) : null}
              </div>
            }
          />
        }
        filters={<RunSelector runs={runs} activeRunId={activeRunId} onSelect={setActiveRunId} />}
        table={
          detail ? (
            <div style={{ display: "grid", gap: "1rem" }}>
              {missingDetail ? (
                <MissingDischargeDetailsPanel
                  detail={missingDetail.detail}
                  admissionId={missingDetail.admissionId}
                  claimId={claimId}
                  fixPath={missingDetail.fixDeepLink}
                />
              ) : null}
              <ResultsTable
                results={sortedResults}
                regulatory={regulatory}
                onOverride={(r) => setOverrideTarget(r)}
              />
            </div>
          ) : (
            <LoadingSpinner />
          )
        }
        detail={undefined}
      />
      {overrideTarget ? (
        <OverrideModal
          claimId={claimId}
          result={overrideTarget}
          regulatoryRequired={regulatory.get(overrideTarget.ruleKey)}
          onClose={() => {
            clearDraft(overrideDraftKey(claimId));
            setOverrideTarget(null);
          }}
          onApplied={(newRunId) => {
            setOverrideTarget(null);
            if (newRunId) setActiveRunId(newRunId);
            else void loadDetail();
            void loadRuns();
          }}
        />
      ) : null}
    </>
  );
}

// ── run selector (most-recent-first) ──────────────────────────────────────────────────────────────────
function RunSelector({
  runs,
  activeRunId,
  onSelect,
}: {
  runs: ValidationRunView[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}): JSX.Element {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
        Validation run
      </span>
      <select
        aria-label="Validation run"
        value={activeRunId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        style={selectStyle}
      >
        {runs.map((r) => (
          <option key={r.validationRunId} value={r.validationRunId}>
            {statusLabel(r.outcome)} · {r.rulesFailed} failed / {r.rulesWarn} warn ·{" "}
            {new Date(r.completedAt).toLocaleString()}
          </option>
        ))}
      </select>
      {(() => {
        const active = runs.find((r) => r.validationRunId === activeRunId);
        return active ? (
          <StatusPill
            label={statusLabel(active.outcome)}
            tone={validationRunTone(active.outcome)}
          />
        ) : null;
      })()}
    </label>
  );
}

// ── per-rule results table (§5.4: role="table", keyboard-navigable, override aria-label includes ruleKey) ─
function ResultsTable({
  results,
  regulatory,
  onOverride,
}: {
  results: ValidationResultView[];
  regulatory: Map<string, boolean>;
  onOverride: (r: ValidationResultView) => void;
}): JSX.Element {
  if (results.length === 0)
    return <EmptyState title="No results" description="This run produced no per-rule results." />;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
          <th style={thStyle}>Rule</th>
          <th style={thStyle}>Severity</th>
          <th style={thStyle}>Outcome</th>
          <th style={thStyle}>Remediation</th>
          <th style={{ ...thStyle, textAlign: "right" }}>Action</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r, i) => {
          const failed = r.outcome === "fail";
          const regReq = regulatory.get(r.ruleKey) === true;
          return (
            <tr
              key={r.resultId}
              style={{ background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent" }}
            >
              <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {r.ruleKey}
                  {regReq ? (
                    <span title="Regulatory-required rule" aria-label="Regulatory-required rule">
                      <Glyph name="shield" size={13} label="regulatory-required" />
                    </span>
                  ) : null}
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={statusLabel(r.severity)}
                  tone={validationSeverityTone(r.severity)}
                />
              </td>
              <td style={tdStyle}>
                {r.overridden ? (
                  <StatusPill label="Overridden" tone="warning" />
                ) : (
                  <StatusPill label={statusLabel(r.outcome)} tone={outcomeTone(r.outcome)} />
                )}
              </td>
              <td style={{ ...tdStyle, maxWidth: "22rem" }}>
                <RemediationCell raw={r.remediation} />
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }}>
                {failed && !r.overridden ? (
                  <button
                    type="button"
                    onClick={() => onOverride(r)}
                    aria-label={`Override rule ${r.ruleKey}`}
                    style={ghostButtonStyle}
                  >
                    Override
                  </button>
                ) : r.overridden ? (
                  <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
                    {r.override ? statusLabel(r.override.overrideRoleApplied) : "Applied"}
                  </span>
                ) : (
                  <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── remediation cell — summary + a deep-link CTA into the owning module's editor ───────────────────────
function RemediationCell({ raw }: { raw: unknown }): JSX.Element {
  const remediation = normalizeRemediation(raw);
  if (!remediation?.summary)
    return <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ color: "var(--color-on-surface)" }}>{remediation.summary}</span>
      {remediation.fixDeepLink ? (
        <a
          href={remediation.fixDeepLink}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            fontSize: "0.78rem",
            color: "var(--color-primary)",
            textDecoration: "none",
          }}
        >
          {fixActionLabel(remediation.fixAction)}
          <Glyph name="arrow-right" size={12} label="" />
        </a>
      ) : null}
    </div>
  );
}

// ── override modal (§5.1 #6) — ≥40-char rationale + override role; GuardChip surfaces regulatory posture ─
function OverrideModal({
  claimId,
  result,
  regulatoryRequired,
  onClose,
  onApplied,
}: {
  claimId: string;
  result: ValidationResultView;
  regulatoryRequired: boolean | undefined;
  onClose: () => void;
  /** The re-run this override immediately triggers may return a new run id — the caller selects it. */
  onApplied: (newRunId?: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  // Resume a draft (step-up round trip) only if it targets THIS result — a stale draft for a different,
  // already-resolved result is never restored.
  const initialDraft = loadDraft<OverrideDraft>(overrideDraftKey(claimId));
  const resumable = initialDraft?.resultId === result.resultId ? initialDraft : undefined;
  const [reason, setReason] = useState(resumable?.reason ?? "");
  const [overrideRole, setOverrideRole] = useState<OverrideRole>(
    resumable?.overrideRole ?? "billing_manager",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;
  const remaining = MIN_REASON_LENGTH - reason.trim().length;

  // Keep the draft cache current so a step-up redirect below (or one from any other action) can resume it.
  useEffect(() => {
    saveDraft(overrideDraftKey(claimId), { resultId: result.resultId, reason, overrideRole });
  }, [claimId, result.resultId, reason, overrideRole]);

  const apply = useCallback(async () => {
    if (reasonTooShort) return;
    setBusy(true);
    setError(null);
    const { error: err, response } = (await client.POST(
      "/api/v1/claims/{id}/validation-runs/{runId}/results/{resultId}/override",
      {
        params: {
          path: { id: claimId, runId: result.validationRunId, resultId: result.resultId },
        },
        body: { reason: reason.trim(), overrideRole },
      } as never,
    )) as { error?: { error?: { code?: string } }; response?: Response };
    if (err) {
      const redirect = authFailureRedirect(
        response?.status,
        err?.error?.code,
        window.location.pathname,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      setError(overrideErrorMessage(err?.error?.code, response?.status));
      setBusy(false);
      return;
    }
    // §4.7/§2.5 — the override alone does not unblock the claim: `overriddenKeysForClaim` is read by the
    // NEXT validation run, so a re-run must follow immediately or the claim sits stuck forever (FLOW-008).
    const revalidated = (await client.POST("/api/v1/claims/{id}/validate", {
      params: { path: { id: claimId } },
    } as never)) as { data?: { validationRunId?: string } };
    clearDraft(overrideDraftKey(claimId));
    setBusy(false);
    onApplied(revalidated.data?.validationRunId);
  }, [client, claimId, result, reason, reasonTooShort, overrideRole, navigate, onApplied]);

  const errorId = "override-reason-error";

  return (
    <Modal open onClose={onClose} ariaLabel="Override validation rule" width="34rem">
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ ...modalTitleStyle, margin: 0 }}>Override validation rule</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={iconButtonStyle}>
            <Glyph name="close" size={16} label="" />
          </button>
        </div>

        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          Rule{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-on-surface)" }}>
            {result.ruleKey}
          </span>{" "}
          (v{result.ruleVersion}) ·{" "}
          <StatusPill
            label={statusLabel(result.severity)}
            tone={validationSeverityTone(result.severity)}
          />
        </p>

        {/* Regulatory posture surfaced prominently (§5.1 #6). regulatory-required → error-toned escalation;
            unknown / non-regulatory → a generic audited-action chip. */}
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
            value={overrideRole}
            onChange={(e) => setOverrideRole(e.target.value as OverrideRole)}
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
            Override rationale (≥ {MIN_REASON_LENGTH} characters)
          </span>
          <textarea
            aria-label="Override rationale"
            aria-describedby={reasonTooShort ? errorId : undefined}
            aria-invalid={reasonTooShort}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            style={textareaStyle}
          />
          {reasonTooShort ? (
            <span id={errorId} style={{ fontSize: "0.75rem", color: "var(--color-error)" }}>
              {remaining} more character{remaining === 1 ? "" : "s"} required.
            </span>
          ) : null}
        </label>

        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: "0.82rem", color: "var(--color-error)" }}>
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
            disabled={reasonTooShort || busy}
            aria-disabled={reasonTooShort || busy}
            style={reasonTooShort || busy ? disabledButtonStyle : primaryButtonStyle}
          >
            {busy ? "Applying…" : "Apply override"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function outcomeTone(
  outcome: ValidationResultOutcome,
): "success" | "error" | "warning" | "neutral" {
  switch (outcome) {
    case "pass":
      return "success";
    case "fail":
      return "error";
    case "warn":
      return "warning";
    default:
      return "neutral";
  }
}

// Map the override error envelope (§4.7 / §D14) to a precise, PHI-free inline message. A 401 or a
// STEP_UP_REQUIRED 403 never reaches here — `authFailureRedirect` routes those to /step-up first.
function overrideErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case "OVERRIDE_ROLE_NOT_ELIGIBLE":
      return "Your role is not eligible to override this rule.";
    default:
      if (status === 403) return "You do not have permission to override this rule.";
      if (status === 422) return "The rationale did not meet the minimum length — add more detail.";
      if (status === 412)
        return "This result changed since you opened it — reopen the worklist to retry.";
      if (status === 503) return "The override seam is unavailable — try again shortly.";
      return "The override could not be applied.";
  }
}

const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
};
const tdStyle = {
  padding: "0.5rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "top" as const,
};
const selectStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const textareaStyle = {
  padding: "0.5rem 0.6rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  resize: "vertical" as const,
  fontFamily: "inherit",
};
const primaryButtonStyle = {
  padding: "0.45rem 0.95rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.82rem",
  fontWeight: 600,
};
const ghostButtonStyle = {
  padding: "0.45rem 0.95rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.82rem",
  fontWeight: 600,
  textDecoration: "none",
};
const disabledButtonStyle = { ...ghostButtonStyle, cursor: "not-allowed", opacity: 0.5 };
const iconButtonStyle = {
  padding: "0.25rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  display: "flex",
};
const modalTitleStyle = {
  fontFamily: "var(--font-display)",
  fontSize: "1.1rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
