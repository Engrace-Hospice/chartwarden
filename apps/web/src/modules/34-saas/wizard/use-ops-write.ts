// apps/web/src/modules/34-saas/wizard — the wizard's writes: the kit's `useOpsWrite` (busy flag, one Idempotency-Key per intent, a
// refusal turned into an `OpsFailure`) with the wizard's own sentences for its codes.
import { type OpsWrite, useOpsWrite as useKitOpsWrite } from "@chartwarden/ui";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

export type { OpsWrite, OpsWriteOutcome } from "@chartwarden/ui";

export function useOpsWrite(): OpsWrite {
  return useKitOpsWrite(WIZARD_ERROR_COPY);
}
