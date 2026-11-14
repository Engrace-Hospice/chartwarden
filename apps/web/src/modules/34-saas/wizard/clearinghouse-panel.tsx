// apps/web/src/modules/34-saas/wizard — step 7, Billing: clearinghouse, on the tenant's side. The organization chooses Stedi, Claim.MD or
// billing outside ChartWarden, records the BAA it holds with its vendor, verifies the connection, and (once ChartWarden has verified the
// BAA) activates. The vendor credential is write-only: sealed under the organization's own key, never returned, never shown, never stashed
// through a Re-verify. Every write needs a fresh step-up, carries one Idempotency-Key per intent, and voids a pending go-live attestation;
// a stale pin or a refusal that says the settings moved reloads this step and the wizard and says so. The cards (choice, BAA, connection,
// activation) hold still while one of them has an editor open or a write running, and results land on a status line that outlives them.
import {
  Button,
  FactList,
  InlineAlert,
  LoadingSpinner,
  StaleNotice,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { useDraftScope } from "./billing-drafts";
import { BILLING_ERROR_COPY } from "./billing-errors";
import type { CardContext, CardId } from "./card-context";
import { ActivateCard } from "./clearinghouse-activate-card";
import { BaaCard } from "./clearinghouse-baa-card";
import { ChoiceSection } from "./clearinghouse-choice-section";
import {
  type TenantClearinghouseView,
  tenantActionsOf,
  tenantClearinghouseIdentityKey,
  tenantFactsOf,
} from "./clearinghouse-tenant";
import { VerifyCard } from "./clearinghouse-verify-card";
import { type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { StatusLine, usePanelStatus } from "./panel-status";

const PATH = "/api/v1/tenant/clearinghouse";
const READ_KEY = "billing.clearinghouse.read";
const ADMIN_KEY = "billing.clearinghouse.admin";

export function ClearinghousePanel(props: StepPanelProps): JSX.Element {
  if (!props.held.has(READ_KEY)) {
    return (
      <section className="wx-drawer-card" aria-label="Clearinghouse settings">
        <div className="wx-drawer-card-head">
          <h3>Clearinghouse</h3>
        </div>
        <InlineAlert tone="info">
          Your role cannot view the clearinghouse settings. Ask your administrator.
        </InlineAlert>
      </section>
    );
  }
  return <ClearinghouseBody {...props} />;
}

function ClearinghouseBody({ step, view, held, onChanged }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const load = useLoad<TenantClearinghouseView>(
    "tenant-clearinghouse",
    () => client.GET(PATH),
    BILLING_ERROR_COPY,
  );
  const scope = useDraftScope();
  const status = usePanelStatus();
  const [busy, setBusy] = useState<ReadonlySet<CardId>>(() => new Set());
  const { reload } = load;

  const onBusy = useCallback((card: CardId, isBusy: boolean): void => {
    setBusy((prev) => {
      if (prev.has(card) === isBusy) return prev;
      const next = new Set(prev);
      if (isBusy) next.add(card);
      else next.delete(card);
      return next;
    });
  }, []);
  /** This step's data and the wizard, read again. `onChanged` never rejects; if it ever did, the stale notice and the shell say so. */
  const reloadBoth = useCallback(async (): Promise<void> => {
    try {
      await Promise.all([reload(true), onChanged()]);
    } catch {
      // nothing to add: a failed quiet reload already raised `stale`
    }
  }, [reload, onChanged]);

  const current = load.data;
  const configKey = current ? tenantClearinghouseIdentityKey(current) : null;
  const canWrite = held.has(ADMIN_KEY) && isStepOpenForWork(view, step);
  const actions = current ? tenantActionsOf(current, canWrite) : null;
  const ctx: CardContext = {
    scope,
    stepKey: step.key,
    wizard: view,
    announce: status.announce,
    onSettled: reloadBoth,
    onMoved: reloadBoth,
    onBusy,
    lockedFor: (card) => [...busy].some((other) => other !== card),
  };

  return (
    <>
      <StatusLine control={status} />
      <section className="wx-drawer-card" aria-label="Clearinghouse settings">
        <div className="wx-drawer-card-head">
          <h3>Clearinghouse</h3>
        </div>
        <p className="wx-row-sub">
          This step is done when your clearinghouse is active, or when you choose to bill outside
          ChartWarden.
        </p>
        {load.loading && !current ? (
          <LoadingSpinner label="Loading the clearinghouse settings" />
        ) : null}
        {load.failure ? (
          <div className="wx-form-stack">
            <InlineAlert tone="error">
              Could not load the clearinghouse settings. {load.failure.message}
            </InlineAlert>
            <div>
              <Button size="sm" tone="secondary" onClick={() => void load.reload()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
        <StaleNotice stale={load.stale} onReload={() => void load.reload()} />
        {current ? (
          <FactList facts={tenantFactsOf(current)} ariaLabel="What settles this step" />
        ) : null}
      </section>

      {current ? <ChoiceSection current={current} canWrite={canWrite} ctx={ctx} /> : null}
      {current && actions?.canRecordBaa ? (
        <BaaCard key={`baa:${configKey}`} view={current} ctx={ctx} />
      ) : null}
      {current && actions?.canVerifyConnection ? (
        <VerifyCard key={`verify:${configKey}`} view={current} ctx={ctx} />
      ) : null}
      {current && actions?.showActivation ? (
        <ActivateCard view={current} actions={actions} ctx={ctx} onRefresh={() => reload(true)} />
      ) : null}
    </>
  );
}
