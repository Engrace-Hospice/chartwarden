import {
  Button,
  InlineAlert,
  REASON_RULES,
  ReasonDialog,
  StatusPill,
  type StatusTone,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useOpsWrite,
  useRequestGuard,
  useStaleSelection,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — tenant price plans (`/admin/pricing-plans`, plan.admin.read): the plans the
// onboarding wizard's plan step signs a tenant to. A plan is a platform fee (the greater of per-user x staff and the census-band fee),
// the billing-service rates in basis points and an implementation fee. Lifecycle over /api/admin/pricing/plans (plan-service.ts): a draft
// is edited in place and published (its prices then freeze for good); a published plan is archived; a published or archived plan
// starts a new draft version, while its family has no draft yet. Every write is plan.admin.write (step-up, Idempotency-Key, a recorded
// reason and, on an existing version, If-Match: the updatedAt read, enforced server-side); the write buttons show only to an operator
// who holds it (read from the actor context the shell reads too: this module may not import the shell, which M34 owns).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { PlanEditor, WriteFailure } from "./pricing-plan-form";
import {
  ACTION_COPY,
  type PlanAction,
  type PlanForm,
  type PricingPlan,
  actionsFor,
  blankForm,
  formFromPlan,
  pinOf,
  priceLines,
} from "./pricing-plan-model";
import { cap, formatCents } from "./status";
import { DrawerHead, StateEmpty, StateError, StateLoading } from "./ui";

type Defaults =
  operations["getApiAdminPricingDefaults"]["responses"][200]["content"]["application/json"];

const STATUS_TONE: Record<PricingPlan["status"], StatusTone> = {
  draft: "neutral",
  published: "success",
  archived: "warning",
};
const CREATE_DRAFT_KEY = "pricing-plan-create";
const editDraftKey = (id: string): string => `pricing-plan-edit:${id}`;
const UNREACHABLE = "Could not reach the server. Check your connection and try again.";

interface LoadError {
  readonly message: string;
  readonly retry: boolean;
}
/** A success, shown in the drawer of the plan it is about (a different row starts clean). */
interface PlanOutcome {
  readonly planId: string;
  readonly message: string;
}

export function PricingPlans(): JSX.Element {
  const client = useApiClient();
  // Fail closed: until the actor context answers (or if it cannot), no write buttons.
  const [canWrite, setCanWrite] = useState(false);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("plan");
  const creating = selectedId === "new";
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const [outcome, setOutcome] = useState<PlanOutcome | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setLoaded(false);
    setError(null);
    try {
      const [list, defs, actor] = await Promise.all([
        client.GET("/api/admin/pricing/plans"),
        client.GET("/api/admin/pricing/defaults"),
        client.GET("/api/v1/auth/context"),
      ]);
      if (!isCurrent()) return;
      setCanWrite(actor.data?.permissions?.includes("plan.admin.write") ?? false);
      if (list.error || defs.error) {
        const forbidden = (list.error ? list.response : defs.response).status === 403;
        setError(
          forbidden
            ? {
                message:
                  "You do not have access to price plans. A platform billing admin manages them.",
                retry: false,
              }
            : { message: "Price plans unavailable.", retry: true },
        );
        return;
      }
      setPlans(list.data);
      setDefaults(defs.data);
      setLoaded(true);
    } catch {
      if (isCurrent()) setError({ message: UNREACHABLE, retry: true });
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);
  // A success belongs to the plan it is about: opening another row (or New plan) drops it.
  useEffect(() => {
    setOutcome((o) => (o && o.planId === selectedId ? o : null));
  }, [selectedId]);

  // While the list cannot be read no drawer is shown: the plan it would show is the last read, not what the server holds now.
  const selected =
    selectedId && !creating && !error ? (plans.find((p) => p.id === selectedId) ?? null) : null;
  useStaleSelection({ param: "plan", ready: loaded, found: selected !== null, ignore: ["new"] });
  const close = (): void => setParams({});
  const done = async (planId: string, message: string): Promise<void> => {
    setOutcome({ planId, message });
    setParams({ plan: planId });
    await load();
  };
  const showCreate = creating && defaults !== null && canWrite && !error;

  return (
    <div className={`wx-list-drawer${showCreate || selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Price plans</h1>
            <p>The plans a tenant signs during onboarding. Only a published plan can be signed.</p>
          </div>
          {canWrite ? (
            <div className="wx-list-toolbar-end">
              <Button disabled={!defaults} onClick={() => setParams({ plan: "new" })}>
                New plan
              </Button>
            </div>
          ) : null}
        </header>
        {creating && loaded && !canWrite ? (
          <InlineAlert tone="info">
            Only a platform billing admin can create price plans. You can read the plans below.
          </InlineAlert>
        ) : null}
        <PlansMain
          error={error}
          loading={loading}
          plans={plans}
          selectedId={selectedId}
          onRetry={() => void load()}
          onOpen={(id) => setParams({ plan: id })}
        />
      </div>
      {showCreate ? (
        <CreateDrawer
          thresholds={defaults.bandThresholds}
          onClose={close}
          onCreated={(plan) => done(plan.id, `Draft "${plan.name}" created.`)}
        />
      ) : selected ? (
        <PlanDrawer
          key={selected.id}
          plan={selected}
          family={plans.filter((p) => p.familySlug === selected.familySlug)}
          canWrite={canWrite}
          reloading={loading}
          outcome={outcome?.planId === selected.id ? outcome.message : null}
          onClose={close}
          onDone={done}
          onReload={load}
        />
      ) : null}
    </div>
  );
}

function PlansMain({
  error,
  loading,
  plans,
  selectedId,
  onRetry,
  onOpen,
}: {
  error: LoadError | null;
  loading: boolean;
  plans: readonly PricingPlan[];
  selectedId: string | null;
  onRetry: () => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  if (error) return <StateError message={error.message} {...(error.retry ? { onRetry } : {})} />;
  if (loading && plans.length === 0) return <StateLoading label="Loading price plans…" />;
  if (plans.length === 0)
    return (
      <StateEmpty icon="layout-grid">
        No price plans yet. Create one, then publish it so tenants can sign it.
      </StateEmpty>
    );
  // The table stays during a reload, so the open drawer's row (and the focus it returns to) is kept.
  return <PlansTable plans={plans} selectedId={selectedId} onOpen={onOpen} />;
}

function PlansTable({
  plans,
  selectedId,
  onOpen,
}: {
  plans: readonly PricingPlan[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Price plans</caption>
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col" className="wx-num-col">
              Version
            </th>
            <th scope="col" className="wx-num-col">
              Per user
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr
              key={p.id}
              className={
                p.id === selectedId
                  ? "is-selected wx-data-row-interactive"
                  : "wx-data-row-interactive"
              }
              {...interactiveRowProps(() => onOpen(p.id), p.id === selectedId)}
            >
              <td>
                <span className="wx-row-title">{p.name}</span>
                <span className="wx-row-sub wx-data-md">{p.slug}</span>
              </td>
              <td className="wx-num-col wx-nums">{p.version}</td>
              <td className="wx-num-col wx-nums">
                {p.perUserPriceCents === null
                  ? "—"
                  : formatCents(p.perUserPriceCents, p.currencyCode)}
              </td>
              <td>
                <StatusPill label={cap(p.status)} tone={STATUS_TONE[p.status]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A plan's version, status and prices. */
function PlanDetails({ plan }: { plan: PricingPlan }): JSX.Element {
  return (
    <>
      <div className="wx-drawer-card-head">
        <h3>Version {plan.version}</h3>
        <StatusPill label={cap(plan.status)} tone={STATUS_TONE[plan.status]} />
      </div>
      <dl className="wx-kv">
        {priceLines(plan, plan.currencyCode).map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd className="wx-nums">{line.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The writes this operator may start on this plan. */
function PlanActions({
  plan,
  family,
  canWrite,
  locked,
  onEdit,
  onAsk,
}: {
  plan: PricingPlan;
  family: readonly PricingPlan[];
  canWrite: boolean;
  locked: boolean;
  onEdit: () => void;
  onAsk: (action: PlanAction) => void;
}): JSX.Element | null {
  if (!canWrite) return null;
  const actions = actionsFor(plan, family);
  const editable = plan.status === "draft";
  if (actions.length === 0 && !editable) return null;
  return (
    <div className="wx-drawer-actions">
      {editable ? (
        <Button tone="secondary" disabled={locked} onClick={onEdit}>
          Edit prices
        </Button>
      ) : null}
      {actions.map((a) => (
        <Button
          key={a}
          tone={a === "archive" ? "secondary" : "primary"}
          disabled={locked}
          onClick={() => onAsk(a)}
        >
          {ACTION_COPY[a].label}
        </Button>
      ))}
    </div>
  );
}

/**
 * The reason dialog of a publish, archive or new version. It re-reads the plan when it opens and shows the prices being acted on
 * (marked when they changed since the drawer was read); the write pins that read (If-Match), and a 409 re-reads it again.
 */
function ActionDialog({
  plan,
  action,
  onClose,
  onDone,
}: {
  plan: PricingPlan;
  action: PlanAction | null;
  onClose: () => void;
  onDone: (planId: string, message: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const guard = useRequestGuard();
  // What the operator is confirming: the drawer's plan until the re-read answers (a failed re-read leaves it; the pin still guards).
  const [fresh, setFresh] = useState<PricingPlan | null>(null);

  const reread = useCallback(async () => {
    const isCurrent = guard();
    try {
      const res = await client.GET("/api/admin/pricing/plans/{id}", {
        params: { path: { id: plan.id } },
      });
      if (isCurrent() && res.data) setFresh(res.data);
    } catch {
      // The drawer's read stands; the server refuses a stale pin.
    }
  }, [client, guard, plan.id]);

  useEffect(() => {
    if (action === null) setFresh(null);
    else void reread();
  }, [action, reread]);

  const shown = fresh ?? plan;
  const copy = action ? ACTION_COPY[action] : null;

  async function run(chosen: PlanAction, reason: string): Promise<void> {
    const init = (key: string) => ({
      params: {
        path: { id: plan.id },
        header: { "Idempotency-Key": key, "If-Match": pinOf(shown) },
      },
      body: { reason },
    });
    const result = await write.run(
      JSON.stringify({ action: chosen, id: plan.id, pin: shown.updatedAt, reason }),
      (key) =>
        chosen === "publish"
          ? client.POST("/api/admin/pricing/plans/{id}/publish", init(key))
          : chosen === "archive"
            ? client.POST("/api/admin/pricing/plans/{id}/archive", init(key))
            : client.POST("/api/admin/pricing/plans/{id}/new-version", init(key)),
      (data) => onDone(data.id, `"${plan.name}" ${ACTION_COPY[chosen].done}.`),
    );
    if (result.ok) onClose();
    else if (result.failure.kind === "conflict") await reread();
  }

  return (
    <ReasonDialog
      open={action !== null}
      title={copy ? `${copy.label} "${plan.name}"` : ""}
      description={copy?.explain(shown) ?? ""}
      record={action ? priceLines(shown, shown.currencyCode) : []}
      stale={shown.updatedAt !== plan.updatedAt || shown.status !== plan.status}
      rule={REASON_RULES.pricing}
      confirmLabel={copy?.label ?? ""}
      {...(copy?.tone ? { tone: copy.tone } : {})}
      busy={write.busy}
      {...(write.failure && copy
        ? { error: <WriteFailure failure={write.failure} failed={copy.failed} /> }
        : {})}
      onConfirm={(reason) => action && void run(action, reason)}
      onCancel={() => {
        write.clear();
        onClose();
      }}
    />
  );
}

function PlanDrawer({
  plan,
  family,
  canWrite,
  reloading,
  outcome,
  onClose,
  onDone,
  onReload,
}: {
  plan: PricingPlan;
  family: readonly PricingPlan[];
  canWrite: boolean;
  reloading: boolean;
  outcome: string | null;
  onClose: () => void;
  onDone: (planId: string, message: string) => Promise<void>;
  onReload: () => Promise<void>;
}): JSX.Element {
  // A step-up refusal sends the operator to /step-up and back; the typed prices come back ONCE (Cancel or a save drops them).
  const restored = useStepUpMemoryDraft<PlanForm>(editDraftKey(plan.id));
  const [stash, setStash] = useState<PlanForm | undefined>(restored);
  const [editing, setEditing] = useState(
    restored !== undefined && plan.status === "draft" && canWrite,
  );
  const [asking, setAsking] = useState<PlanAction | null>(null);
  // The edited flag (Escape stops closing a drawer once something was typed) resets when the dialog or the editor closes.
  const drawer = useDrawerA11y<HTMLElement>(onClose, editing ? "editing" : asking);
  const stopEditing = (): void => {
    setStash(undefined);
    setEditing(false);
    // Focus goes back to the drawer (its buttons return), not to the page.
    drawer.ref.current?.focus({ preventScroll: true });
  };

  return (
    <aside className="wx-admission-drawer" aria-label="Price plan" {...drawer}>
      <DrawerHead icon="layout-grid" title={plan.name} sub={plan.slug} onClose={onClose} />
      <div className="wx-drawer-body">
        {outcome ? <InlineAlert tone="success">{outcome}</InlineAlert> : null}
        {editing ? (
          <PlanEditor
            mode={{ kind: "edit", plan }}
            initial={stash ?? formFromPlan(plan)}
            draftKey={editDraftKey(plan.id)}
            onCancel={stopEditing}
            onConflict={() => void onReload()}
            onSaved={async (saved) => {
              stopEditing();
              await onDone(saved.id, `"${saved.name}" prices saved.`);
            }}
          />
        ) : (
          <section className="wx-drawer-card">
            <PlanDetails plan={plan} />
            <PlanActions
              plan={plan}
              family={family}
              canWrite={canWrite}
              locked={reloading || asking !== null}
              onEdit={() => setEditing(true)}
              onAsk={setAsking}
            />
          </section>
        )}
      </div>
      <ActionDialog plan={plan} action={asking} onClose={() => setAsking(null)} onDone={onDone} />
    </aside>
  );
}

function CreateDrawer({
  thresholds,
  onClose,
  onCreated,
}: {
  thresholds: readonly number[];
  onClose: () => void;
  onCreated: (plan: PricingPlan) => Promise<void>;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  // A step-up refusal sends the operator to /step-up and back; the typed plan comes back (when the bands still match).
  const restored = useStepUpMemoryDraft<PlanForm>(CREATE_DRAFT_KEY);
  const initial =
    restored && restored.bandFees.length === thresholds.length
      ? restored
      : blankForm(thresholds.length);
  return (
    <aside className="wx-admission-drawer" aria-label="New price plan" {...drawer}>
      <DrawerHead icon="plus" title="New price plan" sub="Created as a draft" onClose={onClose} />
      <div className="wx-drawer-body">
        <PlanEditor
          mode={{ kind: "create", thresholds }}
          initial={initial}
          draftKey={CREATE_DRAFT_KEY}
          onSaved={onCreated}
        />
      </div>
    </aside>
  );
}
