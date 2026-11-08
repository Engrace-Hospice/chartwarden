import {
  Button,
  type FieldErrors,
  InlineAlert,
  type OpsFailure,
  REASON_RULES,
  ReasonDialog,
  type ReasonDialogRecordLine,
  TextField,
  focusFirstInvalid,
  isValid,
  stashStepUpDraft,
  useApiClient,
  useOpsWrite,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the price plan form, shared by "New plan" (POST /api/admin/pricing/plans) and a
// draft's "Edit prices" (PUT /api/admin/pricing/plans/:id). Money is typed in dollars and sent as integer cents, rates are typed as
// percentages and sent as integer basis points, both by string math. The form mirrors the server's rules (pricing-typebox.ts caps,
// validatePlanPricing: managed billing never below billing software, a higher census band never cheaper) so a refusal names the field.
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { parseHundredths, parsePriceCents } from "./plans-list";
import { formatCents } from "./status";
import { OutcomeBanner, STEP_UP_MESSAGE } from "./ui";

export type PricingPlan =
  operations["getApiAdminPricingPlans"]["responses"][200]["content"]["application/json"][number];

/** The server's caps (pricing-typebox.ts): $1 billion for a fee, $10 million a seat, 100% for a rate. */
const MAX_CENTS = 100_000_000_000;
const MAX_PER_USER_CENTS = 1_000_000_000;
const MAX_BPS = 10_000;
const NAME_MAX = 120;
const SLUG_MIN = 3;
const SLUG_MAX = 64;
const TERM_MAX = 120;
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WHOLE = /^\d+$/;

/** A percentage typed by the operator ("4.5") to whole basis points (450); null unless 0 to 100 with at most two decimals. */
export const parsePercentBps = (raw: string): number | null => parseHundredths(raw, MAX_BPS);

export interface PlanForm {
  /** The new plan's family; a draft's edit cannot change it. */
  familySlug: string;
  name: string;
  perUserPrice: string;
  /** One monthly fee (dollars) per census band, in threshold order. */
  bandFees: readonly string[];
  billingSoftwarePct: string;
  managedBillingPct: string;
  termMonths: string;
  implementationFee: string;
  minimumMonthly: string;
}
export type PlanFormMode =
  | { readonly kind: "create"; readonly thresholds: readonly number[] }
  | { readonly kind: "edit"; readonly plan: PricingPlan };

export const blankForm = (bands: number): PlanForm => ({
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

/** Hundredths back to the text an operator types ("4900" -> "49", "250" -> "2.50"), without a float divide. */
function hundredthsText(value: number | null): string {
  if (value === null) return "";
  const fraction = String(value % 100).padStart(2, "0");
  const whole = String(Math.trunc(value / 100));
  return fraction === "00" ? whole : `${whole}.${fraction}`;
}

/** A draft's current prices as the form's text. */
export const formFromPlan = (plan: PricingPlan): PlanForm => ({
  familySlug: plan.familySlug,
  name: plan.name,
  perUserPrice: hundredthsText(plan.perUserPriceCents),
  bandFees: plan.bands.map((b) => hundredthsText(b.monthlyFeeCents)),
  billingSoftwarePct: hundredthsText(plan.billingSoftwareBps),
  managedBillingPct: hundredthsText(plan.managedBillingBps),
  termMonths: plan.contractTermMonths === null ? "" : String(plan.contractTermMonths),
  implementationFee: hundredthsText(plan.implementationFeeCents),
  minimumMonthly: hundredthsText(plan.minimumMonthlyCents),
});

export const thresholdsOf = (mode: PlanFormMode): readonly number[] =>
  mode.kind === "create" ? mode.thresholds : mode.plan.bands.map((b) => b.minAdc);

type FormKey = Exclude<keyof PlanForm, "bandFees"> | `band${number}`;

const MONEY = "Enter dollars, 0 to 1,000,000,000, with up to two decimals.";
const PER_USER = "Enter dollars, 0 to 10,000,000, with up to two decimals.";
const PERCENT = "Enter a percentage from 0 to 100, with up to two decimals, e.g. 4.5.";

function bandErrors(form: PlanForm, errors: FieldErrors<FormKey>): void {
  const fees = form.bandFees.map((fee) => parsePriceCents(fee, MAX_CENTS));
  fees.forEach((fee, i) => {
    const below = fees[i - 1];
    if (fee === null) errors[`band${i}`] = MONEY;
    else if (below !== undefined && below !== null && fee < below)
      errors[`band${i}`] = "A higher census band cannot cost less than the band below it.";
  });
}

function rateErrors(form: PlanForm, errors: FieldErrors<FormKey>): void {
  const software = parsePercentBps(form.billingSoftwarePct);
  const managed = parsePercentBps(form.managedBillingPct);
  if (software === null) errors.billingSoftwarePct = PERCENT;
  if (managed === null) errors.managedBillingPct = PERCENT;
  else if (software !== null && managed < software)
    errors.managedBillingPct = "Managed billing cannot cost less than billing software.";
}

/** Per-field messages; empty when the form can be sent. `create` also checks the plan family. */
export function pricingFormErrors(
  form: PlanForm,
  kind: PlanFormMode["kind"] = "create",
): FieldErrors<FormKey> {
  const errors: FieldErrors<FormKey> = {};
  const slug = form.familySlug.trim();
  if (
    kind === "create" &&
    (!SLUG_SHAPE.test(slug) || slug.length < SLUG_MIN || slug.length > SLUG_MAX)
  )
    errors.familySlug = `Use ${SLUG_MIN} to ${SLUG_MAX} lowercase letters, numbers and hyphens, e.g. hospice-core.`;
  const name = form.name.trim();
  if (name === "") errors.name = "Enter a plan name.";
  else if (name.length > NAME_MAX) errors.name = `Use ${NAME_MAX} characters or fewer.`;
  if (parsePriceCents(form.perUserPrice, MAX_PER_USER_CENTS) === null)
    errors.perUserPrice = PER_USER;
  bandErrors(form, errors);
  rateErrors(form, errors);
  const term = form.termMonths.trim();
  if (!WHOLE.test(term) || Number(term) < 1 || Number(term) > TERM_MAX)
    errors.termMonths = `Enter a whole number of months from 1 to ${TERM_MAX}.`;
  if (parsePriceCents(form.implementationFee, MAX_CENTS) === null) errors.implementationFee = MONEY;
  if (form.minimumMonthly.trim() !== "" && parsePriceCents(form.minimumMonthly, MAX_CENTS) === null)
    errors.minimumMonthly = `Leave empty for no minimum. ${MONEY}`;
  return errors;
}

/** The prices of a valid form (call only when `pricingFormErrors` is empty), as the PUT body without its reason. */
function pricesOf(form: PlanForm, thresholds: readonly number[]) {
  const cents = (raw: string): number => parsePriceCents(raw) ?? 0;
  return {
    name: form.name.trim(),
    perUserPriceCents: cents(form.perUserPrice),
    bands: thresholds.map((minAdc, i) => ({
      minAdc,
      monthlyFeeCents: cents(form.bandFees[i] ?? ""),
    })),
    billingSoftwareBps: parsePercentBps(form.billingSoftwarePct) ?? 0,
    managedBillingBps: parsePercentBps(form.managedBillingPct) ?? 0,
    contractTermMonths: Number(form.termMonths.trim()),
    implementationFeeCents: cents(form.implementationFee),
    minimumMonthlyCents: form.minimumMonthly.trim() === "" ? null : cents(form.minimumMonthly),
  };
}

export const bandLabel = (thresholds: readonly number[], i: number): string => {
  const next = thresholds[i + 1];
  return next === undefined
    ? `${thresholds[i]}+ patients a day`
    : `${thresholds[i]}-${next - 1} patients a day`;
};

/** What the operator is about to record, shown in the reason dialog (there is no undo once published). */
function summaryOf(
  form: PlanForm,
  thresholds: readonly number[],
  currency: string,
): ReasonDialogRecordLine[] {
  const p = pricesOf(form, thresholds);
  const money = (c: number | null): string => (c === null ? "None" : formatCents(c, currency));
  const pct = (bps: number): string => `${hundredthsText(bps)}%`;
  return [
    { label: "Per user", value: `${money(p.perUserPriceCents)} a month` },
    {
      label: "Census bands",
      value: p.bands
        .map((b, i) => `${bandLabel(thresholds, i)}: ${money(b.monthlyFeeCents)}`)
        .join(" · "),
    },
    { label: "Billing software", value: `${pct(p.billingSoftwareBps)} of net collections` },
    { label: "Managed billing", value: `${pct(p.managedBillingBps)} of net collections` },
    { label: "Term", value: `${p.contractTermMonths} months` },
    { label: "Implementation fee", value: money(p.implementationFeeCents) },
    { label: "Monthly minimum", value: money(p.minimumMonthlyCents) },
  ];
}

const sentence = (s: string): string => {
  const t = s.trim();
  if (t === "") return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};

/** A refused write in words: what failed, the server's reason, and each detail it named (operator-safe envelope text). */
export function failureText(failure: OpsFailure, failed: string): string {
  const lines = [failure.message, ...failure.details.map((d) => d.message)].map(sentence);
  return [failed, ...new Set(lines.filter((l) => l !== ""))].join(" ");
}

/** A write's refusal, shown in its reason dialog; a step-up refusal offers Re-verify (keeping the typed form via `onReverify`). */
export function WriteFailure({
  failure,
  failed,
  onReverify,
}: {
  failure: OpsFailure;
  failed: string;
  onReverify?: () => void;
}): JSX.Element {
  return failure.kind === "step-up" ? (
    <OutcomeBanner
      ok={false}
      message={STEP_UP_MESSAGE}
      stepUp
      {...(onReverify ? { onReverify } : {})}
    />
  ) : (
    <InlineAlert tone="error">{failureText(failure, failed)}</InlineAlert>
  );
}

/** The create or edit form, its reason dialog (with what is being recorded) and the write. */
export function PlanEditor({
  mode,
  initial,
  draftKey,
  onSaved,
  onCancel,
}: {
  mode: PlanFormMode;
  initial: PlanForm;
  /** The step-up draft key the typed form is kept under across a Re-verify. */
  draftKey: string;
  onSaved: (plan: PricingPlan) => Promise<void>;
  onCancel?: () => void;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const [form, setForm] = useState<PlanForm>(initial);
  const [attempted, setAttempted] = useState(false);
  const [asking, setAsking] = useState(false);
  const thresholds = thresholdsOf(mode);
  const creating = mode.kind === "create";
  const errors = attempted ? pricingFormErrors(form, mode.kind) : {};
  const set = (patch: Partial<PlanForm>): void => setForm((f) => ({ ...f, ...patch }));

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!isValid(pricingFormErrors(form, mode.kind))) {
      setAttempted(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    write.clear();
    setAsking(true);
  };

  async function save(reason: string): Promise<void> {
    const prices = pricesOf(form, thresholds);
    const outcome = await write.run(
      JSON.stringify({ kind: mode.kind, familySlug: form.familySlug.trim(), prices, reason }),
      (key) =>
        mode.kind === "create"
          ? client.POST("/api/admin/pricing/plans", {
              params: { header: { "Idempotency-Key": key } },
              body: { familySlug: form.familySlug.trim(), ...prices, reason },
            })
          : client.PUT("/api/admin/pricing/plans/{id}", {
              params: { path: { id: mode.plan.id }, header: { "Idempotency-Key": key } },
              body: { ...prices, reason },
            }),
      (plan) => onSaved(plan),
    );
    if (outcome.ok) setAsking(false);
  }

  const field = (
    key: Exclude<keyof PlanForm, "bandFees">,
    label: string,
    hint?: string,
    money = false,
  ) => (
    <TextField
      label={label}
      required={key !== "minimumMonthly"}
      {...(hint ? { hint } : {})}
      {...(money ? { inputMode: "decimal" as const } : {})}
      error={errors[key]}
      value={form[key]}
      onChange={(e) => set({ [key]: e.target.value })}
    />
  );
  const confirmLabel = creating ? "Create draft" : "Save prices";
  return (
    <>
      <form className="wx-drawer-card" onSubmit={submit} noValidate>
        {creating
          ? field(
              "familySlug",
              "Plan family",
              "Lowercase letters, numbers and hyphens, e.g. hospice-core.",
            )
          : null}
        {field("name", "Name")}
        {field("perUserPrice", "Per user a month (USD)", undefined, true)}
        {thresholds.map((_, i) => (
          <TextField
            // biome-ignore lint/suspicious/noArrayIndexKey: one fixed field per band, in threshold order
            key={i}
            label={`Census band ${bandLabel(thresholds, i)}, a month (USD)`}
            required
            inputMode="decimal"
            error={errors[`band${i}`]}
            value={form.bandFees[i] ?? ""}
            onChange={(e) =>
              set({ bandFees: form.bandFees.map((v, j) => (j === i ? e.target.value : v)) })
            }
          />
        ))}
        {field("billingSoftwarePct", "Billing software (% of net collections)", undefined, true)}
        {field("managedBillingPct", "Managed billing (% of net collections)", undefined, true)}
        {field("termMonths", "Contract term (months)")}
        {field("implementationFee", "Implementation fee (USD)", undefined, true)}
        {field("minimumMonthly", "Monthly minimum (USD)", "Leave empty for no minimum.", true)}
        <div className="wx-drawer-actions">
          <Button type="submit" disabled={write.busy}>
            {confirmLabel}
          </Button>
          {onCancel ? (
            <Button tone="secondary" disabled={write.busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
      <ReasonDialog
        open={asking}
        title={creating ? "Create this price plan" : `Save the prices of "${mode.plan.name}"`}
        description={
          creating
            ? "The plan is created as a draft. Nothing is offered to tenants until it is published."
            : "The draft's prices are replaced. Nothing is offered to tenants until it is published."
        }
        record={summaryOf(form, thresholds, creating ? "USD" : mode.plan.currencyCode)}
        rule={REASON_RULES.pricing}
        confirmLabel={confirmLabel}
        busy={write.busy}
        {...(write.failure
          ? {
              error: (
                <WriteFailure
                  failure={write.failure}
                  failed={
                    creating ? "Could not create the plan." : "Could not save the draft's prices."
                  }
                  onReverify={() => stashStepUpDraft(draftKey, form)}
                />
              ),
            }
          : {})}
        onConfirm={(reason) => void save(reason)}
        onCancel={() => {
          write.clear();
          setAsking(false);
        }}
      />
    </>
  );
}
