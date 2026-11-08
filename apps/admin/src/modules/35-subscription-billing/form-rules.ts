import { type FieldErrors, parsePriceCents, parseWholeNumber } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the per-field rules of the New plan, New promo and New refund forms, with no
// React (a screen file exports only its component, so fast refresh keeps working). The money rules use the shared strict parser.

export const PLAN_EMPTY_FORM = {
  slug: "",
  name: "",
  tier: "starter",
  cadence: "monthly",
  basePrice: "",
  trialDays: "0",
};
export type PlanForm = typeof PLAN_EMPTY_FORM;

const PLAN_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Per-field messages for the New plan form; empty when it can be submitted (#597, F-042). */
export function planFormErrors(form: PlanForm): FieldErrors<keyof PlanForm> {
  const errors: FieldErrors<keyof PlanForm> = {};
  const slug = form.slug.trim();
  if (slug === "") errors.slug = "Enter a slug.";
  else if (!PLAN_SLUG_SHAPE.test(slug))
    errors.slug = "Use lowercase letters, numbers and hyphens only, e.g. starter-monthly.";
  if (form.name.trim() === "") errors.name = "Enter a plan name.";
  if (form.basePrice.trim() === "") errors.basePrice = "Enter a price in dollars, e.g. 49.00.";
  else if (parsePriceCents(form.basePrice) === null)
    errors.basePrice = "Enter a number of dollars, 0 or more, with up to two decimals, e.g. 49.00.";
  if (parseWholeNumber(form.trialDays) === null)
    errors.trialDays = "Enter a whole number of days, 0 or more.";
  return errors;
}

export const PROMO_EMPTY_FORM = {
  code: "",
  coupon: "",
  promotion: "",
  kind: "percent_off",
  percent: "",
  amount: "",
  duration: "once",
};
export type PromoForm = typeof PROMO_EMPTY_FORM;

/** Per-field messages for the New promo form; empty when it can be submitted (#597, F-042). */
export function promoFormErrors(form: PromoForm): FieldErrors<keyof PromoForm> {
  const errors: FieldErrors<keyof PromoForm> = {};
  if (form.code.trim() === "") errors.code = "Enter a promo code.";
  if (form.kind === "percent_off") {
    const percent = parseWholeNumber(form.percent, 100);
    if (form.percent.trim() === "") errors.percent = "Enter a percentage from 1 to 100.";
    else if (percent === null || percent < 1)
      errors.percent = "Enter a whole percentage from 1 to 100.";
  } else {
    const amount = parsePriceCents(form.amount);
    if (form.amount.trim() === "") errors.amount = "Enter an amount in dollars, e.g. 10.00.";
    else if (amount === null || amount < 1)
      errors.amount =
        "Enter a dollar amount of at least 0.01, with up to two decimals, e.g. 10.00.";
  }
  return errors;
}

/** The reason detail's minimum (mirrors the server contract). */
export const MIN_REFUND_REASON = 40;
const INVOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RefundForm = {
  invoiceId: string;
  amount: string;
  kind: string;
  reasonCode: string;
  detail: string;
};

/** The refund request's per-field messages, and its amount as the validator parsed it (null unless it can be sent). */
export function checkRefundForm(form: RefundForm): {
  readonly errors: FieldErrors<keyof RefundForm>;
  readonly amountCents: number | null;
} {
  const errors: FieldErrors<keyof RefundForm> = {};
  const invoice = form.invoiceId.trim();
  if (invoice === "") errors.invoiceId = "Enter the invoice id.";
  else if (!INVOICE_UUID.test(invoice)) errors.invoiceId = "The invoice id is a UUID, e.g. 3f2b…";
  const amount = parsePriceCents(form.amount);
  if (form.amount.trim() === "") errors.amount = "Enter the refund amount in dollars.";
  else if (amount === null || amount <= 0)
    errors.amount = "Enter a dollar amount greater than 0, with up to two decimals, e.g. 25.00.";
  const length = form.detail.trim().length;
  if (length < MIN_REFUND_REASON)
    errors.detail = `Describe the reason in at least ${MIN_REFUND_REASON} characters (${length} so far).`;
  return { errors, amountCents: Object.keys(errors).length === 0 ? amount : null };
}

/** Per-field messages for the refund request; empty when it can be submitted (#597, F-042). */
export const refundFormErrors = (form: RefundForm): FieldErrors<keyof RefundForm> =>
  checkRefundForm(form).errors;
