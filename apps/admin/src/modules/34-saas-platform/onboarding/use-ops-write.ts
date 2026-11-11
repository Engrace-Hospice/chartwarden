// apps/admin/src/modules/34-saas-platform/onboarding — the wizard's platform writes: the kit's `useOpsWrite` (busy flag, one
// Idempotency-Key per attempt, a refusal turned into an `OpsFailure`) with the wizard's own sentences for its codes.
import { type OpsWrite, useOpsWrite as useKitOpsWrite } from "@chartwarden/ui";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

export { AFTER_SUCCESS_TIMEOUT_MS } from "@chartwarden/ui";
export type { OpsWrite, OpsWriteOutcome } from "@chartwarden/ui";

export function useOpsWrite(): OpsWrite {
  return useKitOpsWrite(WIZARD_ERROR_COPY);
}
