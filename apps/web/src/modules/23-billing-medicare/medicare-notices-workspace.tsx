import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageHeader,
  SelectField,
  StatusPill,
  TextField,
  type operations,
  useApiClient,
  useAttemptKey,
} from "@chartwarden/ui";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";

type WorklistOperation = operations["getApiV1BillingMedicarenoticeworklist"];
type WorklistPage = WorklistOperation["responses"][200]["content"]["application/json"];
type WorkItem = WorklistPage["items"][number];
type NoticeType = WorkItem["identity"]["type"];
type WorklistQuery = NonNullable<WorklistOperation["parameters"]["query"]>;

const NOTICE_LABEL: Record<NoticeType, string> = {
  noe: "Notice of Election · 81A",
  notr: "Termination / Revocation · 81B",
  transfer: "Change of provider · 8xC",
  cancellation: "Transfer cancellation · 8xD",
};

const READ_PERMISSIONS: Record<NoticeType, string> = {
  noe: "billing.noe.read",
  notr: "billing.notr.read",
  transfer: "billing.noe.read",
  cancellation: "billing.noe.read",
};

const RISK_OPTIONS = [
  "overdue",
  "rejected",
  "transport_rejected",
  "accepted_after_deadline",
  "due_today",
  "approaching",
  "submitted_awaiting_verification",
  "filing_timeliness_unknown",
  "on_track",
  "accepted_within_deadline",
  "not_applicable",
  "not_determinable",
];
const TYPE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "", label: "All supported notice types" },
  ...Object.entries(NOTICE_LABEL).map(([value, label]) => ({ value, label })),
];
const STATE_OPTIONS = [
  "",
  "draft",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_rejected",
  "cancelled",
];

const shortId = (value: string | null | undefined): string =>
  value ? value.slice(0, 8) : "Not recorded";
