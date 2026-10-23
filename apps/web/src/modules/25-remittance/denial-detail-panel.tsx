import {
  Button,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the DENIAL WORK PANEL (GAP-074): assign / start / escalate / resolve /
// close / close-with-write-off / reopen / open an appeal, over the live /api/v1/denials/{id}/* routes. The
// server owns every decision (ADR-0030): the panel reads the case fresh (so the If-Match version is the one
// the server holds NOW), offers only the edges the §2.4 denial state ladder has an arc for from the case's
// own `state`, and shows every 403/404/409/422 refusal verbatim. The reason floors are the server's.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import {
  ActionRail,
  ButtonRow,
  ErrorAlert,
  Facts,
  FormButtons,
  Hint,
  NoticeAlert,
  ReasonField,
} from "./action-ui";
import { CaseViewPanel } from "./case-view-panel";
import { DenialRoutePanel } from "./denial-route-panel";
import {
  type AppealTier,
  type DenialAction,
  type DenialDetail,
  type DenialRouteView,
  MIN_REASON,
  MIN_ROUTE_OVERRIDE_REASON,
  isUuid,
  loadDenial,
  runDenialAction,
} from "./remittance-api";
import { DENIAL_STATE_TONE, humanize, money, toneOf } from "./remittance-status";
import { REOPENING_DRAFT_ACTION } from "./reopening-panel";

/** Which actions the §2.4 ladder has an arc for from each state (the server re-validates every one). */
const ACTIONS_BY_STATE: Record<string, readonly DenialAction["kind"][]> = {
  open: ["start", "escalate", "assign"],
  in_progress: ["escalate", "resolve", "assign"],
  escalated: ["appeal", "resolve", "assign"],
  appealed: ["resolve"],
  resolved: ["close", "close-write-off"],
  closed: ["reopen"],
};

const LABEL: Record<DenialAction["kind"], string> = {
  assign: "Assign",
  start: "Start work",
  escalate: "Escalate",
  resolve: "Mark resolved",
  close: "Close",
  "close-write-off": "Close with write-off",
  reopen: "Reopen",
  appeal: "Open appeal",
};

const REASON_FLOOR: Partial<Record<DenialAction["kind"], number>> = {
  escalate: MIN_REASON.escalate,
  resolve: MIN_REASON.resolve,
  "close-write-off": MIN_REASON.closeWriteOff,
  reopen: MIN_REASON.reopen,
};

const TIERS: readonly AppealTier[] = [
  "redetermination",
  "reconsideration",
  "alj",
  "council",
  "federal_court",
];

export interface DenialDetailPanelProps {
  readonly denialId: string;
  readonly onClose: () => void;
  /** Called after any successful write so the worklist reloads. */
  readonly onChanged: () => void;
}

interface DenialDraft {
  readonly act: DenialAction["kind"];
  readonly reason: string;
  readonly assignee: string;
  readonly tier: AppealTier;
  readonly noticeDate?: string;
}

export const DENIAL_DRAFT_ACTION = "m25-denial";

