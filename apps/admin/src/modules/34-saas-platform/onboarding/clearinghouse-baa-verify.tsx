// apps/admin/src/modules/34-saas-platform/onboarding — an operator verifies the vendor BAA the tenant recorded. Used by the step 7 panel
// and by the tenant hub's clearinghouse card (a LIVE tenant that changed vendor needs it too: the route is not limited to onboarding).
//
// The write is PINNED to the record the operator read: `If-Match` is the BAA's `recordedAt`, so a BAA the tenant re-recorded meanwhile is
// never verified unseen. A refusal because the record changed (409) or because no pin was sent (428) re-reads the record and shows what it
// says now under a notice that it changed; nothing is retried on the operator's behalf. A BAA that was verified (by someone else) or
// withdrawn meanwhile closes the prompt.
import { Button, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { VENDOR_LABEL, clearinghouseActions } from "./clearinghouse-model";
import type { ClearinghouseView } from "./clearinghouse-model";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RecordSaveDialog } from "./record-save-dialog";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";

export function VerifyBaa({
  orgSlug,
  view,
  reload,
  onVerified,
}: {
  orgSlug: string;
  view: ClearinghouseView;
  /** Read the clearinghouse again (quietly), after a refusal because the record changed. */
  reload: () => Promise<void>;
  /** The BAA was verified: the caller re-reads whatever depends on it. */
  onVerified: () => Promise<void>;
}): JSX.Element | null {
  const client = useApiClient();
  const write = useOpsWrite();
  const mayVerify = useCan(ONBOARDING_KEYS.clearinghouseVerifyBaa);
  const [open, setOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const baa = view.baa && !view.baa.verified ? view.baa : null;

  function close(): void {
    write.clear();
    setOpen(false);
    setStale(false);
  }

  // The BAA is gone or already verified (by someone else): close the prompt rather than let it pop open for the next one recorded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only whether an unverified BAA is on record is the trigger.
  useEffect(() => {
    if (open && baa === null) close();
  }, [open, baa === null]);

  async function verify(reason: string): Promise<void> {
    if (!baa) return;
    const pin = baa.recordedAt;
    const outcome = await write.run(`baa:${pin}:${reason}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/clearinghouse/baa/verify", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key, "If-Match": pin } },
        body: { reason },
      }),
    );
    if (outcome.ok) {
      close();
      await onVerified();
    } else if (outcome.failure.kind === "conflict" || outcome.failure.kind === "precondition") {
      setStale(true);
      await reload();
    }
  }

  if (!clearinghouseActions(view).canVerifyBaa) return null;
  if (!mayVerify) return <RoleCannot what="verify the vendor BAA" />;
  return (
    <>
      <Button
        tone="secondary"
        size="sm"
        onClick={() => {
          write.clear();
          setStale(false);
          setOpen(true);
        }}
      >
        Verify the vendor BAA
      </Button>
      <RecordSaveDialog
        open={open && baa !== null}
        title="Verify the vendor BAA"
        description="Confirm you have seen the signed agreement this record points to."
        confirmLabel="Verify BAA"
        stale={stale}
        record={
          baa
            ? [
                { label: "Vendor", value: VENDOR_LABEL[view.vendor ?? ""] ?? "The vendor" },
                { label: "Document", value: baa.documentRef },
                { label: "Effective", value: baa.effectiveDate },
                {
                  label: "Recorded by the tenant",
                  value: new Date(baa.recordedAt).toLocaleString(),
                },
              ]
            : undefined
        }
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void verify(reason)}
        onCancel={close}
      />
    </>
  );
}
