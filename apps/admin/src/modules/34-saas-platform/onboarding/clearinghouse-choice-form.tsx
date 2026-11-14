// apps/admin/src/modules/34-saas-platform/onboarding — the clearinghouse choice form now lives in @chartwarden/ui (the tenant wizard
// offers the same form). Re-exported here so admin imports keep their path.
export {
  BLANK_CHOICE,
  ChoiceFormCard,
  SECRET_MAX,
  SECRET_MIN,
  TRANSMITTING_VENDORS,
  VENDORS,
  consequenceOf,
  isLeavingOutside,
  validateChoice,
} from "@chartwarden/ui";
export type { BillingModePick, ChoiceContext, ChoiceErrors, ChoiceForm } from "@chartwarden/ui";
