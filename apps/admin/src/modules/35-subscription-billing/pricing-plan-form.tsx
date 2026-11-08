import {
  Button,
  type FieldErrors,
  InlineAlert,
  type OpsFailure,
  REASON_RULES,
  ReasonDialog,
  TextField,
  focusFirstInvalid,
  isValid,
  stashStepUpMemoryDraft,
  useApiClient,
  useOpsWrite,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the price plan form, shared by "New plan" (POST /api/admin/pricing/plans) and a
// draft's "Edit prices" (PUT /api/admin/pricing/plans/:id, pinned to the version read). The rules and the parse live in
// pricing-plan-model.ts; this file is the inputs, the reason dialog (with what is being recorded) and the write.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  EMPTY_PRICES,
  type FormKey,
  type PlanDraft,
  type PlanForm,
  type PlanFormMode,
  type PricingPlan,
  bandLabel,
  failureText,
  pinOf,
  priceLines,
  pricesOf,
  pricingFormErrors,
  serverFieldErrors,
  thresholdsOf,
} from "./pricing-plan-model";
import { OutcomeBanner, STEP_UP_MESSAGE } from "./ui";

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

type SimpleKey = Exclude<keyof PlanForm, "bandFees">;

/** The plan's inputs. */
function PlanFields({
  form,
  errors,
  creating,
  thresholds,
  onChange,
}: {
  form: PlanForm;
  errors: FieldErrors<FormKey>;
  creating: boolean;
  thresholds: readonly number[];
  onChange: (patch: Partial<PlanForm>) => void;
}): JSX.Element {
  const field = (key: SimpleKey, label: string, hint?: string, money = false) => (
    <TextField
      label={label}
      required={key !== "minimumMonthly"}
      {...(hint ? { hint } : {})}
      {...(money ? { inputMode: "decimal" as const } : {})}
      error={errors[key]}
      value={form[key]}
      onChange={(e) => onChange({ [key]: e.target.value })}
    />
  );
  return (
    <>
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
            onChange({ bandFees: form.bandFees.map((v, j) => (j === i ? e.target.value : v)) })
          }
        />
      ))}
      {field("billingSoftwarePct", "Billing software (% of net collections)", undefined, true)}
      {field("managedBillingPct", "Managed billing (% of net collections)", undefined, true)}
      {field("termMonths", "Contract term (months)")}
      {field("implementationFee", "Implementation fee (USD)", undefined, true)}
      {field("minimumMonthly", "Monthly minimum (USD)", "Leave empty for no minimum.", true)}
    </>
  );
}

