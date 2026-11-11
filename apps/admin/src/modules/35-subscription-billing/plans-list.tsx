import {
  Button,
  SelectField,
  StatusPill,
  TableScroll,
  TextField,
  focusFirstInvalid,
  interactiveRowProps,
  isValid,
  parsePriceCents,
  parseWholeNumber,
  sendWrite,
  stashStepUpMemoryDraft,
  useApiClient,
  useDrawerA11y,
  useIdempotencyKeeper,
  useRequestGuard,
  useSelectionParam,
  useStaleSelection,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Plans list + create (`/admin/plans`, plan.admin.read).
// Cross-tenant plan catalog over GET /api/admin/plans; a draft plan is created via POST /api/admin/plans
// (plan.admin.write — step-up + Idempotency-Key, enforced server-side). Amounts are integer cents formatted once.
// The redesign's list + right drawer: a row opens the plan in the drawer (`?plan=<id>`), whose action leads to the
// meter/pricing editor (`/admin/plans/:id/edit`); "New plan" opens the create form in the same drawer.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { PLAN_EMPTY_FORM, type PlanForm, planFormErrors } from "./form-rules";
import { cap, formatCents } from "./status";
import {
  DrawerHead,
  type Outcome,
  OutcomeBanner,
  StateEmpty,
  StateError,
  StateLoading,
  writeFailure,
} from "./ui";

type PlanRow =
  operations["getApiAdminPlans"]["responses"][200]["content"]["application/json"][number];

const PLAN_DRAFT_KEY = "plan-create";

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
  // One Idempotency-Key per write intent: a retry after "could not reach the server" replays it (the first request may have landed).
  const keeper = useIdempotencyKeeper();
  // The open plan lives in the URL, so Back closes the drawer and open/close keep any other query param.
  const { selectedId, select, close } = useSelectionParam("plan");
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // A step-up refusal sends the operator to /step-up and back; the typed plan is restored and the drawer reopens.
  const restored = useStepUpMemoryDraft<PlanForm>(PLAN_DRAFT_KEY);
  const [showCreate, setShowCreate] = useState(restored !== undefined);
  const [form, setForm] = useState<PlanForm>(restored ?? PLAN_EMPTY_FORM);
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
    const trialPeriodDays = parseWholeNumber(form.trialDays);
    if (!isValid(planFormErrors(form)) || basePriceCents === null || trialPeriodDays === null)
      return;
    setSaving(true);
    setOutcome(null);
    const body = {
      slug: form.slug.trim(),
      name: form.name.trim(),
      tier: form.tier as "starter" | "professional" | "enterprise",
      cadence: form.cadence as "monthly" | "annual",
      basePriceCents,
      currencyCode: "USD" as const,
      trialPeriodDays,
    };
    try {
      // One key per create request: a retry of the same unchanged plan replays it, so a lost reply cannot create a second draft.
      const failure = writeFailure(
        await sendWrite(keeper, JSON.stringify(body), (key) =>
          client.POST("/api/admin/plans", { body, headers: { "Idempotency-Key": key } }),
        ),
        "Could not create the plan (check the fields).",
      );
      if (failure) {
        setOutcome(failure);
        return;
      }
      setOutcome({ ok: true, message: `Draft plan "${form.name}" created.` });
      setShowCreate(false);
      setForm(PLAN_EMPTY_FORM);
      await load();
    } finally {
      setSaving(false); // also when the reload after a landed write throws: the form never stays locked
    }
  }, [client, form, load, keeper]);

  const selected = selectedId ? (plans.find((p) => p.id === selectedId) ?? null) : null;
  useStaleSelection({
    param: "plan",
    ready: loaded,
    found: selected !== null,
    ignore: ["new"],
    clear: close,
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
                if (selectedId !== null) close();
                setShowCreate((s) => !s);
              }}
            >
              {showCreate ? "Cancel" : "New plan"}
            </Button>
          </div>
        </header>
        {outcome ? (
          <OutcomeBanner
            {...outcome}
            onReverify={() => stashStepUpMemoryDraft(PLAN_DRAFT_KEY, form)}
          />
        ) : null}
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
              select(id);
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
        <PlanDrawer key={selected.id} plan={selected} onClose={close} />
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
    <TableScroll>
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
              {...interactiveRowProps(() => onOpen(p.id), p.id === selectedId, false, p.id)}
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
    </TableScroll>
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
  // Errors appear after the first submit attempt; the button stays enabled so a refusal always explains itself.
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? planFormErrors(form) : {};
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (saving) return;
    if (!isValid(planFormErrors(form))) {
      setAttempted(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    onCreate();
  };
  return (
    <aside className="wx-admission-drawer" aria-label="New plan" {...drawer}>
      <DrawerHead icon="plus" title="New plan" sub="Created as a draft" onClose={onClose} />
      <div className="wx-drawer-body">
        <form className="wx-drawer-card" onSubmit={submit} noValidate>
          <TextField
            label="Slug"
            required
            hint="Lowercase letters, numbers and hyphens, e.g. starter-monthly."
            error={errors.slug}
            value={form.slug}
            onChange={(e) => onChange({ ...form, slug: e.target.value })}
          />
          <TextField
            label="Name"
            required
            error={errors.name}
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
          <div className="wx-form-grid">
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
              required
              error={errors.basePrice}
              value={form.basePrice}
              inputMode="decimal"
              onChange={(e) => onChange({ ...form, basePrice: e.target.value })}
            />
            <TextField
              label="Trial days"
              required
              error={errors.trialDays}
              value={form.trialDays}
              inputMode="numeric"
              onChange={(e) => onChange({ ...form, trialDays: e.target.value })}
            />
          </div>
          <div className="wx-drawer-actions">
            <Button type="submit" loading={saving} disabled={saving}>
              Create draft
            </Button>
          </div>
        </form>
      </div>
    </aside>
  );
}
