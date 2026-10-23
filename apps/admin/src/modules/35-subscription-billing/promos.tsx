import {
  Button,
  type FieldErrors,
  SelectField,
  StatusPill,
  TextField,
  focusFirstInvalid,
  interactiveRowProps,
  isValid,
  stashStepUpDraft,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
  useStepUpDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Promos (`/admin/promos`, promo.admin.read/write).
// Cross-tenant promo catalog over GET /api/admin/promos with redemption counts; create via POST
// /api/admin/promos and deactivate via POST /api/admin/promos/:id/deactivate (promo.admin.write — step-up +
// Idempotency-Key). Percent/amount-off + duration are shown per §5.2. Redesign list + right drawer: a row opens the
// promo (`?promo=<id>`) with its Deactivate action; "New promo" opens the create form in the same drawer.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useSearchParams } from "react-router-dom";
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

type Promo =
  operations["getApiAdminPromos"]["responses"][200]["content"]["application/json"][number];

const EMPTY_FORM = {
  code: "",
  coupon: "",
  promotion: "",
  kind: "percent_off",
  percent: "",
  amount: "",
  duration: "once",
};
type PromoForm = typeof EMPTY_FORM;

const PROMO_DRAFT_KEY = "promo-create";

/** Per-field messages for the New promo form; empty when it can be submitted (#597, F-042). */
export function promoFormErrors(form: PromoForm): FieldErrors<keyof PromoForm> {
  const errors: FieldErrors<keyof PromoForm> = {};
  if (form.code.trim() === "") errors.code = "Enter a promo code.";
  if (form.kind === "percent_off") {
    const percent = Number(form.percent);
    if (form.percent.trim() === "") errors.percent = "Enter a percentage from 1 to 100.";
    else if (!Number.isInteger(percent) || percent < 1 || percent > 100)
      errors.percent = "Enter a whole percentage from 1 to 100.";
  } else {
    const amount = Number(form.amount);
    if (form.amount.trim() === "") errors.amount = "Enter an amount in dollars, e.g. 10.00.";
    else if (!Number.isFinite(amount) || Math.round(amount * 100) < 1)
      errors.amount = "Enter a dollar amount of at least 0.01, e.g. 10.00.";
  }
  return errors;
}

const KIND_OPTIONS = [
  { value: "percent_off", label: "Percent off" },
  { value: "amount_off", label: "Amount off" },
];
const DURATION_OPTIONS = [
  { value: "once", label: "Once" },
  { value: "repeating", label: "Repeating" },
  { value: "forever", label: "Forever" },
];

const discount = (p: Promo): string =>
  p.percentOff != null
    ? `${p.percentOff}%`
    : p.fixedOffCents != null
      ? formatCents(p.fixedOffCents)
      : "—";

const durationText = (p: Promo): string =>
  `${cap(p.duration)}${p.durationInMonths ? ` (${p.durationInMonths}m)` : ""}`;

const redemptionsText = (p: Promo): string =>
  `${p.redemptionCount.toLocaleString()}${p.maxRedemptions ? ` / ${p.maxRedemptions}` : ""}`;

export function Promos(): JSX.Element {
  const client = useApiClient();
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  // A step-up refusal sends the operator to /step-up and back; the typed promo is restored and the drawer reopens.
  const restored = useStepUpDraft<PromoForm>(PROMO_DRAFT_KEY);
  const [showCreate, setShowCreate] = useState(restored !== undefined);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("promo");
  const [form, setForm] = useState<PromoForm>(restored ?? EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setLoaded(false);
    setError(null);
    const res = await client.GET("/api/admin/promos");
    if (!isCurrent()) return;
    if (res.error) {
      setError("Promos unavailable.");
      setLoading(false);
      return;
    }
    setPromos(res.data);
    setLoaded(true);
    setLoading(false);
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (!isValid(promoFormErrors(form))) return;
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/promos", {
      body: {
        code: form.code.trim(),
        stripeCouponId: form.coupon.trim() || form.code.trim(),
        stripePromotionCodeId: form.promotion.trim() || form.code.trim(),
        kind: form.kind as "percent_off" | "amount_off",
        percentOff: form.kind === "percent_off" ? Number(form.percent) || undefined : undefined,
        fixedOffCents:
          form.kind === "amount_off"
            ? Math.round(Number(form.amount) * 100) || undefined
            : undefined,
        duration: form.duration as "once" | "repeating" | "forever",
      },
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error)
      setOutcome(failureOutcome(res.error, "Could not create the promo (check the fields)."));
    else {
      setOutcome({ ok: true, message: `Promo "${form.code}" created.` });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      await load();
    }
    setBusy(false);
  }, [client, form, load]);

  const deactivate = useCallback(
    async (id: string, code: string) => {
      setBusy(true);
      setOutcome(null);
      const res = await client.POST("/api/admin/promos/{id}/deactivate", {
        params: { path: { id } },
        headers: { "Idempotency-Key": idempotencyKey() },
      });
      setOutcome(
        res.error
          ? failureOutcome(res.error, "Could not deactivate this promo.")
          : { ok: true, message: `Promo "${code}" deactivated.` },
      );
      if (!res.error) await load();
      setBusy(false);
    },
    [client, load],
  );

  const selected = selectedId ? (promos.find((p) => p.id === selectedId) ?? null) : null;
  useStaleSelection({
    param: "promo",
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
            <h1>Promo codes</h1>
            <p>Discount codes across every tenant, with their redemptions.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button
              onClick={() => {
                setParams({});
                setShowCreate((s) => !s);
              }}
            >
              {showCreate ? "Cancel" : "New promo"}
            </Button>
          </div>
        </header>
        {outcome ? (
          <OutcomeBanner {...outcome} onReverify={() => stashStepUpDraft(PROMO_DRAFT_KEY, form)} />
        ) : null}
        {loading ? (
          <StateLoading label="Loading promos…" />
        ) : error ? (
          <StateError message={error} onRetry={() => void load()} />
        ) : promos.length === 0 ? (
          <StateEmpty icon="receipt">No promos yet. Create the first promo code.</StateEmpty>
        ) : (
          <PromosTable
            promos={promos}
            selectedId={selectedId}
            onOpen={(id) => {
              setShowCreate(false);
              setParams({ promo: id });
            }}
          />
        )}
      </div>
      {showCreate ? (
        <CreatePromoDrawer
          form={form}
          busy={busy}
          onChange={setForm}
          onCreate={() => void create()}
          onClose={() => setShowCreate(false)}
        />
      ) : selected ? (
        <PromoDrawer
          promo={selected}
          busy={busy}
          onDeactivate={() => void deactivate(selected.id, selected.code)}
          onClose={() => setParams({})}
        />
      ) : null}
    </div>
  );
}

