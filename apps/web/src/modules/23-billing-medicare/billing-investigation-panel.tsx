import { Button, LoadingSpinner, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";

type Module = "M23" | "M41";
export interface InvestigationSourceRef {
  readonly sourceModule: Module;
  readonly submissionId: string;
  readonly providerEntityId: string;
}
interface Props {
  readonly source?: InvestigationSourceRef;
  readonly investigationId?: string;
  readonly onClose: () => void;
}
type ApiData = Record<string, unknown>;
type InvestigationApiClient = {
  GET: (path: string, options?: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  POST: (path: string, options?: unknown) => Promise<{ data?: unknown; error?: unknown }>;
};
const requestKey = () => crypto.randomUUID();
const field = (value: unknown): string => (typeof value === "string" ? value : "");

export function BillingInvestigationPanel({
  source,
  investigationId,
  onClose,
}: Props): JSX.Element {
  // The generated schema has >1,900 paths; openapi-fetch's conditional path
  // types exceed TS's instantiation depth in this leaf component. The route
  // schemas remain generated and checked; narrow the local transport surface.
  const client = useApiClient() as unknown as InvestigationApiClient;
  const session = useSession();
  const permissions = new Set(session?.permissions ?? []);
  const canAssign = permissions.has("billing.operations.assign");
  const [detail, setDetail] = useState<ApiData | null>(null);
  const [investigators, setInvestigators] = useState<ApiData[]>([]);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState("referred_to_source_workflow");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadEpoch, setLoadEpoch] = useState(0);
  const requestedSourceModule = source?.sourceModule;
  const requestedSubmissionId = source?.submissionId;
  const refresh = async (caseId: string) => {
    const response = await client.GET("/api/v1/billing/operations/investigations/{id}", {
      params: { path: { id: caseId } },
    });
    if (response.error || !response.data)
      throw new Error("Investigation details are unavailable. Retry the read.");
    setDetail(response.data as unknown as ApiData);
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      setBusy(true);
      setError("");
      try {
        let id = investigationId ?? "";
        if (!id && requestedSourceModule && requestedSubmissionId) {
          const opened = await client.POST("/api/v1/billing/operations/investigations", {
            headers: { "Idempotency-Key": `${loadEpoch}-${requestKey()}` },
            body: { sourceModule: requestedSourceModule, submissionId: requestedSubmissionId },
          });
          if (opened.error || !opened.data)
            throw new Error(
              "Investigation could not be opened. Check access to the source record.",
            );
          id = field((opened.data as unknown as ApiData).id);
        }
        if (!id) throw new Error("Investigation reference is unavailable.");
        const response = await client.GET("/api/v1/billing/operations/investigations/{id}", {
          params: { path: { id } },
        });
        if (response.error || !response.data)
          throw new Error("Investigation details are unavailable. Retry the read.");
        const loaded = response.data as unknown as ApiData;
        if (active) setDetail(loaded);
        const sourceInfo = loaded.source as ApiData | undefined;
        const sourceModule = field(sourceInfo?.sourceModule) as Module;
        const sourceProviderEntityId = field(sourceInfo?.providerEntityId);
        const sourceSubmissionId = field(sourceInfo?.submissionId);
        if (canAssign) {
          const people = await client.GET(
            "/api/v1/billing/operations/investigations/investigators",
            {
              params: {
                query: {
                  providerEntityId: sourceProviderEntityId,
                  sourceModule,
                  submissionId: sourceSubmissionId,
                },
              },
            },
          );
          const peopleData = people.data as ApiData | undefined;
          if (active && peopleData && Array.isArray(peopleData.items))
            setInvestigators(peopleData.items as ApiData[]);
        }
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Investigation service is unavailable.",
          );
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [canAssign, client, loadEpoch, requestedSourceModule, requestedSubmissionId, investigationId]);

  const retryRead = async () => {
    if (!caseId) {
      setLoadEpoch((value) => value + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await refresh(caseId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investigation service is unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (send: () => Promise<{ error?: unknown }>, label: string) => {
    if (!detail) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await send();
      if (response.error)
        throw new Error(
          "The update was refused. Refresh the investigation and review the validation message.",
        );
      await refresh(field((detail.investigation as ApiData | undefined)?.id));
      setNote("");
      setReason("");
      setNotice(label);
      return label;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The update failed.");
    } finally {
      setSaving(false);
    }
  };

  const investigation = detail?.investigation as ApiData | undefined;
  const status = field(investigation?.status);
  const version = Number(investigation?.version ?? 0);
  const caseId = field(investigation?.id);
  const sourceInfo = detail?.source as ApiData | undefined;
  const sourceState = field(sourceInfo?.currentStatus);
  const postAssignment = (body: {
    assignedToMembershipId: string | null;
    version: number;
    reason: string;
  }) =>
    client.POST("/api/v1/billing/operations/investigations/{id}/assignment", {
      params: { path: { id: caseId } },
      headers: { "Idempotency-Key": requestKey() },
      body,
    });
  const postNote = (body: { body: string }) =>
    client.POST("/api/v1/billing/operations/investigations/{id}/notes", {
      params: { path: { id: caseId } },
      headers: { "Idempotency-Key": requestKey() },
      body,
    });
  const postTransition = (body: {
    status: "investigating" | "waiting_external" | "resolved" | "closed";
    version: number;
    reason: string;
    outcome?:
      | "verified_no_action_required"
      | "referred_to_source_workflow"
      | "waiting_for_external_confirmation"
      | "duplicate_investigation"
      | "unable_to_resolve";
  }) =>
    client.POST("/api/v1/billing/operations/investigations/{id}/transitions", {
      params: { path: { id: caseId } },
      headers: { "Idempotency-Key": requestKey() },
      body,
    });

  return (
    <dialog
      open
      aria-labelledby="billing-investigation-title"
      className="billing-investigation-panel"
    >
      <header>
        <div>
          <h2 id="billing-investigation-title">Billing investigation</h2>
          <p>
            {field(sourceInfo?.sourceModule)} ·{" "}
            {sourceState === "in_doubt"
              ? "Submission outcome in doubt. The request may have reached the payer."
              : `Current submission status: ${sourceState || "Unavailable"}.`}
          </p>
          <p>
            Administrative investigation status: <strong>{status || "Opening"}</strong>
          </p>
        </div>
        <Button tone="secondary" size="sm" onClick={onClose}>
          Close panel
        </Button>
      </header>
      {busy ? <LoadingSpinner /> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button
            tone="secondary"
            size="sm"
            disabled={busy || saving}
            onClick={() => void retryRead()}
          >
            Retry read
          </Button>
        </div>
      ) : null}
      {notice ? <output>{notice}</output> : null}
      {detail ? (
        <>
          <section aria-label="Source record">
            <h3>Authoritative source</h3>
            <p>
              The investigation does not change the source submission.{" "}
              <a href={field((detail.source as ApiData | undefined)?.sourceHref)}>
                Open source record
              </a>
            </p>
            <dl>
              <dt>Claim reference</dt>
              <dd>{field((detail.source as ApiData | undefined)?.reference) || "Unavailable"}</dd>
              <dt>Payer</dt>
              <dd>{field((detail.source as ApiData | undefined)?.payer) || "Unavailable"}</dd>
              <dt>Submission attempt</dt>
              <dd>
                {field(sourceInfo?.sourceModule)} · {field(sourceInfo?.attempt)}
              </dd>
            </dl>
            <p>
              Reason:{" "}
              {field((detail.source as ApiData | undefined)?.reasonCode) ||
                "No source reason code recorded"}
            </p>
          </section>
          <section aria-label="Assignment">
            <h3>Assignment</h3>
            <p>
              {investigation?.assignedToMembershipId
                ? field(
                    investigators.find(
                      (person) => person.membershipId === investigation.assignedToMembershipId,
                    )?.displayName,
                  ) || "Assigned investigator"
                : "Unassigned"}
            </p>
            {permissions.has("billing.operations.assign") ? (
              <label>
                Assign investigator
                <select
                  aria-label="Assign investigator"
                  value={field(investigation?.assignedToMembershipId)}
                  disabled={saving}
                  onChange={(event) =>
                    void mutate(
                      () =>
                        postAssignment({
                          assignedToMembershipId: event.target.value || null,
                          version,
                          reason: "Assigned from Billing Operations",
                        }),
                      "Assignment saved",
                    )
                  }
                >
                  <option value="">Unassigned</option>
                  {investigators.map((person) => (
                    <option key={field(person.membershipId)} value={field(person.membershipId)}>
                      {field(person.displayName)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </section>
          <section aria-label="Investigation notes">
            <h3>Investigation notes</h3>
            <p>Do not enter unnecessary patient identifiers or payment credentials.</p>
            <label htmlFor="billing-investigation-note">Add a note</label>
            <textarea
              id="billing-investigation-note"
              value={note}
              maxLength={2000}
              disabled={saving || !permissions.has("billing.operations.triage")}
              onChange={(event) => setNote(event.target.value)}
            />
            <small>{note.length}/2000</small>
            <Button
              disabled={saving || !note.trim() || !permissions.has("billing.operations.triage")}
              onClick={() => void mutate(() => postNote({ body: note }), "Note saved")}
            >
              {saving ? "Saving…" : "Save note"}
            </Button>
            <ol>
              {(Array.isArray(detail.notes) ? (detail.notes as ApiData[]) : []).map((entry) => (
                <li key={field(entry.id)}>
                  <p>{field(entry.body)}</p>
                  <small>{field(entry.createdAt)}</small>
                </li>
              ))}
            </ol>
          </section>
          <section aria-label="Follow-up status">
            <h3>Follow-up</h3>
            {permissions.has("billing.operations.triage") ? (
              <>
                <label htmlFor="billing-investigation-reason">Reason for status change</label>
                <textarea
                  id="billing-investigation-reason"
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
                {status === "investigating" || status === "waiting_external" ? (
                  <label>
                    Resolution outcome
                    <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                      <option value="verified_no_action_required">
                        Verified, no action required
                      </option>
                      <option value="referred_to_source_workflow">
                        Referred to source workflow
                      </option>
                      <option value="waiting_for_external_confirmation">
                        Waiting for external confirmation
                      </option>
                      <option value="duplicate_investigation">Duplicate investigation</option>
                      <option value="unable_to_resolve">Unable to resolve</option>
                    </select>
                  </label>
                ) : null}
                <div className="billing-investigation-actions">
                  {status === "open" ? (
                    <Button
                      disabled={saving || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          () => postTransition({ status: "investigating", version, reason }),
                          "Investigation started",
                        )
                      }
                    >
                      Start investigation
                    </Button>
                  ) : null}
                  {status === "investigating" ? (
                    <Button
                      tone="secondary"
                      disabled={saving || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          () => postTransition({ status: "waiting_external", version, reason }),
                          "Marked waiting for external follow-up",
                        )
                      }
                    >
                      Waiting external
                    </Button>
                  ) : null}
                  {status === "waiting_external" ? (
                    <Button
                      tone="secondary"
                      disabled={saving || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          () => postTransition({ status: "investigating", version, reason }),
                          "Investigation resumed",
                        )
                      }
                    >
                      Resume investigation
                    </Button>
                  ) : null}
                  {(status === "investigating" || status === "waiting_external") &&
                  permissions.has("billing.operations.resolve") ? (
                    <Button
                      disabled={saving || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          () =>
                            postTransition({
                              status: "resolved",
                              version,
                              reason,
                              outcome: outcome as
                                | "verified_no_action_required"
                                | "referred_to_source_workflow"
                                | "waiting_for_external_confirmation"
                                | "duplicate_investigation"
                                | "unable_to_resolve",
                            }),
                          "Investigation resolved",
                        )
                      }
                    >
                      Resolve investigation
                    </Button>
                  ) : null}
                  {status === "resolved" && permissions.has("billing.operations.resolve") ? (
                    <Button
                      tone="secondary"
                      disabled={saving || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          () => postTransition({ status: "closed", version, reason }),
                          "Investigation closed",
                        )
                      }
                    >
                      Close investigation
                    </Button>
                  ) : null}
                  {(status === "closed" || status === "resolved") &&
                  permissions.has("billing.operations.resolve") ? (
                    <Button
                      tone="secondary"
                      disabled={saving || reason.trim().length < 3}
                      onClick={() =>
                        void mutate(
                          () => postTransition({ status: "investigating", version, reason }),
                          "Investigation reopened",
                        )
                      }
                    >
                      Reopen investigation
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <p>
                Read-only access. An operational triage permission is required to update this
                investigation.
              </p>
            )}
            {status === "resolved" || status === "closed" ? (
              <output>
                <strong>Administrative investigation is {status}.</strong> The source submission
                currently reports {sourceState || "an unavailable status"}. This case status does
                not change that source record.
              </output>
            ) : null}
          </section>
          <section aria-label="Audit history">
            <h3>Audit history</h3>
            <ol>
              {(Array.isArray(detail.history) ? (detail.history as ApiData[]) : []).map(
                (entry, index) => (
                  <li key={`${field(entry.occurred_at)}-${index}`}>
                    {field(entry.event_type).replaceAll("_", " ")} ·{" "}
                    {field(entry.occurredAt || entry.occurred_at)}
                  </li>
                ),
              )}
            </ol>
          </section>
        </>
      ) : null}
    </dialog>
  );
}
