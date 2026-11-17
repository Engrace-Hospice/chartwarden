import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  PageHeader,
  SelectField,
  StatusPill,
  type operations,
  useApiClient,
  useAttemptKey,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import { stepUpDraftKey } from "../../shell/step-up-redirect";
import { clearDraft, loadDraft, saveDraft } from "./write-workflow";

type ReviewOperation = operations["getApiV1NoerecordsByIdExceptionreviews"];
type Review = ReviewOperation["responses"][200]["content"]["application/json"]["items"][number];
type NoeOperation = operations["getApiV1NoerecordsById"];
type Noe = NoeOperation["responses"][200]["content"]["application/json"];
type DocumentsOperation = operations["getApiV1Documents"];
type Document =
  DocumentsOperation["responses"][200]["content"]["application/json"]["items"][number];
type HistoryOperation = operations["getApiV1NoerecordsByIdExceptionreviewsByReviewIdHistory"];
type HistoryEvent =
  HistoryOperation["responses"][200]["content"]["application/json"]["items"][number];

type ReviewDraft = {
  category: Review["category"] | "";
  justificationDocumentId: string;
  evidenceDocumentIds: string[];
  additionalEvidenceIds: string[];
  requestDate: string;
  requestReference: string;
  requestEvidenceId: string;
  decision: "approved" | "denied" | "";
  authority: "a_b_mac" | "cms" | "";
  decisionDate: string;
  decisionEvidenceId: string;
};

const categories: readonly { value: Review["category"]; label: string }[] = [
  { value: "operations_disruption", label: "Hospice operational disruption" },
  { value: "cms_mac_system_issue", label: "CMS or MAC system issue" },
  { value: "new_hospice_access_delay", label: "New hospice access delay" },
  { value: "other_external_determination", label: "Other external determination" },
];
const authorities = [
  { value: "", label: "Select the authority shown on the external record" },
  { value: "a_b_mac", label: "A/B MAC" },
  { value: "cms", label: "CMS" },
] as const;
const EMPTY_DRAFT: ReviewDraft = {
  category: "",
  justificationDocumentId: "",
  evidenceDocumentIds: [],
  additionalEvidenceIds: [],
  requestDate: "",
  requestReference: "",
  requestEvidenceId: "",
  decision: "",
  authority: "",
  decisionDate: "",
  decisionEvidenceId: "",
};
const CLOSED = new Set(["external_approved_recorded", "external_denied_recorded", "withdrawn"]);

function documentLabel(document: Document): string {
  const kind =
    document.metadata?.documentType?.replaceAll("_", " ") ??
    document.aggregateType.replaceAll("_", " ");
  return `${document.title} · ${kind} · updated ${new Date(document.updatedAt).toLocaleDateString("en-US")}`;
}

function safeFailure(status: number | undefined, code?: string): string {
  if (status === 401) return "Your session expired. Sign in again before continuing.";
  if (status === 403 && code === "STEP_UP_REQUIRED")
    return "Confirm your identity to record this external event.";
  if (status === 403) return "You do not have permission to make this change.";
  if (status === 404)
    return "The NOE, review, or selected evidence is no longer available in this organization.";
  if (status === 409)
    return "This review changed or an active review already exists. Refresh the review before trying again.";
  if (status === 422)
    return "The selected evidence or review details do not meet the required validation.";
  if (status === 503)
    return "The review service is unavailable right now. Your entered details are still on this page.";
  return "The review action could not be completed. Your entered details are still on this page.";
}

function eventLabel(event: HistoryEvent): string {
  const labels: Record<string, string> = {
    created: "Internal exception review started",
    evidence_updated: "Supporting evidence recorded",
    request_recorded: "External request recorded by an operator",
    decision_recorded: "External decision recorded by an operator",
  };
  return labels[event.eventType] ?? `Review event · ${event.eventType.replaceAll("_", " ")}`;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ").replace(/^\w/, (char) => char.toUpperCase());
}

