// apps/web/src/modules/06-admission/nomnc-panel.tsx — the NOMNC delivery record and the BFCC-QIO expedited review
// (milestone 10a), as one flat clinical section on the admission detail and a compact prompt strip in the discharge
// stepper. RECORD-KEEPING ONLY: it shows what staff typed, labelled "from your notice, not a computed CMS time", with a
// minute-accurate countdown in the organization's zone, and loud prompts for what is MISSING (never a default value).
// Nothing here blocks a discharge or sends anything. The server owns every rule (ADR-0030).
import {
  Button,
  DataTable,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type DeadlineView,
  type NomncApi,
  type NomncOverview,
  type Prompt,
  createNomncApi,
} from "./nomnc-api";
import { NomncDrawer, type NomncDrawerMode } from "./nomnc-drawer";
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

const TICK_MS = 30_000;

/** The prompts as loud alerts: each names a missing fact, never a value. */
export function NomncPrompts({ prompts }: { prompts: readonly Prompt[] }): JSX.Element | null {
  if (prompts.length === 0) return null;
  return (
    <div className="wx-nomnc-prompts" role="status">
      {prompts.map((p) => (
        <InlineAlert key={p.code} tone={PROMPT_TONE[p.severity]}>
          {p.message}
        </InlineAlert>
      ))}
    </div>
  );
}

function useNomnc(
  admissionId: string,
  injected: NomncApi | undefined,
  enabled: boolean,
  dischargeReason?: string,
) {
  const client = useApiClient();
  const api = useMemo(() => injected ?? createNomncApi(client), [injected, client]);
  const [ov, setOv] = useState<NomncOverview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setOv(await api.overview(admissionId, dischargeReason));
      setError(null);
    } catch (e) {
      setOv(null);
      setError(e instanceof Error ? e.message : "Could not load the NOMNC record.");
    }
  }, [api, admissionId, dischargeReason]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { api, ov, error, load };
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

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
  const perms = session?.permissions;
  const allowed = !perms || perms.includes("nomnc.read");
  const { ov } = useNomnc(admissionId, injected, allowed, dischargeReason);
  if (!allowed || !ov) return null;
  return <NomncPrompts prompts={ov.prompts} />;
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
  const canRead = !perms || perms.includes("nomnc.read");
  const canRecord = !perms || perms.includes("nomnc.record");
  const { api, ov, error, load } = useNomnc(admissionId, injected, canRead);
  const [mode, setMode] = useState<NomncDrawerMode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow();
  /** An inline action (mark met, withdraw review): refresh on success, show the server's message on refusal. */
  const act = async (op: () => Promise<unknown>): Promise<void> => {
    setActionError(null);
    try {
      await op();
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "The request failed.");
    }
  };
  if (!canRead) return null;

  const notice = ov?.activeNotice ?? null;
  const review = ov?.review ?? null;
  const tz = ov?.timeZone ?? "UTC";
  const next = ov ? nextOpenDeadline(ov.deadlines) : null;

  const deadlineColumns = [
    {
      id: "kind",
      header: "Deadline",
      cell: (d: DeadlineView) => (d.label ? `${DEADLINE_KIND_LABEL[d.kind]}: ${d.label}` : DEADLINE_KIND_LABEL[d.kind]),
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
      cell: (d: DeadlineView) => (d.satisfiedAt ? "Met" : countdownLabel(d.dueAt, now)),
      priority: "secondary" as const,
    },
    {
      id: "status",
      header: "Status",
      cell: (d: DeadlineView) => <StatusPill label={STATUS_LABEL[d.status]} tone={STATUS_TONE[d.status]} />,
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
        canRecord && !d.satisfiedAt ? (
          <span className="wx-action-row">
            <Button
              tone="tertiary"
              size="sm"
              aria-label={`Mark ${DEADLINE_KIND_LABEL[d.kind]} deadline met`}
              onClick={() => void act(() => api.editDeadline(admissionId, d, { satisfy: true }))}
            >
              Mark met
            </Button>
            <Button
              tone="tertiary"
              size="sm"
              aria-label={`Edit ${DEADLINE_KIND_LABEL[d.kind]} deadline`}
              onClick={() => setMode({ kind: "edit_deadline", deadline: d })}
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
    body = <InlineAlert tone="error">{error ?? "Could not load the NOMNC record."}</InlineAlert>;
  } else {
    body = (
      <div className="wx-addendum-body">
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
              <Button tone="primary" onClick={() => setMode({ kind: "notice", supersedes: null })}>
                Record NOMNC delivery
              </Button>
            ) : (
              <>
                <Button
                  tone="secondary"
                  onClick={() => setMode({ kind: "acknowledgement", notice })}
                >
                  Signature or refusal
                </Button>
                <Button
                  tone="secondary"
                  onClick={() =>
                    setMode({
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
                  <Button tone="secondary" onClick={() => setMode({ kind: "open_review", notice })}>
                    Open QIO review
                  </Button>
                ) : null}
                <Button
                  tone="tertiary"
                  onClick={() => setMode({ kind: "notice", supersedes: notice })}
                >
                  Replace record
                </Button>
                <Button tone="tertiary" onClick={() => setMode({ kind: "withdraw_notice", notice })}>
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
                label={review.state === "open" ? "Open" : review.state === "decided" ? "Decided" : "Withdrawn"}
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
                  onClick={() =>
                    setMode({
                      kind: "add_deadline",
                      subject: "review",
                      parent: review,
                      kinds: REVIEW_DEADLINE_KINDS,
                    })
                  }
                >
                  Type a deadline
                </Button>
                <Button tone="secondary" onClick={() => setMode({ kind: "review_facts", review })}>
                  DENC and records
                </Button>
                <Button tone="secondary" onClick={() => setMode({ kind: "decision", review })}>
                  Record decision
                </Button>
                <Button
                  tone="tertiary"
                  onClick={() => void act(() => api.withdrawReview(admissionId, review))}
                >
                  Withdraw review
                </Button>
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
          key={`${mode.kind}-${"notice" in mode ? mode.notice?.id : ""}`}
          admissionId={admissionId}
          mode={mode}
          api={api}
          onChanged={() => void load()}
          onClose={() => setMode(null)}
        />
      ) : null}
    </div>
  );
}