function PromosTable({
  promos,
  selectedId,
  onOpen,
}: {
  promos: readonly Promo[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Promo codes</caption>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Discount</th>
            <th scope="col">Duration</th>
            <th scope="col" className="wx-num-col">
              Redemptions
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {promos.map((p) => (
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
                <span className="wx-row-title wx-data-md">{p.code}</span>
              </td>
              <td className="wx-nums">{discount(p)}</td>
              <td>{durationText(p)}</td>
              <td className="wx-num-col wx-nums">{redemptionsText(p)}</td>
              <td>
                <StatusPill
                  label={p.isActive ? "Active" : "Inactive"}
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

function PromoDrawer({
  promo,
  busy,
  onDeactivate,
  onClose,
}: {
  promo: Promo;
  busy: boolean;
  onDeactivate: () => void;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" aria-label="Promo code" {...drawer}>
      <DrawerHead icon="receipt" title={promo.code} sub={discount(promo)} onClose={onClose} />
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Promo</h3>
            <StatusPill
              label={promo.isActive ? "Active" : "Inactive"}
              tone={promo.isActive ? "success" : "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Discount</dt>
            <dd className="wx-nums">{discount(promo)}</dd>
            <dt>Duration</dt>
            <dd>{durationText(promo)}</dd>
            <dt>Redemptions</dt>
            <dd className="wx-nums">{redemptionsText(promo)}</dd>
          </dl>
          {promo.isActive ? (
            <div className="wx-drawer-actions">
              <Button tone="secondary" onClick={onDeactivate} disabled={busy}>
                Deactivate
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function CreatePromoDrawer({
  form,
  busy,
  onChange,
  onCreate,
  onClose,
}: {
  form: PromoForm;
  busy: boolean;
  onChange: (form: PromoForm) => void;
  onCreate: () => void;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  // Errors appear after the first submit attempt; the button stays enabled so a refusal always explains itself.
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? promoFormErrors(form) : {};
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (busy) return;
    if (!isValid(promoFormErrors(form))) {
      setAttempted(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    onCreate();
  };
  return (
    <aside className="wx-admission-drawer" aria-label="New promo" {...drawer}>
      <DrawerHead icon="plus" title="New promo" onClose={onClose} />
      <div className="wx-drawer-body">
        <form className="wx-drawer-card" onSubmit={submit} noValidate>
          <TextField
            label="Code"
            required
            error={errors.code}
            value={form.code}
            onChange={(e) => onChange({ ...form, code: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Kind"
              value={form.kind}
              options={KIND_OPTIONS}
              onChange={(e) => onChange({ ...form, kind: e.target.value })}
            />
            {form.kind === "percent_off" ? (
              <TextField
                label="Percent"
                required
                error={errors.percent}
                value={form.percent}
                inputMode="numeric"
                onChange={(e) => onChange({ ...form, percent: e.target.value })}
              />
            ) : (
              <TextField
                label="Amount (USD)"
                required
                error={errors.amount}
                value={form.amount}
                inputMode="decimal"
                onChange={(e) => onChange({ ...form, amount: e.target.value })}
              />
            )}
          </div>
          <SelectField
            label="Duration"
            value={form.duration}
            options={DURATION_OPTIONS}
            onChange={(e) => onChange({ ...form, duration: e.target.value })}
          />
          <TextField
            label="Stripe coupon id"
            value={form.coupon}
            placeholder="defaults to code"
            onChange={(e) => onChange({ ...form, coupon: e.target.value })}
          />
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={busy}>
              Create promo
            </Button>
          </div>
        </form>
      </div>
    </aside>
  );
}