export function NoeExceptionSummary({ noeId }: { noeId: string }): JSX.Element {
  const client = useApiClient();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/noe-records/{id}/exception-reviews", { params: { path: { id: noeId } } })
      .then(({ data, error: failed }) => {
        if (!active) return;
        setError(Boolean(failed || !data));
        setReviews(data?.items ?? []);
      })
      .catch(() => {
        if (active) {
          setError(true);
          setReviews([]);
        }
      });
    return () => {
      active = false;
    };
  }, [client, noeId]);
  if (error)
    return (
      <InlineAlert tone="warning">
        Exception-review status is unavailable. The NOE deadline and acknowledgment evidence above
        remain unchanged.
      </InlineAlert>
    );
  if (!reviews) return <LoadingSpinner />;
  const review = reviews[0];
  return (
    <section className="wx-notice-review-section" aria-labelledby="noe-exception-summary-heading">
      <h2 id="noe-exception-summary-heading">NOE exception review</h2>
      {review ? (
        <p>
          <StatusPill
            label={statusLabel(review.status)}
            tone={CLOSED.has(review.status) ? "neutral" : "warning"}
          />
          {review.externalDecisionProvenance ? (
            <span>
              {" "}
              External decision recorded by an authorized operator; this is not verified MAC
              acceptance.
            </span>
          ) : null}
        </p>
      ) : (
        <p>No exception review is recorded.</p>
      )}
      {review ? (
        <p>
          Supporting documents: {review.evidenceDocumentIds.length + 1} · Last updated{" "}
          {new Date(review.updatedAt).toLocaleString("en-US")}
        </p>
      ) : null}
      {review ? (
        <p>
          {review.externalRequestDate
            ? `External request recorded on ${review.externalRequestDate}${review.externalRequestReference ? ` · reference ${review.externalRequestReference}` : ""}.`
            : "No external request is recorded."}
        </p>
      ) : null}
      {review?.externalDecision ? (
        <p>
          External {review.externalDecision} decision recorded by an authorized operator on{" "}
          {review.externalDecisionDate}; this is not verified MAC acceptance.
        </p>
      ) : null}
      <Link to={`/billing/noe/${noeId}/exception-review`}>
        {review?.status === "awaiting_external_determination"
          ? "Record or review external determination"
          : review?.status === "ready_for_external_request"
            ? "Review evidence and external request status"
            : review
              ? "Open review and event history"
              : "Review exception evidence"}
      </Link>
    </section>
  );
}

