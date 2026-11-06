// apps/admin/src/modules/34-saas-platform/onboarding — step 7's choice form: Stedi, Claim.MD, or billing outside ChartWarden. The vendor
// credential is write-only (sealed under the tenant's own key, never returned, never stashed through a re-verify: the operator types it
// again). Outside takes no mode and no credential. A first choice, and any change of vendor or mode, needs a credential.
import { Button, InlineAlert, SelectField, TextField } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  type ClearinghouseMode,
  type ClearinghouseVendor,
  type ClearinghouseView,
  needsSecret,
} from "./clearinghouse-model";

export interface ChoiceForm {
  vendor: ClearinghouseVendor;
  mode: ClearinghouseMode;
}
export type ChoiceErrors = Partial<Record<"vendor" | "mode" | "secret", string>>;

export const BLANK_CHOICE: ChoiceForm = { vendor: "claimmd", mode: "production" };

const VENDORS: readonly { value: ClearinghouseVendor; label: string }[] = [
  { value: "claimmd", label: "Claim.MD" },
  { value: "stedi", label: "Stedi" },
  { value: "outside", label: "Billing outside ChartWarden" },
];
const MODES: readonly { value: ClearinghouseMode; label: string }[] = [
  { value: "production", label: "Production" },
  { value: "test", label: "Test (the vendor's sandbox)" },
];
/** The server refuses a credential shorter than this (and longer than the max). */
export const SECRET_MIN = 8;
export const SECRET_MAX = 512;

export function validateChoice(
  view: ClearinghouseView,
  form: ChoiceForm,
  secret: string,
): ChoiceErrors {
  if (form.vendor === "outside") return {};
  const errors: ChoiceErrors = {};
  if (secret === "") {
    if (needsSecret(view, form)) errors.secret = "Enter the vendor credential.";
  } else if (secret.length < SECRET_MIN) {
    errors.secret = `The credential is at least ${SECRET_MIN} characters.`;
  } else if (secret.length > SECRET_MAX) {
    errors.secret = `The credential is at most ${SECRET_MAX} characters.`;
  }
  return errors;
}

/** What is true of this tenant that changes what the choice does. */
export interface ChoiceContext {
  /** `tenant_account.status` (the wizard's `tenantStatus`). */
  readonly tenantStatus: string;
  /** A contract is signed (the plan and contract step is done): the billing mode is only ever changed where one exists. */
  readonly hasContract: boolean;
}

/**
 * What the choice does, said before the operator confirms it, and only what is TRUE of this tenant: the MAC and payer enrollment steps
 * are skipped only while it is onboarding, and the billing mode is only touched where a contract exists (at once while onboarding,
 * from the 1st of next month once live).
 */
export function consequenceOf(
  view: ClearinghouseView,
  form: ChoiceForm,
  context: ChoiceContext,
): string {
  if (form.vendor === "outside") {
    const onboarding = context.tenantStatus === "onboarding";
    const parts = ["ChartWarden will transmit nothing for this tenant."];
    if (onboarding) parts.push("Its MAC credential and payer enrollment steps are skipped.");
    if (context.hasContract) {
      parts.push(
        onboarding
          ? "Its billing service mode is set to none now."
          : "Its billing service mode changes to none from the 1st of next month.",
      );
    }
    parts.push("The tenant files its own notices of election and termination.");
    return parts.join(" ");
  }
  if (view.vendor !== null && view.source === "tenant" && needsSecret(view, form)) {
    return "Changing the vendor or the mode starts the new configuration at draft: it must be verified and activated again, and claims work waits until then. A change of vendor also voids the vendor BAA.";
  }
  return "The credential is sealed under the tenant's own key and is never shown again.";
}

export function ChoiceFormCard({
  view,
  form,
  secret,
  errors,
  context,
  onChange,
  onSecret,
  onCancel,
  onContinue,
}: {
  view: ClearinghouseView;
  form: ChoiceForm;
  secret: string;
  errors: ChoiceErrors;
  context: ChoiceContext;
  onChange: (next: ChoiceForm) => void;
  onSecret: (value: string) => void;
  onCancel: () => void;
  onContinue: () => void;
}): JSX.Element {
  const outside = form.vendor === "outside";
  const secretNeeded = needsSecret(view, form);
  return (
    <section className="wx-drawer-card" aria-label="Clearinghouse choice">
      <div className="wx-drawer-card-head">
        <h3>{view.vendor === null ? "Choose the clearinghouse" : "Change the clearinghouse"}</h3>
      </div>
      <div className="wx-form-grid">
        <SelectField
          label="Clearinghouse"
          value={form.vendor}
          onChange={(e) => onChange({ ...form, vendor: e.target.value as ClearinghouseVendor })}
          options={VENDORS}
          error={errors.vendor}
        />
        {outside ? null : (
          <>
            <SelectField
              label="Mode"
              value={form.mode}
              onChange={(e) => onChange({ ...form, mode: e.target.value as ClearinghouseMode })}
              options={MODES}
              error={errors.mode}
            />
            <TextField
              label="Vendor credential"
              hint={
                secretNeeded
                  ? "Write-only. Sealed under the tenant's key and never shown again."
                  : "Write-only. Leave blank to keep the credential on file."
              }
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => onSecret(e.target.value)}
              error={errors.secret}
            />
          </>
        )}
      </div>
      {outside ? <InlineAlert tone="info">{consequenceOf(view, form, context)}</InlineAlert> : null}
      <div className="wx-drawer-actions">
        <Button tone="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </section>
  );
}