const dateLabel = (value: string | null | undefined): string => {
  if (!value) return "Not applicable";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${month}/${day}/${year}` : "Date unavailable";
};

function riskPresentation(item: WorkItem): {
  label: string;
  tone: "neutral" | "progress" | "success" | "warning" | "error";
} {
  if (item.macAcceptance === "verified")
    return { label: "MAC acceptance verified", tone: "success" };
  if (item.lifecycle === "outcome_unknown")
    return { label: "Outcome unknown · investigate", tone: "error" };
  switch (item.deadline.risk) {
    case "overdue":
      return { label: "Overdue · acceptance unverified", tone: "error" };
    case "due_today":
      return { label: "Due today · MAC evidence required", tone: "error" };
    case "approaching":
      return { label: "Deadline approaching", tone: "warning" };
    case "not_applicable":
      return { label: "No deadline applies", tone: "neutral" };
    case "transport_rejected":
      return { label: "Transport rejected · filing unverified", tone: "error" };
    case "rejected":
      return { label: "Rejected · correction review", tone: "error" };
    case "accepted_after_deadline":
      return { label: "Accepted after deadline", tone: "warning" };
    case "accepted_within_deadline":
      return { label: "Accepted within deadline", tone: "success" };
    case "on_track":
      return { label: "Within filing window", tone: "progress" };
    default:
      return { label: "Deadline status needs verification", tone: "warning" };
  }
}

function lifecycleLabel(value: string): string {
  const labels: Record<string, string> = {
    draft: "Draft",
    ready: "Internally ready · transport blocked",
    submitted: "Submission recorded · acceptance unverified",
    ack_pending: "Awaiting MAC evidence",
    ack_accepted: "MAC acceptance verified",
    ack_rejected: "MAC rejection verified",
    outcome_unknown: "In doubt · reconciliation required",
    transport_receipt_confirmed: "Transport receipt · awaiting MAC evidence",
    transport_rejected: "Transport rejected · not filed",
    dispatch_started: "Dispatch started · outcome unresolved",
  };
  return labels[value] ?? `Lifecycle: ${value.replaceAll("_", " ")}`;
}

function destination(item: WorkItem): string {
  switch (item.identity.type) {
    case "noe":
      return `/billing/noe/${item.identity.noticeId}`;
    case "notr":
      return `/billing/notr/${item.identity.noticeId}`;
    case "transfer":
      return `/billing/transfer-notices?notice=${encodeURIComponent(item.identity.noticeId)}`;
    case "cancellation":
      return `/billing/transfer-notices?notice=${encodeURIComponent(item.identity.noticeId)}&kind=cancellation`;
  }
}

function canRead(item: WorkItem, permissions: readonly string[]): boolean {
  return permissions.includes(READ_PERMISSIONS[item.identity.type]);
}

function PageCounts({ page }: { page: WorklistPage }): JSX.Element {
  const counts = page.counts;
  const values: readonly [string, number][] = [
    ["Requires attention", counts.requiresAttention],
    ["Approaching", counts.deadlineApproaching],
    ["Overdue", counts.overdue],
    ["Transport held", counts.heldByTransportCapability],
    ["In doubt", counts.inDoubt],
    ["Awaiting MAC evidence", counts.awaitingMacEvidence],
  ];
  return (
    <section className="wx-notice-counts" aria-label="Counts on this page">
      <div className="wx-notice-counts-head">
        <h2>On this page</h2>
        <p>These categories overlap; they are not organization-wide totals.</p>
      </div>
      <dl>
        {values.map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Readiness({ item }: { item: WorkItem }): JSX.Element {
  const blocked = item.readiness.filter((check) => check.state === "blocked");
  const review = item.readiness.filter(
    (check) => check.state === "verification_required" || check.state === "unknown",
  );
  const okay = item.readiness.filter((check) => check.state === "ready");
  const notApplicable = item.readiness.filter((check) => check.state === "not_applicable");
  const ordered = [...blocked, ...review, ...okay, ...notApplicable];
  const groups = [
    {
      key: "source",
      label: "Source and configuration",
      checks: ordered.filter((check) => check.blockingStage === null),
    },
    {
      key: "render",
      label: "Internal rendering and artifact",
      checks: ordered.filter((check) => check.blockingStage === "render"),
    },
    {
      key: "dispatch",
      label: "Submission and transport",
      checks: ordered.filter((check) => check.blockingStage === "dispatch"),
    },
    {
      key: "reconciliation",
      label: "Acknowledgment and reconciliation",
      checks: ordered.filter((check) => check.blockingStage === "reconciliation"),
    },
  ].filter((group) => group.checks.length > 0);
  const stateLabel = (state: string): string =>
    ({
      ready: "Ready",
      blocked: "Blocked",
      not_applicable: "Not applicable",
      unknown: "Unknown",
      verification_required: "Verification required",
    })[state] ?? "Verification required";
  return (
    <details className="wx-notice-readiness">
      <summary>
        Readiness checks ·{" "}
        {blocked.length
          ? `${blocked.length} blocked`
          : review.length
            ? "verification required"
            : "review"}
      </summary>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h3>{group.label}</h3>
          <ul>
            {group.checks.map((check, index) => (
              <li key={`${check.key}:${index}`}>
                <strong>{check.key.replaceAll("_", " ")}: </strong>
                <span>{stateLabel(check.state)}</span>
                <p>{check.message}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}

export function MedicareNoticesWorkspace(): JSX.Element {
  const client = useApiClient();
  const attempt = useAttemptKey();
  const navigate = useNavigate();
  const session = useSession();
  const permissions = session?.permissions ?? [];
  const currentMembershipId = session?.membershipId;
  const [type, setType] = useState("");
  const [state, setState] = useState("");
  const [deadlineRisk, setDeadlineRisk] = useState("");
  const [readiness, setReadiness] = useState<"" | "blocked" | "verification_required" | "ready">(
    "",
  );
  const [requiresAttention, setRequiresAttention] = useState(false);
  const [providerEntityId, setProviderEntityId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [eventFrom, setEventFrom] = useState("");
  const [eventTo, setEventTo] = useState("");
  const [exceptionReviewStatus, setExceptionReviewStatus] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<Partial<WorklistQuery>>({});
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<WorklistPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [issueActionError, setIssueActionError] = useState<string | null>(null);
  const [issueActionPending, setIssueActionPending] = useState<string | null>(null);

  const requestQuery = useMemo<WorklistQuery>(
    () => ({
      limit: 25,
      providerEntityId: appliedFilters.providerEntityId ?? "",
      ...(pageCursors[pageIndex] ? { cursor: pageCursors[pageIndex]! } : {}),
      ...appliedFilters,
    }),
    [pageCursors, pageIndex, appliedFilters],
  );

  useEffect(() => {
    void retry; // Retry explicitly repeats this request with the current signed cursor.
    let active = true;
    setLoading(true);
    setLoadError(null);
    if (!requestQuery.providerEntityId) {
      setPage(null);
      setLoadError("Enter a provider entity ID to load the provider-scoped notice worklist.");
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void client
      .GET("/api/v1/billing/medicare-notice-worklist", { params: { query: requestQuery } })
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          setPage(null);
          setLoadError(
            "Medicare notices could not be loaded. You may lack notice-read permission or the service may be unavailable.",
          );
        } else {
          setPage(data);
          setLoadError(null);
          setPageCursors((current) => {
            if (!data.nextCursor) return current.slice(0, pageIndex + 1);
            if (current[pageIndex + 1] === data.nextCursor) return current;
            return [...current.slice(0, pageIndex + 1), data.nextCursor];
          });
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setPage(null);
          setLoadError("Medicare notices could not be loaded. Check your connection and retry.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, requestQuery, pageIndex, retry]);

  const resetPages = (): void => {
    setPageCursors([null]);
    setPageIndex(0);
    setPage(null);
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!providerEntityId.trim()) {
      setLoadError("Enter a provider entity ID to load the provider-scoped notice worklist.");
      return;
    }
    setAppliedFilters({
      ...(type ? { type: [type as NoticeType] } : {}),
      ...(state ? { state: state as NonNullable<WorklistQuery["state"]> } : {}),
      ...(deadlineRisk ? { deadlineRisk } : {}),
      ...(readiness ? { readiness } : {}),
      ...(requiresAttention ? { requiresAttention: true } : {}),
      providerEntityId: providerEntityId.trim(),
      ...(patientId.trim() ? { patientId: patientId.trim() } : {}),
      ...(admissionId.trim() ? { admissionId: admissionId.trim() } : {}),
      ...(eventFrom ? { eventFrom } : {}),
      ...(eventTo ? { eventTo } : {}),
      ...(exceptionReviewStatus ? { exceptionReviewStatus } : {}),
    });
    resetPages();
  };

  const goNext = (): void => {
    if (!page?.nextCursor) return;
    setPageCursors((current) =>
      current[pageIndex + 1] === page.nextCursor
        ? current
        : [...current.slice(0, pageIndex + 1), page.nextCursor],
    );
    setPageIndex((current) => current + 1);
  };

  const canReadAny =
    permissions.includes("billing.noe.read") || permissions.includes("billing.notr.read");
  const rows = (page?.items ?? []).filter((item) => canRead(item, permissions));

  return (
    <main className="wx-page wx-medicare-notices">
      <BillingTabs />
      <PageHeader title="Medicare notices">
        <p>
          Review NOE, NOTR, transfer and supported cancellation work. Rendering readiness, transport
          status, deadlines and MAC evidence are shown separately.
        </p>
      </PageHeader>
      {!canReadAny ? (
        <InlineAlert tone="warning">
          You do not have notice-read permission for this workspace.
        </InlineAlert>
      ) : null}
      {page && canReadAny ? <PageCounts page={page} /> : null}

      <section className="wx-notice-workspace-panel" aria-labelledby="notice-filter-heading">
        <h2 id="notice-filter-heading">Filter work</h2>
        <form onSubmit={applyFilters} className="wx-notice-filter-grid">
          <SelectField
            label="Notice type"
            value={type}
            options={TYPE_OPTIONS}
            onChange={(event) => setType(event.target.value)}
          />
          <SelectField
            label="Lifecycle state"
            value={state}
            options={STATE_OPTIONS.map((value) => ({
              value,
              label: value ? lifecycleLabel(value) : "All states",
            }))}
            onChange={(event) => setState(event.target.value)}
          />
          <SelectField
            label="Deadline risk"
            value={deadlineRisk}
            options={[
              { value: "", label: "All deadline states" },
              ...RISK_OPTIONS.map((value) => ({ value, label: value.replaceAll("_", " ") })),
            ]}
            onChange={(event) => setDeadlineRisk(event.target.value)}
          />
          <SelectField
            label="Readiness"
            value={readiness}
            options={[
              { value: "", label: "All readiness states" },
              { value: "blocked", label: "Blocked" },
              { value: "verification_required", label: "Verification required" },
              { value: "ready", label: "Ready" },
            ]}
            onChange={(event) => setReadiness(event.target.value as typeof readiness)}
          />
          <TextField
            label="Provider entity ID"
            value={providerEntityId}
            onChange={(event) => setProviderEntityId(event.target.value)}
            hint="Exact ID filter; no name search."
          />
          <TextField
            label="Patient ID"
            value={patientId}
            onChange={(event) => setPatientId(event.target.value)}
            hint="Exact ID filter; no name search."
          />
          <TextField
            label="Admission ID"
            value={admissionId}
            onChange={(event) => setAdmissionId(event.target.value)}
            hint="Exact ID filter; no name search."
          />
          <TextField
            label="Event from"
            type="date"
            value={eventFrom}
            onChange={(event) => setEventFrom(event.target.value)}
          />
          <TextField
            label="Event to"
            type="date"
            value={eventTo}
            onChange={(event) => setEventTo(event.target.value)}
          />
          <SelectField
            label="NOE exception review"
            value={exceptionReviewStatus}
            options={[
              { value: "", label: "Any review status" },
              ...[
                "draft",
                "evidence_required",
                "ready_for_external_request",
                "request_recorded",
                "awaiting_external_determination",
                "external_approved_recorded",
                "external_denied_recorded",
                "withdrawn",
              ].map((value) => ({ value, label: value.replaceAll("_", " ") })),
            ]}
            onChange={(event) => setExceptionReviewStatus(event.target.value)}
          />
          <label className="wx-notice-attention">
            <input
              type="checkbox"
              checked={requiresAttention}
              onChange={(event) => setRequiresAttention(event.target.checked)}
            />{" "}
            Requires attention
          </label>
          <div className="wx-notice-filter-actions">
            <Button type="submit">Apply filters</Button>
            <Button
              type="button"
              tone="secondary"
              onClick={() => {
                setType("");
                setState("");
                setDeadlineRisk("");
                setReadiness("");
                setRequiresAttention(false);
                setProviderEntityId("");
                setPatientId("");
                setAdmissionId("");
                setEventFrom("");
                setEventTo("");
                setExceptionReviewStatus("");
                setAppliedFilters({});
                resetPages();
              }}
            >
              Clear filters
            </Button>
          </div>
        </form>
      </section>

      {loading ? <LoadingSpinner /> : null}
      {!loading && loadError ? (
        <InlineAlert tone="error">
          <span>
            {loadError}{" "}
            <button
              type="button"
              className="wx-btn-link"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>{" "}
            ·{" "}
            <button type="button" className="wx-btn-link" onClick={resetPages}>
              Restart from first page
            </button>
          </span>
        </InlineAlert>
      ) : null}
      {!loading && !loadError && page && rows.length === 0 ? (
        <EmptyState
          title="No notices on this page"
          description="Change filters or move back to the previous result page. No organization-wide count is inferred from this page."
        />
      ) : null}

      {!loading && !loadError && page ? (
        <section
          className="wx-notice-items"
          aria-label="Medicare notice results"
          aria-live="polite"
        >
          {rows.map((item) => {
            const risk = riskPresentation(item);
            const blockers = item.readiness.filter((check) => check.state === "blocked");
            const awaiting = item.readiness.filter(
              (check) => check.state === "verification_required" || check.state === "unknown",
            );
            return (
              <article
                className="wx-notice-card"
                key={`${item.identity.type}:${item.identity.noticeId}`}
              >
                <header className="wx-notice-card-head">
                  <div>
                    <p className="wx-notice-eyebrow">{NOTICE_LABEL[item.identity.type]}</p>
                    <h2>
                      <Link to={destination(item)}>{item.identity.noticeId}</Link>
                    </h2>
                  </div>
                  <StatusPill label={risk.label} tone={risk.tone} />
                </header>
                <dl className="wx-notice-facts">
                  <div>
                    <dt>Patient reference</dt>
                    <dd>{shortId(item.patientId)}</dd>
                  </div>
                  <div>
                    <dt>Admission reference</dt>
                    <dd>{shortId(item.admissionId)}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{shortId(item.providerEntityId)}</dd>
                  </div>
                  <div>
                    <dt>
                      {item.identity.type === "noe"
                        ? "Election date"
                        : item.identity.type === "notr"
                          ? "Termination / revocation date"
                          : "Transfer event date"}
                    </dt>
                    <dd>{dateLabel(item.eventDate)}</dd>
                  </div>
                  <div>
                    <dt>Applicable deadline</dt>
                    <dd>
                      {item.deadline.dueDate
                        ? dateLabel(item.deadline.dueDate)
                        : item.deadline.risk === "not_applicable"
                          ? "No deadline applies"
                          : "Not determinable"}
                    </dd>
                  </div>
                  <div>
                    <dt>Lifecycle</dt>
                    <dd>{lifecycleLabel(item.lifecycle)}</dd>
                  </div>
                </dl>
                {blockers.length > 0 ? (
                  <output className="wx-notice-blocker" aria-live="polite">
                    <strong>Blocked:</strong> {blockers.map((check) => check.message).join(" ")}
                  </output>
                ) : null}
                {blockers.length === 0 && awaiting.length > 0 ? (
                  <div className="wx-notice-verification" role="note">
                    <strong>Verification required:</strong> {awaiting[0]?.message}
                  </div>
                ) : null}
                {item.latestAttempt?.dispatchState === "in_doubt" ||
                item.lifecycle === "outcome_unknown" ? (
                  <InlineAlert tone="error">
                    This attempt may have reached the gateway. Investigate or reconcile it;
                    automatic resend is not available.
                  </InlineAlert>
                ) : null}
                {item.exceptionReview ? (
                  <p className="wx-notice-review-status">
                    Exception review:{" "}
                    <strong>{item.exceptionReview.status.replaceAll("_", " ")}</strong>
                    {item.exceptionReview.decisionProvenance
                      ? " · external decision recorded by an authorized operator (not verified MAC acceptance)"
                      : ""}
                  </p>
                ) : null}
                {item.operationalIssues.length > 0 ? (
                  <section className="wx-notice-follow-up" aria-label="Operational follow-up">
                    <h3>Operational follow-up</h3>
                    <ul>
                      {item.operationalIssues.map((issue) => (
                        <li
                          key={`${issue.identity.type}:${issue.identity.noticeId}:${issue.identity.kind}`}
                        >
                          <div>
                            <StatusPill
                              label={
                                issue.severity === "critical"
                                  ? "Urgent"
                                  : issue.severity === "warning"
                                    ? "Action needed"
                                    : "Evidence pending"
                              }
                              tone={
                                issue.severity === "critical"
                                  ? "error"
                                  : issue.severity === "warning"
                                    ? "warning"
                                    : "progress"
                              }
                            />{" "}
                            <span>{issue.summary}</span>
                            <small>
                              Responsible area: {issue.responsibleArea.replaceAll("_", " ")}
                            </small>
                          </div>
                          {issue.permittedAction === "open_dde_queue" ? (
                            <Link to="/billing/dde">Open DDE work queue</Link>
                          ) : issue.permittedAction === "open_noe_exception_review" &&
                            item.identity.type === "noe" ? (
                            <Link to={`/billing/noe/${item.identity.noticeId}/exception-review`}>
                              Continue exception review
                            </Link>
                          ) : (
                            <Link to={destination(item)}>Investigate notice</Link>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p>
                      These follow-ups reflect persisted notice evidence. Opening or dismissing an
                      alert does not resolve the underlying filing or acceptance status.
                    </p>
                  </section>
                ) : null}
                {(item.persistedIssues ?? []).length > 0 ? (
                  <section className="wx-notice-follow-up" aria-label="Assigned operational issues">
                    <h3>Operational issue history</h3>
                    <ul>
                      {(item.persistedIssues ?? []).map((issue) => (
                        <li key={issue.id}>
                          <div>
                            <StatusPill
                              label={`${issue.severity} · ${issue.status}`}
                              tone={
                                issue.severity === "critical"
                                  ? "error"
                                  : issue.severity === "warning"
                                    ? "warning"
                                    : "progress"
                              }
                            />{" "}
                            <span>{issue.issueCode.replaceAll("_", " ")}</span>
                            <small>
                              {issue.assignedMembershipId
                                ? `Assigned to membership ${shortId(issue.assignedMembershipId)}`
                                : "Unassigned"}
                              {issue.acknowledgedAt ? " · acknowledged" : " · not acknowledged"}
                            </small>
                            {issue.notificationDeliveryState === "retry_exhausted" ? (
                              <small>
                                Notification delivery needs recipient or assignment configuration.
                              </small>
                            ) : null}
                          </div>
                          {issue.status !== "resolved" &&
                          issue.status !== "superseded" &&
                          permissions.includes(
                            item.identity.type === "notr"
                              ? "billing.notr.submit"
                              : "billing.noe.submit",
                          ) ? (
                            <div className="wx-notice-issue-actions">
                              {!issue.acknowledgedAt ? (
                                <Button
                                  type="button"
                                  tone="secondary"
                                  disabled={issueActionPending === issue.id}
                                  onClick={() => {
                                    setIssueActionPending(issue.id);
                                    setIssueActionError(null);
                                    void attempt
                                      .run(`notice-issue:${issue.id}:acknowledge:${issue.version}`, (key) =>
                                        client.POST(
                                        "/api/v1/billing/medicare-notice-issues/{id}/acknowledge",
                                        {
                                          params: {
                                            path: { id: issue.id },
                                            header: { "Idempotency-Key": key },
                                          },
                                          body: { expectedVersion: issue.version },
                                        },
                                        ),
                                      )
                                      .then(({ error }) => {
                                        if (error)
                                          setIssueActionError(
                                            "The issue could not be acknowledged. Refresh and retry if it is still active.",
                                          );
                                        else setRetry((value) => value + 1);
                                      })
                                      .catch(() =>
                                        setIssueActionError(
                                          "The issue could not be acknowledged. Check your connection and retry.",
                                        ),
                                      )
                                      .finally(() => setIssueActionPending(null));
                                  }}
                                >
                                  Acknowledge
                                </Button>
                              ) : null}
                              {currentMembershipId &&
                              issue.assignedMembershipId !== currentMembershipId ? (
                                <Button
                                  type="button"
                                  tone="secondary"
                                  disabled={issueActionPending === issue.id}
                                  onClick={() => {
                                    setIssueActionPending(issue.id);
                                    setIssueActionError(null);
                                    void attempt
                                      .run(
                                        `notice-issue:${issue.id}:assign:${currentMembershipId}:${issue.version}`,
                                        (key) =>
                                          client.POST(
                                            "/api/v1/billing/medicare-notice-issues/{id}/assign",
                                            {
                                              params: {
                                                path: { id: issue.id },
                                                header: { "Idempotency-Key": key },
                                              },
                                              body: {
                                                expectedVersion: issue.version,
                                                assignedMembershipId: currentMembershipId,
                                              },
                                            },
                                          ),
                                      )
                                      .then(({ error }) => {
                                        if (error)
                                          setIssueActionError(
                                            "The issue could not be assigned. Confirm that you have notice-work permission and retry.",
                                          );
                                        else setRetry((value) => value + 1);
                                      })
                                      .catch(() =>
                                        setIssueActionError(
                                          "The issue could not be assigned. Check your connection and retry.",
                                        ),
                                      )
                                      .finally(() => setIssueActionPending(null));
                                  }}
                                >
                                  Assign to me
                                </Button>
                              ) : null}
                              {issue.assignedMembershipId ? (
                                <Button
                                  type="button"
                                  tone="secondary"
                                  disabled={issueActionPending === issue.id}
                                  onClick={() => {
                                    setIssueActionPending(issue.id);
                                    setIssueActionError(null);
                                    void attempt
                                      .run(
                                        `notice-issue:${issue.id}:unassign:${issue.version}`,
                                        (key) =>
                                          client.POST(
                                            "/api/v1/billing/medicare-notice-issues/{id}/assign",
                                            {
                                              params: {
                                                path: { id: issue.id },
                                                header: { "Idempotency-Key": key },
                                              },
                                              body: {
                                                expectedVersion: issue.version,
                                                assignedMembershipId: null,
                                              },
                                            },
                                          ),
                                      )
                                      .then(({ error }) => {
                                        if (error)
                                          setIssueActionError(
                                            "The issue could not be unassigned. Refresh and retry if it is still active.",
                                          );
                                        else setRetry((value) => value + 1);
                                      })
                                      .catch(() =>
                                        setIssueActionError(
                                          "The issue could not be unassigned. Check your connection and retry.",
                                        ),
                                      )
                                      .finally(() => setIssueActionPending(null));
                                  }}
                                >
                                  Unassign
                                </Button>
                              ) : null}
                              {issue.ddeWorkItemId ? (
                                <Link to="/billing/dde">Open DDE work</Link>
                              ) : null}
                              {item.identity.type === "noe" &&
                              issue.issueCode.startsWith("exception_review") ? (
                                <Link
                                  to={`/billing/noe/${item.identity.noticeId}/exception-review`}
                                >
                                  Open exception review
                                </Link>
                              ) : null}
                              <IssueHistory issueId={issue.id} />
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <p>
                      Acknowledgment records that work was seen; it does not resolve the underlying
                      notice condition.
                    </p>
                  </section>
                ) : null}
                <Readiness item={item} />
                <footer className="wx-notice-card-actions">
                  {canRead(item, permissions) ? (
                    <Button type="button" onClick={() => navigate(destination(item))}>
                      Open notice
                    </Button>
                  ) : (
                    <span>Notice detail is outside your current read scope.</span>
                  )}
                  {item.identity.type === "noe" &&
                  canRead(item, permissions) &&
                  item.nextActions.includes("open_noe_exception_review") ? (
                    <Link to={`/billing/noe/${item.identity.noticeId}/exception-review`}>
                      Review exception evidence
                    </Link>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </section>
      ) : null}

      {issueActionError ? <InlineAlert tone="error">{issueActionError}</InlineAlert> : null}

      {page ? (
        <nav className="wx-notice-pagination" aria-label="Notice result pages">
          <Button
            type="button"
            tone="secondary"
            disabled={pageIndex === 0 || loading}
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          >
            Previous
          </Button>
          <span>
            Result page {pageIndex + 1} · {page.items.length} records
          </span>
          <Button
            type="button"
            tone="secondary"
            disabled={!page.hasMore || !page.nextCursor || loading}
            onClick={goNext}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </main>
  );
}

function IssueHistory({ issueId }: { issueId: string }): JSX.Element {
  const client = useApiClient();
  const [events, setEvents] = useState<
    readonly { eventType: string; reasonCode: string; occurredAt: string }[] | null
  >(null);
  const [error, setError] = useState(false);
  return (
    <details
      onToggle={(event) => {
        if (!event.currentTarget.open || events !== null) return;
        void client
          .GET("/api/v1/billing/medicare-notice-issues/{id}/history", {
            params: { path: { id: issueId } },
          })
          .then(({ data, error: responseError }) => {
            if (responseError || !data) {
              setError(true);
              return;
            }
            setEvents(data);
          })
          .catch(() => setError(true));
      }}
    >
      <summary>Issue history</summary>
      {error ? (
        <p>Issue history is temporarily unavailable.</p>
      ) : events === null ? (
        <p>Open to load history.</p>
      ) : (
        <ol>
          {events.map((entry, index) => (
            <li key={`${entry.eventType}:${entry.occurredAt}:${index}`}>
              {entry.eventType.replaceAll("_", " ")} · {entry.reasonCode.replaceAll("_", " ")} ·{" "}
              {dateLabel(entry.occurredAt)}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
