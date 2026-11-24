import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
  useAttemptKey,
} from "@chartwarden/ui";
import type { paths } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import {
  decisionLabel,
  formatCents,
  formatObservedAt,
  parseMedicaidEraSummary,
  reasonExplanation,
  workflowLabel,
} from "./medicaid-era-presentation";
import type { PresentedAdjustment, PresentedClaimObservation } from "./medicaid-era-presentation";
import "./medicaid-era-reviews.css";

type ReviewPage =
  paths["/api/v1/remittance/medicaid-era-reviews"]["get"]["responses"][200]["content"]["application/json"];
type ReviewRow = ReviewPage["items"][number];
type ReviewDetail =
  paths["/api/v1/remittance/medicaid-era-reviews/{id}"]["get"]["responses"][200]["content"]["application/json"];
type HistoryPage =
  paths["/api/v1/remittance/medicaid-era-reviews/{id}/history"]["get"]["responses"][200]["content"]["application/json"];
type HistoryItem = HistoryPage["items"][number];
type EvaluateResult =
  paths["/api/v1/remittance/medicaid-era-reviews/{id}/reassess"]["post"]["responses"][200]["content"]["application/json"];
type DispositionBody = NonNullable<
  paths["/api/v1/remittance/medicaid-era-reviews/{id}/disposition"]["post"]["requestBody"]
>["content"]["application/json"];
type WorkflowState = DispositionBody["state"];

interface CachedWorklist {
  items: ReviewRow[];
  nextCursor: string | null;
}

// In-memory only: this preserves the operator's loaded page while navigating to a detail route.
// It contains no financial summary, patient identity, or browser-persistent data.
const worklistCache = new Map<string, CachedWorklist>();
let lastScopeKey = "";

const WORKFLOW_TONE: Readonly<Record<string, "neutral" | "progress" | "warning" | "success">> = {
  needs_review: "warning",
  investigating: "progress",
  follow_up_required: "warning",
  reviewed_not_posted: "neutral",
  reopened: "warning",
};

const NOTE_REASONS = [
  ["SOURCE_CONTEXT_REVIEWED", "Source context reviewed"],
  ["MATCH_EVIDENCE_REVIEWED", "Claim match evidence reviewed"],
  ["FOLLOW_UP_REQUESTED", "Follow-up requested"],
  ["ADDITIONAL_REVIEW_REQUIRED", "Additional review required"],
  ["INTERNAL_REVIEW_COMPLETE", "Internal review completed"],
] as const;

const DISPOSITION_ACTIONS: readonly {
  state: WorkflowState;
  label: string;
  reasonCode: string;
}[] = [
  { state: "investigating", label: "Start investigation", reasonCode: "INVESTIGATION_STARTED" },
  { state: "follow_up_required", label: "Request follow-up", reasonCode: "FOLLOW_UP_REQUESTED" },
  {
    state: "reviewed_not_posted",
    label: "Complete review — no posting",
    reasonCode: "INTERNAL_REVIEW_COMPLETE",
  },
  { state: "reopened", label: "Reopen investigation", reasonCode: "INVESTIGATION_REOPENED" },
];

function contextKey(session: ReturnType<typeof useSession>): string {
  if (!session) return "anonymous";
  return [
    session.organizationId,
    session.userId,
    [...(session.providerEntityIds ?? [])].sort().join(","),
    [...(session.permissions ?? [])].sort().join(","),
  ].join("|");
}

function vendorLabel(vendor: string): string {
  return vendor === "claimmd" ? "Claim.MD" : "Source vendor unavailable";
}

function environmentLabel(environment: string | null): string {
  if (environment === "test") return "Test environment";
  if (environment === "production") return "Production environment";
  return "Environment unknown";
}

function decisionTone(status: string): "warning" | "progress" | "neutral" {
  if (status === "payment_reported") return "progress";
  if (status === "unverified") return "neutral";
  return "warning";
}

function resultMessage(result: EvaluateResult): {
  kind: "success" | "held" | "unavailable";
  text: string;
} {
  if (result.status === "review_saved")
    return {
      kind: "success",
      text: result.replay
        ? "The existing nonposting assessment is current."
        : "A nonposting assessment was saved for investigation.",
    };
  return {
    kind: result.status,
    text:
      result.status === "held"
        ? reasonExplanation(result.reasonCode)
        : `The evaluator is unavailable: ${reasonExplanation(result.reasonCode)}`,
  };
}

