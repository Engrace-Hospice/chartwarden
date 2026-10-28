// apps/web/src/modules/06-admission/nomnc-panel.tsx — the NOMNC delivery record and the BFCC-QIO expedited review
// (milestone 10a), as one flat clinical section on the admission detail and a compact prompt strip in the discharge
// stepper. RECORD-KEEPING ONLY: it shows what staff typed, labelled "from your notice, not a computed CMS time", with a
// minute-accurate countdown in the organization's zone, and loud prompts for what is MISSING (never a default value).
// Nothing here blocks a discharge or sends anything. The server owns every rule (ADR-0030).
//
// Failure is visible: a failed reload keeps what is on screen and says so (with Retry); a 409 reloads, rebinds the open
// form to the fresh record and keeps what was typed; a stale response from a previous admission / reason is dropped.
import {
  Button,
  DataTable,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  findStepUpDraftResourceId,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import {
  type DeadlineView,
  type NomncApi,
  type NomncOverview,
  type Prompt,
  createNomncApi,
  isConflict,
  isStepUp,
} from "./nomnc-api";
import {
  NOMNC_DRAFT_ACTIONS,
  NOMNC_STEP_UP_ACTIONS,
  NomncDrawer,
  type NomncDrawerMode,
  drawerTargetKey,
} from "./nomnc-drawer";
import {
  ACK_LABEL,
  DEADLINE_KIND_LABEL,
  NOTICE_DEADLINE_KINDS,
  OUTCOME_LABEL,
  PROMPT_TONE,
  RECIPIENT_LABEL,
  REVIEW_DEADLINE_KINDS,
  STATUS_LABEL,
  STATUS_TONE,
  countdownLabel,
  formatInZone,
  nextOpenDeadline,
  typedEcho,
} from "./nomnc-format";

const TICK_MS = 10_000;
const CONFLICT_NOTICE =
  "This record changed since you opened it. The latest version is shown — check it and try again.";

/** The prompts as loud alerts: each names a missing fact, never a value. A warning is announced; info is polite. */
export function NomncPrompts({ prompts }: { prompts: readonly Prompt[] }): JSX.Element | null {
  if (prompts.length === 0) return null;
  return (
    <div className="wx-nomnc-prompts">
      {prompts.map((p) => (
        <div key={p.code} role={p.severity === "warn" ? "alert" : "status"}>
          <InlineAlert tone={PROMPT_TONE[p.severity]}>{p.message}</InlineAlert>
        </div>
      ))}
    </div>
  );
}

/**
 * Re-point an open form at the freshly loaded record with the same id (a 409 means the object it holds is stale).
 * `null` = the record is gone or no longer in a state the form applies to: the caller closes the form.
 */
export function rebindMode(mode: NomncDrawerMode, ov: NomncOverview): NomncDrawerMode | null {
  const activeNotice = ov.activeNotice;
  const openReview = ov.review?.state === "open" ? ov.review : null;
  switch (mode.kind) {
    case "notice":
      if (!mode.supersedes) return mode;
      return activeNotice && activeNotice.id === mode.supersedes.id
        ? { ...mode, supersedes: activeNotice }
        : null;
    case "acknowledgement":
    case "withdraw_notice":
    case "open_review":
      return activeNotice && activeNotice.id === mode.notice.id
        ? { ...mode, notice: activeNotice }
        : null;
    case "review_facts":
    case "decision":
      return openReview && openReview.id === mode.review.id
        ? { ...mode, review: openReview }
        : null;
    case "add_deadline": {
      const parent = mode.subject === "notice" ? activeNotice : openReview;
      return parent && parent.id === mode.parent.id ? { ...mode, parent } : null;
    }
    case "edit_deadline": {
      const fresh = ov.deadlines.find((d) => d.id === mode.deadline.id);
      return fresh && !fresh.satisfiedAt && fresh.status !== "closed"
        ? { ...mode, deadline: fresh }
        : null;
    }
  }
}

const deadlineName = (d: DeadlineView): string =>
  d.label ? `${DEADLINE_KIND_LABEL[d.kind]}: ${d.label}` : DEADLINE_KIND_LABEL[d.kind];

function useNomnc(
  admissionId: string,
  injected: NomncApi | undefined,
  enabled: boolean,
  dischargeReason?: string,
) {
  const client = useApiClient();
  const api = useMemo(() => injected ?? createNomncApi(client), [injected, client]);
  const [ov, setOv] = useState<NomncOverview | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const latest = useRef(0);

  /** Load the record. A response that is no longer the latest request (another admission / reason) is dropped. */
  const load = useCallback(async (): Promise<NomncOverview | null> => {
    const mine = ++latest.current;
    try {
      const o = await api.overview(admissionId, dischargeReason);
      if (mine !== latest.current) return null;
      setOv(o);
      setLoadError(null);
      return o;
    } catch (e) {
      if (mine !== latest.current) return null;
      setLoadError(e instanceof Error ? e.message : "Could not load the NOMNC record.");
      // keep what is on screen; only a first load with nothing to show becomes the error state
      setOv((prev) => (prev === undefined ? null : prev));
      return null;
    }
  }, [api, admissionId, dischargeReason]);

  useEffect(() => {
    if (!enabled) return;
    // a different admission / reason: forget the old record at once, then load the new one
    setOv(undefined);
    setLoadError(null);
    void load();
    return () => {
      latest.current += 1;
    };
  }, [enabled, load]);

  return { api, ov, loadError, load };
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

const hasPermission = (perms: readonly string[] | null | undefined, key: string): boolean =>
  perms?.includes(key) ?? false;

/** Discharge stepper strip: the prompts for this admission and the reason being chosen, nothing more. */
export function NomncPromptStrip({
  admissionId,
  dischargeReason,
  api: injected,
}: {
  admissionId: string;
  dischargeReason?: string;
  api?: NomncApi;
}): JSX.Element | null {
  const session = useSession();
  const allowed = hasPermission(session?.permissions, "nomnc.read");
  const { ov, loadError } = useNomnc(admissionId, injected, allowed, dischargeReason);
  if (!allowed) return null;
  // fail visible, never block: the discharge can continue either way
  if (loadError && !ov) {
    return (
      <div role="alert">
        <InlineAlert tone="warning">
          Could not check NOMNC status. You can continue; check the admission's NOMNC record.
        </InlineAlert>
      </div>
    );
  }
  return ov ? <NomncPrompts prompts={ov.prompts} /> : null;
}

export function NomncPanel({
  admissionId,
  api: injected,
}: {
  admissionId: string;
  /** Test seam; production builds the typed client API. */
  api?: NomncApi;
}): JSX.Element | null {
  const session = useSession();
  const perms = session?.permissions;
  const canRead = hasPermission(perms, "nomnc.read");
  const canRecord = hasPermission(perms, "nomnc.record");
  const { api, ov, loadError, load } = useNomnc(admissionId, injected, canRead);
  const [mode, setMode] = useState<NomncDrawerMode | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  /** The open form was restored from a draft stashed before the step-up redirect. */
  const [restored, setRestored] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, NOMNC_DRAFT_ACTIONS);
  const reopened = useRef(false);
  const now = useNow();

  // another admission: nothing from the previous one stays open
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the admission changes.
  useEffect(() => {
    setMode(null);
    setDirty(false);
    setActionError(null);
    setConfirmWithdraw(false);
  }, [admissionId]);

  // Back from /step-up: reopen the form (or the withdraw confirmation) the user was on, with what they had typed.
  useEffect(() => {
    if (!returning || reopened.current || !ov) return;
    reopened.current = true;
    const noticeId = findStepUpDraftResourceId(owner, NOMNC_STEP_UP_ACTIONS.withdraw_notice);
    const reviewDecisionId = findStepUpDraftResourceId(owner, NOMNC_STEP_UP_ACTIONS.decision);
    const reviewWithdrawId = findStepUpDraftResourceId(
      owner,
      NOMNC_STEP_UP_ACTIONS.withdraw_review,
    );
    if (noticeId && ov.activeNotice?.id === noticeId) {
      setMode({ kind: "withdraw_notice", notice: ov.activeNotice });
      setRestored(true);
    } else if (
      reviewDecisionId &&
      ov.review?.id === reviewDecisionId &&
      ov.review.state === "open"
    ) {
      setMode({ kind: "decision", review: ov.review });
      setRestored(true);
    } else if (
      reviewWithdrawId &&
      ov.review?.id === reviewWithdrawId &&
      ov.review.state === "open"
    ) {
      setConfirmWithdraw(true);
    }
  }, [returning, ov, owner]);

  if (!canRead) return null;

  const notice = ov?.activeNotice ?? null;
  const review = ov?.review ?? null;
  const tz = ov?.timeZone ?? "UTC";
  const next = ov ? nextOpenDeadline(ov.deadlines.filter((d) => d.status !== "closed")) : null;
  const locked = dirty || busy;

  const open = (m: NomncDrawerMode) => {
    setRestored(false);
    setActionError(null);
    setConfirmWithdraw(false);
    setMode(m);
  };

  /** Reload and re-point the open form at the fresh record; close it if it no longer applies. */
  const onConflict = async (): Promise<void> => {
    const fresh = await load();
    if (!fresh || !mode) return;
    const rebound = rebindMode(mode, fresh);
    if (rebound) setMode(rebound);
    else {
      setMode(null);
      setActionError(CONFLICT_NOTICE);
    }
  };

  /** An inline action (mark met, withdraw review): busy while it runs; a 409 reloads and says the record changed. */
  const act = async (
    op: () => Promise<unknown>,
    stepUpKey: string | null = null,
  ): Promise<void> => {
    setActionError(null);
    setBusy(true);
    try {
      await op();
      clearStepUpDraft(stepUpKey);
      await load();
    } catch (e) {
      if (isStepUp(e) && stepUpKey) {
        // not fresh enough: nothing was typed here, so the draft only marks "come back to the confirmation"
        stashStepUpDraft(stepUpKey, {});
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      if (isConflict(e)) {
        await load();
        setActionError(`${CONFLICT_NOTICE} (${e instanceof Error ? e.message : ""})`);
      } else {
        setActionError(e instanceof Error ? e.message : "The request failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const deadlineColumns = [
    {
      id: "kind",
      header: "Deadline",
      cell: deadlineName,
      priority: "primary" as const,
    },
    {
      id: "due",
      header: "Due, as typed",
      cell: (d: DeadlineView) => typedEcho(d.dueLocal, d.zone),
      priority: "primary" as const,
    },
    {
      id: "left",
      header: "Time left",
      cell: (d: DeadlineView) =>
        d.satisfiedAt ? "Met" : d.status === "closed" ? "—" : countdownLabel(d.dueAt, now),
      priority: "secondary" as const,
    },
    {
      id: "status",
      header: "Status",
      cell: (d: DeadlineView) => (
        <StatusPill label={STATUS_LABEL[d.status]} tone={STATUS_TONE[d.status]} />
      ),
      priority: "primary" as const,
    },
    {
      id: "source",
      header: "From",
      cell: (d: DeadlineView) => d.sourceNote,
      priority: "tertiary" as const,
    },
    {
      id: "act",
      header: "",
      cell: (d: DeadlineView) =>
        canRecord && !d.satisfiedAt && d.status !== "closed" ? (
          <span className="wx-action-row">
            <Button
              tone="tertiary"
              size="sm"
              disabled={locked}
              aria-label={`Mark ${deadlineName(d)} deadline due ${d.dueLocal.replace("T", " ")} met`}
              onClick={() => void act(() => api.editDeadline(admissionId, d, { satisfy: true }))}
            >
              Mark met
            </Button>
            <Button
              tone="tertiary"
              size="sm"
              disabled={locked}
              aria-label={`Edit ${deadlineName(d)} deadline due ${d.dueLocal.replace("T", " ")}`}
              onClick={() => open({ kind: "edit_deadline", deadline: d })}
            >
              Edit
            </Button>
          </span>
        ) : null,
      priority: "secondary" as const,
    },
  ];

  let body: JSX.Element;
  if (ov === undefined) {
    body = <LoadingSpinner />;
  } else if (ov === null) {
    body = (
      <div className="wx-addendum-body">
        <InlineAlert tone="error">{loadError ?? "Could not load the NOMNC record."}</InlineAlert>
        <div className="wx-action-row">
          <Button tone="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="wx-addendum-body">
        {loadError ? (
          <>
            <InlineAlert tone="error">
              Could not refresh this record — what is shown may be out of date. {loadError}
            </InlineAlert>
            <div className="wx-action-row">
              <Button tone="secondary" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          </>
        ) : null}
        {actionError ? <InlineAlert tone="error">{actionError}</InlineAlert> : null}
        <NomncPrompts prompts={ov.prompts} />
        {notice ? (
          <>
            <dl className="wx-kv">
              <dt>Last day of services</dt>
              <dd className="wx-nums">{notice.servicesEndOn}</dd>
              <dt>Delivered</dt>
              <dd className="wx-nums">{formatInZone(notice.deliveredAt, tz)}</dd>
              <dt>Delivered to</dt>
              <dd>
                {RECIPIENT_LABEL[notice.recipientKind]}
                {notice.representativeName ? `: ${notice.representativeName}` : ""}
              </dd>
              {notice.deliveryNote ? (
                <>
                  <dt>How</dt>
                  <dd>{notice.deliveryNote}</dd>
                </>
              ) : null}
              <dt>Signature or refusal</dt>
              <dd>
                {notice.acknowledgementKind
                  ? `${ACK_LABEL[notice.acknowledgementKind]}${notice.acknowledgementNote ? `: ${notice.acknowledgementNote}` : ""}`
                  : "Not recorded"}
              </dd>
              <dt>Source</dt>
              <dd>{notice.sourceNote}</dd>
            </dl>
            <p className="wx-row-sub">
              Dates and times here are from your notice or the QIO's call, not a computed CMS time.
            </p>
          </>
        ) : (
          <p className="wx-row-sub">No NOMNC delivery recorded for this admission.</p>
        )}

        {canRecord ? (
          <div className="wx-action-row">
            {!notice ? (
              <Button
                tone="primary"
                disabled={locked}
                onClick={() => open({ kind: "notice", supersedes: null })}
              >
                Record NOMNC delivery
              </Button>
            ) : (
              <>
                <Button
                  tone="secondary"
                  disabled={locked}
                  onClick={() => open({ kind: "acknowledgement", notice })}
                >
                  Signature or refusal
                </Button>
                <Button
                  tone="secondary"
                  disabled={locked}
                  onClick={() =>
                    open({
                      kind: "add_deadline",
                      subject: "notice",
                      parent: notice,
                      kinds: NOTICE_DEADLINE_KINDS,
                    })
                  }
                >
                  Type a deadline
                </Button>
                {!review ? (
                  <Button
                    tone="secondary"
                    disabled={locked}
                    onClick={() => open({ kind: "open_review", notice })}
                  >
                    Open QIO review
                  </Button>
                ) : null}
                <Button
                  tone="tertiary"
                  disabled={locked}
                  onClick={() => open({ kind: "notice", supersedes: notice })}
                >
                  Replace record
                </Button>
                <Button
                  tone="tertiary"
                  disabled={locked}
                  onClick={() => open({ kind: "withdraw_notice", notice })}
                >
                  Withdraw
                </Button>
              </>
            )}
          </div>
        ) : null}

        {review ? (
          <div className="wx-addendum-group">
            <h4 className="wx-addendum-subhead">
              QIO expedited review{" "}
              <StatusPill
                label={
                  review.state === "open"
                    ? "Open"
                    : review.state === "decided"
                      ? "Decided"
                      : "Withdrawn"
                }
                tone={review.state === "open" ? "warning" : "neutral"}
              />
            </h4>
            <dl className="wx-kv">
              <dt>QIO</dt>
              <dd>
                {review.qioName}
                {review.qioReference ? ` (${review.qioReference})` : ""}
              </dd>
              <dt>QIO told the hospice</dt>
              <dd className="wx-nums">{formatInZone(review.qioNotifiedAt, tz)}</dd>
              <dt>DENC delivered</dt>
              <dd className="wx-nums">{formatInZone(review.dencDeliveredAt, tz)}</dd>
              <dt>Records sent</dt>
              <dd className="wx-nums">
                {formatInZone(review.recordsSentAt, tz)}
                {review.recordsSentNote ? ` · ${review.recordsSentNote}` : ""}
              </dd>
              <dt>Decision</dt>
              <dd>
                {review.decisionOutcome
                  ? `${OUTCOME_LABEL[review.decisionOutcome]} · ${formatInZone(review.decisionReceivedAt, tz)}`
                  : "Not recorded"}
              </dd>
            </dl>
            {canRecord && review.state === "open" ? (
              <div className="wx-action-row">
                <Button
                  tone="secondary"
                  disabled={locked}
                  onClick={() =>
                    open({
                      kind: "add_deadline",
                      subject: "review",
                      parent: review,
                      kinds: REVIEW_DEADLINE_KINDS,
                    })
                  }
                >
                  Type a deadline
                </Button>
                <Button
                  tone="secondary"
                  disabled={locked}
                  onClick={() => open({ kind: "review_facts", review })}
                >
                  DENC and records
                </Button>
                <Button
                  tone="secondary"
                  disabled={locked}
                  onClick={() => open({ kind: "decision", review })}
                >
                  Record decision
                </Button>
                {confirmWithdraw ? (
                  <fieldset
                    className="wx-choice-fieldset wx-action-row"
                    aria-label="Confirm withdrawing the review"
                  >
                    <span className="wx-row-sub">Withdraw this QIO review?</span>
                    <Button
                      tone="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirmWithdraw(false);
                        void act(
                          () => api.withdrawReview(admissionId, review),
                          stepUpDraftKey(owner, NOMNC_STEP_UP_ACTIONS.withdraw_review, review.id),
                        );
                      }}
                    >
                      Confirm withdraw
                    </Button>
                    <Button
                      tone="tertiary"
                      size="sm"
                      onClick={() => {
                        clearStepUpDraft(
                          stepUpDraftKey(owner, NOMNC_STEP_UP_ACTIONS.withdraw_review, review.id),
                        );
                        setConfirmWithdraw(false);
                      }}
                    >
                      Keep review
                    </Button>
                  </fieldset>
                ) : (
                  <Button
                    tone="tertiary"
                    disabled={locked}
                    onClick={() => setConfirmWithdraw(true)}
                  >
                    Withdraw review
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {ov.deadlines.length > 0 ? (
          <DataTable<DeadlineView>
            ariaLabel="Typed deadlines"
            rows={ov.deadlines}
            getRowId={(d) => d.id}
            columns={deadlineColumns}
          />
        ) : null}
        {notice && ov.deadlines.length === 0 ? (
          <p className="wx-row-sub">No deadline recorded: enter it from the notice.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`wx-addendum-split${mode ? " has-drawer" : ""}`}>
      <section className="wx-clinical-section" aria-label="NOMNC and QIO review">
        <header>
          <span className="wx-clinical-section-icon" aria-hidden>
            <Glyph name="file-check" size={22} strokeWidth={1.6} />
          </span>
          <div className="wx-addendum-head-text">
            <h3>NOMNC and QIO review</h3>
            <p>Delivery record, QIO fast-track facts and the deadlines you typed from them</p>
          </div>
          <div className="wx-clinical-section-aside">
            {next ? (
              <StatusPill label={countdownLabel(next.dueAt, now)} tone={STATUS_TONE[next.status]} />
            ) : null}
          </div>
        </header>
        <div className="wx-clinical-section-body">{body}</div>
      </section>
      {mode ? (
        <NomncDrawer
          key={drawerTargetKey(mode)}
          admissionId={admissionId}
          mode={mode}
          api={api}
          onChanged={async () => {
            await load();
          }}
          onConflict={onConflict}
          onDirty={setDirty}
          restore={restored}
          onClose={() => setMode(null)}
        />
      ) : null}
    </div>
  );
}
