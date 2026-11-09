// apps/admin/src/modules/34-saas-platform/onboarding — the frame every step sits in: what the step is and who owns it, why it cannot be
// acted on (locked, tenant not onboarding), what settled it (evidence, who, when), and the three things an operator may do to the
// step itself: mark it done with evidence, skip it (only where it does not apply), re-open it to edit. A panel is the step's own data.
import {
  Button,
  InlineAlert,
  REASON_RULES,
  ReasonDialog,
  StatusPill,
  type StatusTone,
  stashStepUpMemoryDraft,
  useApiClient,
} from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useSession } from "../../../shell/session";
import { statusLabel } from "../saas-status";
import { AttestCard, attestDraftKey } from "./attest-card";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { RecordSaveDialog } from "./record-save-dialog";
import { useOpsWrite } from "./use-ops-write";
import { useReturnedMemoryDraft } from "./use-returned-draft";
import { OWNER_LABEL, isSystemSkip } from "./wizard-model";

const STEP_TONE: Record<string, StatusTone> = {
  done: "success",
  skipped: "neutral",
  in_progress: "progress",
  blocked: "error",
  pending: "neutral",
};

type Dialog = "skip" | "reopen" | null;

/** What a Re-verify keeps of the skip / re-open prompt: which one was open and the reason typed in it (free text: memory only). */
interface DecideDraft {
  readonly dialog: "skip" | "reopen";
  readonly reason: string;
}
const decideDraftKey = (orgSlug: string, stepKey: string): string =>
  `wizard:${orgSlug}:${stepKey}:decide`;

function settledBy(ctx: PanelContext, me: string | undefined): string | null {
  const by = ctx.step.attestedBy;
  if (!by) return null;
  if (by.actorKind === "tenant") return "The tenant";
  return by.membershipId !== null && by.membershipId === me ? "You" : "A ChartWarden operator";
}