function displayError(status: number | undefined, fallback: string): string {
  if (status === 401) return "Your session expired. Sign in again to continue.";
  if (status === 403) return "You do not have permission to view or change this review.";
  if (status === 404) return "This review is no longer available in your authorized scope.";
  if (status === 409)
    return "This review changed while you were working. Reload it and review the current state.";
  if (status === 503) return "The review service is temporarily unavailable. Try again shortly.";
  return fallback;
}

function Header({
  title,
  description,
  actions,
}: { title: string; description: string; actions?: ReactNode }): JSX.Element {
  return (
    <PageHeader title={title} actions={actions}>
      <p className="mer-page-description">{description}</p>
      <BillingTabs />
    </PageHeader>
  );
}

export function MedicaidEraReviews(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const scopeKey = contextKey(session);
  useEffect(() => {
    if (lastScopeKey && lastScopeKey !== scopeKey) worklistCache.clear();
    lastScopeKey = scopeKey;
  }, [scopeKey]);
  return id ? (
    <ReviewDetailScreen key={`${scopeKey}:${id}`} reviewId={id} />
  ) : (
    <ReviewListScreen key={scopeKey} scopeKey={scopeKey} />
  );
}

function ReviewListScreen({ scopeKey }: { scopeKey: string }): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const location = useLocation();
  const canRead = session?.permissions?.includes("remittance.read") ?? false;
  const cached = worklistCache.get(scopeKey);
  const [items, setItems] = useState<ReviewRow[]>(cached?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(cached?.nextCursor ?? null);
  const [loading, setLoading] = useState(!cached);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const hasRows = useRef(items.length > 0);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const request = ++sequence.current;
      if (append) setLoadingMore(true);
      else if (hasRows.current) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const response = await client.GET("/api/v1/remittance/medicaid-era-reviews", {
          params: { query: { limit: "50", ...(cursor ? { cursor } : {}) } },
        });
        if (request !== sequence.current) return;
        if (response.error || !response.data) {
          setError(
            displayError(
              response.response?.status,
              "The Medicaid ERA review worklist could not be loaded.",
            ),
          );
          return;
        }
        const updated = append
          ? [...(worklistCache.get(scopeKey)?.items ?? []), ...response.data.items]
          : response.data.items;
        setItems(updated);
        hasRows.current = updated.length > 0;
        setNextCursor(response.data.nextCursor);
        worklistCache.set(scopeKey, { items: updated, nextCursor: response.data.nextCursor });
      } catch {
        if (request === sequence.current)
          setError(
            "The Medicaid ERA review worklist could not reach the service. Check your connection and retry.",
          );
      } finally {
        if (request === sequence.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [client, scopeKey],
  );

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setError("Remittance read permission is required to view this worklist.");
      return;
    }
    void load(null, false);
    return () => {
      sequence.current += 1;
    };
  }, [canRead, load]);

  const header = (
    <Header
      title="Medicaid ERA reviews"
      description="Review Medicaid remittance observations, investigate exceptions, and track resolution without posting financial activity."
      actions={
        <Button
          size="sm"
          tone="secondary"
          onClick={() => void load(null, false)}
          disabled={loading || refreshing || !canRead}
        >
          <Glyph name="rotate-ccw" size={14} /> {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      }
    />
  );
  const notice = (
    <div className="mer-notice" role="note">
      <Glyph name="info" size={17} />
      <span>
        These are nonposting observations. Reviewing an ERA does not post payment, change a claim
        balance, or mark a claim paid.
      </span>
    </div>
  );

  let content: ReactNode;
  if (loading) {
    content = (
      <div className="mer-loading">
        <LoadingSpinner label="Loading Medicaid ERA reviews…" />
      </div>
    );
  } else if (error) {
    content = (
      <EmptyState
        title={canRead ? "Worklist unavailable" : "Access unavailable"}
        description={error}
        action={
          canRead ? (
            <Button size="sm" tone="secondary" onClick={() => void load(null, false)}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  } else if (items.length === 0) {
    content = (
      <EmptyState
        title="No Medicaid ERA reviews"
        description="No nonposting Medicaid assessments are available in this provider scope. New staged sources can be evaluated from the Claim.MD ERA review screen; an empty list does not confirm that no remittances exist."
        action={
          <Link className="mer-button-link" to="/remittance/claimmd-era-review">
            Open Claim.MD ERA review
          </Link>
        }
      />
    );
  } else {
    content = (
      <div className="mer-list-region">
        <div className="mer-list-summary" aria-live="polite">
          <span>
            {items.length} review{items.length === 1 ? "" : "s"} loaded
            {nextCursor ? " · more available" : ""}
          </span>
          {refreshing ? <output>Refreshing current results…</output> : null}
        </div>
        <ul className="mer-review-list" aria-label="Medicaid ERA assessments">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                className="mer-review-row"
                to={`/remittance/medicaid-era-reviews/${item.id}`}
                state={{ from: `${location.pathname}${location.search}` }}
                aria-label={`Open ${decisionLabel(item.decisionStatus)} review, ${workflowLabel(item.workflowState)}`}
              >
                <span className="mer-row-main">
                  <span className="mer-row-kicker">
                    {item.assessmentTrustStatus === "legacy_unverified"
                      ? "Historical assessment"
                      : vendorLabel(item.vendor)}
                  </span>
                  <strong>{decisionLabel(item.decisionStatus)}</strong>
                  <span className="mer-row-meta">
                    {item.assessmentObservedAt
                      ? `Observed ${formatObservedAt(item.assessmentObservedAt)}`
                      : "Observation time unavailable"}
                  </span>
                </span>
                <span className="mer-row-status">
                  <StatusPill
                    label={workflowLabel(item.workflowState)}
                    tone={WORKFLOW_TONE[item.workflowState] ?? "neutral"}
                  />
                  <span className="mer-row-secondary">
                    {item.assessmentTrustStatus === "legacy_unverified"
                      ? "Legacy, unverified"
                      : "Evaluator assessment"}
                    {" · "}
                    {item.assessmentTrustStatus === "legacy_unverified"
                      ? "Environment unavailable"
                      : item.sourceEnvironment === "test"
                        ? "Test source"
                        : item.sourceEnvironment === "production"
                          ? "Production source environment"
                          : "Environment unknown"}
                  </span>
                </span>
                <span className="mer-row-facts">
                  <span>
                    <b>Provider</b>
                    {item.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : "Verified provider scope"}
                  </span>
                  <span>
                    <b>Payer / program</b>
                    {item.assessmentTrustStatus !== "legacy_unverified" &&
                    item.canonicalPayerId &&
                    item.programId
                      ? "Identity recorded"
                      : "Unavailable"}
                  </span>
                  <span>
                    <b>Claim match</b>
                    {item.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : item.claimMatchStatus}
                  </span>
                  <span>
                    <b>Duplicate</b>
                    {item.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : item.duplicateStatus === "none"
                        ? "None identified"
                        : item.duplicateStatus === "possible"
                          ? "Possible duplicate"
                          : item.duplicateStatus === "exact"
                            ? "Exact duplicate"
                            : "Unverified"}
                  </span>
                </span>
                <span className="mer-row-arrow" aria-hidden="true">
                  <Glyph name="chevron-right" size={18} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {nextCursor ? (
          <div className="mer-pagination">
            <Button
              size="sm"
              tone="secondary"
              disabled={loadingMore}
              onClick={() => void load(nextCursor, true)}
            >
              {loadingMore ? "Loading more…" : "Load more reviews"}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return <WorkQueueLayout header={header} filters={notice} table={content} fullPageScroll />;
}

function ReviewDetailScreen({ reviewId }: { reviewId: string }): JSX.Element {
  const client = useApiClient();
  const attemptKey = useAttemptKey();
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const canRead = session?.permissions?.includes("remittance.read") ?? false;
  const canFinancialReview = session?.permissions?.includes("remittance.financial_review") ?? false;
  const canReassess = session?.permissions?.includes("remittance.match_review") ?? false;
  const canReadClaim = session?.permissions?.includes("medicaid.claim.read") ?? false;
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    kind: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const sequence = useRef(0);
  const from = (location.state as { from?: unknown } | null)?.from;
  const returnTo =
    typeof from === "string" && from.startsWith("/remittance/medicaid-era-reviews")
      ? from
      : "/remittance/medicaid-era-reviews";

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setDetailError(null);
    setHistoryError(null);
    if (!canRead) {
      setDetail(null);
      setHistory([]);
      setDetailError("Remittance read permission is required to view this investigation.");
      setLoading(false);
      return;
    }
    try {
      const historyRequest = client.GET("/api/v1/remittance/medicaid-era-reviews/{id}/history", {
        params: { path: { id: reviewId } },
      });
      if (canFinancialReview) {
        const [detailResponse, historyResponse] = await Promise.all([
          client.GET("/api/v1/remittance/medicaid-era-reviews/{id}", {
            params: { path: { id: reviewId } },
          }),
          historyRequest,
        ]);
        if (request !== sequence.current) return;
        if (detailResponse.error || !detailResponse.data)
          setDetailError(
            displayError(detailResponse.response?.status, "Review detail is unavailable."),
          );
        else setDetail(detailResponse.data);
        if (historyResponse.error || !historyResponse.data)
          setHistoryError(
            displayError(historyResponse.response?.status, "Investigation history is unavailable."),
          );
        else setHistory(historyResponse.data.items);
      } else {
        setDetail(null);
        const historyResponse = await historyRequest;
        if (request !== sequence.current) return;
        if (historyResponse.error || !historyResponse.data)
          setHistoryError(
            displayError(historyResponse.response?.status, "Investigation history is unavailable."),
          );
        else setHistory(historyResponse.data.items);
        setDetailError(
          "Financial review permission is required to view assessment details. Authorized investigation history is shown below.",
        );
      }
    } catch {
      if (request === sequence.current)
        setDetailError(
          "Review details could not reach the service. Check your connection and retry.",
        );
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [canFinancialReview, canRead, client, reviewId]);

  useEffect(() => {
    setDetail(null);
    setHistory([]);
    setMessage(null);
    void reload();
    return () => {
      sequence.current += 1;
    };
  }, [reload]);

  const refreshAfterMutation = async (successText: string) => {
    await reload();
    setMessage({ kind: "success", text: successText });
  };

  const saveNote = async () => {
    if (!detail || !reason) return;
    setBusy("note");
    setMessage(null);
    try {
      const response = await attemptKey.run(
        `medicaid-era-note:${reviewId}:${detail.version}:${reason}`,
        (key) =>
          client.POST("/api/v1/remittance/medicaid-era-reviews/{id}/notes", {
            params: { path: { id: reviewId }, header: { "Idempotency-Key": key } },
            body: { expectedVersion: detail.version, reasonCode: reason },
          }),
      );
      if (response.error || !response.data) {
        setMessage({
          kind: "error",
          text: displayError(response.response?.status, "The investigation reason was not saved."),
        });
        if (response.response?.status === 409) await reload();
        return;
      }
      await refreshAfterMutation(
        "Investigation reason recorded. No payment or claim state was changed.",
      );
    } catch {
      setMessage({
        kind: "error",
        text: "The action may not have completed. Reload the review before trying again.",
      });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const changeDisposition = async (action: (typeof DISPOSITION_ACTIONS)[number]) => {
    if (!detail || action.state === detail.workflowState) return;
    if (
      action.state === "reviewed_not_posted" &&
      !window.confirm(
        "Complete this investigation? The review will be marked as reviewed without posting any payment or adjustment.",
      )
    )
      return;
    setBusy(action.state);
    setMessage(null);
    try {
      const response = await attemptKey.run(
        `medicaid-era-disposition:${reviewId}:${detail.version}:${action.state}`,
        (key) =>
          client.POST("/api/v1/remittance/medicaid-era-reviews/{id}/disposition", {
            params: { path: { id: reviewId }, header: { "Idempotency-Key": key } },
            body: {
              expectedVersion: detail.version,
              state: action.state,
              reasonCode: action.reasonCode,
            },
          }),
      );
      if (response.error || !response.data) {
        setMessage({
          kind: "error",
          text: displayError(
            response.response?.status,
            "The investigation status was not changed.",
          ),
        });
        if (response.response?.status === 409) await reload();
        return;
      }
      await refreshAfterMutation(
        `${action.label} recorded. This does not post financial activity.`,
      );
    } catch {
      setMessage({
        kind: "error",
        text: "The action may not have completed. Reload the review before trying again.",
      });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const reassess = async () => {
    setBusy("reassess");
    setMessage(null);
    try {
      const response = await attemptKey.run(
        `medicaid-era-reassess:${reviewId}:${detail?.version ?? "unknown"}`,
        (key) =>
          client.POST("/api/v1/remittance/medicaid-era-reviews/{id}/reassess", {
            params: { path: { id: reviewId }, header: { "Idempotency-Key": key } },
          }),
      );
      if (response.error || !response.data) {
        setMessage({
          kind: "error",
          text: displayError(response.response?.status, "Reassessment could not be completed."),
        });
        if (response.response?.status === 409) await reload();
        return;
      }
      const outcome = resultMessage(response.data);
      if (outcome.kind === "success" && response.data.status === "review_saved") {
        if (response.data.reviewId !== reviewId) {
          navigate(`/remittance/medicaid-era-reviews/${response.data.reviewId}`, {
            state: { from: returnTo },
            replace: true,
          });
          return;
        }
        await refreshAfterMutation(outcome.text);
      } else
        setMessage({ kind: outcome.kind === "unavailable" ? "error" : "info", text: outcome.text });
    } catch {
      setMessage({
        kind: "error",
        text: "Reassessment may have completed. Reload the review before trying again.",
      });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const parsed = detail ? parseMedicaidEraSummary(detail.safeSummary as unknown) : null;
  const back = (
    <Link className="mer-back-link" to={returnTo}>
      <Glyph name="chevron-left" size={16} /> Back to reviews
    </Link>
  );
  const title = "Medicaid ERA investigation";
  const header = (
    <Header
      title={title}
      description="Investigate the source-backed assessment and record nonposting follow-up."
      actions={back}
    />
  );

  let content: ReactNode;
  if (loading) {
    content = (
      <div className="mer-loading">
        <LoadingSpinner label="Loading review and investigation history…" />
      </div>
    );
  } else if (!canRead) {
    content = (
      <EmptyState
        title="Access unavailable"
        description={detailError ?? "Remittance read permission is required."}
      />
    );
  } else if (!detail && canFinancialReview) {
    content = (
      <EmptyState
        title="Review details unavailable"
        description={detailError ?? "This review is no longer available in your authorized scope."}
        action={
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Retry
          </Button>
        }
      />
    );
  } else {
    content = (
      <div className="mer-detail-layout">
        {detailError ? <output className="mer-banner mer-banner-info">{detailError}</output> : null}
        {message?.kind === "error" ? (
          <div className={`mer-banner mer-banner-${message.kind}`} role="alert">
            {message.text}
          </div>
        ) : message ? (
          <output className={`mer-banner mer-banner-${message.kind}`}>{message.text}</output>
        ) : null}
        {detail ? (
          <>
            <section className="mer-detail-heading" aria-labelledby="mer-detail-title">
              <div>
                <p className="mer-eyebrow">
                  {detail.assessmentTrustStatus === "legacy_unverified"
                    ? "Historical review"
                    : vendorLabel(detail.vendor)}
                </p>
                <h2 id="mer-detail-title">{decisionLabel(detail.decisionStatus)}</h2>
                <p className="mer-detail-subtitle">
                  {detail.assessmentTrustStatus === "legacy_unverified"
                    ? "Provider and payer identity are not verified"
                    : "Provider entity details are limited in this view"}{" "}
                  ·{" "}
                  <span>
                    {detail.assessmentObservedAt
                      ? `Observed ${formatObservedAt(detail.assessmentObservedAt)}`
                      : formatObservedAt(null)}
                  </span>
                </p>
              </div>
              <div className="mer-status-stack">
                <StatusPill
                  label={workflowLabel(detail.workflowState)}
                  tone={WORKFLOW_TONE[detail.workflowState] ?? "neutral"}
                />
                <StatusPill
                  label={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Legacy, unverified"
                      : "Isolated evaluator"
                  }
                  tone={
                    detail.assessmentTrustStatus === "legacy_unverified" ? "warning" : "progress"
                  }
                />
              </div>
            </section>

            {detail.assessmentSemantics === "point_in_time_nonposting" ? (
              <div className="mer-notice" role="note">
                <Glyph name="info" size={17} />
                <span>
                  Assessment observed on {formatObservedAt(detail.assessmentObservedAt)}. This is
                  not current eligibility verification or payment authorization.
                </span>
              </div>
            ) : detail.assessmentSemantics === "legacy_unverified" ? (
              <div className="mer-banner mer-banner-warning" role="note">
                This historical assessment predates the trusted evaluator. Its original findings
                have not been independently verified.
              </div>
            ) : (
              <div className="mer-banner mer-banner-warning" role="note">
                Evidence snapshot unavailable. This assessment must not be treated as current
                verified evidence.
              </div>
            )}

            <section className="mer-section" aria-labelledby="mer-overview-title">
              <div className="mer-section-heading">
                <div>
                  <p className="mer-eyebrow">Assessment overview</p>
                  <h3 id="mer-overview-title">What needs attention</h3>
                </div>
              </div>
              {detail.reasonCodes.length ? (
                <ul className="mer-exception-list">
                  {detail.reasonCodes.map((code) => (
                    <li key={code}>
                      <Glyph name="alert-circle" size={17} />
                      <span>{reasonExplanation(code)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mer-muted">No assessment reason was recorded.</p>
              )}
              <dl className="mer-fact-grid">
                <Fact
                  label="Claim match"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : humanizeStatus(detail.claimMatchStatus)
                  }
                />
                <Fact
                  label="Duplicate review"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : duplicateLabel(detail.duplicateStatus)
                  }
                />
                <Fact
                  label="Payer / program"
                  value={
                    detail.canonicalPayerId &&
                    detail.programId &&
                    detail.assessmentTrustStatus !== "legacy_unverified"
                      ? "Identity recorded"
                      : "Unavailable"
                  }
                />
                <Fact
                  label="Source environment"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Unavailable"
                      : environmentLabel(detail.sourceEnvironment)
                  }
                />
              </dl>
              {canReassess && detail.assessmentTrustStatus === "isolated_evaluator" ? (
                <div className="mer-action-row">
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={() => void reassess()}
                    disabled={busy !== null}
                  >
                    <Glyph name="rotate-ccw" size={14} />
                    {busy === "reassess" ? "Re-evaluating…" : "Re-evaluate evidence"}
                  </Button>
                  <span className="mer-muted">
                    The server resolves the staged source and rechecks current evidence. No posting
                    occurs.
                  </span>
                </div>
              ) : null}
            </section>

            <section className="mer-section" aria-labelledby="mer-claims-title">
              <div className="mer-section-heading">
                <div>
                  <p className="mer-eyebrow">835 observations</p>
                  <h3 id="mer-claims-title">Claim observations</h3>
                </div>
                {parsed ? (
                  <span className="mer-section-meta">
                    {parsed.claims.length} claim observation{parsed.claims.length === 1 ? "" : "s"}
                    {parsed.transactionSetCount !== null
                      ? ` · ${parsed.transactionSetCount} transaction set${parsed.transactionSetCount === 1 ? "" : "s"}`
                      : ""}
                  </span>
                ) : null}
              </div>
              {detail.assessmentTrustStatus === "legacy_unverified" ? (
                <p className="mer-muted">
                  Claim observations were redacted because the original assessment is not trusted.
                </p>
              ) : !parsed ? (
                <p className="mer-muted">
                  The assessment summary is missing or uses a format this screen cannot safely
                  display. No financial values are shown.
                </p>
              ) : parsed.claims.length === 0 ? (
                <p className="mer-muted">
                  No claim-level observations were present in this assessment.
                </p>
              ) : (
                <div className="mer-claim-list">
                  {parsed.claims.map((claim, index) => (
                    <ClaimObservation
                      key={`${claim.reasonCode}-${index}`}
                      claim={claim}
                      index={index}
                      canReadClaim={canReadClaim}
                      multiClaim={parsed.claims.length > 1}
                    />
                  ))}
                </div>
              )}
              <p className="mer-financial-disclaimer">
                Amounts are reported 835 observations only. They are not ledger balances, payment
                allocations, allowed amounts, or posted transactions.
              </p>
            </section>

            <section className="mer-section" aria-labelledby="mer-source-title">
              <div className="mer-section-heading">
                <div>
                  <p className="mer-eyebrow">Provenance</p>
                  <h3 id="mer-source-title">Source and evidence</h3>
                </div>
              </div>
              <dl className="mer-fact-grid">
                <Fact
                  label="Source vendor"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Unavailable"
                      : vendorLabel(detail.vendor)
                  }
                />
                <Fact
                  label="Source environment"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Unavailable"
                      : environmentLabel(detail.sourceEnvironment)
                  }
                />
                <Fact
                  label="Provider entity"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : "Verified provider scope; display name unavailable"
                  }
                />
                <Fact
                  label="Payer and program"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : detail.canonicalPayerId && detail.programId
                        ? "Identity recorded; directory labels unavailable"
                        : "Unavailable"
                  }
                />
                <Fact
                  label="Source account"
                  value={
                    detail.assessmentTrustStatus === "legacy_unverified"
                      ? "Not verified"
                      : detail.accountReference
                        ? "Account context verified"
                        : "Unavailable"
                  }
                />
                <Fact
                  label="Assessment snapshot"
                  value={
                    detail.assessmentSemantics === "point_in_time_nonposting"
                      ? "Point-in-time, nonposting"
                      : detail.assessmentSemantics === "legacy_unverified"
                        ? "Legacy, unverified"
                        : "Snapshot unavailable"
                  }
                />
              </dl>
              {parsed?.claims.some((claim) => claim.evidenceReferenceCount > 0) ? (
                <p className="mer-muted">
                  Server evidence references are recorded for this assessment. Restricted references
                  are not displayed here.
                </p>
              ) : null}
              <p className="mer-muted">
                The source environment describes where the artifact originated. It does not certify
                payer enrollment, route qualification, or production authorization.
              </p>
            </section>

            {canFinancialReview ? (
              <section className="mer-section" aria-labelledby="mer-actions-title">
                <div className="mer-section-heading">
                  <div>
                    <p className="mer-eyebrow">Investigation</p>
                    <h3 id="mer-actions-title">Record a nonposting action</h3>
                  </div>
                </div>
                <div className="mer-action-form">
                  <label htmlFor="mer-reason">
                    Investigation reason <span className="mer-required">(required)</span>
                  </label>
                  <select
                    id="mer-reason"
                    aria-required="true"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    disabled={busy !== null}
                  >
                    <option value="">Select a reason</option>
                    {NOTE_REASONS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={!reason || busy !== null}
                    onClick={() => void saveNote()}
                  >
                    {busy === "note" ? "Saving reason…" : "Record investigation reason"}
                  </Button>
                  <p className="mer-muted">
                    This records a controlled reason in the audit history. It does not support
                    free-text clinical or financial notes.
                  </p>
                </div>
                <div className="mer-disposition-actions" aria-label="Investigation status actions">
                  {DISPOSITION_ACTIONS.filter(
                    (action) => action.state !== detail.workflowState,
                  ).map((action) => (
                    <Button
                      key={action.state}
                      size="sm"
                      tone={action.state === "reviewed_not_posted" ? "primary" : "secondary"}
                      disabled={busy !== null}
                      onClick={() => void changeDisposition(action)}
                    >
                      {busy === action.state ? "Saving…" : action.label}
                    </Button>
                  ))}
                </div>
                <p className="mer-muted">
                  Status changes are version-checked. “Reviewed — not posted” closes only this
                  investigation record; it never posts payment or changes claim status.
                </p>
              </section>
            ) : null}
          </>
        ) : null}

        <section className="mer-section" aria-labelledby="mer-history-title">
          <div className="mer-section-heading">
            <div>
              <p className="mer-eyebrow">Audit trail</p>
              <h3 id="mer-history-title">Investigation history</h3>
            </div>
          </div>
          {historyError ? (
            <div className="mer-inline-error" role="alert">
              {historyError}
              <Button size="sm" tone="secondary" onClick={() => void reload()}>
                Retry history
              </Button>
            </div>
          ) : history.length === 0 ? (
            <p className="mer-muted">No investigation history is available.</p>
          ) : (
            <ol className="mer-timeline" aria-label="Assessment and investigation history">
              {history.map((event, index) => (
                <HistoryEvent key={`${event.version}-${event.action}-${index}`} event={event} />
              ))}
            </ol>
          )}
        </section>
      </div>
    );
  }

  return <WorkQueueLayout header={header} table={content} fullPageScroll />;
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="mer-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ClaimObservation({
  claim,
  index,
  canReadClaim,
  multiClaim,
}: {
  claim: PresentedClaimObservation;
  index: number;
  canReadClaim: boolean;
  multiClaim: boolean;
}): JSX.Element {
  const amountRows: [string, string][] = [
    ["Reported charge", "claimChargeCents"],
    ["Reported claim payment", "claimPaidCents"],
    ["Patient responsibility reported", "patientResponsibilityCents"],
  ];
  const providerAdjustments = claim.providerAdjustments;
  return (
    <article className="mer-claim-observation">
      <div className="mer-claim-heading">
        <div>
          <p className="mer-eyebrow">Claim observation {index + 1}</p>
          <h4>{decisionLabel(claim.decision)}</h4>
        </div>
        <StatusPill
          label={humanizeStatus(claim.matchStatus)}
          tone={claim.matchStatus === "MATCHED" ? "progress" : "warning"}
        />
      </div>
      <p className="mer-reason-text">{reasonExplanation(claim.reasonCode)}</p>
      <dl className="mer-amount-grid">
        {amountRows.map(([label, key]) =>
          claim.amounts[key] !== null ? (
            <Fact key={key} label={label} value={formatCents(claim.amounts[key] ?? null)} />
          ) : null,
        )}
        {!multiClaim && typeof claim.amounts.providerAdjustmentCents === "number" ? (
          <Fact
            label="Reported provider-level adjustment"
            value={formatCents(claim.amounts.providerAdjustmentCents)}
          />
        ) : null}
      </dl>
      {multiClaim &&
      (providerAdjustments.length > 0 ||
        typeof claim.amounts.providerAdjustmentCents === "number") ? (
        <p className="mer-muted">
          Provider-level adjustments are present in this remittance. They are not allocated to
          individual claims and are not repeated as per-claim amounts.
        </p>
      ) : null}
      {claim.claimAdjustments.length || claim.serviceLineAdjustments.length ? (
        <details className="mer-adjustment-details">
          <summary>
            Adjustment observations (
            {claim.claimAdjustments.length + claim.serviceLineAdjustments.length})
          </summary>
          <ul>
            {claim.claimAdjustments.map((adjustment) => (
              <Adjustment key={adjustment.key} item={adjustment} label="Claim adjustment" />
            ))}
            {claim.serviceLineAdjustments.map((adjustment) => (
              <Adjustment
                key={adjustment.key}
                item={adjustment}
                label={`Service-line adjustment${typeof adjustment.lineIndex === "number" ? ` · line ${adjustment.lineIndex + 1}` : ""}`}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {claim.unresolvedRequirements.length ? (
        <div className="mer-unresolved">
          <strong>Unresolved requirements</strong>
          <ul>
            {claim.unresolvedRequirements.slice(0, 8).map((code) => (
              <li key={code}>{reasonExplanation(code)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {claim.matchedClaimId && canReadClaim ? (
        <Link className="mer-inline-link" to={`/medicaid/billing/claims/${claim.matchedClaimId}`}>
          Open verified Medicaid claim
          {claim.claimVersion !== null ? ` · version ${claim.claimVersion}` : ""}
          <Glyph name="chevron-right" size={14} />
        </Link>
      ) : null}
      {claim.matchedClaimId && !canReadClaim ? (
        <p className="mer-muted">
          A claim match is verified; separate Medicaid claim read permission is required to open it.
        </p>
      ) : null}
      {!claim.matchedClaimId && claim.matchStatus !== "MATCHED" ? (
        <p className="mer-muted">
          No claim link is shown because the match is unresolved or not verified.
        </p>
      ) : null}
    </article>
  );
}

function Adjustment({ item, label }: { item: PresentedAdjustment; label: string }): JSX.Element {
  return (
    <li>
      {label}: {item.groupCode ? `${item.groupCode} · ` : ""}
      {item.reasonCode} · {formatCents(item.amountCents ?? null)}
    </li>
  );
}

function HistoryEvent({ event }: { event: HistoryItem }): JSX.Element {
  const legacy = event.trustStatus === "legacy_unverified";
  const labels: Readonly<Record<string, string>> = {
    assessed: "Initial assessment saved",
    reassessed: "Assessment refreshed",
    note: "Investigation reason recorded",
    investigating: "Investigation started",
    follow_up_required: "Follow-up requested",
    reviewed_not_posted: "Review completed — not posted",
    reopened: "Investigation reopened",
    legacy_unverified: "Historical event — unverified",
  };
  const reason = event.reasonCode ? reasonCodeLabel(event.reasonCode) : null;
  return (
    <li className={`mer-timeline-event${legacy ? " mer-timeline-legacy" : ""}`}>
      <span className="mer-timeline-marker" aria-hidden="true">
        <Glyph name={legacy ? "info" : "check-circle"} size={15} />
      </span>
      <div className="mer-timeline-content">
        <div className="mer-timeline-heading">
          <strong>
            {legacy
              ? "Historical event — unverified"
              : (labels[event.action] ?? "Investigation event")}
          </strong>
          <time dateTime={event.createdAt}>{formatObservedAt(event.createdAt)}</time>
        </div>
        <p>
          {legacy
            ? "This event predates the trusted evaluator. Its original details have not been independently verified."
            : `Recorded by an authorized reviewer${reason ? ` · ${reason}` : ""}.`}
        </p>
        <span className="mer-timeline-trust">
          {legacy ? "Legacy, unverified" : `Version ${event.version} · nonposting workflow`}
        </span>
      </div>
    </li>
  );
}

function humanizeStatus(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function duplicateLabel(value: string): string {
  if (value === "none") return "None identified";
  if (value === "possible") return "Possible duplicate";
  if (value === "exact") return "Exact duplicate";
  return "Unverified";
}

function reasonCodeLabel(code: string): string {
  const note = NOTE_REASONS.find(([known]) => known === code)?.[1];
  if (note) return note;
  const disposition = DISPOSITION_ACTIONS.find((action) => action.reasonCode === code);
  return disposition ? disposition.label : "Reason details unavailable";
}
