// apps/admin/src/modules/34-saas-platform/onboarding — an operator releases the clearinghouse credentials a tenant still holds (migration
// 1404). Every credential a tenant seals stays reserved to it through a key rotation and a switch to outside, so no other organization can
// seal it; this frees all but the tenant's current one (an account moved to another organization, a key retired by a rotation). The
// server refuses while the tenant's vendor responses may still arrive (409, shown by the dialog) and never says which credentials it freed.
import { Button, InlineAlert, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { ClearinghouseView } from "./clearinghouse-model";
import { RecordSaveDialog } from "./record-save-dialog";
import { useOpsWrite } from "./use-ops-write";

export function ReleaseCredentials({
  orgSlug,
  view,
}: { orgSlug: string; view: ClearinghouseView }): JSX.Element | null {
  const client = useApiClient();
  const write = useOpsWrite();
  const [open, setOpen] = useState(false);
  const [released, setReleased] = useState<number | null>(null);

  async function release(reason: string): Promise<void> {
    const outcome = await write.run(`release:${reason}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/clearinghouse/credentials/release", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
        body: { reason },
      }),
    );
    if (!outcome.ok) return;
    setOpen(false);
    setReleased(outcome.data.released);
  }

  if (view.source !== "tenant") return null; // a tenant that never chose holds no credential
  return (
    <>
      <Button
        tone="secondary"
        size="sm"
        onClick={() => {
          write.clear();
          setReleased(null);
          setOpen(true);
        }}
      >
        Release earlier credentials
      </Button>
      {released !== null ? (
        <InlineAlert tone="success">
          {released === 0
            ? "This tenant held no earlier credentials."
            : `Released ${released} earlier credential${released === 1 ? "" : "s"}.`}
        </InlineAlert>
      ) : null}
      <RecordSaveDialog
        open={open}
        title="Release earlier credentials"
        description="Frees every clearinghouse key this tenant used before, so another organization can connect it. The key in use now stays with this tenant. Refused while this tenant's vendor responses may still arrive (a production claim in the last 90 days)."
        confirmLabel="Release"
        tone="danger"
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void release(reason)}
        onCancel={() => {
          write.clear();
          setOpen(false);
        }}
      />
    </>
  );
}
