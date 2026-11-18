// apps/web/src/modules/23-billing-medicare — the DDE item drawer (ADR-0052): deadline, what was keyed / came back,
// the append-only history, and only the actions the server says are allowed now. The rail is keyed by item id only,
// so it stays mounted across reloads; its form state is reset EXPLICITLY when the item's version changes. A stale version (409) is
// reported to the parent (which holds the notice in its own state, so a reload cannot wipe it). A step-up round trip
// stashes the open form in process memory (never browser storage) and restores it on return.
import {
  Button,
  Glyph,
  InlineAlert,
  StatusPill,
  useApiClient,
  useAttemptKey,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import { EligibilityPanel } from "./dde-eligibility-panel";
import { OutcomeForm, SubmissionForm } from "./dde-forms";
import {
  IN_DOUBT_GUIDANCE,
  type ProviderState,
  canSubmitViaProvider,
  canSyncProvider,
  evidenceOf,
  providerBadge,
  providerRefusal,
  syncMessage,
} from "./dde-provider-model";
import {
  CLOSE_REQUEUE_NOTE,
  DEADLINE_TONE,
  type DdeItem,
  type DdeItemDetail,
  type DdeProviderCapability,
  EVENT_LABEL,
  type OutcomeDraft,
  REQUEUED_LABEL,
  STATE_LABEL,
  STATE_TONE,
  type SubmissionDraft,
  TYPE_LABEL,
  deadlineBadgeLabel,
  deadlineNote,
  errorCode,
  errorMessage,
  fmtDateTime,
  fmtDay,
  isNoticeType,
} from "./dde-queue-model";
import { authFailureRedirect, clearDraft, loadDraft, saveDraft } from "./write-workflow";

type Panel = "none" | "submit" | "outcome";
interface Drafts {
  panel: Panel;
  submit: SubmissionDraft;
  outcome: OutcomeDraft;
}

const EMPTY_SUBMISSION: SubmissionDraft = {
  dcn: "",
  notes: "",
  confirmedExistingTransaction: false,
};
const emptyOutcome = (item: DdeItem): OutcomeDraft => ({
  outcome: "",
  macAcceptedOn: "",
  rtpReasonCode: "",
  dcn: item.dcn ?? "",
  notes: "",
});
const draftKey = (id: string) => `dde:${id}`;

interface RunOptions {
  /** A send that may have reached the provider: a lost response leaves it in doubt, so never offer another send. */
  sends?: boolean;
  /** A provider call: map the DDE_* refusals to plain language (and remember an in-doubt send). */
  providerOperation?: "submission" | "status";
  /** The success body, before the item is reloaded. */
  onData?: (data: unknown) => void;
}

function Row({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function ItemRail({
  item: n,
  providerCapability,
  patientName,
  notInList,
  onClose,
  onChanged,
  onConflict,
}: {
  item: DdeItemDetail;
  providerCapability: DdeProviderCapability | null;
  patientName: string;
  notInList: boolean;
  onClose: () => void;
  onChanged: () => void;
  onConflict: (message: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [drafts, setDrafts] = useState<Drafts>(() => {
    const restored = loadDraft<Drafts>(draftKey(n.ddeWorkItemId));
    return restored ?? { panel: "none", submit: EMPTY_SUBMISSION, outcome: emptyOutcome(n) };
  });
  // Escape is owned by an edited form; the flag resets when the form closes or the item changes under it.
  const drawer = useDrawerA11y<HTMLElement>(onClose, `${n.version}:${drafts.panel}`);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous guard: `busy` state is stale within one event tick
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // The server owns the in-doubt marker (durable across reloads and tabs); read defensively from an older server.
  // `sentUnsure` only bridges until a reload lands: a send whose outcome this tab never saw stays blocked even if
  // that reload fails, and the server's answer replaces it as soon as the item version changes.
  const [sentUnsure, setSentUnsure] = useState(false);
  const inDoubt = n.providerInDoubt === true || sentUnsure;
  const permissions = session?.permissions ?? [];
  const assignedToOther =
    n.assigneeMembershipId !== null &&
    n.assigneeMembershipId !== session?.membershipId &&
    !permissions.includes("billing.dde.admin");
  const requiredPermission: Record<DdeItem["allowedActions"][number], string> = {
    claim: "billing.dde.work",
    assign: "billing.dde.admin",
    start: "billing.dde.work",
    record_submission: "billing.dde.mark_submitted",
    record_outcome: "billing.dde.work",
    record_acceptance: "billing.dde.mark_submitted",
    submit_via_provider: "billing.dde.submit_via_provider",
    sync_provider: "billing.dde.submit_via_provider",
    retry: "billing.dde.work",
    cancel: "billing.dde.work",
    close: "billing.dde.work",
  };
  const can = (a: DdeItem["allowedActions"][number]) =>
    n.allowedActions.includes(a) && permissions.includes(requiredPermission[a]) && !assignedToOther;
  const canSendViaProvider =
    can("submit_via_provider") &&
    canSubmitViaProvider(
      n.itemType,
      providerCapability,
      permissions.includes("billing.dde.submit_via_provider"),
      assignedToOther,
    );
  const note = deadlineNote(n);
  const badge = providerBadge(n);
  const evidence = evidenceOf(n);

  // A restored draft is single-use.
  useEffect(() => {
    clearDraft(draftKey(n.ddeWorkItemId));
  }, [n.ddeWorkItemId]);

  // The item changed (an action landed, or it was reloaded): reset the forms explicitly. Skipped on mount so a
  // draft restored after a step-up round trip survives.
  const lastVersion = useRef(n.version);
  useEffect(() => {
    if (lastVersion.current === n.version) return;
    lastVersion.current = n.version;
    setDrafts({ panel: "none", submit: EMPTY_SUBMISSION, outcome: emptyOutcome(n) });
    setActionError(null);
    setSyncNote(null);
    setSentUnsure(n.providerInDoubt === true);
  }, [n]);

  const setPanel = (panel: Panel) => setDrafts((d) => ({ ...d, panel }));
  const attempt = useAttemptKey();
  const params = (key: string) => ({
    path: { id: n.ddeWorkItemId },
    header: { "Idempotency-Key": key },
  });

  /** One POST: route auth failures (step-up included), surface the server's refusal, hand a stale version (409 STALE_VERSION) to the parent. */
  const run = async (
    fingerprint: string,
    call: (key: string) => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    fallback: string,
    opts: RunOptions = {},
  ): Promise<void> => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    setSyncNote(null);
    try {
      const { data, error, response } = await attempt.run(
        `${n.ddeWorkItemId}|${fingerprint}`,
        call,
      );
      if (error) {
        const redirect = authFailureRedirect(
          response?.status,
          errorCode(error),
          `${location.pathname}${location.search}`,
        );
        if (redirect) {
          saveDraft(draftKey(n.ddeWorkItemId), drafts);
          navigate(redirect);
          return;
        }
        if (errorCode(error) === "STALE_VERSION") {
          onChanged(); // clears any older notice and reloads
          onConflict("This item changed since you opened it. It has been reloaded; try again.");
          return;
        }
        const refusal = opts.providerOperation
          ? providerRefusal(error, fallback, opts.providerOperation)
          : null;
        setActionError(refusal?.message ?? errorMessage(error, fallback));
        // The server marked the send in doubt (a send moves the version by 2): reload to read the marker.
        if (refusal?.inDoubt) {
          setSentUnsure(true);
          onChanged();
        }
        return;
      }
      opts.onData?.(data);
      onChanged();
    } catch {
      if (opts.sends) {
        // A lost response: the server marks the send in doubt before calling the provider, so reload and trust it.
        setActionError(
          providerRefusal({ error: { code: "DDE_IN_DOUBT" } }, fallback)?.message ?? fallback,
        );
        setSentUnsure(true);
        onChanged();
      } else
        setActionError(
          opts.providerOperation === "status"
            ? "The status check did not complete. The recorded submission and outcome are unchanged. Try the read-only check again later."
            : `${fallback} Check your connection.`,
        );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const simple = (
    kind: "claim" | "start" | "retry" | "cancel" | "close",
    fallback: string,
  ): Promise<void> => {
    const call = (key: string) => {
      const args = { params: params(key), body: { expectedVersion: n.version } };
      switch (kind) {
        case "claim":
          return client.POST("/api/v1/billing/dde-items/{id}/claim", args);
        case "start":
          return client.POST("/api/v1/billing/dde-items/{id}/start", args);
        case "retry":
          return client.POST("/api/v1/billing/dde-items/{id}/retry", args);
        case "cancel":
          return client.POST("/api/v1/billing/dde-items/{id}/cancel", args);
        case "close":
          return client.POST("/api/v1/billing/dde-items/{id}/close", args);
      }
    };
    return run(`${kind}|${n.version}`, call, fallback);
  };

  const sendViaProvider = (): Promise<void> =>
    run(
      `submit-via-provider|${n.version}`,
      (key) =>
        client.POST("/api/v1/billing/dde-items/{id}/submit-via-provider", {
          params: params(key),
          body: { expectedVersion: n.version },
        }),
      "The item could not be sent through the provider.",
      { providerOperation: "submission", sends: true },
    );

  const syncProvider = (): Promise<void> =>
    run(
      `sync-provider|${n.version}`,
      (key) => client.POST("/api/v1/billing/dde-items/{id}/sync-provider", { params: params(key) }),
      "The provider could not be checked.",
      {
        providerOperation: "status",
        onData: (d) => {
          const state = (d as { providerState?: ProviderState } | undefined)?.providerState;
          setSyncNote(state ? syncMessage(state) : null);
        },
      },
    );

  const submitOutcome = (d: OutcomeDraft): Promise<void> =>
    d.outcome === "accepted"
      ? run(
          `record-acceptance|${n.version}|${JSON.stringify(d)}`,
          (key) =>
            client.POST("/api/v1/billing/dde-items/{id}/record-acceptance", {
              params: params(key),
              body: {
                expectedVersion: n.version,
                ...(inDoubt ? { confirmedExistingTransaction: true } : {}),
                ...(d.macAcceptedOn ? { macAcceptedOn: d.macAcceptedOn } : {}),
                ...(d.dcn ? { dcn: d.dcn } : {}),
                ...(d.notes ? { notes: d.notes } : {}),
              },
            }),
          "The acceptance could not be recorded.",
        )
      : run(
          `record-outcome|${n.version}|${JSON.stringify(d)}`,
          (key) =>
            client.POST("/api/v1/billing/dde-items/{id}/record-outcome", {
              params: params(key),
              body: {
                expectedVersion: n.version,
                outcome: "returned",
                rtpReasonCode: d.rtpReasonCode,
                ...(inDoubt ? { confirmedExistingTransaction: true } : {}),
                ...(d.dcn ? { dcn: d.dcn } : {}),
                ...(d.notes ? { notes: d.notes } : {}),
              },
            }),
          "The outcome could not be recorded.",
        );

  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={`DDE work for ${patientName}`}>
      <header className="wx-drawer-head">
        <div className="wx-drawer-head-main">
          <div className="wx-drawer-title-row">
            <h2>{patientName}</h2>
            <StatusPill label={STATE_LABEL[n.state]} tone={STATE_TONE[n.state]} />
            {n.respawnedFromId ? <StatusPill label={REQUEUED_LABEL} tone="warning" /> : null}
            <StatusPill label={badge.label} tone={badge.tone} />
          </div>
          <div className="wx-row-sub">
            {TYPE_LABEL[n.itemType]} · attempt {n.attemptNumber}
          </div>
        </div>
        <button type="button" className="wx-icon-link" aria-label="Close details" onClick={onClose}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <nav className="wx-detail-tabs" aria-label="Item views">
        <span aria-current="page">DDE item</span>
        <Link to={`/patients/${n.patientId}/claims`}>Claims</Link>
        {isNoticeType(n.itemType) ? <Link to="/billing/noe">Notices</Link> : null}
      </nav>

      <div className="wx-drawer-body">
        <div aria-live="polite">
          {notInList ? (
            <InlineAlert tone="info">This item is no longer in the list.</InlineAlert>
          ) : null}
        </div>
        <section className="wx-drawer-card">
          <h3>Work item</h3>
          <dl className="wx-kv">
            <Row term="Deadline">
              <span className="wx-nums">{fmtDay(n.deadlineAt)}</span>
              {n.deadlineStatus !== "none" ? (
                <StatusPill label={deadlineBadgeLabel(n)} tone={DEADLINE_TONE[n.deadlineStatus]} />
              ) : null}
            </Row>
            {note ? (
              <Row term="Note">
                <span className="wx-row-sub">{note}</span>
              </Row>
            ) : null}
            <Row term="Submission channel">{badge.label}</Row>
            <Row term="Keyed in DDE">{n.submittedAt ? fmtDateTime(n.submittedAt) : "Not yet"}</Row>
            <Row term="MAC accepted on">{fmtDay(n.macAcceptedOn)}</Row>
            <Row term="DCN / ICN">
              <span className="wx-nums">{n.dcn ?? "—"}</span>
            </Row>
            {n.rtpReasonCode ? (
              <Row term="RTP reason code">
                <span className="wx-nums">{n.rtpReasonCode}</span>
              </Row>
            ) : null}
            {evidence ? (
              <Row term="Outcome evidence">
                <span>{evidence.label}</span>
              </Row>
            ) : null}
            {n.providerReference ? (
              <Row term="Provider reference">
                <span className="wx-nums">{n.providerReference}</span>
              </Row>
            ) : null}
            <Row term="Source">
              {n.source === "watchdog" ? "Filing-window watch" : "Added by staff"}
            </Row>
            {n.notes ? <Row term="Notes">{n.notes}</Row> : null}
          </dl>
        </section>

        {n.keying ? (
          <section className="wx-drawer-card" aria-label="Key into DDE">
            <h3>Key into DDE</h3>
            <p className="wx-row-sub">{n.keying.screenHint}</p>
            <dl className="wx-kv">
              {n.keying.fields.map((f) => (
                <Row key={f.label} term={f.label}>
                  <span className="wx-nums">{f.value}</span>
                </Row>
              ))}
              <Row term="Medicare ID">Open the patient chart to reveal it</Row>
              {n.keying.rejectionCodes.map((c) => (
                <Row key={c.code} term={`Reject ${c.code}`}>
                  {c.meaning ?? "Look this code up on the DDE screen"}
                </Row>
              ))}
            </dl>
          </section>
        ) : null}

        <EligibilityPanel patientId={n.patientId} />

        <section className="wx-drawer-card" aria-label="History">
          <h3>History</h3>
          {n.events.length === 0 ? (
            <p className="wx-row-sub">No history yet.</p>
          ) : (
            <ul className="wx-checklist">
              {n.events.map((e) => (
                <li key={e.eventId}>
                  <span className="wx-check-box" aria-hidden />
                  <span className="wx-checklist-text">
                    {EVENT_LABEL[e.event] ?? e.event}
                    <span className="wx-row-sub wx-nums">{fmtDateTime(e.occurredAt)}</span>
                    {e.actorKind ? (
                      <span className="wx-row-sub">
                        {e.detail?.outcomeSource === "provider"
                          ? "Provider-reported"
                          : e.detail?.submissionSource === "operator_verified_existing"
                            ? "Operator confirmed existing transaction; channel unknown"
                            : e.event === "submit" && e.detail?.submissionMode === "provider"
                              ? "Submitted via provider"
                              : e.actorKind === "user"
                                ? "Recorded by staff"
                                : e.actorKind === "system"
                                  ? "System update"
                                  : "Source unknown"}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {n.allowedActions.length > 0 ? (
          <section className="wx-drawer-card" aria-label="Actions">
            <h3>Actions</h3>
            {inDoubt ? (
              <div role="alert">
                <InlineAlert tone="warning" live={false}>
                  {IN_DOUBT_GUIDANCE}
                </InlineAlert>
              </div>
            ) : null}
            {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}
            {syncNote ? (
              <output className="wx-row-sub" aria-label="Provider answer">
                {syncNote}
              </output>
            ) : null}
            {drafts.panel === "submit" ? (
              <SubmissionForm
                busy={busy}
                resolvingInDoubt={inDoubt}
                draft={drafts.submit}
                onDraft={(submit) => setDrafts((d) => ({ ...d, submit }))}
                onCancel={() => setPanel("none")}
                onSubmit={(d) =>
                  run(
                    `record-submission|${n.version}|${JSON.stringify(d)}`,
                    (key) =>
                      client.POST("/api/v1/billing/dde-items/{id}/record-submission", {
                        params: params(key),
                        body: {
                          expectedVersion: n.version,
                          ...(inDoubt ? { confirmedExistingTransaction: true } : {}),
                          ...(d.dcn ? { dcn: d.dcn } : {}),
                          ...(d.notes ? { notes: d.notes } : {}),
                        },
                      }),
                    "That could not be recorded.",
                  )
                }
              />
            ) : drafts.panel === "outcome" ? (
              <OutcomeForm
                item={n}
                resolvingInDoubt={inDoubt}
                busy={busy}
                draft={drafts.outcome}
                onDraft={(outcome) => setDrafts((d) => ({ ...d, outcome }))}
                onCancel={() => setPanel("none")}
                onSubmit={submitOutcome}
              />
            ) : (
              <div className="wx-action-row">
                {can("close") && isNoticeType(n.itemType) ? (
                  <p className="wx-row-sub">{CLOSE_REQUEUE_NOTE}</p>
                ) : null}
                {can("claim") ? (
                  <Button
                    disabled={busy}
                    onClick={() => simple("claim", "You could not take this item.")}
                  >
                    Take it
                  </Button>
                ) : null}
                {can("start") ? (
                  <Button
                    disabled={busy}
                    onClick={() => simple("start", "The item could not be started.")}
                  >
                    Start work
                  </Button>
                ) : null}
                {can("record_submission") ? (
                  <Button disabled={busy} onClick={() => setPanel("submit")}>
                    {inDoubt ? "Record confirmed submission" : "Record manual submission"}
                  </Button>
                ) : null}
                {canSendViaProvider && !inDoubt ? (
                  <Button disabled={busy} onClick={sendViaProvider}>
                    Send via provider
                  </Button>
                ) : null}
                {canSyncProvider(
                  n,
                  providerCapability,
                  permissions.includes("billing.dde.submit_via_provider") && !assignedToOther,
                ) && !inDoubt ? (
                  <Button tone="secondary" disabled={busy} onClick={syncProvider}>
                    Check provider status
                  </Button>
                ) : null}
                {can("record_outcome") ? (
                  <Button disabled={busy} onClick={() => setPanel("outcome")}>
                    {inDoubt ? "Record confirmed outcome" : "Record what came back"}
                  </Button>
                ) : null}
                {can("retry") && !inDoubt ? (
                  <Button
                    disabled={busy}
                    onClick={() => simple("retry", "The item could not be reopened.")}
                  >
                    Reopen as a new attempt
                  </Button>
                ) : null}
                {can("close") ? (
                  <Button
                    tone="secondary"
                    disabled={busy}
                    onClick={() => simple("close", "The item could not be closed.")}
                  >
                    Close
                  </Button>
                ) : null}
                {can("cancel") && !inDoubt ? (
                  <Button
                    tone="tertiary"
                    disabled={busy}
                    onClick={() => simple("cancel", "The item could not be cancelled.")}
                  >
                    Cancel item
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
