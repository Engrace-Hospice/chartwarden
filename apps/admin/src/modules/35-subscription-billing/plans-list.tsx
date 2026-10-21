import {
  Button,
  SelectField,
  StatusPill,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Plans list + create (`/admin/plans`, plan.admin.read).
// Cross-tenant plan catalog over GET /api/admin/plans; a draft plan is created via POST /api/admin/plans
// (plan.admin.write — step-up + Idempotency-Key, enforced server-side). Amounts are integer cents formatted once.
// The redesign's list + right drawer: a row opens the plan in the drawer (`?plan=<id>`), whose action leads to the
// meter/pricing editor (`/admin/plans/:id/edit`); "New plan" opens the create form in the same drawer.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

type PlanRow =
  operations["getApiAdminPlans"]["responses"][200]["content"]["application/json"][number];

const EMPTY_FORM = {
  slug: "",
  name: "",
  tier: "starter",
  cadence: "monthly",
  basePrice: "",
  trialDays: "0",
};
type PlanForm = typeof EMPTY_FORM;

/** Dollars typed by the operator to integer cents; null unless it is a finite number >= 0 ("abc" is not a $0 plan). */
export function parsePriceCents(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const dollars = Number(text);
  return Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : null;
}

/** Whole trial days >= 0; null for anything else. */
export function parseTrialDays(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const days = Number(text);
  return Number.isInteger(days) && days >= 0 ? days : null;
}

const canCreatePlan = (form: PlanForm): boolean =>
  form.slug.trim() !== "" &&
  form.name.trim() !== "" &&
  parsePriceCents(form.basePrice) !== null &&
  parseTrialDays(form.trialDays) !== null;

const TIER_OPTIONS = [
  { value: "starter", label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise", label: "Enterprise" },
];
const CADENCE_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

export function PlansList(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("plan");
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setLoaded(false);
    setError(null);
    const res = await client.GET("/api/admin/plans");
    if (!isCurrent()) return;
    if (res.error) {
      setError("Plans unavailable.");
      setLoading(false);
      return;
    }
    setPlans(res.data);
    setLoaded(true);
    setLoading(false);
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    const basePriceCents = parsePriceCents(form.basePrice);
    const trialPeriodDays = parseTrialDays(form.trialDays);
    if (basePriceCents === null || trialPeriodDays === null) return;
    setSaving(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/plans", {
      body: {
        slug: form.slug.trim(),
        name: form.name.trim(),
        tier: form.tier as "starter" | "professional" | "enterprise",
        cadence: form.cadence as "monthly" | "annual",
        basePriceCents,
        currencyCode: "USD",
        trialPeriodDays,
      },
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error) {
      setOutcome(failureOutcome(res.error, "Could not create the plan (check the fields)."));
    } else {
      setOutcome({ ok: true, message: `Draft plan "${form.name}" created.` });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      await load();
    }
    setSaving(false);
  }, [client, form, load]);

  const selected = selectedId ? (plans.find((p) => p.id === selectedId) ?? null) : null;
  useStaleSelection({
    param: "plan",
    ready: loaded,
    found: selected !== null,
    ignore: ["new"],
  });
  const hasDrawer = showCreate || selected !== null;

  return (
    <div className={`wx-list-drawer${hasDrawer ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Plans</h1>
            <p>The subscription plan catalog every tenant is billed from.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button
              onClick={() => {
                setParams({});
                setShowCreate((s) => !s);
              }}
            >
              {showCreate ? "Cancel" : "New plan"}
            </Button>
          </div>
        </header>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        {loading ? (
          <StateLoading label="Loading plans…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load()} />
        ) : plans.length === 0 ? (
          <StateEmpty icon="layout-grid">No plans yet. Create the first plan to begin.</StateEmpty>
        ) : (
          <PlansTable
            plans={plans}
            selectedId={selectedId}
            onOpen={(id) => {
              setShowCreate(false);
              setParams({ plan: id });
            }}
          />
        )}
      </div>
      {showCreate ? (
        <CreatePlanDrawer
          form={form}
          saving={saving}
          onChange={setForm}
          onCreate={() => void create()}
          onClose={() => setShowCreate(false)}
        />
      ) : selected ? (
        <PlanDrawer plan={selected} onClose={() => setParams({})} />
      ) : null}
    </div>
  );
}

function PlansTable({
  plans,
  selectedId,
  onOpen,
}: {
  plans: readonly PlanRow[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Plans</caption>
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col">Tier</th>
            <th scope="col">Cadence</th>
            <th scope="col" className="wx-num-col">
              Base price
            </th>
            <th scope="col" className="wx-num-col">
              Trial
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
              <td>{cap(p.tier)}</td>
              <td>{cap(p.cadence)}</td>
              <td className="wx-num-col wx-nums">
                {formatCents(p.basePriceCents, p.currencyCode)}
              </td>
              <td className="wx-num-col wx-nums">{p.trialPeriodDays}d</td>
              <td>
                <StatusPill
                  label={p.isActive ? "Active" : "Draft"}
                  tone={p.isActive ? "success" : "neutral"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanDrawer({ plan, onClose }: { plan: PlanRow; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" aria-label="Plan" {...drawer}>
      <DrawerHead icon="layout-grid" title={plan.name} sub={plan.slug} onClose={onClose} />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Plan</h3>
            <StatusPill
              label={plan.isActive ? "Active" : "Draft"}
              tone={plan.isActive ? "success" : "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Tier</dt>
            <dd>{cap(plan.tier)}</dd>
            <dt>Cadence</dt>
            <dd>{cap(plan.cadence)}</dd>
            <dt>Base price</dt>
            <dd className="wx-nums">{formatCents(plan.basePriceCents, plan.currencyCode)}</dd>
            <dt>Trial</dt>
            <dd className="wx-nums">{plan.trialPeriodDays} days</dd>
          </dl>
          <div className="wx-drawer-actions">
            <Button onClick={() => navigate(`/admin/plans/${plan.id}/edit`)}>Edit plan</Button>
          </div>
        </section>
      </div>
    </aside>
  );
}

function CreatePlanDrawer({
  form,
  saving,
  onChange,
  onCreate,
  onClose,
}: {
  form: PlanForm;
  saving: boolean;
  onChange: (form: PlanForm) => void;
  onCreate: () => void;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const canSubmit = canCreatePlan(form);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (canSubmit && !saving) onCreate();
  };
  return (
    <aside className="wx-admission-drawer" aria-label="New plan" {...drawer}>
      <DrawerHead icon="plus" title="New plan" sub="Created as a draft" onClose={onClose} />
      <div className="wx-drawer-body">
        <form className="wx-drawer-card" onSubmit={submit} noValidate>
          <TextField
            label="Slug"
            value={form.slug}
            onChange={(e) => onChange({ ...form, slug: e.target.value })}
          />
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Tier"
              value={form.tier}
              options={TIER_OPTIONS}
              onChange={(e) => onChange({ ...form, tier: e.target.value })}
            />
            <SelectField
              label="Cadence"
              value={form.cadence}
              options={CADENCE_OPTIONS}
              onChange={(e) => onChange({ ...form, cadence: e.target.value })}
            />
            <TextField
              label="Base price (USD)"
              value={form.basePrice}
              inputMode="decimal"
              onChange={(e) => onChange({ ...form, basePrice: e.target.value })}
            />
            <TextField
              label="Trial days"
              value={form.trialDays}
              inputMode="numeric"
              onChange={(e) => onChange({ ...form, trialDays: e.target.value })}
            />
          </div>
          <div className="wx-drawer-actions">
            <Button type="submit" loading={saving} disabled={saving || !canSubmit}>
              Create draft
            </Button>
          </div>
        </form>
      </div>
    </aside>
  );
}
