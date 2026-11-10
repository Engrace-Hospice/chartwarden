// apps/web/src/modules/34-saas/wizard — the frame every step sits in: what the step is and who owns it, why it cannot be acted on
// (locked, organization live), how it was settled, and the four things the tenant may do to the step itself: Start, Mark done with
// evidence, Skip (steps 8, 9 and 10 only: the organization's administrator, with a written reason and a fresh step-up) and Re-open.
// The step's own data is the panel, drawn inside the frame (panel-props.ts is the contract between the two).
import {
  Button,
  InlineAlert,
  type OpsFailure,
  REASON_RULES,
  StatusPill,
  type StatusTone,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { statusLabel } from "../saas-status";
import { AttestCard, attestDraftKey } from "./attest-card";
import { FailureNotice } from "./failure-notice";
import type { StepPanelProps } from "./panel-props";
import type { PanelComponent } from "./panels";
import { ReasonPrompt } from "./reason-prompt";
import { SettledCard } from "./settled-card";
import { useEditorFocus } from "./use-editor-focus";
import { useOpsWrite } from "./use-ops-write";
import { viewHasMoved } from "./wizard-errors";
import { OWNER_LABEL, stepActionsOf } from "./wizard-model";

const STEP_TONE: Record<string, StatusTone> = {
  done: "success",
  skipped: "neutral",
  in_progress: "progress",
  blocked: "error",
  pending: "neutral",
};

/** The skip rationale is 8 to 2000 characters; a re-open reason 8 to 1000 (the server's own bounds). */
const REOPEN_RULE = REASON_RULES.decision;
const SKIP_RULE = REASON_RULES.skip;

type Prompt = "skip" | "reopen" | null;

/** What a Re-verify keeps of the skip / re-open prompt: which one was open and the reason typed in it (free text: memory only). */
interface DecideDraft {
  readonly prompt: "skip" | "reopen";
  readonly reason: string;
}
const decideDraftKey = (stepKey: string): string => `wizard:${stepKey}:decide`;

const PROMPT_COPY = {
  skip: {
    title: "This does not apply to us",
    description:
      "Skip this step only if it does not apply to your organization. Say why. You can re-open it later.",
    label: "Why it does not apply",
    confirmLabel: "Skip this step",
  },
  reopen: {
    title: "Re-open this step",
    description: "Re-opening discards how the step was settled. Steps after it keep their state.",
    label: "Why you are re-opening it",
    confirmLabel: "Re-open step",
  },
} as const;

export function StepFrame({
  base,
  Panel,
}: {
  base: Omit<StepPanelProps, "skip">;
  Panel: PanelComponent;
}): JSX.Element {
  const client = useApiClient();
  const { step, view, held, roles, onChanged } = base;
  const actions = stepActionsOf(step, view, held, roles);
  // Back from Re-verify with a stashed form: the card (or prompt) opens with what was typed. Only on that return.
  const attestDraft = useStepUpMemoryDraft(attestDraftKey(step.key));
  const [attesting, setAttesting] = useState(() => actions.canAttest && attestDraft !== undefined);
  const decideDraft = useStepUpMemoryDraft<DecideDraft>(decideDraftKey(step.key));
  const [prompt, setPrompt] = useState<Prompt>(decideDraft?.prompt ?? null);
  // What is in the prompt's box right now (a Re-verify keeps an edit made after a refusal, not only the last submitted text).
  const typed = useRef(decideDraft?.reason ?? "");
  const write = useOpsWrite();
  // A refusal that says the step moved under the person: the view is read again and the refusal is read on the page.
  const [moved, setMoved] = useState<OpsFailure | null>(null);
  const attestHeading = useEditorFocus(attesting && actions.canAttest, "attest");

  const closePrompt = (keepFailure = false): void => {
    typed.current = "";
    if (!keepFailure) write.clear();
    setPrompt(null);
  };
  const openPrompt = (kind: "skip" | "reopen"): void => {
    write.clear();
    setMoved(null);
    setPrompt(kind);
  };

  async function start(): Promise<void> {
    const taskId = step.id;
    if (!taskId) return;
    setMoved(null);
    const outcome = await write.run(
      `start:${taskId}`,
      (key) =>
        client.POST("/api/v1/tenant/onboarding/{taskId}/start", {
          params: { path: { taskId } },
          body: {},
          headers: { "Idempotency-Key": key },
        }),
      async () => onChanged(),
    );
    if (!outcome.ok && viewHasMoved(outcome.failure)) {
      await onChanged();
      setMoved(outcome.failure);
    }
  }

  async function decide(kind: "skip" | "reopen", reason: string): Promise<void> {
    const taskId = step.id;
    if (!taskId) return;
    const outcome = await write.run(`${kind}:${reason}`, (key) =>
      kind === "skip"
        ? client.POST("/api/v1/tenant/onboarding/{taskId}/skip", {
            params: { path: { taskId }, header: { "Idempotency-Key": key } },
            body: { skipRationale: reason },
          })
        : client.POST("/api/v1/tenant/onboarding/{taskId}/reopen", {
            params: { path: { taskId } },
            body: { reason },
            headers: { "Idempotency-Key": key },
          }),
    );
    if (outcome.ok) {
      closePrompt();
      await onChanged();
    } else if (viewHasMoved(outcome.failure)) {
      closePrompt(true);
      await onChanged();
      setMoved(outcome.failure);
    }
  }

  const skip = { available: actions.canSkip, request: () => actions.canSkip && openPrompt("skip") };
  const failure = write.failure;
  const promptCopy = prompt ? PROMPT_COPY[prompt] : null;

  return (
    <div className="wx-wizard-panel">
      <section className="wx-drawer-card" aria-label={step.title}>
        <div className="wx-drawer-card-head">
          {/* wizard-screen moves focus here when the person changes step */}
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
        {step.completionMode === "auto" && !actions.closedReason && step.status !== "done" ? (
          <InlineAlert tone="info">
            ChartWarden settles this step itself once the facts below hold. It cannot be marked done
            by hand.
          </InlineAlert>
        ) : null}
      </section>

      <Panel {...base} skip={skip} />

      <SettledCard step={step} />

      {attesting ? (
        <AttestCard
          step={step}
          headingRef={attestHeading}
          onDone={async () => onChanged()}
          onCancel={() => setAttesting(false)}
          onMoved={(refusal) => {
            setAttesting(false);
            setMoved(refusal);
          }}
        />
      ) : null}

      {moved && !attesting ? <FailureNotice failure={moved} /> : null}
      {failure && !prompt && !attesting ? <FailureNotice failure={failure} /> : null}
      {actions.reopenBlockedBy === "go_live_pending" ? (
        <InlineAlert tone="info">
          A go-live attestation is waiting for ChartWarden's approval. Reassign the compliance
          officer or ask ChartWarden to revoke it, then re-open this step.
        </InlineAlert>
      ) : null}

      <div className="wx-drawer-actions">
        {actions.canStart ? (
          <Button tone="secondary" disabled={write.busy} onClick={() => void start()}>
            Start this step
          </Button>
        ) : null}
        {actions.canAttest && !attesting ? (
          <Button
            data-editor-return="attest"
            onClick={() => {
              setMoved(null);
              setAttesting(true);
            }}
          >
            Mark done with evidence
          </Button>
        ) : null}
        {actions.canSkip ? (
          <Button tone="secondary" onClick={() => openPrompt("skip")}>
            Skip this step
          </Button>
        ) : null}
        {actions.canReopen ? (
          <Button tone="secondary" onClick={() => openPrompt("reopen")}>
            Re-open to edit
          </Button>
        ) : null}
      </div>

      {promptCopy && prompt ? (
        <ReasonPrompt
          open
          {...promptCopy}
          rule={prompt === "skip" ? SKIP_RULE : REOPEN_RULE}
          busy={write.busy}
          fieldError={failure?.fieldErrors.reason ?? failure?.fieldErrors.skipRationale}
          initialReason={decideDraft?.prompt === prompt ? decideDraft.reason : undefined}
          error={
            failure ? (
              <FailureNotice
                failure={failure}
                onReverify={() =>
                  stashStepUpMemoryDraft<DecideDraft>(decideDraftKey(step.key), {
                    prompt,
                    reason: typed.current,
                  })
                }
              />
            ) : null
          }
          onReasonChange={(reason) => {
            typed.current = reason;
          }}
          onConfirm={(reason) => void decide(prompt, reason)}
          onCancel={() => closePrompt()}
        />
      ) : null}
    </div>
  );
}
