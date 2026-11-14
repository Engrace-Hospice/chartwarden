// apps/web/src/modules/34-saas/wizard — how a step was settled, in the tenant's words: the evidence, who did it ("You", "Your
// organization", "ChartWarden operations": the operator is never named) and, for a skip, which of the three it was and why. Who
// skipped comes from the server's `skippedBy`; the rationale text is never read to decide it.
import { isSystemSkip } from "@chartwarden/ui";
import type { JSX } from "react";
import { useSession } from "../../../shell/session";
import type { WizardStep } from "./wizard-model";

const SKIPPED_BY: Readonly<Record<NonNullable<WizardStep["skippedBy"]>, string>> = {
  system: "Skipped automatically because your organization bills outside ChartWarden",
  tenant: "Skipped by your organization",
  platform_ops: "Skipped by ChartWarden operations",
};
const OPERATIONS = "ChartWarden operations";

function settledBy(step: WizardStep, me: string | undefined): string | null {
  const by = step.attestedBy;
  if (!by) return null;
  if (by.actorKind === "platform_ops") return by.label ?? OPERATIONS;
  return by.membershipId !== null && by.membershipId === me ? "You" : "Your organization";
}

export function SettledCard({ step }: { step: WizardStep }): JSX.Element | null {
  const me = useSession()?.membershipId;
  const by = settledBy(step, me);
  const skippedBy = step.status === "skipped" ? (step.skippedBy ?? null) : null;
  if (!step.evidence && !step.skipRationale && !by && skippedBy === null) return null;
  const systemSkip = isSystemSkip(step);
  return (
    <section className="wx-drawer-card" aria-label="How this step was settled">
      <div className="wx-drawer-card-head">
        <h3>{step.status === "skipped" ? "Skipped" : "Settled"}</h3>
      </div>
      {skippedBy !== null ? <p className="wx-row-sub">{SKIPPED_BY[skippedBy]}.</p> : null}
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
        {step.skipRationale && !systemSkip ? (
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
