// apps/web/src/modules/34-saas/wizard — step 14, Go live: two people. Your compliance officer attests that your organization is ready
// (POST /api/v1/tenant/go-live/attest, a fresh step-up); a ChartWarden operator then approves, and only then does your organization go
// live. A pending attestation can be approved for 14 days. The step itself is never marked done or skipped by hand.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  TextAreaField,
  UnstyledList,
  useApiClient,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../../shell/session";
import { FailureNotice, stepHref } from "./failure-notice";
import type { StepPanelProps } from "./panel-props";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";
import { useWizardDraft } from "./wizard-drafts";
import { guardLabel, viewHasMoved } from "./wizard-errors";
import { GO_LIVE_STEP_KEY, ROLE_COMPLIANCE_OFFICER, type WizardStep } from "./wizard-model";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTE_MAX = 1000;
const DRAFT_NAME = "go-live-note";

/** What a Re-verify keeps: the note only. The attestation tick is never restored: the officer attests knowingly, again. */
interface Draft {
  note: string;
}

const isSettled = (s: WizardStep): boolean => s.status === "done" || s.status === "skipped";

function StateLine({ props }: { props: StepPanelProps }): JSX.Element {
  const { goLive } = props.view;
  const expiresAt = goLive.attestation?.expiresAt
    ? new Date(goLive.attestation.expiresAt).getTime()
    : null;
  const daysLeft =
    expiresAt === null ? null : Math.max(Math.ceil((expiresAt - Date.now()) / DAY_MS), 0);
  switch (goLive.state) {
    case "live":
      return <InlineAlert tone="success">Your organization is live.</InlineAlert>;
    case "closed":
      return <InlineAlert tone="info">Onboarding is closed for your organization.</InlineAlert>;
    case "awaiting_approval":
      return (
        <InlineAlert tone="info">
          Your compliance officer has attested. Waiting for ChartWarden's approval
          {daysLeft === null
            ? "."
            : daysLeft === 0
              ? ": the attestation has expired. Ask ChartWarden to clear it, then your compliance officer can attest again."
              : `: it can be approved for ${daysLeft} more ${daysLeft === 1 ? "day" : "days"}.`}
        </InlineAlert>
      );
    case "awaiting_attestation":
      return (
        <InlineAlert tone="info">
          Every step is done. Your compliance officer can attest now.
        </InlineAlert>
      );
    default:
      return (
        <InlineAlert tone="info">
          Finish the steps below, then your compliance officer attests.
        </InlineAlert>
      );
  }
}

export function GoLivePanel(props: StepPanelProps): JSX.Element {
  const { view, held, roles, onChanged } = props;
  const client = useApiClient();
  const me = useSession()?.membershipId;
  const { goLive } = view;
  const { restored, stash } = useWizardDraft<Draft>(DRAFT_NAME);
  const [note, setNote] = useState(restored?.note ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const write = useOpsWrite();

  const open = view.steps.filter(
    (s) => s.isCanonical && !s.optional && s.key !== GO_LIVE_STEP_KEY && !isSettled(s),
  );
  const mayAttest = held.has(ONBOARDING_KEYS.goLiveAttest) && roles.has(ROLE_COMPLIANCE_OFFICER);
  // The server's rule: with no officer assigned, any holder of the role may attest; once one is assigned, only that person.
  const assigned = goLive.complianceOfficerMembershipId;
  const isAssigned = me !== undefined && (assigned === null || assigned === me);
  const canAttest = mayAttest && goLive.state === "awaiting_attestation" && isAssigned;
  const noteTooLong = note.trim().length > NOTE_MAX;

  async function attest(): Promise<void> {
    if (!confirmed || noteTooLong) return;
    const body = {
      attestationConfirmed: true as const,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const outcome = await write.run(
      JSON.stringify(body),
      (key) =>
        client.POST("/api/v1/tenant/go-live/attest", { body, headers: { "Idempotency-Key": key } }),
      async () => onChanged(),
    );
    if (outcome.ok) {
      setNote("");
      setConfirmed(false);
    } else if (viewHasMoved(outcome.failure)) await onChanged();
  }

  const facts: Fact[] = [
    {
      key: "steps",
      label: "Every required step is done or skipped",
      state: open.length === 0 ? "ok" : "pending",
    },
    {
      key: "attested",
      label: "Your compliance officer has attested",
      state: goLive.attestation && goLive.attestation.status !== "revoked" ? "ok" : "pending",
    },
    {
      key: "approved",
      label: "ChartWarden has approved",
      state: goLive.state === "live" ? "ok" : "pending",
    },
  ];

  return (
    <section className="wx-drawer-card" aria-label="Go live">
      <div className="wx-drawer-card-head">
        <h3>Go live</h3>
      </div>
      <StateLine props={props} />
      <FactList facts={facts} ariaLabel="What settles this step" />
      {open.length > 0 ? (
        <>
          <p>Still open:</p>
          <UnstyledList>
            {open.map((s) => (
              <li key={s.key}>
                <Link to={stepHref(s.key)}>{s.title}</Link>
              </li>
            ))}
          </UnstyledList>
        </>
      ) : null}
      {goLive.failedGuards.length > 0 ? (
        <UnstyledList>
          {goLive.failedGuards.map((g) => (
            <li key={g}>{guardLabel(g)}</li>
          ))}
        </UnstyledList>
      ) : null}
      {canAttest ? (
        <form
          className="wx-form-stack"
          aria-label="Attest go-live readiness"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void attest();
          }}
        >
          <TextAreaField
            label="Note (optional)"
            hint="Recorded with your attestation. Do not include patient information."
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            error={
              noteTooLong ? `At most ${NOTE_MAX} characters.` : write.failure?.fieldErrors.note
            }
          />
          <label className="wx-action-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>I attest that our organization is ready to go live.</span>
          </label>
          {write.failure ? (
            <FailureNotice
              failure={write.failure}
              inputFields={["note"]}
              onReverify={() => stash({ note })}
            />
          ) : null}
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={!confirmed || noteTooLong || write.busy}>
              {write.busy ? "Attesting…" : "Attest readiness"}
            </Button>
          </div>
        </form>
      ) : goLive.state === "awaiting_attestation" ? (
        <RoleCannot what="attest go-live readiness: only your assigned compliance officer can" />
      ) : null}
    </section>
  );
}