/** The create or edit form, its reason dialog and the write. */
export function PlanEditor({
  mode,
  initial,
  initialReason = "",
  pin,
  draftKey,
  onSaved,
  onCancel,
  onConflict,
}: {
  mode: PlanFormMode;
  initial: PlanForm;
  /** The reason a Re-verify kept (shown when the dialog next opens). */
  initialReason?: string;
  /**
   * An edit's If-Match when it is not the plan's current read: the version a Re-verify draft was typed against, so a save that
   * comes back after someone else saved is refused (409) rather than overwriting their prices.
   */
  pin?: string;
  /** The step-up draft key the typed form is kept under (in memory) across a Re-verify. */
  draftKey: string;
  onSaved: (plan: PricingPlan) => Promise<void>;
  onCancel?: () => void;
  /**
   * The draft changed under the operator (409): the caller closes the editor and re-reads the plan, so the operator sees what it
   * now says and makes the change again (a retry here would overwrite the other save blind).
   */
  onConflict?: () => void;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<PlanForm>(initial);
  const [attempted, setAttempted] = useState(false);
  const [asking, setAsking] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors<FormKey>>({});
  // The reason of an attempt the server refused on a field: closing the dialog to fix it must not cost the operator their reason.
  const [lastReason, setLastReason] = useState(initialReason);
  // What is in the reason box right now (a Re-verify keeps the live text, not the last submitted one).
  const typedRef = useRef(initialReason);
  const thresholds = thresholdsOf(mode);
  const creating = mode.kind === "create";
  const errors = {
    ...(attempted ? pricingFormErrors(form, mode.kind, thresholds) : {}),
    ...serverErrors,
  };
  const editing = mode.kind === "edit";

  // Editing starts in the first field (a keyboard user is not left on the button that just unmounted).
  useEffect(() => {
    if (editing) formRef.current?.querySelector("input")?.focus();
  }, [editing]);
  // A field the server refused is focused once the dialog has closed.
  useEffect(() => {
    if (Object.keys(serverErrors).length > 0) focusFirstInvalid(formRef.current);
  }, [serverErrors]);

  const change = (patch: Partial<PlanForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setServerErrors({});
  };

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!isValid(pricingFormErrors(form, mode.kind, thresholds))) {
      setAttempted(true);
      focusFirstInvalid(e.currentTarget);
      return;
    }
    write.clear();
    typedRef.current = lastReason;
    setAsking(true);
  };

  async function save(reason: string): Promise<void> {
    const prices = pricesOf(form, thresholds);
    if (prices === null) return; // the submit checked the form; nothing is sent from a form that does not parse
    const outcome = await write.run(
      JSON.stringify({ mode: mode.kind, familySlug: form.familySlug.trim(), prices, reason }),
      (key) =>
        mode.kind === "create"
          ? client.POST("/api/admin/pricing/plans", {
              params: { header: { "Idempotency-Key": key } },
              body: { familySlug: form.familySlug.trim(), ...prices, reason },
            })
          : client.PUT("/api/admin/pricing/plans/{id}", {
              params: {
                path: { id: mode.plan.id },
                header: { "Idempotency-Key": key, "If-Match": pin ? `"${pin}"` : pinOf(mode.plan) },
              },
              // The form does not edit the description; it is sent back as read, so a save never erases it.
              body: { ...prices, description: mode.plan.description, reason },
            }),
      (plan) => onSaved(plan),
    );
    if (outcome.ok) {
      setLastReason("");
      typedRef.current = "";
      setAsking(false);
      return;
    }
    setLastReason(reason);
    if (outcome.failure.kind === "conflict" && onConflict) {
      setAsking(false);
      onConflict();
      return;
    }
    const onFields =
      outcome.failure.kind === "validation" ? serverFieldErrors(outcome.failure) : {};
    if (Object.keys(onFields).length > 0) {
      setServerErrors(onFields);
      setAsking(false);
    }
  }

  const confirmLabel = creating ? "Create draft" : "Save prices";
  return (
    <>
      <form ref={formRef} className="wx-drawer-card" onSubmit={submit} noValidate>
        <PlanFields
          form={form}
          errors={errors}
          creating={creating}
          thresholds={thresholds}
          onChange={change}
        />
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
        {...(asking
          ? {
              record: priceLines(
                pricesOf(form, thresholds) ?? EMPTY_PRICES,
                creating ? "USD" : mode.plan.currencyCode,
              ),
            }
          : {})}
        rule={REASON_RULES.pricing}
        confirmLabel={confirmLabel}
        initialReason={lastReason}
        onReasonChange={(typed) => {
          typedRef.current = typed;
        }}
        busy={write.busy}
        {...(write.failure
          ? {
              error: (
                <WriteFailure
                  failure={write.failure}
                  failed={
                    creating ? "Could not create the plan." : "Could not save the draft's prices."
                  }
                  onReverify={() =>
                    stashStepUpMemoryDraft<PlanDraft>(draftKey, {
                      form,
                      reason: typedRef.current,
                      ...(mode.kind === "edit" ? { pin: pin ?? mode.plan.updatedAt } : {}),
                    })
                  }
                />
              ),
            }
          : {})}
        onConfirm={(reason) => void save(reason)}
        onCancel={() => {
          write.clear();
          typedRef.current = lastReason;
          setAsking(false);
        }}
      />
    </>
  );
}
