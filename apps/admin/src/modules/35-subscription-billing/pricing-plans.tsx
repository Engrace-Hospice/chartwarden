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
  useStepUpDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — tenant price plans (`/admin/pricing-plans`, plan.admin.read): the plans the
// onboarding wizard's plan step signs a tenant to. A plan is a platform fee (the greater of per-user x staff and the census-band fee),
// the billing-service rates in basis points and an implementation fee. Lifecycle over /api/admin/pricing/plans (plan-service.ts): a draft
// is edited in place and published (its prices then freeze for good); a published plan is archived; a published or archived plan
// starts a new draft version, while its family has no draft yet. Every write is plan.admin.write (step-up, Idempotency-Key and a
// recorded reason, enforced server-side); the write buttons show only to an operator who holds it.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  PlanEditor,
  type PlanForm,
  type PricingPlan,
  WriteFailure,
  blankForm,
  formFromPlan,
} from "./pricing-plan-form";
import { cap, formatCents } from "./status";
import { DrawerHead, StateEmpty, StateError, StateLoading } from "./ui";

export { parsePercentBps, pricingFormErrors } from "./pricing-plan-form";

type Defaults =
  operations["getApiAdminPricingDefaults"]["responses"][200]["content"]["application/json"];
type Action = "publish" | "new-version" | "archive";

const STATUS_TONE: Record<PricingPlan["status"], StatusTone> = {
  draft: "neutral",
  published: "success",
  archived: "warning",
};
const ACTION_COPY: Record<
  Action,
  {
    label: string;
    done: string;
    failed: string;
    tone?: "danger";
    explain: (p: PricingPlan) => string;
  }
> = {
  publish: {
    label: "Publish",
    done: "published",
    failed: "Could not publish the plan.",
    explain: () =>
      "Publishing freezes these prices for good: a published plan can never be edited, and onboarding offers it to tenants straight away. Tenants keep the price they sign.",
  },
  "new-version": {
    label: "Start a new version",
    done: "copied to a new draft version",
    failed: "Could not start a new version of the plan.",
    explain: (p) =>
      `This copies version ${p.version}'s prices into a new draft version you can edit, then publish. Version ${p.version} does not change.`,
  },
  archive: {
    label: "Archive",
    done: "archived",
    failed: "Could not archive the plan.",
    tone: "danger",
    explain: () =>
      "Archiving stops new tenants from signing this plan. Tenants already on it keep their contract and price.",
  },
};
const CREATE_DRAFT_KEY = "pricing-plan-create";
const editDraftKey = (id: string): string => `pricing-plan-edit:${id}`;
const UNREACHABLE = "Could not reach the server. Check your connection and try again.";

/**
 * The writes a plan allows (plan-service.ts refuses the rest): a draft is published; a published plan is archived; a published or
 * archived plan starts a new version only when its family has no draft and no newer version (a copy of an older one would be stale).
 */
export function actionsFor(plan: PricingPlan, family: readonly PricingPlan[]): readonly Action[] {
  if (plan.status === "draft") return ["publish"];
  const canVersion =
    !family.some((p) => p.status === "draft") && family.every((p) => p.version <= plan.version);
  const archive: readonly Action[] = plan.status === "published" ? ["archive"] : [];
  return canVersion ? ["new-version", ...archive] : archive;
}

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
  const permissions = useSession()?.permissions ?? [];
  const canWrite = permissions.includes("plan.admin.write");
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
      const [list, defs] = await Promise.all([
        client.GET("/api/admin/pricing/plans"),
        client.GET("/api/admin/pricing/defaults"),
      ]);
      if (!isCurrent()) return;
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

  const selected =
    selectedId && !creating ? (plans.find((p) => p.id === selectedId) ?? null) : null;
  useStaleSelection({ param: "plan", ready: loaded, found: selected !== null, ignore: ["new"] });
  const close = (): void => setParams({});
  const done = async (planId: string, message: string): Promise<void> => {
    setOutcome({ planId, message });
    setParams({ plan: planId });
    await load();
  };
  const showCreate = creating && defaults !== null && canWrite;

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
        {error ? (
          <StateError
            message={error.message}
            {...(error.retry ? { onRetry: () => void load() } : {})}
          />
        ) : loading && plans.length === 0 ? (
          <StateLoading label="Loading price plans…" />
        ) : plans.length === 0 ? (
          <StateEmpty icon="layout-grid">
            No price plans yet. Create one, then publish it so tenants can sign it.
          </StateEmpty>
        ) : (
          // The table stays during a reload, so the open drawer's row (and the focus it returns to) is kept.
          <PlansTable
            plans={plans}
            selectedId={selectedId}
            onOpen={(id) => setParams({ plan: id })}
          />
        )}
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
        />
      ) : null}
    </div>
  );
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

