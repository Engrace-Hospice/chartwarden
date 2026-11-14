// apps/web/src/modules/34-saas/wizard — step 7's choice: the button that opens it and the form (the shared ChoiceFormCard, in the tenant's
// words). An organization that bills outside ChartWarden is not offered the vendor form: leaving outside while a contract exists also sets
// the billing service mode, which only ChartWarden can do, so the member would type a credential only to be refused.
import { Button, ChoiceFormCard, PendingAttestationWarning } from "@chartwarden/ui";
import type { JSX } from "react";
import { BillingFailureNotice } from "./billing-failure-notice";
import type { CardContext } from "./card-context";
import { type TenantClearinghouseView, isChosenOutside } from "./clearinghouse-tenant";
import { useChoiceEditor } from "./use-choice-editor";

const NO_CONTRACT = { hasContract: false } as const;

export function ChoiceSection({
  current,
  canWrite,
  ctx,
}: {
  current: TenantClearinghouseView;
  canWrite: boolean;
  ctx: CardContext;
}): JSX.Element | null {
  const editor = useChoiceEditor({ current, wizard: ctx.wizard, canWrite, ctx });
  if (!canWrite) return null;
  const locked = ctx.lockedFor("choice");
  const chosen = current.vendor !== null && current.source === "tenant";
  const { failure } = editor;
  return (
    <>
      {isChosenOutside(current) ? (
        <p className="wx-row-sub">
          Your organization bills outside ChartWarden. Moving to a clearinghouse also changes your
          billing service mode, so ChartWarden makes that switch: ask ChartWarden for help.
        </p>
      ) : !editor.editing ? (
        <div className="wx-drawer-actions">
          <Button
            tone="secondary"
            data-editor-return="clearinghouse"
            disabled={locked}
            onClick={editor.open}
          >
            {chosen ? "Change the clearinghouse" : "Choose the clearinghouse"}
          </Button>
        </div>
      ) : null}

      {/* A refusal that closed the form (a stale pin) is still read here, not in a form that is gone. */}
      {failure && !editor.editing && !editor.failureBesideInput ? (
        <BillingFailureNotice failure={failure} />
      ) : null}

      {editor.editing && !isChosenOutside(current) ? (
        <>
          <PendingAttestationWarning view={ctx.wizard} audience="tenant" />
          <ChoiceFormCard
            view={current}
            form={editor.form}
            secret={editor.secret}
            errors={editor.errors}
            context={{ tenantStatus: ctx.wizard.tenantStatus, ...NO_CONTRACT }}
            headingRef={editor.headingRef}
            busy={editor.busy}
            copy={{
              submitLabel: "Save choice",
              secretNeededHint:
                "Write-only. Sealed under your organization's own key and never shown again.",
              ...(editor.consequence ? { consequence: editor.consequence } : {}),
            }}
            onChange={editor.change}
            onSecret={editor.setSecret}
            onCancel={editor.cancel}
            onContinue={() => void editor.save()}
          />
          {failure && !editor.failureBesideInput ? (
            <BillingFailureNotice failure={failure} onReverify={editor.reverify} />
          ) : null}
        </>
      ) : null}
      {editor.notice}
    </>
  );
}
