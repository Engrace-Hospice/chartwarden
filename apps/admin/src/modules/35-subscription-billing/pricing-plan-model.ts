import {
  type FieldErrors,
  type OpsFailure,
  type ReasonDialogRecordLine,
  hundredthsText,
  isValid,
  parseHundredths,
  parsePriceCents,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the price plan editor's rules, with no React: the form's text and its parse to the
// API body, the server's rules mirrored so a refusal names the field (pricing-typebox.ts caps, validatePlanPricing: managed billing
// never below billing software, a higher census band never cheaper), what a plan says in words, and which writes a plan allows.
import { formatCents } from "./status";

export type PricingPlan =
  operations["getApiAdminPricingPlans"]["responses"][200]["content"]["application/json"][number];
export type PlanAction = "publish" | "new-version" | "archive";

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
export type FormKey = Exclude<keyof PlanForm, "bandFees"> | `band${number}`;

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

/**
 * Per-field messages; empty when the form can be sent. `create` also checks the plan family. Given the census `thresholds`, a form
 * without exactly one fee per band is refused too (nothing would be sent).
 */
export function pricingFormErrors(
  form: PlanForm,
  kind: PlanFormMode["kind"] = "create",
  thresholds?: readonly number[],
): FieldErrors<FormKey> {
  const errors: FieldErrors<FormKey> = {};
  if (thresholds && form.bandFees.length !== thresholds.length)
    errors.band0 =
      "The census bands changed since this form opened: cancel and enter one fee per band.";
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

/** The PUT body's prices (without its reason). */
export interface PlanPricesBody {
  readonly name: string;
  readonly perUserPriceCents: number;
  readonly bands: { minAdc: number; monthlyFeeCents: number }[];
  readonly billingSoftwareBps: number;
  readonly managedBillingBps: number;
  readonly contractTermMonths: number;
  readonly implementationFeeCents: number;
  readonly minimumMonthlyCents: number | null;
}

/** The form's prices as the validator parsed them; null when any field does not parse (so nothing defaults to 0 silently). */
export function pricesOf(form: PlanForm, thresholds: readonly number[]): PlanPricesBody | null {
  if (!isValid(pricingFormErrors(form, "edit", thresholds))) return null; // one fee per census band, or nothing is sent
  const cents = (raw: string, max: number): number => parsePriceCents(raw, max) as number;
  const bps = (raw: string): number => parsePercentBps(raw) as number;
  return {
    name: form.name.trim(),
    perUserPriceCents: cents(form.perUserPrice, MAX_PER_USER_CENTS),
    bands: thresholds.map((minAdc, i) => ({
      minAdc,
      monthlyFeeCents: cents(form.bandFees[i] ?? "", MAX_CENTS),
    })),
    billingSoftwareBps: bps(form.billingSoftwarePct),
    managedBillingBps: bps(form.managedBillingPct),
    contractTermMonths: Number(form.termMonths.trim()),
    implementationFeeCents: cents(form.implementationFee, MAX_CENTS),
    minimumMonthlyCents:
      form.minimumMonthly.trim() === "" ? null : cents(form.minimumMonthly, MAX_CENTS),
  };
}

export const bandLabel = (thresholds: readonly number[], i: number): string => {
  const next = thresholds[i + 1];
  return next === undefined
    ? `${thresholds[i]}+ patients a day`
    : `${thresholds[i]}-${next - 1} patients a day`;
};

/** A rate in words, the same everywhere ("2.50%"); "None" when unset. */
export const percentText = (bps: number | null): string =>
  bps === null ? "None" : `${hundredthsText(bps)}%`;
/** A contract term in words; "None" when unset (never "— months"). */
export const termText = (months: number | null): string =>
  months === null ? "None" : `${months} ${months === 1 ? "month" : "months"}`;

/** Nothing to show (the dialog opens only on a form that parses). */
export const EMPTY_PRICES: PlanPrices = {
  perUserPriceCents: null,
  bands: [],
  billingSoftwareBps: null,
  managedBillingBps: null,
  contractTermMonths: null,
  implementationFeeCents: null,
  minimumMonthlyCents: null,
};

/** What a plan's prices say, as label/value lines: the drawer's details and the record a reason dialog shows. */
export interface PlanPrices {
  readonly perUserPriceCents: number | null;
  readonly bands: readonly { readonly minAdc: number; readonly monthlyFeeCents: number }[];
  readonly billingSoftwareBps: number | null;
  readonly managedBillingBps: number | null;
  readonly contractTermMonths: number | null;
  readonly implementationFeeCents: number | null;
  readonly minimumMonthlyCents: number | null;
}
export function priceLines(prices: PlanPrices, currency: string): ReasonDialogRecordLine[] {
  const money = (c: number | null): string => (c === null ? "None" : formatCents(c, currency));
  const thresholds = prices.bands.map((b) => b.minAdc);
  return [
    { label: "Per user", value: `${money(prices.perUserPriceCents)} a month` },
    {
      label: "Census bands",
      value: prices.bands
        .map((b, i) => `${bandLabel(thresholds, i)}: ${money(b.monthlyFeeCents)}`)
        .join(" · "),
    },
    {
      label: "Billing software",
      value: `${percentText(prices.billingSoftwareBps)} of net collections`,
    },
    {
      label: "Managed billing",
      value: `${percentText(prices.managedBillingBps)} of net collections`,
    },
    { label: "Term", value: termText(prices.contractTermMonths) },
    { label: "Implementation fee", value: money(prices.implementationFeeCents) },
    { label: "Monthly minimum", value: money(prices.minimumMonthlyCents) },
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
  // a stale-pin detail carries the current timestamp for a retry, not words for the operator
  const details = failure.details.filter((d) => d.field !== "currentUpdatedAt");
  const lines = [failure.message, ...details.map((d) => d.message)].map(sentence);
  return [failed, ...new Set(lines.filter((l) => l !== ""))].join(" ");
}

/** The API's field names (validatePlanPricing, the TypeBox path) to the form's own. */
const SERVER_FIELD: Readonly<Record<string, FormKey>> = {
  familySlug: "familySlug",
  name: "name",
  perUserPriceCents: "perUserPrice",
  billingSoftwareBps: "billingSoftwarePct",
  managedBillingBps: "managedBillingPct",
  contractTermMonths: "termMonths",
  implementationFeeCents: "implementationFee",
  minimumMonthlyCents: "minimumMonthly",
};
const BAND_FIELD = /^bands(?:\[(\d+)\]|\.(\d+))\.monthlyFeeCents$/;

/** A 422's field errors on the form's inputs (only the fields the form has; the rest stay in the dialog's text). */
export function serverFieldErrors(failure: OpsFailure): FieldErrors<FormKey> {
  const errors: FieldErrors<FormKey> = {};
  for (const [field, message] of Object.entries(failure.fieldErrors)) {
    const band = BAND_FIELD.exec(field);
    const key: FormKey | undefined = band
      ? `band${Number(band[1] ?? band[2])}`
      : SERVER_FIELD[field];
    if (key) errors[key] = sentence(message);
  }
  return errors;
}

/**
 * The writes a plan allows (plan-service.ts): a draft is published; a published plan is archived; a published or archived plan
 * starts a new version only when its family has no draft and no newer version (a copy of an older one would be stale; the server
 * refuses the first, the second is this screen's own rule).
 */
export function actionsFor(
  plan: PricingPlan,
  family: readonly PricingPlan[],
): readonly PlanAction[] {
  if (plan.status === "draft") return ["publish"];
  const canVersion =
    !family.some((p) => p.status === "draft") && family.every((p) => p.version <= plan.version);
  const archive: readonly PlanAction[] = plan.status === "published" ? ["archive"] : [];
  return canVersion ? ["new-version", ...archive] : archive;
}

export interface ActionCopy {
  readonly label: string;
  readonly done: string;
  readonly failed: string;
  readonly tone?: "danger";
  readonly explain: (p: PricingPlan) => string;
}
export const ACTION_COPY: Readonly<Record<PlanAction, ActionCopy>> = {
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

/** The `If-Match` a write on an existing version sends: the `updatedAt` the operator read. */
export const pinOf = (plan: PricingPlan): string => `"${plan.updatedAt}"`;

/** What a Re-verify keeps of the editor: the typed form, the reason typed so far and, on an edit, the version it was typed against (its pin). */
export interface PlanDraft {
  readonly form: PlanForm;
  readonly reason?: string;
  readonly pin?: string;
}
