// apps/web/src/modules/34-saas/wizard — step 8's portal check: the server probes the MAC portal for a provider entity's jurisdiction and
// says whether it ANSWERED. It does not read or validate the client secret, so the result never speaks for the credential. The check needs
// a fresh step-up and an Idempotency-Key; it stamps the credential's version, which is why nothing else on the panel runs beside it.
import { type OpsFailure, useApiClient, useOpsWrite } from "@chartwarden/ui";
import { BILLING_ERROR_COPY } from "./billing-errors";
import { portalCheckText } from "./mac-facts";
import type { PanelStatusControl } from "./panel-status";
import { useGuarded } from "./use-guarded";
import { forScope } from "./use-mac-editor";

const TEST = "/api/v1/billing/mac-credentials/{providerEntityId}/test";

export function useMacCheck(args: {
  nameOf: (providerEntityId: string) => string;
  announce: PanelStatusControl["announce"];
  /** The check stamped the credential: read the list again. */
  reload: () => Promise<unknown>;
}) {
  const { nameOf, announce, reload } = args;
  const client = useApiClient();
  const probe = useOpsWrite(BILLING_ERROR_COPY);
  const { guard, notice } = useGuarded();

  async function check(providerEntityId: string): Promise<void> {
    announce(null);
    probe.clear();
    const outcome = await probe.run(`check:${providerEntityId}`, (key) =>
      client.POST(TEST, {
        params: { path: { providerEntityId } },
        headers: { "Idempotency-Key": key },
      }),
    );
    if (!outcome.ok) return;
    announce({
      tone: outcome.data.ok ? "success" : "error",
      text: portalCheckText(nameOf(providerEntityId), outcome.data.ok, outcome.data.detail),
    });
    await reload();
  }

  const failure: OpsFailure | null = forScope(probe.failure);
  return { busy: probe.busy, failure, notice, check: (id: string) => guard(() => check(id)) };
}
