// apps/web/src/modules/34-saas/wizard — step 7, the activation: the organization's own administrator's act, refused by the server until the
// connection and the BAA are both verified. The write needs a fresh step-up, carries one Idempotency-Key, and voids a pending go-live
// attestation. Its result goes to the panel's status line (the button is replaced by text), and a refusal that says the settings moved
// reloads them (an operator may have voided the BAA since the member last looked).
import { Button, PendingAttestationWarning, useApiClient, useOpsWrite } from "@chartwarden/ui";
import { useEffect, useId } from "react";
import type { JSX } from "react";
import { BILLING_ERROR_COPY, isViewMoved } from "./billing-errors";
import { BillingFailureNotice } from "./billing-failure-notice";
import type { CardContext } from "./card-context";
import type { TenantClearinghouseActions, TenantClearinghouseView } from "./clearinghouse-tenant";
import { useGuarded } from "./use-guarded";

const BASE = "/api/v1/tenant/clearinghouse";

export function ActivateCard({
  view,
  actions,
  ctx,
  onRefresh,
}: {
  view: TenantClearinghouseView;
  actions: TenantClearinghouseActions;
  ctx: CardContext;
  /** Read this step's data again (not the wizard: that read is audited per call). */
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const { guard, notice } = useGuarded();
  const locked = ctx.lockedFor("activate");
  const headingId = useId();
  const { onBusy } = ctx;
  useEffect(() => {
    onBusy("activate", write.busy);
  }, [onBusy, write.busy]);

  async function activate(): Promise<void> {
    ctx.announce(null);
    const outcome = await write.run(
      "activate",
      (key) => client.POST(`${BASE}/activate`, { params: { header: { "Idempotency-Key": key } } }),
      async () => {
        ctx.announce(
          {
            tone: "success",
            text: "The clearinghouse is active. Claims can go out under your vendor account.",
          },
          true,
        );
        await ctx.onSettled();
      },
    );
    if (!outcome.ok && isViewMoved(outcome.failure)) await ctx.onMoved();
  }

  return (
    <section className="wx-drawer-card" aria-labelledby={headingId}>
      <div className="wx-drawer-card-head">
        <h3 id={headingId}>Activation</h3>
      </div>
      {write.failure ? <BillingFailureNotice failure={write.failure} /> : null}
      {view.status === "active" ? (
        <p className="wx-row-sub">The clearinghouse is active.</p>
      ) : actions.canActivate ? (
        <div className="wx-form-stack">
          <p className="wx-row-sub">
            The connection and your vendor BAA are verified. Activating lets claims go out under
            your vendor account.
          </p>
          {locked ? null : <PendingAttestationWarning view={ctx.wizard} audience="tenant" />}
          {locked ? <p className="wx-row-sub">Finish or cancel the change above first.</p> : null}
          <div className="wx-drawer-actions">
            <Button
              disabled={locked}
              aria-disabled={write.busy || undefined}
              onClick={() => {
                if (!write.busy) void guard(activate);
              }}
            >
              Activate the clearinghouse
            </Button>
          </div>
        </div>
      ) : actions.waitingForBaa ? (
        <div className="wx-form-stack">
          <p className="wx-row-sub">
            Waiting for ChartWarden to verify your vendor BAA. Activation opens once it has, and the
            connection is verified.
          </p>
          <div>
            <Button size="sm" tone="secondary" onClick={() => void onRefresh()}>
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <p className="wx-row-sub">
          Activation opens once the connection is verified and ChartWarden has verified your vendor
          BAA.
        </p>
      )}
      {notice}
    </section>
  );
}