function EvidenceCard({ ctx }: { ctx: PanelContext }): JSX.Element | null {
  const me = useSession()?.membershipId;
  const { step } = ctx;
  const by = settledBy(ctx, me);
  if (!step.evidence && !step.skipRationale && !by) return null;
  return (
    <section className="wx-drawer-card" aria-label="How this step was settled">
      <div className="wx-drawer-card-head">
        <h3>{step.status === "skipped" ? "Skipped" : "Settled"}</h3>
      </div>
      {isSystemSkip(step) ? (
        <p className="wx-row-sub">
          Skipped automatically because this tenant bills outside ChartWarden.
        </p>
      ) : null}
      <dl className="wx-kv">
        {step.evidence ? (
          <>
            <dt>Evidence</dt>
            <dd>{step.evidence.note}</dd>
            {step.evidence.ref ? (
              <>
                <dt>Reference</dt>
                <dd>{step.evidence.ref}</dd>
              </>
            ) : null}
          </>
        ) : null}
        {step.skipRationale && !isSystemSkip(step) ? (
          <>
            <dt>Reason</dt>
            <dd>{step.skipRationale}</dd>
          </>
        ) : null}
        {by && step.attestedBy ? (
          <>
            <dt>By</dt>
            <dd>{by}</dd>
            <dt>When</dt>
            <dd className="wx-nums">{new Date(step.attestedBy.at).toLocaleString()}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

export function StepFrame({
  ctx,
  settledByPanel = false,
  children,
}: {
  ctx: PanelContext;
  /** The panel settles the step itself (signing the contract), so no "mark done" is offered. */
  settledByPanel?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const client = useApiClient();
  const { step, actions, orgSlug } = ctx;
  // Coming back from Re-verify with a stashed form: the card opens with what was typed (the card itself restores it). Only on that
  // return: a draft an abandoned Re-verify left is dropped here, so it never opens the card on a later visit or another step-up's return.
  const attestDraft = useReturnedMemoryDraft(attestDraftKey(orgSlug, step.key));
  const [attesting, setAttesting] = useState(() => actions.canAttest && attestDraft !== undefined);
  // The same for the skip / re-open prompt: it reopens, with the reason that was typed, on the return from Re-verify.
  const decideDraft = useReturnedMemoryDraft<DecideDraft>(decideDraftKey(orgSlug, step.key));
  const [dialog, setDialog] = useState<Dialog>(decideDraft?.dialog ?? null);
  // What is in the prompt's reason box right now (a Re-verify keeps an edit made after a refusal, not only the last submitted text).
  const typedReason = useRef(decideDraft?.reason ?? "");
  const write = useOpsWrite();

  /** The props a skip / re-open prompt shares: the typed reason survives a Re-verify, and is dropped with the prompt. */
  const reasonKeeping = (kind: "skip" | "reopen") => ({
    ...(decideDraft?.dialog === kind ? { initialReason: decideDraft.reason } : {}),
    onReasonChange: (reason: string) => {
      typedReason.current = reason;
    },
    onReverify: () =>
      stashStepUpMemoryDraft<DecideDraft>(decideDraftKey(orgSlug, step.key), {
        dialog: kind,
        reason: typedReason.current,
      }),
  });
  const closeDialog = (): void => {
    typedReason.current = "";
    setDialog(null);
  };

  async function decide(kind: "skip" | "reopen", reason: string): Promise<void> {
    const taskId = step.id;
    if (!taskId) return;
    const outcome = await write.run(`${kind}:${reason}`, (key) =>
      kind === "skip"
        ? client.POST("/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/skip", {
            params: { path: { orgSlug, taskId } },
            body: { skipRationale: reason },
            headers: { "Idempotency-Key": key },
          })
        : client.POST("/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/reopen", {
            params: { path: { orgSlug, taskId } },
            body: { reason },
            headers: { "Idempotency-Key": key },
          }),
    );
    if (outcome.ok) {
      closeDialog();
      await ctx.refresh();
    }
  }

  const failure = write.failure;

  return (
    <div className="wx-wizard-panel">
      <section className="wx-drawer-card" aria-label={step.title}>
        <div className="wx-drawer-card-head">
          {/* wizard-screen moves focus here when the operator changes step */}
          <h2 tabIndex={-1} data-step-heading="">
            {step.title}
          </h2>
          <StatusPill label={statusLabel(step.status)} tone={STEP_TONE[step.status] ?? "neutral"} />
        </div>
        <p className="wx-row-sub">
          {step.description} · Owner: {OWNER_LABEL[step.owner]}
          {step.optional ? " · Optional" : ""}
        </p>
        {actions.readOnlyReason ? (
          <InlineAlert tone="info">{actions.readOnlyReason}</InlineAlert>
        ) : null}
        {step.completionMode === "auto" && !actions.readOnlyReason && step.status !== "done" ? (
          <InlineAlert tone="info">
            The platform settles this step itself once the facts below hold. It cannot be marked
            done by hand.
          </InlineAlert>
        ) : null}
      </section>

      {children}

      <EvidenceCard ctx={ctx} />

      {attesting ? <AttestCard ctx={ctx} onCancel={() => setAttesting(false)} /> : null}

      {failure && !dialog ? <FailureNotice failure={failure} orgSlug={orgSlug} /> : null}
      {actions.reopenBlockedBy === "go_live_pending" ? (
        <InlineAlert tone="info">
          A go-live attestation is pending. Revoke the go-live attestation first (on the Go-live
          step), then re-open this step.
        </InlineAlert>
      ) : null}

      <div className="wx-drawer-actions">
        {actions.canAttest && !settledByPanel && !attesting ? (
          <Button onClick={() => setAttesting(true)}>Mark done with evidence</Button>
        ) : null}
        {actions.canSkip ? (
          <Button
            tone="secondary"
            onClick={() => {
              write.clear();
              setDialog("skip");
            }}
          >
            Skip this step
          </Button>
        ) : null}
        {actions.canReopen ? (
          <Button
            tone="secondary"
            onClick={() => {
              write.clear();
              setDialog("reopen");
            }}
          >
            Re-open to edit
          </Button>
        ) : null}
      </div>

      <RecordSaveDialog
        open={dialog === "skip"}
        title={`Skip ${step.title}`}
        description="Use this only where the step does not apply to this tenant."
        rule={REASON_RULES.skip}
        confirmLabel="Skip step"
        write={write}
        orgSlug={orgSlug}
        {...reasonKeeping("skip")}
        onConfirm={(reason) => void decide("skip", reason)}
        onCancel={closeDialog}
      />
      <RecordSaveDialog
        open={dialog === "reopen"}
        title={`Re-open ${step.title}`}
        description="Re-opening discards the attestation the audit trail relied on. Later steps keep their state."
        rule={REASON_RULES.decision}
        confirmLabel="Re-open step"
        write={write}
        orgSlug={orgSlug}
        {...reasonKeeping("reopen")}
        onConfirm={(reason) => void decide("reopen", reason)}
        onCancel={closeDialog}
      />
    </div>
  );
}