export function NoeExceptionReview(): JSX.Element {
  const { noeId = "" } = useParams<{ noeId: string }>();
  const client = useApiClient();
  const attempt = useAttemptKey();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const canWrite = Boolean(session?.permissions?.includes("billing.noe.submit"));
  const draftKey = stepUpDraftKey(session, "m23-noe-exception-review", noeId);
  const [restored] = useState(() => (draftKey ? loadDraft<ReviewDraft>(draftKey) : null));
  const [draft, setDraft] = useState<ReviewDraft>(() => restored ?? EMPTY_DRAFT);
  const [noe, setNoe] = useState<Noe | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [documents, setDocuments] = useState<Document[] | null>(null);
  const [history, setHistory] = useState<HistoryEvent[] | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [noeResult, reviewResult] = await Promise.all([
        client.GET("/api/v1/noe-records/{id}", { params: { path: { id: noeId } } }),
        client.GET("/api/v1/noe-records/{id}/exception-reviews", {
          params: { path: { id: noeId } },
        }),
      ]);
      if (noeResult.error || !noeResult.data || reviewResult.error || !reviewResult.data) {
        setError("The NOE or its exception-review records are unavailable in your current scope.");
        setLoading(false);
        return;
      }
      setNoe(noeResult.data);
      setReviews(reviewResult.data.items);
      setSelectedReviewId((selected) =>
        reviewResult.data.items.some((item) => item.id === selected)
          ? selected
          : (reviewResult.data.items.find((item) => !CLOSED.has(item.status))?.id ??
            reviewResult.data.items[0]?.id ??
            ""),
      );
      const docsResult = await client.GET("/api/v1/documents", {
        params: { query: { patientId: noeResult.data.patientId, limit: 100 } },
      });
      if (docsResult.error || !docsResult.data) {
        setDocuments([]);
        setNotice(
          "Protected document selection is unavailable. You can open Documents to review the authorized source records.",
        );
      } else {
        setDocuments(
          docsResult.data.items.filter(
            (doc) => doc.patientId === noeResult.data.patientId && doc.status === "active",
          ),
        );
        setNotice(null);
      }
    } catch {
      setError("The NOE review could not be loaded. Check your connection and retry.");
    }
    setLoading(false);
  }, [client, noeId]);

  useEffect(() => {
    void retry; // Retry explicitly refetches the same NOE and review read model.
    void load();
  }, [load, retry]);

  const selectedReview = useMemo(
    () => reviews?.find((review) => review.id === selectedReviewId) ?? null,
    [reviews, selectedReviewId],
  );
  useEffect(() => {
    if (!selectedReview) {
      setHistory(null);
      return;
    }
    let active = true;
    setHistory(null);
    void client
      .GET("/api/v1/noe-records/{id}/exception-reviews/{reviewId}/history", {
        params: { path: { id: noeId, reviewId: selectedReview.id } },
      })
      .then(({ data, error: failed }) => {
        if (active) setHistory(failed || !data ? [] : data.items);
      })
      .catch(() => {
        if (active) setHistory([]);
      });
    return () => {
      active = false;
    };
  }, [client, noeId, selectedReview]);

  const activeReview = reviews?.find((review) => !CLOSED.has(review.status)) ?? null;
  const finalDecisionRecorded =
    reviews?.some(
      (review) =>
        review.status === "external_approved_recorded" ||
        review.status === "external_denied_recorded",
    ) ?? false;
  const availableDocuments = documents ?? [];
  const attachedIds = new Set([
    ...(selectedReview?.evidenceDocumentIds ?? []),
    ...(selectedReview?.justificationDocumentId ? [selectedReview.justificationDocumentId] : []),
  ]);
  const options = availableDocuments.map((document) => ({
    value: document.id,
    label: documentLabel(document),
  }));
  const updateDraft = <K extends keyof ReviewDraft>(key: K, value: ReviewDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function writeAction(
    intent: string,
    send: (
      idempotencyKey: string,
    ) => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await attempt.run(`noe-exception:${noeId}:${intent}`, send);
      if (result.error) {
        const body = result.error as { error?: { code?: string } };
        const message = safeFailure(result.response?.status, body?.error?.code);
        setError(message);
        if (body?.error?.code === "STEP_UP_REQUIRED") {
          if (draftKey) saveDraft(draftKey, draft);
          navigate(
            `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
          );
        }
      } else {
        if (draftKey) clearDraft(draftKey);
        await load();
        setNotice(
          "Review record updated. This records operator activity only; it does not file a notice or verify MAC acceptance.",
        );
      }
    } catch {
      setError(
        "The server could not be reached. Retry the same operation; the idempotency key is retained for a safe retry.",
      );
    }
    setBusy(false);
  }

  async function createReview(): Promise<void> {
    if (!canWrite || !draft.category || !draft.justificationDocumentId) {
      setError("Choose a circumstance category and an active protected justification document.");
      return;
    }
    const category = draft.category;
    await writeAction("create", (key) =>
      client.POST("/api/v1/noe-records/{id}/exception-reviews", {
        params: { path: { id: noeId }, header: { "Idempotency-Key": key } },
        body: {
          category,
          justificationDocumentId: draft.justificationDocumentId,
          evidenceDocumentIds: draft.evidenceDocumentIds,
        },
      }),
    );
  }

  async function addEvidence(): Promise<void> {
    if (!canWrite || !selectedReview || !draft.additionalEvidenceIds.length) return;
    await writeAction(
      `evidence:${selectedReview.id}:${selectedReview.version}:${draft.additionalEvidenceIds.join(",")}`,
      (key) =>
        client.POST("/api/v1/noe-records/{id}/exception-reviews/{reviewId}/evidence", {
          params: {
            path: { id: noeId, reviewId: selectedReview.id },
            header: { "Idempotency-Key": key },
          },
          body: {
            expectedVersion: selectedReview.version,
            evidenceDocumentIds: draft.additionalEvidenceIds,
          },
        }),
    );
  }

  async function recordRequest(): Promise<void> {
    if (
      !canWrite ||
      !selectedReview ||
      !draft.requestEvidenceId ||
      !draft.requestDate ||
      selectedReview.status !== "ready_for_external_request"
    )
      return;
    if (
      !window.confirm(
        "Record that an external exception request was made? WardenX will not send the request.",
      )
    )
      return;
    await writeAction(
      `request:${selectedReview.id}:${selectedReview.version}:${draft.requestDate}:${draft.requestEvidenceId}`,
      (key) =>
        client.POST("/api/v1/noe-records/{id}/exception-reviews/{reviewId}/record-request", {
          params: {
            path: { id: noeId, reviewId: selectedReview.id },
            header: { "Idempotency-Key": key },
          },
          body: {
            expectedVersion: selectedReview.version,
            requestDate: draft.requestDate,
            ...(draft.requestReference.trim()
              ? { requestReference: draft.requestReference.trim() }
              : {}),
            evidenceDocumentId: draft.requestEvidenceId,
          },
        }),
    );
  }

  async function recordDecision(): Promise<void> {
    if (
      !canWrite ||
      !selectedReview ||
      !draft.decisionEvidenceId ||
      !draft.decisionDate ||
      !draft.decision ||
      !draft.authority ||
      selectedReview.status !== "awaiting_external_determination"
    )
      return;
    const { decision, authority, decisionDate, decisionEvidenceId } = draft;
    if (
      !window.confirm(
        "Record this externally received determination as an operator attestation? This does not change MAC acceptance or NOE timeliness.",
      )
    )
      return;
    await writeAction(
      `decision:${selectedReview.id}:${selectedReview.version}:${decision}:${authority}:${decisionDate}:${decisionEvidenceId}`,
      (key) =>
        client.POST("/api/v1/noe-records/{id}/exception-reviews/{reviewId}/record-decision", {
          params: {
            path: { id: noeId, reviewId: selectedReview.id },
            header: { "Idempotency-Key": key },
          },
          body: {
            expectedVersion: selectedReview.version,
            decision,
            authority,
            decisionDate,
            evidenceDocumentId: decisionEvidenceId,
          },
        }),
    );
  }

  if (loading)
    return (
      <main className="wx-page">
        <BillingTabs />
        <LoadingSpinner />
      </main>
    );
  if (error && !noe)
    return (
      <main className="wx-page">
        <BillingTabs />
        <EmptyState
          title="Exception review unavailable"
          description={error}
          action={
            <Button type="button" tone="secondary" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </Button>
          }
        />
      </main>
    );
  if (!noe)
    return (
      <main className="wx-page">
        <BillingTabs />
        <EmptyState
          title="NOE unavailable"
          description="The NOE record could not be loaded in your current organization scope."
        />
      </main>
    );

  const submitted = activeReview !== null || finalDecisionRecorded;
  const chosenJustification = availableDocuments.find(
    (document) => document.id === draft.justificationDocumentId,
  );

  return (
    <main className="wx-page wx-medicare-notices">
      <BillingTabs />
      <PageHeader title="NOE exception review">
        <p>
          Record protected evidence and externally performed actions. WardenX does not decide
          exception eligibility, send a request to CMS/MAC, or change filing status.
        </p>
      </PageHeader>
      <div className="wx-notice-review">
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}
        <section className="wx-notice-review-section" aria-labelledby="filing-context-heading">
          <h2 id="filing-context-heading">Filing context · NOE {noe.noeId}</h2>
          <dl className="wx-notice-facts">
            <div>
              <dt>Admission / election date</dt>
              <dd>{noe.electionEffectiveDate}</dd>
            </div>
            <div>
              <dt>NOE window target</dt>
              <dd>{noe.windowTargetAt}</dd>
            </div>
            <div>
              <dt>Window status</dt>
              <dd>
                {noe.windowBreachedAt
                  ? `Server-recorded breach · ${noe.windowBreachedAt}`
                  : "No breach recorded in this read"}
              </dd>
            </div>
            <div>
              <dt>MAC acceptance</dt>
              <dd>
                {noe.acceptedAt ? `Verified acknowledgment · ${noe.acceptedAt}` : "Not verified"}
              </dd>
            </div>
            <div>
              <dt>External filing record</dt>
              <dd>
                {noe.externalFiling?.filedOn
                  ? `Recorded externally on ${noe.externalFiling.filedOn} · status ${noe.externalFiling.status}`
                  : "None recorded"}
              </dd>
            </div>
          </dl>
          <p role="note">
            An exception review does not revise the original deadline, prove timely filing, or
            replace a verified MAC acknowledgment.
          </p>
          <Link to={`/billing/noe/${noeId}`}>Return to NOE detail</Link>
        </section>

        <section className="wx-notice-review-section" aria-labelledby="circumstances-heading">
          <h2 id="circumstances-heading">Circumstances and supporting evidence</h2>
          {!canWrite ? (
            <InlineAlert tone="warning">
              You can read this review but do not have permission to change it.
            </InlineAlert>
          ) : null}
          {!submitted ? (
            <>
              <SelectField
                label="Circumstance category · required"
                value={draft.category}
                options={[
                  { value: "", label: "Select the circumstances to document" },
                  ...categories,
                ]}
                disabled={!canWrite || busy}
                onChange={(event) =>
                  updateDraft("category", event.target.value as ReviewDraft["category"])
                }
              />
              <SelectField
                label="Justification document"
                value={draft.justificationDocumentId}
                options={[{ value: "", label: "Select an active protected document" }, ...options]}
                disabled={!canWrite || busy || !documents}
                onChange={(event) => updateDraft("justificationDocumentId", event.target.value)}
              />
              {chosenJustification ? <p>Selected: {documentLabel(chosenJustification)}</p> : null}
              <p>
                Attach supporting evidence (optional while saving a draft). Only active documents
                already authorized for this beneficiary are listed. Document contents are not loaded
                here.
              </p>
              <DocumentChoices
                documents={availableDocuments}
                selected={draft.evidenceDocumentIds}
                disabled={!canWrite || busy}
                onChange={(ids) => updateDraft("evidenceDocumentIds", ids)}
              />
              <div className="wx-notice-card-actions">
                <Link to="/documents">Open Documents</Link>
                <Button
                  type="button"
                  disabled={!canWrite || busy || !draft.category || !draft.justificationDocumentId}
                  loading={busy}
                  onClick={() => void createReview()}
                >
                  Save review
                </Button>
              </div>
            </>
          ) : null}
          {submitted && selectedReview ? (
            <>
              {reviews && reviews.length > 1 ? (
                <SelectField
                  label="Review record"
                  value={selectedReviewId}
                  options={reviews.map((review) => ({
                    value: review.id,
                    label: `${statusLabel(review.status)} · ${new Date(review.updatedAt).toLocaleDateString("en-US")}`,
                  }))}
                  onChange={(event) => setSelectedReviewId(event.target.value)}
                />
              ) : null}
              {selectedReview ? (
                <>
                  <p>
                    <strong>State:</strong>{" "}
                    <StatusPill
                      label={statusLabel(selectedReview.status)}
                      tone={CLOSED.has(selectedReview.status) ? "neutral" : "warning"}
                    />
                  </p>
                  <p>
                    <strong>Circumstance:</strong>{" "}
                    {
                      categories.find((category) => category.value === selectedReview.category)
                        ?.label
                    }
                  </p>
                  <p>
                    <strong>Justification:</strong>{" "}
                    <DocumentReference
                      id={selectedReview.justificationDocumentId}
                      documents={availableDocuments}
                    />
                  </p>
                  <p>
                    <strong>Supporting evidence:</strong>{" "}
                    {selectedReview.evidenceDocumentIds.length
                      ? selectedReview.evidenceDocumentIds.map((id) => (
                          <DocumentReference key={id} id={id} documents={availableDocuments} />
                        ))
                      : "None recorded"}
                  </p>
                  <div className="wx-notice-document-list">
                    <p className="wx-field-hint">Add more active, authorized evidence documents.</p>
                    <DocumentChoices
                      documents={availableDocuments.filter(
                        (document) => !attachedIds.has(document.id),
                      )}
                      selected={draft.additionalEvidenceIds}
                      disabled={!canWrite || busy || CLOSED.has(selectedReview.status)}
                      onChange={(ids) => updateDraft("additionalEvidenceIds", ids)}
                    />
                    <Button
                      type="button"
                      tone="secondary"
                      disabled={
                        !canWrite ||
                        busy ||
                        draft.additionalEvidenceIds.length === 0 ||
                        CLOSED.has(selectedReview.status)
                      }
                      loading={busy}
                      onClick={() => void addEvidence()}
                    >
                      Add selected evidence
                    </Button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          {availableDocuments.length === 0 ? (
            <p>
              No active protected documents are available for this beneficiary. Use Documents to
              review or add authorized evidence; the server validates ownership and status again on
              save.
            </p>
          ) : null}
        </section>

        {selectedReview && !CLOSED.has(selectedReview.status) ? (
          <section className="wx-notice-review-section" aria-labelledby="external-request-heading">
            <h2 id="external-request-heading">External request</h2>
            <p>
              This form records a request already made outside WardenX. It does not submit to CMS or
              a MAC.
            </p>
            {selectedReview.externalRequestDate ? (
              <p>
                Request recorded: {selectedReview.externalRequestDate}
                {selectedReview.externalAuthority
                  ? ` · ${selectedReview.externalAuthority === "cms" ? "CMS" : "A/B MAC"}`
                  : ""}
                {selectedReview.externalRequestReference
                  ? ` · reference ${selectedReview.externalRequestReference}`
                  : ""}
              </p>
            ) : selectedReview.status === "ready_for_external_request" ? (
              <>
                <SelectField
                  label="Request evidence document"
                  value={draft.requestEvidenceId}
                  options={[
                    { value: "", label: "Select active evidence of the external request" },
                    ...options,
                  ]}
                  disabled={!canWrite || busy}
                  onChange={(event) => updateDraft("requestEvidenceId", event.target.value)}
                />
                <label className="wx-field-frame">
                  <span>External request date · required</span>
                  <input
                    className="wx-input"
                    type="date"
                    value={draft.requestDate}
                    required
                    disabled={!canWrite || busy}
                    onChange={(event) => updateDraft("requestDate", event.target.value)}
                  />
                </label>
                <label className="wx-field-frame">
                  <span>External reference (optional)</span>
                  <input
                    className="wx-input"
                    value={draft.requestReference}
                    maxLength={200}
                    disabled={!canWrite || busy}
                    onChange={(event) => updateDraft("requestReference", event.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  disabled={!canWrite || busy || !draft.requestEvidenceId || !draft.requestDate}
                  loading={busy}
                  onClick={() => void recordRequest()}
                >
                  Record external request
                </Button>
              </>
            ) : (
              <p>
                Additional validated supporting evidence is required before an external request can
                be recorded.
              </p>
            )}
          </section>
        ) : null}

        {selectedReview && !CLOSED.has(selectedReview.status) ? (
          <section className="wx-notice-review-section" aria-labelledby="external-decision-heading">
            <h2 id="external-decision-heading">External determination</h2>
            {selectedReview.externalDecision ? (
              <InlineAlert tone="info">
                External {selectedReview.externalDecision} decision recorded by an authorized
                operator on {selectedReview.externalDecisionDate}. Provenance: operator-attested
                document. This is not independently verified MAC acknowledgment and does not change
                NOE timeliness.
              </InlineAlert>
            ) : selectedReview.status === "awaiting_external_determination" ? (
              <>
                <p>
                  Record the outcome only after it has been received externally and supported by an
                  active M22 document.
                </p>
                <SelectField
                  label="Decision authority · required"
                  value={draft.authority}
                  options={authorities}
                  disabled={!canWrite || busy}
                  onChange={(event) =>
                    updateDraft("authority", event.target.value as ReviewDraft["authority"])
                  }
                />
                <SelectField
                  label="Externally received decision · required"
                  value={draft.decision}
                  options={[
                    { value: "", label: "Select the outcome on the external record" },
                    { value: "approved", label: "Approved externally" },
                    { value: "denied", label: "Denied externally" },
                  ]}
                  disabled={!canWrite || busy}
                  onChange={(event) =>
                    updateDraft("decision", event.target.value as ReviewDraft["decision"])
                  }
                />
                <label className="wx-field-frame">
                  <span>Decision date · required</span>
                  <input
                    className="wx-input"
                    type="date"
                    value={draft.decisionDate}
                    required
                    disabled={!canWrite || busy}
                    onChange={(event) => updateDraft("decisionDate", event.target.value)}
                  />
                </label>
                <SelectField
                  label="Decision evidence document"
                  value={draft.decisionEvidenceId}
                  options={[
                    { value: "", label: "Select the external determination document" },
                    ...options,
                  ]}
                  disabled={!canWrite || busy}
                  onChange={(event) => updateDraft("decisionEvidenceId", event.target.value)}
                />
                <Button
                  type="button"
                  tone="secondary"
                  disabled={
                    !canWrite ||
                    busy ||
                    !draft.decisionEvidenceId ||
                    !draft.decisionDate ||
                    !draft.decision ||
                    !draft.authority
                  }
                  loading={busy}
                  onClick={() => void recordDecision()}
                >
                  Record external decision
                </Button>
              </>
            ) : (
              <p>
                Record an external request and wait for an externally received determination before
                recording an outcome.
              </p>
            )}
          </section>
        ) : null}

        <section className="wx-notice-review-section" aria-labelledby="review-history-heading">
          <h2 id="review-history-heading">Exception-review history</h2>
          {!selectedReview ? (
            <p>No review history is available until a review is created.</p>
          ) : history === null ? (
            <LoadingSpinner />
          ) : history.length === 0 ? (
            <p>Event history is unavailable or no events have been recorded.</p>
          ) : (
            <ol className="wx-notice-timeline">
              {history.map((event, index) => (
                <li key={`${event.occurredAt}:${event.eventType}:${index}`}>
                  <strong>{eventLabel(event)}</strong>
                  <div>
                    {new Date(event.occurredAt).toLocaleString("en-US")} ·{" "}
                    {statusLabel(event.fromStatus ?? "new")} → {statusLabel(event.toStatus)}
                  </div>
                  {event.evidenceDocumentIds.length ? (
                    <small>
                      Protected evidence references recorded: {event.evidenceDocumentIds.length}
                    </small>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}

function DocumentChoices({
  documents,
  selected,
  disabled,
  onChange,
}: {
  documents: readonly Document[];
  selected: readonly string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}): JSX.Element {
  if (!documents.length) return <p>No eligible active documents found for this beneficiary.</p>;
  return (
    <div className="wx-notice-document-list">
      {documents.map((document) => (
        <label className="wx-notice-document-option" key={document.id}>
          <input
            type="checkbox"
            checked={selected.includes(document.id)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, document.id]
                  : selected.filter((id) => id !== document.id),
              )
            }
          />
          <span>{documentLabel(document)}</span>
        </label>
      ))}
    </div>
  );
}

function DocumentReference({
  id,
  documents,
}: { id: string; documents: readonly Document[] }): JSX.Element {
  const document = documents.find((item) => item.id === id);
  return (
    <span>
      {document
        ? documentLabel(document)
        : `Protected document reference ${id.slice(0, 8)} · unavailable in the current authorized list`}
    </span>
  );
}
