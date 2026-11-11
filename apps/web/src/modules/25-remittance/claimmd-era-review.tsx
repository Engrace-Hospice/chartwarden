import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import type { paths } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import { formatDay, humanize, money, toneOf } from "./remittance-status";

type ReviewPage =
  paths["/api/v1/remittance/claimmd-era"]["get"]["responses"][200]["content"]["application/json"];
type ReviewSummary = ReviewPage["items"][number];
type ReviewItem =
  paths["/api/v1/remittance/claimmd-era/{id}"]["get"]["responses"][200]["content"]["application/json"];
type MatchReview =
  paths["/api/v1/remittance/claimmd-era/{id}/matching"]["get"]["responses"][200]["content"]["application/json"];
type CandidatePage =
  paths["/api/v1/remittance/claimmd-era/{id}/matching/claims/{claimIndex}/candidates"]["get"]["responses"][200]["content"]["application/json"];
type PostingPlan =
  paths["/api/v1/remittance/claimmd-era/{id}/posting-plan"]["post"]["responses"][200]["content"]["application/json"];
type PostingHistory =
  paths["/api/v1/remittance/claimmd-era/{id}/posting-history"]["get"]["responses"][200]["content"]["application/json"];

const STATES = ["", "staged", "held", "possible_duplicate"] as const;
const REVIEW_STATE_TONE: Record<string, "neutral" | "progress" | "success" | "warning" | "error"> =
  {
    staged: "progress",
    delivered: "success",
    possible_duplicate: "warning",
    held: "warning",
  };

