import {
  Button,
  type FieldErrors,
  REASON_RULES,
  ReasonDialog,
  StatusPill,
  type StatusTone,
  TextField,
  focusFirstInvalid,
  interactiveRowProps,
  isValid,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — tenant price plans (`/admin/pricing-plans`, plan.admin.read): the plans the
// onboarding wizard's plan step signs a tenant to. A plan is a platform fee (the greater of per-user x staff and the census-band fee),
// the billing-service rates in basis points and an implementation fee. Lifecycle over /api/admin/pricing/plans: create a draft, publish
// it, start a new version of a published plan (a draft copy), archive. Every write is plan.admin.write (step-up, Idempotency-Key and a
// recorded reason, enforced server-side); the reason is asked for in one dialog before the write runs.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { parsePriceCents } from "./plans-list";
import { cap, formatCents, idempotencyKey } from "./status";
import {
  DrawerHead,
  type Outcome,
  OutcomeBanner,
  StateEmpty,
  StateError,
  StateLoading,
  failureOutcome,
} from "./ui";

type PricingPlan =
  operations["getApiAdminPricingPlans"]["responses"][200]["content"]["application/json"][number];
type Defaults =
  operations["getApiAdminPricingDefaults"]["responses"][200]["content"]["application/json"];
type Action = "publish" | "new-version" | "archive";

const STATUS_TONE: Record<PricingPlan["status"], StatusTone> = {
  draft: "neutral",
  published: "success",
  archived: "warning",
};
const ACTION_COPY: Record<Action, { label: string; done: string; tone?: "danger" }> = {
  publish: { label: "Publish", done: "published" },
  "new-version": { label: "Start a new version", done: "copied to a new draft version" },
  archive: { label: "Archive", done: "archived", tone: "danger" },
};
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BPS = 10_000;

/** A percentage typed by the operator ("4.5") to whole basis points (450); null unless 0 to 100. */
export function parsePercentBps(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const bps = Math.round(Number(text) * 100);
  return Number.isFinite(bps) && bps >= 0 && bps <= MAX_BPS ? bps : null;
}

interface PlanForm {
  familySlug: string;
  name: string;
  perUserPrice: string;
  /** One monthly fee (dollars) per census band, in the order of the defaults' thresholds. */
  bandFees: readonly string[];
  billingSoftwarePct: string;
  managedBillingPct: string;
  termMonths: string;
  implementationFee: string;
  minimumMonthly: string;
}
const blankForm = (bands: number): PlanForm => ({
  familySlug: "",
  name: "",
  perUserPrice: "",
  bandFees: Array.from({ length: bands }, () => ""),
  billingSoftwarePct: "",
  managedBillingPct: "",
  termMonths: "12",
  implementationFee: "0",
  minimumMonthly: "",
});

type FormKey = Exclude<keyof PlanForm, "bandFees"> | `band${number}`;

/** Per-field messages for the new-plan form; empty when it can be submitted. */
export function pricingFormErrors(form: PlanForm): FieldErrors<FormKey> {
  const errors: FieldErrors<FormKey> = {};
  if (!SLUG_SHAPE.test(form.familySlug.trim()) || form.familySlug.trim().length < 3)
    errors.familySlug = "Use 3 or more lowercase letters, numbers and hyphens, e.g. hospice-core.";
  if (form.name.trim() === "") errors.name = "Enter a plan name.";
  const money = "Enter a number of dollars, 0 or more.";
  if (parsePriceCents(form.perUserPrice) === null) errors.perUserPrice = money;
  form.bandFees.forEach((fee, i) => {
    if (parsePriceCents(fee) === null) errors[`band${i}`] = money;
  });
  const pct = "Enter a percentage from 0 to 100, e.g. 4.5.";
  if (parsePercentBps(form.billingSoftwarePct) === null) errors.billingSoftwarePct = pct;
  if (parsePercentBps(form.managedBillingPct) === null) errors.managedBillingPct = pct;
  const term = Number(form.termMonths);
  if (!Number.isInteger(term) || term < 1 || term > 120)
    errors.termMonths = "Enter a whole number of months from 1 to 120.";
  if (parsePriceCents(form.implementationFee) === null) errors.implementationFee = money;
  if (form.minimumMonthly.trim() !== "" && parsePriceCents(form.minimumMonthly) === null)
    errors.minimumMonthly = "Leave empty for no minimum, or enter dollars, 0 or more.";
  return errors;
}

/** The create body for a valid form (call only when `pricingFormErrors` is empty). */
function createBody(form: PlanForm, thresholds: readonly number[], reason: string) {
  const cents = (raw: string): number => parsePriceCents(raw) ?? 0;
  return {
    familySlug: form.familySlug.trim(),
    name: form.name.trim(),
    perUserPriceCents: cents(form.perUserPrice),
    bands: thresholds.map((minAdc, i) => ({
      minAdc,
      monthlyFeeCents: cents(form.bandFees[i] ?? ""),
    })),
    billingSoftwareBps: parsePercentBps(form.billingSoftwarePct) ?? 0,
    managedBillingBps: parsePercentBps(form.managedBillingPct) ?? 0,
    contractTermMonths: Number(form.termMonths),
    implementationFeeCents: cents(form.implementationFee),
    minimumMonthlyCents: form.minimumMonthly.trim() === "" ? null : cents(form.minimumMonthly),
    reason,
  };
}

const bandLabel = (thresholds: readonly number[], i: number): string => {
  const next = thresholds[i + 1];
  return next === undefined
    ? `${thresholds[i]}+ patients a day`
    : `${thresholds[i]}-${next - 1} patients a day`;
};

export function PricingPlans(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("plan");
  const creating = selectedId === "new";
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setLoaded(false);
    setError(null);
    const [list, defs] = await Promise.all([
      client.GET("/api/admin/pricing/plans"),
      client.GET("/api/admin/pricing/defaults"),
    ]);
    if (!isCurrent()) return;
    if (list.error || defs.error) {
      setError("Price plans unavailable.");
      setLoading(false);
      return;
    }
    setPlans(list.data);
    setDefaults(defs.data);
    setLoaded(true);
    setLoading(false);
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected =
    selectedId && !creating ? (plans.find((p) => p.id === selectedId) ?? null) : null;
  useStaleSelection({ param: "plan", ready: loaded, found: selected !== null, ignore: ["new"] });
  const close = (): void => setParams({});
  const done = async (message: string, openId?: string): Promise<void> => {
    setOutcome({ ok: true, message });
    setParams(openId ? { plan: openId } : {});
    await load();
  };

  return (
    <div className={`wx-list-drawer${creating || selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Price plans</h1>
            <p>The plans a tenant signs during onboarding. Only a published plan can be signed.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button disabled={!defaults} onClick={() => setParams({ plan: "new" })}>
              New plan
            </Button>
          </div>
        </header>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        {loading ? (
          <StateLoading label="Loading price plans…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load()} />
        ) : plans.length === 0 ? (
          <StateEmpty icon="layout-grid">
            No price plans yet. Create one, then publish it so tenants can sign it.
          </StateEmpty>
        ) : (
          <PlansTable
            plans={plans}
            selectedId={selectedId}
            onOpen={(id) => setParams({ plan: id })}
          />
        )}
      </div>
      {creating && defaults ? (
        <CreateDrawer
          thresholds={defaults.bandThresholds}
          onClose={close}
          onOutcome={setOutcome}
          onCreated={(plan) => done(`Draft "${plan.name}" created.`, plan.id)}
        />
      ) : selected ? (
        <PlanDrawer
          key={selected.id}
          plan={selected}
          onClose={close}
          onOutcome={setOutcome}
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

/** The actions a plan's status allows (the server refuses the rest). */
const actionsFor = (status: PricingPlan["status"]): readonly Action[] =>
  status === "draft"
    ? ["publish", "archive"]
    : status === "published"
      ? ["new-version", "archive"]
      : [];

function PlanDrawer({
  plan,
  onClose,
  onOutcome,
  onDone,
}: {
  plan: PricingPlan;
  onClose: () => void;
  onOutcome: (o: Outcome | null) => void;
  onDone: (message: string, openId?: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const [asking, setAsking] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (cents: number | null): string =>
    cents === null ? "None" : formatCents(cents, plan.currencyCode);
  const pct = (bps: number | null): string => (bps === null ? "—" : `${bps / 100}%`);

  async function run(action: Action, reason: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    onOutcome(null);
    const init = {
      params: { path: { id: plan.id }, header: { "Idempotency-Key": idempotencyKey() } },
      body: { reason },
    };
    const res =
      action === "publish"
        ? await client.POST("/api/admin/pricing/plans/{id}/publish", init)
        : action === "archive"
          ? await client.POST("/api/admin/pricing/plans/{id}/archive", init)
          : await client.POST("/api/admin/pricing/plans/{id}/new-version", init);
    setBusy(false);
    setAsking(null);
    if (res.error) {
      onOutcome(
        failureOutcome(res.error, `Could not ${ACTION_COPY[action].label.toLowerCase()} the plan.`),
      );
      return;
    }
    await onDone(`"${plan.name}" ${ACTION_COPY[action].done}.`, res.data?.id);
  }

  const copy = asking ? ACTION_COPY[asking] : null;
  return (
    <aside className="wx-admission-drawer" aria-label="Price plan" {...drawer}>
      <DrawerHead icon="layout-grid" title={plan.name} sub={plan.slug} onClose={onClose} />
      <div className="wx-drawer-body">
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
          {actionsFor(plan.status).length > 0 ? (
            <div className="wx-drawer-actions">
              {actionsFor(plan.status).map((a) => (
                <Button
                  key={a}
                  tone={a === "archive" ? "secondary" : "primary"}
                  onClick={() => setAsking(a)}
                >
                  {ACTION_COPY[a].label}
                </Button>
              ))}
            </div>
          ) : null}
        </section>
      </div>
      <ReasonDialog
        open={asking !== null}
        title={copy ? `${copy.label} "${plan.name}"` : ""}
        rule={REASON_RULES.pricing}
        confirmLabel={copy?.label ?? ""}
        {...(copy?.tone ? { tone: copy.tone } : {})}
        busy={busy}
        onConfirm={(reason) => asking && void run(asking, reason)}
        onCancel={() => setAsking(null)}
      />
    </aside>
  );
}

function CreateDrawer({
  thresholds,
  onClose,
  onOutcome,
  onCreated,
}: {
  thresholds: readonly number[];
  onClose: () => void;
  onOutcome: (o: Outcome | null) => void;
  onCreated: (plan: PricingPlan) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const [form, setForm] = useState<PlanForm>(() => blankForm(thresholds.length));
  const [attempted, setAttempted] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = attempted ? pricingFormErrors(form) : {};
  const set = (patch: Partial<PlanForm>): void => setForm((f) => ({ ...f, ...patch }));

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!isValid(pricingFormErrors(form))) {
      setAttempted(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    setAsking(true);
  };
  // ponytail: a step-up refusal leaves for /step-up and the typed form is not stashed (plans-list.tsx stashes with
  // stashStepUpDraft); add it if operators hit Re-verify mid-create often.
  async function create(reason: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    onOutcome(null);
    const res = await client.POST("/api/admin/pricing/plans", {
      params: { header: { "Idempotency-Key": idempotencyKey() } },
      body: createBody(form, thresholds, reason),
    });
    setBusy(false);
    setAsking(false);
    if (res.error) {
      onOutcome(failureOutcome(res.error, "Could not create the plan (check the fields)."));
      return;
    }
    await onCreated(res.data);
  }

  const field = (key: Exclude<keyof PlanForm, "bandFees">, label: string, hint?: string) => (
    <TextField
      label={label}
      required={key !== "minimumMonthly"}
      {...(hint ? { hint } : {})}
      error={errors[key]}
      value={form[key]}
      onChange={(e) => set({ [key]: e.target.value })}
    />
  );
  return (
    <aside className="wx-admission-drawer" aria-label="New price plan" {...drawer}>
      <DrawerHead icon="plus" title="New price plan" sub="Created as a draft" onClose={onClose} />
      <div className="wx-drawer-body">
        <form className="wx-drawer-card" onSubmit={submit} noValidate>
          {field(
            "familySlug",
            "Plan family",
            "Lowercase letters, numbers and hyphens, e.g. hospice-core.",
          )}
          {field("name", "Name")}
          {field("perUserPrice", "Per user a month (USD)")}
          {thresholds.map((_, i) => (
            <TextField
              // biome-ignore lint/suspicious/noArrayIndexKey: one fixed field per band, in threshold order
              key={i}
              label={`Census band ${bandLabel(thresholds, i)}, a month (USD)`}
              required
              error={errors[`band${i}`]}
              value={form.bandFees[i] ?? ""}
              onChange={(e) =>
                set({ bandFees: form.bandFees.map((v, j) => (j === i ? e.target.value : v)) })
              }
            />
          ))}
          {field("billingSoftwarePct", "Billing software (% of net collections)")}
          {field("managedBillingPct", "Managed billing (% of net collections)")}
          {field("termMonths", "Contract term (months)")}
          {field("implementationFee", "Implementation fee (USD)")}
          {field("minimumMonthly", "Monthly minimum (USD)", "Leave empty for no minimum.")}
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={busy}>
              Create draft
            </Button>
          </div>
        </form>
      </div>
      <ReasonDialog
        open={asking}
        title="Create this price plan"
        rule={REASON_RULES.pricing}
        confirmLabel="Create draft"
        busy={busy}
        onConfirm={(reason) => void create(reason)}
        onCancel={() => setAsking(false)}
      />
    </aside>
  );
}