function PlanDrawer({
  plan,
  family,
  canWrite,
  reloading,
  outcome,
  onClose,
  onDone,
}: {
  plan: PricingPlan;
  family: readonly PricingPlan[];
  canWrite: boolean;
  reloading: boolean;
  outcome: string | null;
  onClose: () => void;
  onDone: (planId: string, message: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const restored = useStepUpDraft<PlanForm>(editDraftKey(plan.id));
  const [editing, setEditing] = useState(
    restored !== undefined && plan.status === "draft" && canWrite,
  );
  const [asking, setAsking] = useState<Action | null>(null);
  // The edited flag (Escape stops closing a drawer once something was typed) resets when the dialog or the editor closes.
  const drawer = useDrawerA11y<HTMLElement>(onClose, editing ? "editing" : asking);
  const money = (cents: number | null): string =>
    cents === null ? "None" : formatCents(cents, plan.currencyCode);
  const pct = (bps: number | null): string => (bps === null ? "—" : `${bps / 100}%`);

  async function run(action: Action, reason: string): Promise<void> {
    const init = (key: string) => ({
      params: { path: { id: plan.id }, header: { "Idempotency-Key": key } },
      body: { reason },
    });
    const result = await write.run(
      JSON.stringify({ action, id: plan.id, reason }),
      (key) =>
        action === "publish"
          ? client.POST("/api/admin/pricing/plans/{id}/publish", init(key))
          : action === "archive"
            ? client.POST("/api/admin/pricing/plans/{id}/archive", init(key))
            : client.POST("/api/admin/pricing/plans/{id}/new-version", init(key)),
      (data) => onDone(data.id, `"${plan.name}" ${ACTION_COPY[action].done}.`),
    );
    if (result.ok) setAsking(null);
  }

  const copy = asking ? ACTION_COPY[asking] : null;
  const actions = canWrite ? actionsFor(plan, family) : [];
  const locked = reloading || write.busy;
  return (
    <aside className="wx-admission-drawer" aria-label="Price plan" {...drawer}>
      <DrawerHead icon="layout-grid" title={plan.name} sub={plan.slug} onClose={onClose} />
      <div className="wx-drawer-body">
        {outcome ? <InlineAlert tone="success">{outcome}</InlineAlert> : null}
        {editing ? (
          <PlanEditor
            mode={{ kind: "edit", plan }}
            initial={restored ?? formFromPlan(plan)}
            draftKey={editDraftKey(plan.id)}
            onCancel={() => setEditing(false)}
            onSaved={async (saved) => {
              setEditing(false);
              await onDone(saved.id, `"${saved.name}" prices saved.`);
            }}
          />
        ) : (
          <section className="wx-drawer-card">
            <div className="wx-drawer-card-head">
              <h3>Version {plan.version}</h3>
              <StatusPill label={cap(plan.status)} tone={STATUS_TONE[plan.status]} />
            </div>
            <dl className="wx-kv">
              <dt>Per user</dt>
              <dd className="wx-nums">{money(plan.perUserPriceCents)} a month</dd>
              <dt>Census bands</dt>
              <dd className="wx-nums">
                {plan.bands
                  .map(
                    (b) =>
                      `${b.minAdc}${b.maxAdc === null ? "+" : `-${b.maxAdc}`}: ${money(b.monthlyFeeCents)}`,
                  )
                  .join(" · ")}
              </dd>
              <dt>Billing software</dt>
              <dd className="wx-nums">{pct(plan.billingSoftwareBps)} of net collections</dd>
              <dt>Managed billing</dt>
              <dd className="wx-nums">{pct(plan.managedBillingBps)} of net collections</dd>
              <dt>Term</dt>
              <dd className="wx-nums">{plan.contractTermMonths ?? "—"} months</dd>
              <dt>Implementation fee</dt>
              <dd className="wx-nums">{money(plan.implementationFeeCents)}</dd>
              <dt>Monthly minimum</dt>
              <dd className="wx-nums">{money(plan.minimumMonthlyCents)}</dd>
            </dl>
            {actions.length > 0 || (canWrite && plan.status === "draft") ? (
              <div className="wx-drawer-actions">
                {canWrite && plan.status === "draft" ? (
                  <Button tone="secondary" disabled={locked} onClick={() => setEditing(true)}>
                    Edit prices
                  </Button>
                ) : null}
                {actions.map((a) => (
                  <Button
                    key={a}
                    tone={a === "archive" ? "secondary" : "primary"}
                    disabled={locked}
                    onClick={() => {
                      write.clear();
                      setAsking(a);
                    }}
                  >
                    {ACTION_COPY[a].label}
                  </Button>
                ))}
              </div>
            ) : null}
          </section>
        )}
      </div>
      <ReasonDialog
        open={asking !== null}
        title={copy ? `${copy.label} "${plan.name}"` : ""}
        description={copy?.explain(plan) ?? ""}
        rule={REASON_RULES.pricing}
        confirmLabel={copy?.label ?? ""}
        {...(copy?.tone ? { tone: copy.tone } : {})}
        busy={write.busy}
        {...(write.failure && copy
          ? { error: <WriteFailure failure={write.failure} failed={copy.failed} /> }
          : {})}
        onConfirm={(reason) => asking && void run(asking, reason)}
        onCancel={() => {
          write.clear();
          setAsking(null);
        }}
      />
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
  const restored = useStepUpDraft<PlanForm>(CREATE_DRAFT_KEY);
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