export function ClaimMdEraReview(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [selected, setSelected] = useState<ReviewItem | null>(null);
  const [matchReview, setMatchReview] = useState<MatchReview | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const [financialReviewBusy, setFinancialReviewBusy] = useState(false);
  const [candidatePages, setCandidatePages] = useState<Record<number, CandidatePage>>({});
  const [candidateLoading, setCandidateLoading] = useState<number | null>(null);
  const [postingPlan, setPostingPlan] = useState<PostingPlan | null>(null);
  const [postingHistory, setPostingHistory] = useState<PostingHistory>([]);
  const [postingBusy, setPostingBusy] = useState(false);
  const [postingError, setPostingError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("");
  const [payerFilter, setPayerFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [searchWindowLimited, setSearchWindowLimited] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const detailIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(
    async (append = false) => {
      setLoading(!append);
      setLoadingMore(append);
      setError(null);
      const nextCursor = append ? cursorRef.current : null;
      if (!append) {
        cursorRef.current = null;
        setCursor(null);
        setItems([]);
      }
      const params = {
        query: {
          ...(stateFilter ? { state: stateFilter } : {}),
          ...(payerFilter.trim() ? { payer: payerFilter.trim() } : {}),
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
          limit: "50",
          ...(nextCursor ? { cursor: nextCursor } : {}),
        },
      };
      try {
        const response = await client.GET("/api/v1/remittance/claimmd-era", { params });
        if (response.error || !response.data) {
          setError(
            "ERA review is unavailable. Check your remittance access and provider scope, then retry.",
          );
          setLoading(false);
          setLoadingMore(false);
          return;
        }
        setItems((previous) =>
          append ? [...previous, ...response.data.items] : response.data.items,
        );
        cursorRef.current = response.data.nextCursor;
        setCursor(response.data.nextCursor);
        setSearchWindowLimited(response.data.searchWindowLimited);
      } catch {
        setError("ERA review could not reach the service. Check your connection and retry.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [client, fromDate, payerFilter, stateFilter, toDate],
  );

  useEffect(() => {
    cursorRef.current = null;
    setCursor(null);
    setItems([]);
    setSelected(null);
    void load(false);
  }, [load]);

  useEffect(() => {
    if (selected) detailHeading.current?.focus();
  }, [selected]);

  const visibleItems = useMemo(() => items, [items]);

  const openItem = async (item: ReviewSummary) => {
    detailIdRef.current = item.id;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("stage", item.id);
        return next;
      },
      { replace: true },
    );
    setSelected(null);
    setMatchReview(null);
    setCandidatePages({});
    setPostingPlan(null);
    setPostingHistory([]);
    setPostingError(null);
    setMatchError(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setMatchLoading(true);
      const [response, matching] = await Promise.all([
        client.GET("/api/v1/remittance/claimmd-era/{id}", { params: { path: { id: item.id } } }),
        client.GET("/api/v1/remittance/claimmd-era/{id}/matching", {
          params: { path: { id: item.id } },
        }),
      ]);
      if (response.error || !response.data) {
        setDetailError("This remittance detail is unavailable in your authorized scope.");
      } else {
        setSelected(response.data);
      }
      if (matching.error || !matching.data)
        setMatchError("Claim identity review is unavailable. Retry to reload verified evidence.");
      else setMatchReview(matching.data);
    } catch {
      setDetailError("Remittance details could not be loaded. Check your connection and retry.");
    } finally {
      setMatchLoading(false);
      setDetailLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: openItem is a local action closure; detailIdRef prevents duplicate opens for the same URL stage.
  useEffect(() => {
    const stageId = searchParams.get("stage");
    if (!stageId || loading || detailIdRef.current === stageId) return;
    const item = items.find((candidate) => candidate.id === stageId);
    if (item) void openItem(item);
  }, [items, loading, searchParams]);

  const canResolveIdentity = session?.permissions?.includes("remittance.match_review") ?? false;
  const canFinancialReview = session?.permissions?.includes("remittance.financial_review") ?? false;
  const canPostingApprove = session?.permissions?.includes("remittance.posting.approve") ?? false;
  const canPostingExecute = session?.permissions?.includes("remittance.posting.execute") ?? false;

  const refreshPostingPlan = async (itemId: string) => {
    setPostingBusy(true);
    setPostingError(null);
    try {
      const [planResponse, historyResponse] = await Promise.all([
        client.POST("/api/v1/remittance/claimmd-era/{id}/posting-plan", {
          params: { path: { id: itemId } },
        }),
        client.GET("/api/v1/remittance/claimmd-era/{id}/posting-history", {
          params: { path: { id: itemId } },
        }),
      ]);
      if (planResponse.error || !planResponse.data)
        setPostingError(
          "The server could not build a current posting plan. Review the source and try again.",
        );
      else setPostingPlan(planResponse.data);
      if (!historyResponse.error && historyResponse.data) setPostingHistory(historyResponse.data);
    } catch {
      setPostingError("Posting readiness could not be loaded. Check your connection and retry.");
    } finally {
      setPostingBusy(false);
    }
  };

  const approvePosting = async (plan: PostingPlan, reason: string) => {
    if (!selected) return;
    setPostingBusy(true);
    setPostingError(null);
    try {
      // The Idempotency-Key is the API client's: one per intent (this plan digest and reason), so a retry after a lost reply replays.
      const response = await client.POST(
        "/api/v1/remittance/claimmd-era/{id}/posting-plans/{planId}/approval",
        {
          params: { path: { id: selected.id, planId: plan.planId } },
          body: { planDigest: plan.planDigest, reason },
        },
      );
      if (response.error) {
        setPostingError(
          "Approval was refused because the plan may be stale, blocked, or outside your authorization. Refresh the plan.",
        );
        return;
      }
      await refreshPostingPlan(selected.id);
    } catch {
      setPostingError("The approval was not recorded. Reload the plan before retrying.");
    } finally {
      setPostingBusy(false);
    }
  };

  const executePosting = async (plan: PostingPlan, reason: string) => {
    if (!selected) return;
    setPostingBusy(true);
    setPostingError(null);
    try {
      // The Idempotency-Key is the API client's: one per intent (this plan digest and reason), so a retry after a lost reply replays.
      const response = await client.POST(
        "/api/v1/remittance/claimmd-era/{id}/posting-plans/{planId}/execution",
        {
          params: { path: { id: selected.id, planId: plan.planId } },
          body: { planDigest: plan.planDigest, reason },
        },
      );
      if (response.error || !response.data) {
        setPostingError(
          "Execution was refused or did not commit. Refresh the plan and posting history before retrying.",
        );
        return;
      }
      setPostingError(
        response.data.outcome === "already_posted"
          ? "This approved financial effect is already posted."
          : null,
      );
      await refreshPostingPlan(selected.id);
    } catch {
      setPostingError("No committed result was returned. Check posting history before retrying.");
    } finally {
      setPostingBusy(false);
    }
  };

  const loadCandidates = async (claimIndex: number) => {
    if (!selected) return;
    setCandidateLoading(claimIndex);
    setMatchError(null);
    try {
      const response = await client.GET(
        "/api/v1/remittance/claimmd-era/{id}/matching/claims/{claimIndex}/candidates",
        {
          params: { path: { id: selected.id, claimIndex: String(claimIndex) } },
        },
      );
      if (response.error || !response.data)
        setMatchError(
          "Historical claim candidates could not be loaded. Retry after refreshing the remittance.",
        );
      else setCandidatePages((current) => ({ ...current, [claimIndex]: response.data }));
    } catch {
      setMatchError(
        "Historical claim candidates could not be loaded. Check the connection and retry.",
      );
    } finally {
      setCandidateLoading(null);
    }
  };

  const recordIdentityDecision = async (
    claimIndex: number,
    action: "confirm_identity" | "confirm_candidate" | "clear",
    expectedVersion: number,
    reason: string,
    evidenceId?: string,
  ) => {
    if (!selected) return;
    setMatchBusy(true);
    setMatchError(null);
    try {
      const result = await client.POST(
        "/api/v1/remittance/claimmd-era/{id}/matching/claims/{claimIndex}/decision",
        {
          params: { path: { id: selected.id, claimIndex: String(claimIndex) } },
          body: { action, expectedVersion, reason, ...(evidenceId ? { evidenceId } : {}) },
        },
      );
      if (result.error) {
        setMatchError(
          "The matching review changed or is no longer eligible. Reload the remittance before continuing.",
        );
        return;
      }
      const refreshed = await client.GET("/api/v1/remittance/claimmd-era/{id}/matching", {
        params: { path: { id: selected.id } },
      });
      if (refreshed.error || !refreshed.data)
        setMatchError("The decision was recorded, but the latest review could not be refreshed.");
      else setMatchReview(refreshed.data);
      if (action === "confirm_candidate" || action === "clear") await loadCandidates(claimIndex);
    } catch {
      setMatchError(
        "The matching decision could not be saved. Retry after reloading the remittance.",
      );
    } finally {
      setMatchBusy(false);
    }
  };

  const recordFinancialDecision = async (
    itemId: string,
    itemType: "era" | "claim",
    itemIndex: number,
    disposition: "note" | "follow_up" | "reviewed" | "reopened" | "completed",
    expectedVersion: number,
    reason: string,
  ) => {
    setFinancialReviewBusy(true);
    setMatchError(null);
    try {
      const result = await client.POST(
        "/api/v1/remittance/claimmd-era/{id}/financial-review/decision",
        {
          params: { path: { id: itemId } },
          body: { itemType, itemIndex, disposition, expectedVersion, reason },
        },
      );
      if (result.error) {
        setMatchError(
          "The financial review changed or has unresolved blockers. Reload the remittance and review its current exceptions.",
        );
        return;
      }
      const refreshed = await client.GET("/api/v1/remittance/claimmd-era/{id}/matching", {
        params: { path: { id: itemId } },
      });
      if (refreshed.error || !refreshed.data)
        setMatchError(
          "The decision was saved, but the latest financial review could not be refreshed.",
        );
      else setMatchReview(refreshed.data);
    } catch {
      setMatchError("The nonposting review decision could not be saved. Reload before retrying.");
    } finally {
      setFinancialReviewBusy(false);
    }
  };

  const readyCount = items.filter((item) => item.reconciliationEligible).length;
  const heldCount = items.filter((item) => !item.reconciliationEligible).length;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Billing / Claim.MD ERA Review">
          <div style={subheadStyle}>
            Tenant-scoped remittances staged for review. Review decisions preserve verified claim
            identity evidence; they never allocate payments or post financial activity.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <BillingTabs />
          </div>
        </PageHeader>
      }
      filters={
        <section style={filterStyle} aria-label="ERA review filters">
          <div style={noticeStyle} role="note">
            <Glyph name="info" size={16} />
            <span>
              Review only — no payment, adjustment, claim balance, or ledger entry is created here.
            </span>
          </div>
          {error ? (
            <div role="alert" style={errorStyle}>
              {error}
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <label style={labelStyle}>
              Review status
              <select
                aria-label="Filter by review status"
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value)}
                style={inputStyle}
              >
                {STATES.map((state) => (
                  <option key={state || "all"} value={state}>
                    {state ? humanize(state) : "All statuses"}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Payer
              <input
                aria-label="Filter by payer"
                value={payerFilter}
                onChange={(event) => setPayerFilter(event.target.value)}
                placeholder="Search payer"
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Staged from
              <input
                aria-label="Received from"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Staged through
              <input
                aria-label="Received through"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                style={inputStyle}
              />
            </label>
            <Button tone="secondary" size="sm" onClick={() => void load(false)} disabled={loading}>
              <Glyph name="rotate-ccw" size={14} /> Refresh
            </Button>
            <Button
              tone="secondary"
              size="sm"
              onClick={() => {
                setStateFilter("");
                setPayerFilter("");
                setFromDate("");
                setToDate("");
              }}
              disabled={loading || (!stateFilter && !payerFilter && !fromDate && !toDate)}
            >
              Clear filters
            </Button>
          </div>
          <div style={mutedStyle}>
            Filters apply on the server before paging. Payer search examines a bounded set of
            protected stage summaries; continue loading to search older stages.
          </div>
          <div style={summaryStyle} aria-live="polite">
            {loading
              ? "Loading staged remittances…"
              : `${visibleItems.length} shown · ${readyCount} ready for review · ${heldCount} held or otherwise not eligible`}
          </div>
        </section>
      }
      table={
        loading ? (
          <div style={centerStyle}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <EmptyState
            title="ERA review unavailable"
            description={error}
            action={
              <Button size="sm" tone="secondary" onClick={() => void load(false)}>
                Retry
              </Button>
            }
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            title="No staged remittances"
            description={
              searchWindowLimited
                ? "No matching stages were found in this search window. Continue to search older stages."
                : "No Claim.MD ERA stages match this view. Account-wide source records are not shown here."
            }
            action={
              searchWindowLimited && cursor ? (
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={() => void load(true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Search older stages"}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div style={layoutStyle}>
            <section aria-label="Staged remittance list" style={listStyle}>
              <div style={scrollStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Staged</th>
                      <th style={thStyle}>Payer / payee</th>
                      <th style={thStyle}>Payment</th>
                      <th style={thStyle}>Review state</th>
                      <th style={thStyle}>Claims</th>
                      <th style={thStyle}>Identity exceptions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => {
                      const isSelected = selected?.id === item.id;
                      return (
                        <tr key={item.id} style={isSelected ? selectedRowStyle : rowStyle}>
                          <td style={tdStyle}>{formatDay(item.createdAt)}</td>
                          <td style={tdStyle}>
                            <strong>{item.payer.name ?? "Unknown payer"}</strong>
                            <div style={mutedStyle}>{item.payee.name ?? "Verified payee"}</div>
                          </td>
                          <td style={tdStyle}>
                            <strong>{money(item.payment.amount)}</strong>
                            <div style={mutedStyle}>
                              {item.payment.date
                                ? formatDay(item.payment.date)
                                : "Payment date unavailable"}
                            </div>
                          </td>
                          <td style={tdStyle}>
                            <StatusPill
                              label={humanize(item.state)}
                              tone={toneOf(REVIEW_STATE_TONE, item.state)}
                            />
                            {item.duplicateClassification !== "none" ? (
                              <div style={warningStyle}>
                                {item.duplicateClassification === "exact"
                                  ? "Exact duplicate"
                                  : "Possible duplicate"}
                              </div>
                            ) : null}
                          </td>
                          <td style={tdStyle}>{item.claimCount}</td>
                          <td style={tdStyle}>{item.identityExceptionCount}</td>
                          <td style={tdStyle}>
                            <Button
                              size="sm"
                              tone={isSelected ? "primary" : "secondary"}
                              aria-label={`Review remittance from ${item.payer.name ?? "unknown payer"}`}
                              onClick={() => void openItem(item)}
                            >
                              Review
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {cursor ? (
                <div style={moreStyle}>
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={() => void load(true)}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </section>
            <section aria-label="Remittance details" style={detailStyle}>
              {detailLoading ? (
                <div style={centerStyle}>
                  <LoadingSpinner />
                </div>
              ) : detailError ? (
                <div role="alert" style={errorStyle}>
                  {detailError}
                  <div style={{ marginTop: ".6rem" }}>
                    <Button
                      size="sm"
                      tone="secondary"
                      onClick={() => {
                        const item = items.find(
                          (candidate) => candidate.id === detailIdRef.current,
                        );
                        if (item) void openItem(item);
                      }}
                    >
                      Retry details
                    </Button>
                  </div>
                </div>
              ) : selected ? (
                <ReviewDetail
                  key={selected.id}
                  item={selected}
                  headingRef={detailHeading}
                  matching={matchReview}
                  matchLoading={matchLoading}
                  matchError={matchError}
                  matchBusy={matchBusy}
                  canResolveIdentity={canResolveIdentity}
                  onIdentityDecision={recordIdentityDecision}
                  candidatePages={candidatePages}
                  candidateLoading={candidateLoading}
                  onLoadCandidates={loadCandidates}
                  canFinancialReview={canFinancialReview}
                  financialReviewBusy={financialReviewBusy}
                  onFinancialDecision={recordFinancialDecision}
                  postingPlan={postingPlan}
                  postingHistory={postingHistory}
                  postingBusy={postingBusy}
                  postingError={postingError}
                  canPostingApprove={canPostingApprove}
                  canPostingExecute={canPostingExecute}
                  onRefreshPostingPlan={() => void refreshPostingPlan(selected.id)}
                  onApprovePosting={approvePosting}
                  onExecutePosting={executePosting}
                />
              ) : (
                <EmptyState
                  title="Select a remittance"
                  description="Review its claim and service-line summary, ownership state, and any hold reason."
                />
              )}
            </section>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function ReviewDetail({
  item,
  headingRef,
  matching,
  matchLoading,
  matchError,
  matchBusy,
  canResolveIdentity,
  onIdentityDecision,
  candidatePages,
  candidateLoading,
  onLoadCandidates,
  canFinancialReview,
  financialReviewBusy,
  onFinancialDecision,
  postingPlan,
  postingHistory,
  postingBusy,
  postingError,
  canPostingApprove,
  canPostingExecute,
  onRefreshPostingPlan,
  onApprovePosting,
  onExecutePosting,
}: {
  item: ReviewItem;
  headingRef: RefObject<HTMLHeadingElement>;
  matching: MatchReview | null;
  matchLoading: boolean;
  matchError: string | null;
  matchBusy: boolean;
  canResolveIdentity: boolean;
  onIdentityDecision: (
    claimIndex: number,
    action: "confirm_identity" | "confirm_candidate" | "clear",
    expectedVersion: number,
    reason: string,
    evidenceId?: string,
  ) => Promise<void>;
  candidatePages: Record<number, CandidatePage>;
  candidateLoading: number | null;
  onLoadCandidates: (claimIndex: number) => Promise<void>;
  canFinancialReview: boolean;
  financialReviewBusy: boolean;
  onFinancialDecision: (
    itemId: string,
    itemType: "era" | "claim",
    itemIndex: number,
    disposition: "note" | "follow_up" | "reviewed" | "reopened" | "completed",
    expectedVersion: number,
    reason: string,
  ) => Promise<void>;
  postingPlan: PostingPlan | null;
  postingHistory: PostingHistory;
  postingBusy: boolean;
  postingError: string | null;
  canPostingApprove: boolean;
  canPostingExecute: boolean;
  onRefreshPostingPlan: () => void;
  onApprovePosting: (plan: PostingPlan, reason: string) => Promise<void>;
  onExecutePosting: (plan: PostingPlan, reason: string) => Promise<void>;
}): JSX.Element {
  const [reviewReason, setReviewReason] = useState("");
  const [financialReason, setFinancialReason] = useState("");
  const [postingReason, setPostingReason] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<Record<number, string>>({});
  const matchedOutcomes = item.claimOutcomes.filter(
    (outcome) => outcome.outcome === "verified",
  ).length;
  const unmatchedOutcomes = item.claimOutcomes.filter((outcome) => outcome.outcome !== "verified");
  return (
    <div style={detailContentStyle}>
      <header style={detailHeaderStyle}>
        <div>
          <div style={eyebrowStyle}>Staged remittance</div>
          <h2 ref={headingRef} tabIndex={-1} style={titleStyle}>
            {item.payer.name ?? "Unknown payer"}
          </h2>
          <div style={mutedStyle}>
            {item.payee.name ?? "Verified provider"} · staged {formatDay(item.createdAt)}
          </div>
        </div>
        <StatusPill label={humanize(item.state)} tone={toneOf(REVIEW_STATE_TONE, item.state)} />
      </header>
      <dl style={summaryGridStyle}>
        <Summary label="Reported payment" value={money(item.payment.amount)} />
        <Summary
          label="Payment date"
          value={item.payment.date ? formatDay(item.payment.date) : "Unavailable"}
        />
        <Summary label="Claims represented" value={String(item.claims.length)} />
        <Summary
          label="Claim identity outcomes"
          value={`${matchedOutcomes} verified · ${unmatchedOutcomes.length} need review`}
        />
      </dl>
      {matching ? (
        <section aria-labelledby="financial-review-heading" style={matchPanelStyle}>
          <h3 id="financial-review-heading" style={sectionTitleStyle}>
            Financial review
          </h3>
          <p style={mutedStyle}>
            This records review and follow-up only. It does not reconcile cash, allocate payments,
            adjust balances, or authorize posting.
          </p>
          <dl style={summaryGridStyle}>
            <Summary
              label="Reported ERA payment"
              value={centsMoney(matching.financialReview.reportedPaymentCents)}
            />
            <Summary
              label="Claim charges"
              value={centsMoney(matching.financialReview.chargeCents)}
            />
            <Summary
              label="Claim payments"
              value={centsMoney(matching.financialReview.claimPaymentCents)}
            />
            <Summary
              label="Patient responsibility"
              value={centsMoney(matching.financialReview.patientResponsibilityCents)}
            />
            <Summary
              label="Claim adjustments"
              value={centsMoney(matching.financialReview.claimAdjustmentCents)}
            />
            <Summary
              label="Service-line adjustments"
              value={centsMoney(matching.financialReview.serviceLineAdjustmentCents)}
            />
            <Summary
              label="Provider-level adjustments (PLB)"
              value={centsMoney(matching.financialReview.providerAdjustmentCents)}
            />
            <Summary
              label="ERA balance check"
              value={
                matching.financialReview.balance.status === "balanced"
                  ? "Balances using reported values"
                  : matching.financialReview.balance.status === "discrepancy"
                    ? `Difference ${centsMoney(matching.financialReview.balance.differenceCents)}`
                    : "Insufficient source data"
              }
            />
          </dl>
          {matching.financialReview.claims.map((claim) => {
            const prior = matching.financialReviewHistory.find(
              (entry) =>
                entry.itemType === "claim" &&
                entry.itemIndex === claim.claimIndex &&
                entry.currentSource,
            );
            const version = prior?.decisionVersion ?? 0;
            return (
              <div key={claim.claimIndex} style={matchRowStyle}>
                <p style={{ ...mutedStyle, margin: 0 }}>
                  Claim {claim.claimIndex + 1}: <strong>{humanize(claim.status)}</strong> · reported
                  charge {centsMoney(claim.chargeCents)} · paid {centsMoney(claim.paymentCents)} ·
                  claim-level patient responsibility {centsMoney(claim.patientResponsibilityCents)}{" "}
                  · {humanize(claim.lineEvidence)}
                </p>
                {canFinancialReview ? (
                  <div style={filterRowStyle}>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={financialReviewBusy || financialReason.trim().length < 3}
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "claim",
                          claim.claimIndex,
                          "note",
                          version,
                          financialReason,
                        )
                      }
                    >
                      Add claim note
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={financialReviewBusy || financialReason.trim().length < 3}
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "claim",
                          claim.claimIndex,
                          "follow_up",
                          version,
                          financialReason,
                        )
                      }
                    >
                      Flag claim follow-up
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={financialReviewBusy || financialReason.trim().length < 3}
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "claim",
                          claim.claimIndex,
                          "reviewed",
                          version,
                          financialReason,
                        )
                      }
                    >
                      Mark claim reviewed
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {matching.financialReview.exceptions.length ? (
            <ul aria-label="Financial review exceptions" style={outcomeListStyle}>
              {matching.financialReview.exceptions.map((exception) => (
                <li key={exception.code}>
                  <StatusPill
                    label={humanize(exception.severity)}
                    tone={
                      exception.severity === "blocking"
                        ? "error"
                        : exception.severity === "follow_up"
                          ? "warning"
                          : "neutral"
                    }
                  />{" "}
                  <strong>{humanize(exception.code)}</strong> ·{" "}
                  {financialExceptionGuidance(exception.code)}
                  {exception.blocksFuturePosting
                    ? " This remains unresolved for any future posting review."
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p style={mutedStyle}>No derived financial-review exceptions.</p>
          )}
          {matching.financialReview.adjustments.length ? (
            <div style={scrollStyle}>
              <table style={lineTableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Scope</th>
                    <th style={thStyle}>CAS group</th>
                    <th style={thStyle}>Reason</th>
                    <th style={thStyle}>Reported amount</th>
                  </tr>
                </thead>
                <tbody>
                  {matching.financialReview.adjustments.map((adjustment, index) => (
                    <tr
                      key={`${adjustment.scope}-${adjustment.groupCode}-${adjustment.reasonCode}-${index}`}
                    >
                      <td style={tdStyle}>{humanize(adjustment.scope)}</td>
                      <td style={tdStyle}>
                        {adjustment.groupCode ?? "Unavailable"} · {humanize(adjustment.category)}
                      </td>
                      <td style={tdStyle}>
                        {adjustment.reasonCode ?? "Code unavailable"} · {adjustment.description}
                      </td>
                      <td style={tdStyle}>{centsMoney(adjustment.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {canFinancialReview ? (
            (() => {
              const history = matching.financialReviewHistory.filter(
                (entry) => entry.itemType === "era" && entry.itemIndex === -1,
              );
              const current = history.find((entry) => entry.currentSource);
              const version = current?.decisionVersion ?? 0;
              const completed = current?.disposition === "completed" && current.currentSource;
              const reviewed = current?.disposition === "reviewed" && current.currentSource;
              return (
                <div style={{ marginTop: ".75rem" }}>
                  <label style={labelStyle}>
                    Financial review note or completion reason
                    <input
                      aria-label="Financial review reason"
                      value={financialReason}
                      onChange={(event) => setFinancialReason(event.target.value)}
                      maxLength={1000}
                      style={inputStyle}
                    />
                  </label>
                  <div style={filterRowStyle}>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={financialReviewBusy || financialReason.trim().length < 3}
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "era",
                          -1,
                          "note",
                          version,
                          financialReason,
                        )
                      }
                    >
                      Add note
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={financialReviewBusy || financialReason.trim().length < 3}
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "era",
                          -1,
                          "follow_up",
                          version,
                          financialReason,
                        )
                      }
                    >
                      Flag follow-up
                    </Button>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={
                        financialReviewBusy ||
                        financialReason.trim().length < 3 ||
                        reviewed ||
                        completed
                      }
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "era",
                          -1,
                          "reviewed",
                          version,
                          financialReason,
                        )
                      }
                    >
                      {reviewed ? "ERA reviewed" : "Mark ERA reviewed"}
                    </Button>
                    <Button
                      size="sm"
                      tone="primary"
                      disabled={
                        financialReviewBusy ||
                        financialReason.trim().length < 3 ||
                        !matching.financialReview.canCompleteNonpostingReview ||
                        completed
                      }
                      onClick={() =>
                        void onFinancialDecision(
                          item.id,
                          "era",
                          -1,
                          "completed",
                          version,
                          financialReason,
                        )
                      }
                    >
                      {completed ? "Review completed" : "Complete nonposting review"}
                    </Button>
                    {reviewed || completed ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={financialReviewBusy || financialReason.trim().length < 3}
                        onClick={() =>
                          void onFinancialDecision(
                            item.id,
                            "era",
                            -1,
                            "reopened",
                            version,
                            financialReason,
                          )
                        }
                      >
                        Reopen review
                      </Button>
                    ) : null}
                  </div>
                  {!matching.financialReview.canCompleteNonpostingReview ? (
                    <p style={warningStyle}>
                      Completion is blocked by the financial-review exceptions above.
                    </p>
                  ) : null}
                </div>
              );
            })()
          ) : (
            <p style={mutedStyle}>
              A separate financial-review permission is required to record review decisions.
            </p>
          )}
          {matching.financialReviewHistory.length ? (
            <ol aria-label="Financial review history">
              {matching.financialReviewHistory.map((event) => (
                <li key={`${event.itemType}-${event.itemIndex}-${event.decisionVersion}`}>
                  {event.itemType === "era" ? "ERA" : `Claim ${event.itemIndex + 1}`} ·{" "}
                  {humanize(event.disposition)} · Reviewer {event.reviewerMembershipId.slice(0, 8)}{" "}
                  · {new Date(event.occurredAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC ·{" "}
                  {event.currentSource ? "current source" : "source changed since this decision"} ·{" "}
                  {event.reason}
                </li>
              ))}
            </ol>
          ) : (
            <p style={mutedStyle}>No financial-review decisions recorded.</p>
          )}
          <p style={warningStyle}>
            A completed review is only a nonposting acknowledgement. It does not approve or execute
            a payment.
          </p>
        </section>
      ) : null}
      <section aria-labelledby="controlled-posting-heading" style={matchPanelStyle}>
        <h3 id="controlled-posting-heading" style={sectionTitleStyle}>
          Controlled M25 posting
        </h3>
        <p style={mutedStyle}>
          Posting requires a current server-generated plan, a separate approver, and an explicit
          execution action. Review and approval alone do not create payment records.
        </p>
        {postingError ? (
          <div role="alert" style={errorStyle}>
            {postingError}
          </div>
        ) : null}
        {postingPlan ? (
          <>
            <dl style={summaryGridStyle}>
              <Summary label="Plan status" value={humanize(postingPlan.status)} />
              <Summary label="Proposed ERA payment" value={centsMoney(postingPlan.paymentCents)} />
              <Summary
                label="Total submitted charges"
                value={centsMoney(postingPlan.billedCents)}
              />
              <Summary
                label="Unresolved adjustment amount"
                value={centsMoney(postingPlan.unresolvedCents)}
              />
              <Summary label="Claims in batch" value={String(postingPlan.claims?.length ?? 0)} />
              <Summary label="Approval" value={humanize(postingPlan.approval)} />
              <Summary
                label="Execution capability"
                value={postingPlan.featureEnabled ? "Enabled for this environment" : "Disabled"}
              />
            </dl>
            <p style={mutedStyle}>Payer: {postingPlan.payer ?? "Unverified"}</p>
            <div style={{ overflowX: "auto", marginBlock: "0.75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <caption style={mutedStyle}>
                  Every claim below is bound to this approval. One blocker prevents the entire ERA
                  posting. Unresolved amounts are preserved for review and are not treated as a
                  patient bill or automatic write-off.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Claim</th>
                    <th scope="col">Billed</th>
                    <th scope="col">Payer paid</th>
                    <th scope="col">Patient responsibility reported</th>
                    <th scope="col">Adjustment / unresolved</th>
                    <th scope="col">Identity</th>
                    <th scope="col">Financial state</th>
                    <th scope="col">Eligibility</th>
                  </tr>
                </thead>
                <tbody>
                  {(postingPlan.claims ?? []).map((claim) => {
                    const href =
                      claim.claimId && claim.billingModule
                        ? claimHref(claim.billingModule, claim.claimId)
                        : null;
                    return (
                      <tr key={`${claim.claimIndex}-${claim.claimId ?? "unmatched"}`}>
                        <th scope="row">
                          {href ? (
                            <Link to={href}>{claim.patientControlNumber ?? "Open claim"}</Link>
                          ) : (
                            (claim.patientControlNumber ?? "Unmatched claim")
                          )}
                          {claim.payerIcn ? (
                            <small
                              style={{ display: "block", color: "var(--color-on-surface-variant)" }}
                            >
                              Payer ref: {claim.payerIcn}
                            </small>
                          ) : null}
                        </th>
                        <td>{centsMoney(claim.billedCents)}</td>
                        <td>{centsMoney(claim.paidCents)}</td>
                        <td>{centsMoney(claim.patientResponsibilityCents)}</td>
                        <td>
                          {claim.adjustments.some((adjustment) => adjustment.groupCode === "PR") ? (
                            <small
                              style={{ display: "block", color: "var(--color-on-surface-variant)" }}
                            >
                              CLP05 is the reported total; PR CAS entries explain that amount and
                              are not added a second time.
                            </small>
                          ) : null}
                          {claim.adjustments.length ? (
                            <ul style={outcomeListStyle}>
                              {claim.adjustments.map((adjustment, index) => (
                                <li
                                  key={`${adjustment.groupCode}-${adjustment.reasonCode}-${index}`}
                                >
                                  {adjustment.groupCode} / CARC {adjustment.reasonCode}:{" "}
                                  {centsMoney(adjustment.amountCents)}
                                  {adjustment.classification === "other_adjustment_unresolved"
                                    ? " · unresolved, flagged for review"
                                    : ""}
                                  {adjustment.groupCode === "CO"
                                    ? " · payer-reported provider responsibility; policy required; no write-off is authorized"
                                    : ""}
                                  {adjustment.groupCode === "PR"
                                    ? " · payer-reported patient responsibility; no patient invoice or receivable is authorized"
                                    : ""}
                                  {adjustment.groupCode === "PI"
                                    ? " · payer-initiated reduction; accounting treatment is not authorized"
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            "No reported CAS adjustment"
                          )}
                          {claim.unresolvedCents ? (
                            <small
                              style={{ display: "block", color: "var(--color-on-surface-variant)" }}
                            >
                              Unresolved amount: {centsMoney(claim.unresolvedCents)}
                            </small>
                          ) : null}
                        </td>
                        <td>{humanize(claim.matching)}</td>
                        <td>{humanize(claim.financialStatus)}</td>
                        <td>
                          {claim.eligible ? (
                            <StatusPill label="Eligible" tone="success" />
                          ) : (
                            <StatusPill label="Blocked" tone="error" />
                          )}
                          {claim.blockers.length ? (
                            <ul
                              aria-label={`Claim ${claim.claimIndex + 1} blockers`}
                              style={outcomeListStyle}
                            >
                              {claim.blockers.map((blocker) => (
                                <li key={blocker}>{postingBlocker(blocker)}</li>
                              ))}
                            </ul>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {postingPlan.blockers.length ? (
              <ul aria-label="Posting blockers" style={outcomeListStyle}>
                {postingPlan.blockers.map((blocker) => (
                  <li key={blocker}>
                    <StatusPill label="Blocked" tone="error" /> {postingBlocker(blocker)}
                  </li>
                ))}
              </ul>
            ) : (
              <output style={mutedStyle}>
                Every claim passes the fully paid, no-adjustment rules. The entire batch executes
                atomically.
              </output>
            )}
            <label style={labelStyle}>
              Posting action reason
              <input
                aria-label="Posting action reason"
                value={postingReason}
                onChange={(event) => setPostingReason(event.target.value)}
                maxLength={500}
                style={inputStyle}
              />
            </label>
            <div style={filterRowStyle}>
              {canPostingApprove ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={
                    postingBusy ||
                    postingReason.trim().length < 3 ||
                    !postingPlan.eligible ||
                    postingPlan.approval !== "not_approved"
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        "Approve this exact posting plan? This records approval only and does not post payment.",
                      )
                    )
                      void onApprovePosting(postingPlan, postingReason);
                  }}
                >
                  Approve plan
                </Button>
              ) : null}
              {canPostingExecute ? (
                <Button
                  size="sm"
                  tone="primary"
                  disabled={
                    postingBusy ||
                    postingReason.trim().length < 3 ||
                    !postingPlan.featureEnabled ||
                    postingPlan.approval !== "approved" ||
                    !postingPlan.eligible
                  }
                  onClick={() => {
                    if (window.confirm("Execute the approved M25 payment posting?"))
                      void onExecutePosting(postingPlan, postingReason);
                  }}
                >
                  Execute approved posting
                </Button>
              ) : null}
              <Button
                size="sm"
                tone="secondary"
                disabled={postingBusy}
                onClick={onRefreshPostingPlan}
              >
                {postingBusy ? "Refreshing…" : "Refresh posting plan"}
              </Button>
            </div>
            {!postingPlan.featureEnabled ? (
              <p style={warningStyle}>
                Controlled Claim.MD posting is disabled in this environment. No execution action is
                available.
              </p>
            ) : null}
          </>
        ) : (
          <div style={filterRowStyle}>
            <p style={mutedStyle}>The server has not generated a posting plan for this stage.</p>
            {canFinancialReview ? (
              <Button
                size="sm"
                tone="secondary"
                disabled={postingBusy}
                onClick={onRefreshPostingPlan}
              >
                {postingBusy ? "Checking…" : "Review posting readiness"}
              </Button>
            ) : (
              <p style={mutedStyle}>Financial-review permission is required to request a plan.</p>
            )}
          </div>
        )}
        {postingHistory.length ? (
          <ol aria-label="Posting history">
            {postingHistory.map((event) => (
              <li key={`${event.planId}-${event.eventType}-${event.occurredAt}`}>
                {humanize(event.eventType)} ·{" "}
                {new Date(event.occurredAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC ·{" "}
                {event.reason}
                {event.eventType === "posted"
                  ? ` · M25 committed ${(event.remittanceLineIds ?? []).length} claim record${(event.remittanceLineIds ?? []).length === 1 ? "" : "s"}; downstream processing may still be pending`
                  : ""}
              </li>
            ))}
          </ol>
        ) : (
          <p style={mutedStyle}>No posting approval or execution history.</p>
        )}
      </section>
      {item.holdReason ? (
        <output style={warningPanelStyle}>
          <strong>Held for review</strong>
          <div>{holdExplanation(item.holdReason)}</div>
          <div style={mutedStyle}>
            This view cannot change ownership or retry delivery. Contact an authorized platform
            operator.
          </div>
        </output>
      ) : null}
      {item.duplicateClassification !== "none" ? (
        <div role="alert" style={warningPanelStyle}>
          <strong>
            {item.duplicateClassification === "exact" ? "Exact duplicate" : "Possible duplicate"}
          </strong>
          <div>
            {item.duplicateClassification === "exact"
              ? "The source matches an existing remittance identity and was not staged as a new financial effect."
              : "Do not treat this stage as a new financial identity. Compare its existing remittance reference through an authorized review workflow."}
          </div>
        </div>
      ) : null}
      {!item.detailsAvailable ? (
        <div role="alert" style={errorStyle}>
          Protected remittance details are unavailable. The source is retained; contact an
          authorized administrator.
        </div>
      ) : null}
      <h3 style={sectionTitleStyle}>Claims and service lines</h3>
      {item.claims.length === 0 ? (
        <p style={mutedStyle}>No claim transactions are available in this staged detail.</p>
      ) : (
        item.claims.map((claim, index) => {
          return (
            <article key={`${claim.patientControlNumber ?? "claim"}-${index}`} style={claimStyle}>
              <div style={claimHeaderStyle}>
                <div>
                  <strong>
                    Claim {claim.patientControlNumber ?? "control number unavailable"}
                  </strong>
                  <div style={mutedStyle}>
                    Payer reference: {claim.payerIcn ?? "—"} · status code {claim.statusCode ?? "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <strong>{money(claim.totalPayment)}</strong>
                  <div style={mutedStyle}>of {money(claim.totalCharge)} reported</div>
                </div>
              </div>
              <div style={mutedStyle}>
                Service period: {formatDay(claim.serviceFrom)} – {formatDay(claim.serviceTo)} ·
                patient responsibility: {money(claim.patientResponsibility)}
              </div>
              {claim.serviceLines.length ? (
                <div style={scrollStyle}>
                  <table style={lineTableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Service</th>
                        <th style={thStyle}>Charge</th>
                        <th style={thStyle}>Paid</th>
                        <th style={thStyle}>Adjustments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claim.serviceLines.map((line, lineIndex) => (
                        <tr
                          key={`${line.procedureCode ?? line.revenueCode ?? "line"}-${lineIndex}`}
                        >
                          <td style={tdStyle}>
                            {line.procedureCode ?? line.revenueCode ?? "Uncoded service"}
                          </td>
                          <td style={tdStyle}>{money(line.chargeAmount)}</td>
                          <td style={tdStyle}>{money(line.paidAmount)}</td>
                          <td style={tdStyle}>
                            {line.adjustments.length
                              ? line.adjustments.map((adj, adjIndex) => (
                                  <div key={`${adj.groupCode}-${adj.reasonCode}-${adjIndex}`}>
                                    {adj.groupCode ?? "—"} {adj.reasonCode ?? "—"}:{" "}
                                    {money(adj.amount)}
                                  </div>
                                ))
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {claim.adjustments.length ? (
                <div style={adjustmentStyle}>
                  <strong>Claim adjustments</strong>
                  {claim.adjustments.map((adjustment) => (
                    <span
                      key={`${adjustment.groupCode ?? ""}-${adjustment.reasonCode ?? ""}-${adjustment.amount}-${adjustment.quantity ?? ""}`}
                    >
                      {adjustment.groupCode ?? "—"} {adjustment.reasonCode ?? "—"}:{" "}
                      {money(adjustment.amount)}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })
      )}
      {item.claimOutcomes.length ? (
        <>
          <h3 style={sectionTitleStyle}>Claim identity results</h3>
          <p style={mutedStyle}>
            These outcomes record identity correlation from verified submission evidence. They are
            not payment allocation or financial reconciliation.
          </p>
          <ul style={outcomeListStyle}>
            {item.claimOutcomes.map((outcome, index) => {
              const href =
                outcome.claimId && outcome.module
                  ? claimHref(outcome.module, outcome.claimId)
                  : null;
              return (
                <li key={`${outcome.fileIndex}-${index}`}>
                  {outcome.patientControlNumber ?? "Claim reference unavailable"}:{" "}
                  <strong>{humanize(outcome.outcome)}</strong>
                  {outcome.module ? ` · ${outcome.module}` : ""}
                  {href ? (
                    <>
                      {" "}
                      · <Link to={href}>Open claim</Link>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <section aria-labelledby="claim-match-review-heading" style={matchPanelStyle}>
        <h3 id="claim-match-review-heading" style={sectionTitleStyle}>
          Claim identity matching
        </h3>
        <p style={mutedStyle}>
          Source-verified identities and human-reviewed historical attempts are shown separately. A
          claim match does not allocate payment or post financial activity.
        </p>
        {matchLoading ? <output>Loading matching evidence…</output> : null}
        {matchError ? (
          <div role="alert" style={errorStyle}>
            {matchError}
          </div>
        ) : null}
        {matching ? (
          <>
            <dl style={summaryGridStyle}>
              <Summary
                label="Verified source identities"
                value={String(matching.verifiedSourceIdentities)}
              />
              <Summary
                label="Unresolved identities"
                value={String(matching.unresolvedSourceIdentities)}
              />
              <Summary
                label="ERA payment balance"
                value={
                  matching.readOnlyBalance.status === "balanced"
                    ? "Balances"
                    : matching.readOnlyBalance.status === "discrepancy"
                      ? `Difference ${money(matching.readOnlyBalance.differenceCents / 100)}`
                      : "Unavailable"
                }
              />
            </dl>
            {matching.claims.map((match) => {
              const outcome = item.claimOutcomes[match.claimIndex];
              const verifiedClaimHref =
                match.linkedClaimId && (match.linkedModule ?? outcome?.module)
                  ? claimHref(match.linkedModule ?? outcome!.module!, match.linkedClaimId)
                  : null;
              return (
                <div key={match.claimIndex}>
                  <div style={matchRowStyle}>
                    <div>
                      <strong>
                        {match.patientControlNumber ?? `ERA claim ${match.claimIndex + 1}`}
                      </strong>
                      <div style={mutedStyle}>
                        {humanize(match.outcome)} ·{" "}
                        {verifiedClaimHref ? (
                          <Link to={verifiedClaimHref}>Open claim</Link>
                        ) : match.linkedClaimId ? (
                          "Claim link unavailable"
                        ) : (
                          "No claim linked"
                        )}
                        {match.decision !== "unreviewed"
                          ? ` · ${humanize(match.decision)} (v${match.decisionVersion})`
                          : " · awaiting reviewer confirmation"}
                      </div>
                    </div>
                    {canResolveIdentity &&
                    match.outcome === "verified" &&
                    match.decision !== "confirmed_identity" ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={matchBusy || reviewReason.trim().length < 3}
                        onClick={() =>
                          void onIdentityDecision(
                            match.claimIndex,
                            "confirm_identity",
                            match.decisionVersion,
                            reviewReason,
                          )
                        }
                      >
                        Confirm identity
                      </Button>
                    ) : null}
                    {canResolveIdentity &&
                    ["ambiguous", "unmatched", "unsupported"].includes(match.outcome) &&
                    match.decision !== "human_confirmed_candidate" ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={matchBusy || candidateLoading === match.claimIndex}
                        onClick={() => void onLoadCandidates(match.claimIndex)}
                      >
                        {candidateLoading === match.claimIndex
                          ? "Searching…"
                          : "Find historical claim"}
                      </Button>
                    ) : null}
                    {canResolveIdentity &&
                    ["confirmed_identity", "human_confirmed_candidate"].includes(match.decision) ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={matchBusy || reviewReason.trim().length < 3}
                        onClick={() =>
                          void onIdentityDecision(
                            match.claimIndex,
                            "clear",
                            match.decisionVersion,
                            reviewReason,
                          )
                        }
                      >
                        Clear decision
                      </Button>
                    ) : null}
                  </div>
                  {match.serviceLines.length ? (
                    <ul aria-label={`Service-line identity for ERA claim ${match.claimIndex + 1}`}>
                      {match.serviceLines.map((line) => (
                        <li key={line.lineIndex}>
                          ERA line {line.lineIndex + 1}
                          {line.payerLineReference
                            ? ` · payer REF*6R ${line.payerLineReference}`
                            : " · payer line reference not supplied"}
                          {line.outcome === "original_line_evidence_unavailable"
                            ? " · original submitted line snapshot unavailable; no line match made"
                            : " · no line match made"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {candidatePages[match.claimIndex] ? (
                    <div style={{ ...matchRowStyle, display: "block", marginTop: "-.25rem" }}>
                      {!candidatePages[match.claimIndex]!.candidates.length ? (
                        <p style={mutedStyle}>
                          No historical submission attempt with matching tenant, provider, payer,
                          account and patient control number was found.
                        </p>
                      ) : null}
                      {candidatePages[match.claimIndex]!.complete === false ? (
                        <output style={warningStyle}>
                          The candidate search was capped. No candidate from this incomplete result
                          can be confirmed.
                        </output>
                      ) : null}
                      {candidatePages[match.claimIndex]!.candidates.map((candidate) => (
                        <label
                          key={candidate.evidenceId}
                          style={{ ...labelStyle, display: "block", marginTop: ".6rem" }}
                        >
                          <input
                            type="radio"
                            name={`candidate-${match.claimIndex}`}
                            value={candidate.evidenceId}
                            checked={selectedEvidence[match.claimIndex] === candidate.evidenceId}
                            disabled={
                              !candidate.selectable || !candidatePages[match.claimIndex]!.complete
                            }
                            onChange={() =>
                              setSelectedEvidence((current) => ({
                                ...current,
                                [match.claimIndex]: candidate.evidenceId,
                              }))
                            }
                          />
                          <strong>
                            {candidate.module} {humanize(candidate.lineage)} ·{" "}
                            {humanize(candidate.attemptState)}
                          </strong>
                          <span>
                            {" "}
                            · Payer {candidate.payerId} · {candidate.usage} environment · Submitted{" "}
                            {new Date(candidate.submittedAt).toLocaleDateString("en-US", {
                              timeZone: "UTC",
                            })}{" "}
                            · Charge{" "}
                            {candidate.chargeCents === null
                              ? "unavailable"
                              : money(candidate.chargeCents / 100)}
                          </span>
                          <span> · {candidate.supportingEvidence.join("; ")}</span>
                          <span> · Original submitted service-line evidence unavailable</span>
                          {!candidate.selectable ? (
                            <span> · Insufficient matching evidence; selection is blocked</span>
                          ) : null}
                        </label>
                      ))}
                      {canResolveIdentity &&
                      candidatePages[match.claimIndex]!.candidates.some(
                        (candidate) => candidate.selectable,
                      ) ? (
                        <div style={{ marginTop: ".8rem" }}>
                          <label style={labelStyle}>
                            Reason for manual claim association
                            <input
                              aria-label="Manual matching reason"
                              value={reviewReason}
                              onChange={(event) => setReviewReason(event.target.value)}
                              maxLength={500}
                              style={inputStyle}
                            />
                          </label>
                          <Button
                            size="sm"
                            tone="primary"
                            disabled={
                              matchBusy ||
                              reviewReason.trim().length < 3 ||
                              !selectedEvidence[match.claimIndex] ||
                              !candidatePages[match.claimIndex]!.complete
                            }
                            onClick={() =>
                              void onIdentityDecision(
                                match.claimIndex,
                                "confirm_candidate",
                                match.decisionVersion,
                                reviewReason,
                                selectedEvidence[match.claimIndex],
                              )
                            }
                          >
                            Confirm reviewed claim
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {canResolveIdentity && matching.verifiedSourceIdentities > 0 ? (
              <label style={labelStyle}>
                Review reason
                <input
                  aria-label="Matching review reason"
                  value={reviewReason}
                  onChange={(event) => setReviewReason(event.target.value)}
                  maxLength={500}
                  style={inputStyle}
                />
              </label>
            ) : !canResolveIdentity ? (
              <p style={mutedStyle}>
                You can inspect identity evidence. A separate matching-review permission is required
                to record a decision.
              </p>
            ) : null}
            {matching.decisionHistory.length ? (
              <ol aria-label="Claim matching decision history">
                {matching.decisionHistory.map((decision, index) => (
                  <li key={`${decision.claimIndex}-${decision.decisionVersion}-${index}`}>
                    Claim {decision.claimIndex + 1}: {humanize(decision.decision)} ·{" "}
                    {new Date(decision.occurredAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
                    · {decision.reason}
                  </li>
                ))}
              </ol>
            ) : (
              <p style={mutedStyle}>No reviewer decision has been recorded.</p>
            )}
            <p style={warningStyle}>
              Service-line matching is unavailable until an original submitted line reference can be
              verified. No line association has been inferred.
            </p>
          </>
        ) : null}
      </section>
      {item.providerAdjustments.length ? (
        <section aria-labelledby="provider-adjustments-heading" style={matchPanelStyle}>
          <h3 id="provider-adjustments-heading" style={sectionTitleStyle}>
            Provider-level adjustment review
          </h3>
          <p style={warningStyle}>
            PLB amounts adjust the ERA payment at provider level. They are not claim payments. A
            balanced ERA does not authorize a write-off, recovery, refund, or reversal. No effective
            financial adjustment policy is configured, so these items remain nonposting.
          </p>
          <div style={scrollStyle}>
            <table style={lineTableStyle} aria-label="Provider-level adjustment evidence">
              <thead>
                <tr>
                  <th style={thStyle}>Source occurrence</th>
                  <th style={thStyle}>Reason / reference</th>
                  <th style={thStyle}>Signed amount</th>
                  <th style={thStyle}>Evidence and disposition</th>
                </tr>
              </thead>
              <tbody>
                {item.providerAdjustments.map((adjustment) => (
                  <tr
                    key={`${adjustment.segmentPosition ?? "legacy"}-${adjustment.occurrence ?? "legacy"}-${adjustment.reason ?? ""}`}
                  >
                    <td style={tdStyle}>
                      {adjustment.segmentPosition === null || adjustment.occurrence === null
                        ? "Position unavailable (legacy source)"
                        : `Segment ${adjustment.segmentPosition}, pair ${adjustment.occurrence}`}
                      <br />
                      Fiscal period: {adjustment.fiscalPeriod ?? "Unavailable"}
                      <br />
                      Provider identifier: {adjustment.providerIdentifierMasked ?? "Unavailable"}
                    </td>
                    <td style={tdStyle}>
                      {adjustment.reason ?? "Code unavailable"} ·{" "}
                      {humanize(adjustment.classification)}
                      <br />
                      Reference: {adjustment.reference ?? "None reported"}
                    </td>
                    <td style={tdStyle}>{money(adjustment.amount)}</td>
                    <td style={tdStyle}>
                      Historical link: not verified
                      <br />
                      Policy: not configured · no financial action
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matching ? (
            <p style={mutedStyle}>
              ERA balance:{" "}
              {matching.financialReview.balance.status === "balanced"
                ? "the reported claim payments, signed provider adjustments, and BPR total balance"
                : matching.financialReview.balance.status === "discrepancy"
                  ? `difference ${centsMoney(matching.financialReview.balance.differenceCents)}`
                  : "unavailable from the source facts"}
              . This is source arithmetic only; it does not confirm bank settlement or financial
              authorization.
            </p>
          ) : null}
          {canFinancialReview ? (
            <Button
              size="sm"
              tone="secondary"
              disabled={financialReviewBusy || financialReason.trim().length < 3 || !matching}
              onClick={() => {
                const latest = matching?.financialReviewHistory.find(
                  (entry) =>
                    entry.itemType === "era" && entry.itemIndex === -1 && entry.currentSource,
                );
                void onFinancialDecision(
                  item.id,
                  "era",
                  -1,
                  "follow_up",
                  latest?.decisionVersion ?? 0,
                  financialReason,
                );
              }}
            >
              Record provider-adjustment investigation
            </Button>
          ) : (
            <p style={mutedStyle}>
              A separate financial-review permission is required to record an investigation note.
            </p>
          )}
        </section>
      ) : null}
      <h3 style={sectionTitleStyle}>Processing history</h3>
      {item.history.availability === "unavailable" ? (
        <p style={mutedStyle}>
          Processing history is unavailable for this stage. No historical events have been inferred
          from its current status.
        </p>
      ) : (
        <>
          {item.history.availability === "partial" ? (
            <p style={warningStyle}>
              Earlier processing history may be unavailable. Events below are backed by durable
              records only.
            </p>
          ) : null}
          {item.history.events.length === 0 ? (
            <p style={mutedStyle}>No durable processing events are available.</p>
          ) : (
            <ol style={timelineStyle} aria-label="ERA processing history">
              {item.history.events.map((event, index) => (
                <li
                  key={`${event.eventType}-${event.occurredAt}-${index}`}
                  style={timelineItemStyle}
                >
                  <div style={timelineHeadingStyle}>
                    <Glyph name={event.origin === "recovery" ? "rotate-ccw" : "clock"} size={15} />
                    <strong>{event.description}</strong>
                  </div>
                  <time dateTime={event.occurredAt} style={mutedStyle}>
                    {new Date(event.occurredAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
                  </time>
                  {event.reasonCode ? (
                    <div style={mutedStyle}>Reason: {humanize(event.reasonCode)}</div>
                  ) : null}
                  {event.attemptCount !== null ? (
                    <div style={mutedStyle}>Recorded attempts: {event.attemptCount}</div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <div style={nonpostingStyle}>
        Nonposting review only. Claim identity confirmations do not allocate payment or authorize
        posting.
      </div>
    </div>
  );
}

function claimHref(module: string, claimId: string): string | null {
  const id = encodeURIComponent(claimId);
  if (module === "M23") return `/billing/claims/${id}`;
  if (module === "M41") return `/commercial/billing/claims/${id}`;
  if (module === "M24") return `/medicaid/billing/claims/${id}`;
  return null;
}

function holdExplanation(code: string): string {
  switch (code) {
    case "POSSIBLE_CROSS_SOURCE_DUPLICATE":
      return "A matching remittance may already exist in another intake path. Review its identity before any later financial processing.";
    case "PAYEE_IDENTITY_AMBIGUOUS":
    case "MIXED_PROVIDER_OR_TENANT":
      return "The source cannot be safely attributed to one authorized provider. Platform review is required.";
    case "PAYEE_IDENTITY_CONFLICT":
    case "CLAIM_OWNER_CONFLICT":
      return "Ownership evidence conflicts with the verified billing identity. Status changes alone cannot resolve this hold.";
    case "DELIVERY_RETRY_LIMIT":
      return "Automated staging retries are exhausted. An authorized platform operator must inspect the delivery history.";
    case "DELIVERY_AUTHORIZATION_CHANGED":
      return "The verified delivery authorization changed before staging. Platform review is required.";
    case "STALE_OR_UNVERIFIED_RESOLUTION":
    case "STALE_RESOLUTION_DURING_DELIVERY":
      return "The ownership decision is stale or unverified. New verified evidence is required before delivery.";
    default:
      return `Processing is held (${humanize(code)}). This view cannot change ownership or retry delivery.`;
  }
}

function postingBlocker(code: string): string {
  const explanations: Record<string, string> = {
    STAGE_NOT_DELIVERED: "The staged ERA is not in a delivered review state.",
    POSSIBLE_DUPLICATE: "A duplicate or cross-source match needs resolution first.",
    OWNERSHIP_EVIDENCE_INSUFFICIENT: "Provider ownership evidence is incomplete.",
    SOURCE_IDENTITY_INCOMPLETE:
      "The source digest, account identity, or payment trace is unavailable.",
    UNSUPPORTED_CLAIM_COUNT: "Only a single-claim ERA is supported by this posting path.",
    MATCH_IDENTITY_CONFLICT: "Authoritative claim identifiers conflict.",
    MATCH_NOT_VERIFIED:
      "A current source-verified or owner-revalidated claim association is required.",
    MATCH_REFERENCES_INCOMPLETE: "The claim's control number or service dates are missing.",
    MEDICARE_POSTING_NOT_CERTIFIED:
      "The historical M23 hospice claim is matched for review, but Medicare Claim.MD financial posting is not certified. This ERA cannot be posted through this workflow.",
    PAYER_ROUTE_UNVERIFIED:
      "No supported internal payer route matches the historical claim evidence.",
    FINANCIAL_REVIEW_INCOMPLETE_OR_STALE:
      "Complete the current nonposting financial review before requesting approval.",
    PROTECTED_SOURCE_INVALID: "The protected parsed source could not be verified.",
    UNSUPPORTED_OR_INCOMPLETE_835:
      "The 835 contains unsupported or incomplete payment identity facts.",
    UNSUPPORTED_FINANCIAL_FACTS:
      "The source facts do not fit a currently supported, fully balanced Claim.MD accounting scenario.",
    PROVIDER_ADJUSTMENT_POLICY_UNAVAILABLE:
      "The ERA contains a provider-level adjustment without an effective authorized policy. The whole posting plan is blocked; investigate the source without assigning the amount to a claim.",
    CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE:
      "The ERA reports provider responsibility (CO), but no effective payer and organization policy authorizes a contractual write-off. No balance is written off.",
    PATIENT_RESPONSIBILITY_POLICY_UNAVAILABLE:
      "The ERA reports patient responsibility (PR), but no authorized patient billing policy is bound to this plan. No patient invoice or receivable is created.",
    PAYER_REDUCTION_POLICY_UNAVAILABLE:
      "The ERA reports a payer-initiated reduction (PI), but no accounting rule authorizes settling that amount.",
    PARSED_CLAIM_PROJECTION_MISMATCH: "The protected source and staged claim summary disagree.",
    PAYMENT_BALANCE_UNSUPPORTED: "The reported payment does not balance under the supported rules.",
    POTENTIAL_CROSS_SOURCE_DUPLICATE:
      "An existing M25 payment has the same trace and amount; reconcile it before proceeding.",
  };
  return explanations[code] ?? "This source requires an unsupported review or accounting action.";
}

function financialExceptionGuidance(code: string): string {
  switch (code) {
    case "UPSTREAM_STAGE_HELD":
      return "The staging issue must be reviewed by an authorized platform operator; this screen cannot change ownership or retry delivery.";
    case "EXACT_DUPLICATE_ERA":
      return "This source was classified as an exact duplicate and must not be treated as a new financial effect.";
    case "POSSIBLE_DUPLICATE_ERA":
      return "Compare the existing source through the authorized duplicate-review process before treating this as new.";
    case "CLAIM_IDENTITY_CONFLICT":
      return "Verified identity facts conflict. Stop and request a platform or source-owner investigation.";
    case "CLAIM_IDENTITY_UNRESOLVED":
      return "Review the separate claim-matching evidence; do not infer a claim association from amount or date.";
    case "ERA_PAYMENT_BALANCE_DISCREPANCY":
      return "Compare the reported ERA total, claim payments and provider-level adjustments. Do not force a balancing adjustment.";
    case "ERA_PAYMENT_BALANCE_UNVERIFIED":
      return "Required source amounts are unavailable, so the balance cannot be confirmed.";
    case "PROVIDER_ADJUSTMENT_REQUIRES_POLICY_REVIEW":
      return "The provider-level amount is included in the ERA balance, but no exact-scope financial policy authorizes a posting action. Record an investigation note; do not assign it to a claim.";
    case "SERVICE_LINE_REFERENCE_MISSING":
      return "Original submitted-line evidence is unavailable; no internal line allocation can be verified.";
    case "REVERSAL_REQUIRES_INVESTIGATION":
      return "Confirm the prior payment/reversal context through an authorized financial workflow before any future posting.";
    case "ADJUSTMENT_GROUP_UNSUPPORTED":
      return "The original adjustment code is shown, but its accounting treatment is not configured here.";
    default:
      return "Review the source and follow the established financial policy; no posting action is available here.";
  }
}

function Summary({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt style={eyebrowStyle}>{label}</dt>
      <dd style={summaryValueStyle}>{value}</dd>
    </div>
  );
}

function centsMoney(value: number | null): string {
  return value === null ? "Unavailable" : money(value / 100);
}

const subheadStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
  maxWidth: "70rem",
};
const filterStyle = { padding: "0 1.5rem 1rem", display: "grid", gap: "0.85rem" };
const noticeStyle = {
  display: "flex",
  gap: ".5rem",
  alignItems: "center",
  padding: ".75rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: ".875rem",
};
const errorStyle = {
  color: "var(--color-error)",
  padding: ".75rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
};
const filterRowStyle = {
  display: "flex",
  alignItems: "end",
  flexWrap: "wrap" as const,
  gap: ".75rem",
};
const labelStyle = {
  display: "grid",
  gap: ".25rem",
  color: "var(--color-on-surface-variant)",
  fontSize: ".75rem",
  fontWeight: 600,
};
const inputStyle = {
  minHeight: "2.35rem",
  padding: ".35rem .55rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  font: "inherit",
};
const summaryStyle = { color: "var(--color-on-surface-variant)", fontSize: ".8rem" };
const centerStyle = { display: "grid", placeItems: "center", minHeight: "12rem" };
const layoutStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 28rem), 1fr))",
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
  alignItems: "start",
};
const listStyle = {
  minWidth: 0,
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
};
const detailStyle = {
  minWidth: 0,
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
  position: "sticky" as const,
  top: "1rem",
  maxHeight: "calc(100vh - 2rem)",
  overflow: "auto",
};
const detailContentStyle = { padding: "1rem", display: "grid", gap: ".85rem" };
const scrollStyle = { width: "100%", overflowX: "auto" as const };
const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: ".83rem" };
const lineTableStyle = { ...tableStyle, minWidth: "34rem", marginTop: ".75rem" };
const thStyle = {
  textAlign: "left" as const,
  padding: ".65rem .6rem",
  borderBottom: "1px solid var(--color-outline-variant)",
  color: "var(--color-on-surface-variant)",
  fontSize: ".7rem",
  letterSpacing: ".04em",
};
const tdStyle = {
  padding: ".65rem .6rem",
  borderBottom: "1px solid var(--color-surface-container)",
  verticalAlign: "top" as const,
  color: "var(--color-on-surface)",
};
const rowStyle = { borderBottom: "1px solid var(--color-surface-container)" };
const selectedRowStyle = { ...rowStyle, background: "var(--color-surface-low)" };
const mutedStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".78rem",
  marginTop: ".2rem",
};
const warningStyle = { color: "var(--color-warning)", fontSize: ".72rem", marginTop: ".25rem" };
const moreStyle = { padding: ".75rem", display: "flex", justifyContent: "center" };
const detailHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "start",
  gap: ".75rem",
  borderBottom: "1px solid var(--color-outline-variant)",
  paddingBottom: ".85rem",
};
const eyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".65rem",
  letterSpacing: ".06em",
  fontWeight: 700,
};
const titleStyle = { margin: ".25rem 0", fontSize: "1.1rem", color: "var(--color-on-surface)" };
const summaryGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: ".75rem",
  margin: 0,
  padding: ".75rem",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface-low)",
};
const summaryValueStyle = {
  margin: ".2rem 0 0",
  fontSize: ".9rem",
  fontWeight: 650,
  color: "var(--color-on-surface)",
};
const warningPanelStyle = {
  padding: ".75rem",
  borderRadius: "var(--radius-sm)",
  border: "1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)",
  background: "color-mix(in srgb, var(--color-warning) 9%, transparent)",
  color: "var(--color-on-surface)",
  fontSize: ".82rem",
};
const sectionTitleStyle = {
  margin: ".25rem 0 0",
  fontSize: ".95rem",
  color: "var(--color-on-surface)",
};
const claimStyle = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-sm)",
  padding: ".75rem",
  display: "grid",
  gap: ".45rem",
};
const matchPanelStyle = {
  borderTop: "1px solid var(--color-outline-variant)",
  paddingTop: ".8rem",
  display: "grid",
  gap: ".65rem",
};
const matchRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: ".75rem",
  padding: ".7rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-sm)",
};
const claimHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: ".75rem",
  alignItems: "start",
  fontSize: ".85rem",
};
const outcomeListStyle = {
  display: "grid",
  gap: ".4rem",
  paddingLeft: "1.25rem",
  fontSize: ".82rem",
};
const timelineStyle = { margin: 0, paddingLeft: "1.25rem", display: "grid", gap: ".75rem" };
const timelineItemStyle = { paddingLeft: ".25rem" };
const timelineHeadingStyle = { display: "flex", alignItems: "start", gap: ".5rem" };
const adjustmentStyle = {
  display: "grid",
  gap: ".25rem",
  fontSize: ".78rem",
  color: "var(--color-on-surface-variant)",
};
const nonpostingStyle = {
  marginTop: ".25rem",
  borderTop: "1px solid var(--color-outline-variant)",
  paddingTop: ".75rem",
  color: "var(--color-on-surface-variant)",
  fontSize: ".78rem",
};