export function DenialDetailPanel({
  denialId,
  onClose,
  onChanged,
}: DenialDetailPanelProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const myMembershipId = session?.membershipId;
  const navigate = useNavigate();
  const location = useLocation();
  const [denial, setDenial] = useState<DenialDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const draftKey = stepUpDraftKey(session, DENIAL_DRAFT_ACTION, denialId);
  const [restored] = useState(() => peekStepUpDraft<DenialDraft>(draftKey));
  const [act, setAct] = useState<DenialAction["kind"] | null>(restored?.act ?? null);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [assignee, setAssignee] = useState(restored?.assignee ?? "");
  const [tier, setTier] = useState<AppealTier>(restored?.tier ?? "redetermination");
  const [noticeDate, setNoticeDate] = useState(restored?.noticeDate ?? "");
  // Which path the routing rules send this denial to; a reopening route makes an appeal need a recorded reason.
  const [route, setRoute] = useState<DenialRouteView["route"] | null>(null);
  // The path section mutates the same denial version as this form, so each waits for the other.
  const [routeBusy, setRouteBusy] = useState(false);
  // Bumped after a successful action so the path is read again (an action can change what the rules decide).
  const [refreshToken, setRefreshToken] = useState(0);
  // Whether the appeal in progress needs an override reason, fixed when the action is picked so a reason-code
  // change mid-form cannot add or drop the field under the person's typing.
  const [overrideMode, setOverrideMode] = useState(false);
  const [ownBusy, setBusy] = useState(false);
  const busy = ownBusy || routeBusy;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await loadDenial(client, denialId);
    if (!res.ok) {
      setLoadError(res.message);
      return;
    }
    setLoadError(null);
    setDenial(res.value);
    setVersion(res.value.version);
  }, [client, denialId]);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(next: DenialAction["kind"] | null): void {
    clearStepUpDraft(draftKey);
    setOverrideMode(next === "appeal" && route === "reopening");
    setAct(next);
    setReason("");
    setAssignee("");
    setNoticeDate("");
    setError(null);
  }

  const appealOverride = act === "appeal" && overrideMode;
  const floor = appealOverride ? MIN_ROUTE_OVERRIDE_REASON : act ? (REASON_FLOOR[act] ?? 0) : 0;
  const blocked =
    act === null ||
    (floor > 0 && reason.trim().length < floor) ||
    (act === "assign" && !isUuid(assignee)) ||
    (act === "appeal" && tier !== "redetermination" && !noticeDate);

  function buildAction(kind: DenialAction["kind"]): DenialAction {
    switch (kind) {
      case "assign":
        return {
          kind,
          assigneeMembershipId: assignee.trim(),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        };
      case "escalate":
      case "resolve":
      case "close-write-off":
      case "reopen":
        return { kind, reason: reason.trim() };
      case "appeal":
        return {
          kind,
          tier,
          ...(noticeDate ? { noticeDate } : {}),
          ...(appealOverride ? { overrideReason: reason.trim() } : {}),
        };
      default:
        return { kind };
    }
  }

  async function submit(): Promise<void> {
    if (!act || version === null) return;
    setBusy(true);
    setError(null);
    const res = await runDenialAction(client, denialId, version, buildAction(act));
    setBusy(false);
    if (!res.ok) {
      if (res.stepUp) {
        stashStepUpDraft(draftKey, { act, reason, assignee, tier, noticeDate });
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      setError(res.message);
      return;
    }
    setNotice(`${LABEL[act]}: done.`);
    pick(null);
    onChanged();
    setRefreshToken((n) => n + 1);
    await load();
  }

  function closePanel(): void {
    clearStepUpDraft(draftKey);
    clearStepUpDraft(stepUpDraftKey(session, REOPENING_DRAFT_ACTION, denialId));
    onClose();
  }

  const available = denial ? (ACTIONS_BY_STATE[denial.state] ?? []) : [];

  return (
    <ActionRail ariaLabel="Denial case" onClose={closePanel}>
      {loadError ? (
        <ErrorAlert message={loadError} />
      ) : !denial ? (
        <LoadingSpinner />
      ) : (
        <>
          <Facts
            items={[
              [
                "CARC / RARC",
                `${denial.carcCode}${denial.rarcCode ? ` / ${denial.rarcCode}` : ""}`,
              ],
              ["Category", humanize(denial.category)],
              ["Source", humanize(denial.source)],
              ["Aging", denial.agingBucketLabel],
              ["Value", money(denial.dollarValue)],
              [
                "State",
                <StatusPill
                  key="s"
                  label={humanize(denial.state)}
                  tone={toneOf(DENIAL_STATE_TONE, denial.state)}
                />,
              ],
              ["Assignee", denial.assigneeMembershipId ?? "Unassigned"],
              ["Claim", denial.claimId ?? "None linked"],
            ]}
          />
          <NoticeAlert message={notice} />
          {denial.claimId ? (
            <CaseViewPanel
              key={denial.claimId}
              claimId={denial.claimId}
              refreshKey={refreshToken}
            />
          ) : null}
          <DenialRoutePanel
            key={denialId}
            denialId={denialId}
            denialVersion={version}
            onDenialChanged={load}
            onChanged={onChanged}
            onRoute={setRoute}
            locked={ownBusy}
            onBusyChange={setRouteBusy}
            refreshToken={refreshToken}
          />
          {act === null ? (
            <ButtonRow>
              {available.map((kind) => (
                <Button
                  key={kind}
                  tone="secondary"
                  size="sm"
                  // An appeal waits for the path: without it the right endpoint (and the override reason) is unknown.
                  disabled={kind === "appeal" && route === null}
                  onClick={() => pick(kind)}
                >
                  {kind === "appeal" && route === "reopening" ? "Appeal anyway" : LABEL[kind]}
                </Button>
              ))}
              {available.length === 0 ? <Hint>No action is available from this state.</Hint> : null}
            </ButtonRow>
          ) : (
            <>
              {act === "assign" ? (
                <>
                  <TextField
                    label="Assignee membership ID"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    error={assignee && !isUuid(assignee) ? "Enter a membership UUID." : undefined}
                  />
                  {myMembershipId ? (
                    <Button tone="tertiary" size="sm" onClick={() => setAssignee(myMembershipId)}>
                      Assign to me
                    </Button>
                  ) : null}
                  <TextField
                    label="Reason (optional)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                  />
                </>
              ) : null}
              {act === "appeal" ? (
                <SelectField
                  label="Appeal tier"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as AppealTier)}
                  options={TIERS.map((t) => ({ value: t, label: humanize(t) }))}
                />
              ) : null}
              {act === "appeal" ? (
                <TextField
                  label={
                    tier === "redetermination"
                      ? "Date on the notice (needed when no remittance is linked)"
                      : "Date on the prior decision notice"
                  }
                  type="date"
                  value={noticeDate}
                  onChange={(e) => setNoticeDate(e.target.value)}
                />
              ) : null}
              {appealOverride ? (
                <Hint>
                  The routing rules send this denial to a MAC reopening, not an appeal. Appealing it
                  anyway needs a reason, which is kept on the appeal.
                </Hint>
              ) : null}
              {floor > 0 ? (
                <ReasonField
                  label={appealOverride ? "Why appeal this anyway?" : "Reason"}
                  value={reason}
                  min={floor}
                  max={1000}
                  onChange={setReason}
                />
              ) : null}
              {act === "close-write-off" ? (
                <Hint>
                  A write-off needs a recent step-up verification; you will be asked to re-verify if
                  yours is stale.
                </Hint>
              ) : null}
              <ErrorAlert message={error} />
              <FormButtons
                submitLabel={LABEL[act]}
                busy={busy}
                blocked={blocked}
                danger={act === "close-write-off"}
                onSubmit={() => void submit()}
                onCancel={() => pick(null)}
              />
            </>
          )}
        </>
      )}
      <ButtonRow end>
        <Button tone="tertiary" onClick={closePanel}>
          Close panel
        </Button>
      </ButtonRow>
    </ActionRail>
  );
}
