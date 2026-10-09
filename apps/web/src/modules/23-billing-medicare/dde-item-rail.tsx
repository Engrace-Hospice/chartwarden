// apps/web/src/modules/23-billing-medicare — the DDE item drawer (ADR-0052): deadline, what was keyed / came back,
// the append-only history, and only the actions the server says are allowed now. The rail is keyed by item id only,
// so it stays mounted across reloads; its form state is reset EXPLICITLY when the item's version changes. A 412 is
// reported to the parent (which holds the notice in its own state, so a reload cannot wipe it). A step-up round trip
// stashes the open form in process memory (never browser storage) and restores it on return.
import { Button, Glyph, InlineAlert, StatusPill, useApiClient, useDrawerA11y } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { OutcomeForm, SubmissionForm } from "./dde-forms";
import {
  DEADLINE_LABEL,
  DEADLINE_TONE,
  type DdeItem,
  type DdeItemDetail,
  EVENT_LABEL,
  type OutcomeDraft,
  STATE_LABEL,
  STATE_TONE,
  type SubmissionDraft,
  TYPE_LABEL,
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

const EMPTY_SUBMISSION: SubmissionDraft = { dcn: "", notes: "" };
const emptyOutcome = (item: DdeItem): OutcomeDraft => ({
  outcome: "",
  macAcceptedOn: "",
  rtpReasonCode: "",
  dcn: item.dcn ?? "",
  notes: "",
});
const draftKey = (id: string) => `dde:${id}`;

function Row({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

const newKey = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export function ItemRail({
  item: n,
  patientName,
  notInList,
  onClose,
  onChanged,
  onConflict,
}: {
  item: DdeItemDetail;
  patientName: string;
  notInList: boolean;
  onClose: () => void;
  onChanged: () => void;
  onConflict: (message: string) => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [drafts, setDrafts] = useState<Drafts>(() => {
    const restored = loadDraft<Drafts>(draftKey(n.ddeWorkItemId));
    return restored ?? { panel: "none", submit: EMPTY_SUBMISSION, outcome: emptyOutcome(n) };
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const can = (a: DdeItem["allowedActions"][number]) => n.allowedActions.includes(a);
  const note = deadlineNote(n);

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
  }, [n]);

  const setPanel = (panel: Panel) => setDrafts((d) => ({ ...d, panel }));
  const params = () => ({ path: { id: n.ddeWorkItemId }, header: { "Idempotency-Key": newKey() } });

  /** One POST: route auth failures (step-up included), surface the server's refusal, hand a 412 to the parent. */
  const run = async (
    call: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    fallback: string,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { error, response } = await call();
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
        if (response?.status === 412) {
          onConflict("This item changed since you opened it. It has been reloaded; try again.");
          onChanged();
          return;
        }
        setActionError(errorMessage(error, fallback));
        return;
      }
      onChanged();
    } catch {
      setActionError(`${fallback} Check your connection.`);
    } finally {
      setBusy(false);
    }
  };

  const simple = (
    kind: "claim" | "start" | "retry" | "cancel" | "close",
    fallback: string,
  ): Promise<void> => {
    const call = () => {
      const args = { params: params(), body: { expectedVersion: n.version } };
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
    return run(call, fallback);
  };

  const submitOutcome = (d: OutcomeDraft): Promise<void> =>
    d.outcome === "accepted"
      ? run(
          () =>
            client.POST("/api/v1/billing/dde-items/{id}/record-acceptance", {
              params: params(),
              body: {
                expectedVersion: n.version,
                ...(d.macAcceptedOn ? { macAcceptedOn: d.macAcceptedOn } : {}),
                ...(d.dcn ? { dcn: d.dcn } : {}),
                ...(d.notes ? { notes: d.notes } : {}),
              },
            }),
          "The acceptance could not be recorded.",
        )
      : run(
          () =>
            client.POST("/api/v1/billing/dde-items/{id}/record-outcome", {
              params: params(),
              body: {
                expectedVersion: n.version,
                outcome: "returned",
                rtpReasonCode: d.rtpReasonCode,
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
                <StatusPill
                  label={DEADLINE_LABEL[n.deadlineStatus]}
                  tone={DEADLINE_TONE[n.deadlineStatus]}
                />
              ) : null}
            </Row>
            {note ? (
              <Row term="Note">
                <span className="wx-row-sub">{note}</span>
              </Row>
            ) : null}
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
            <Row term="Source">
              {n.source === "watchdog" ? "Filing-window watch" : "Added by staff"}
            </Row>
            {n.notes ? <Row term="Notes">{n.notes}</Row> : null}
          </dl>
        </section>

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
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {n.allowedActions.length > 0 ? (
          <section className="wx-drawer-card" aria-label="Actions">
            <h3>Actions</h3>
            {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}
            {drafts.panel === "submit" ? (
              <SubmissionForm
                busy={busy}
                draft={drafts.submit}
                onDraft={(submit) => setDrafts((d) => ({ ...d, submit }))}
                onCancel={() => setPanel("none")}
                onSubmit={(d) =>
                  run(
                    () =>
                      client.POST("/api/v1/billing/dde-items/{id}/record-submission", {
                        params: params(),
                        body: {
                          expectedVersion: n.version,
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
                busy={busy}
                draft={drafts.outcome}
                onDraft={(outcome) => setDrafts((d) => ({ ...d, outcome }))}
                onCancel={() => setPanel("none")}
                onSubmit={submitOutcome}
              />
            ) : (
              <div className="wx-action-row">
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
                    Record as keyed in DDE
                  </Button>
                ) : null}
                {can("record_outcome") ? (
                  <Button disabled={busy} onClick={() => setPanel("outcome")}>
                    Record what came back
                  </Button>
                ) : null}
                {can("retry") ? (
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
                {can("cancel") ? (
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
