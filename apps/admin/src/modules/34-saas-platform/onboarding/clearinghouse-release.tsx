// apps/admin/src/modules/34-saas-platform/onboarding — an operator releases the clearinghouse credentials a tenant still holds (migration
// 1404). Every credential a tenant seals stays reserved to it through a key rotation and a switch to outside, so no other organization can
// seal it; this frees all but the tenant's current one (an account moved to another organization, a key retired by a rotation). The
// server refuses while the tenant's vendor responses may still arrive (409, shown by the dialog) and never says which credentials it freed.
// Offered only to an operator who holds the release key (fail closed); the result is reported by the card, outside its actions row.
import { CLEARINGHOUSE_RELEASE_QUIET_DAYS } from "@chartwarden/types";
import {
  Button,
  stashStepUpMemoryDraft,
  useApiClient,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { ClearinghouseView } from "./clearinghouse-model";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RecordSaveDialog } from "./record-save-dialog";
import { useOpsWrite } from "./use-ops-write";

/** The memory draft a Re-verify keeps the typed reason under (screened free text: never in sessionStorage). */
export const releaseDraftKey = (orgSlug: string): string => `clearinghouse-release:${orgSlug}`;

const DESCRIPTION = `Frees every clearinghouse key this tenant used before; the key in use now stays with it. Release only keys the tenant has stopped using at the vendor: once another organization connects one, this tenant cannot use it again, and the vendor's responses on that account go to that organization. Refused while the tenant has a production claim in flight or sent one in the last ${CLEARINGHOUSE_RELEASE_QUIET_DAYS} days. The reason is kept in the audit trail: give a ticket reference, never the name of the organization an account moved to.`;

export function ReleaseCredentials({
  orgSlug,
  view,
  onReleased,
}: {
  orgSlug: string;
  view: ClearinghouseView;
  /** How many were released, for the card to report (null clears the report). */
  onReleased: (released: number | null) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const write = useOpsWrite();
  const mayRelease = useCan(ONBOARDING_KEYS.clearinghouseRelease);
  // A step-up refusal sends the operator to /step-up and back; the dialog reopens with the typed reason.
  const restored = useStepUpMemoryDraft<{ reason: string }>(releaseDraftKey(orgSlug));
  const [open, setOpen] = useState(restored !== undefined);
  const [reason, setReason] = useState(restored?.reason ?? "");

  async function release(typed: string): Promise<void> {
    setReason(typed);
    const outcome = await write.run(`release:${orgSlug}:${typed}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/clearinghouse/credentials/release", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
        body: { reason: typed },
      }),
    );
    if (!outcome.ok) return;
    setOpen(false);
    setReason("");
    onReleased(outcome.data.released);
  }

  if (view.source !== "tenant" || !mayRelease) return null; // a tenant that never chose holds no credential
  return (
    <>
      <Button
        tone="secondary"
        size="sm"
        onClick={() => {
          write.clear();
          onReleased(null);
          setOpen(true);
        }}
      >
        Release earlier credentials
      </Button>
      <RecordSaveDialog
        open={open}
        title="Release earlier credentials"
        description={DESCRIPTION}
        confirmLabel="Release"
        tone="danger"
        write={write}
        orgSlug={orgSlug}
        initialReason={reason}
        onReverify={() => stashStepUpMemoryDraft(releaseDraftKey(orgSlug), { reason })}
        onConfirm={(typed) => void release(typed)}
        onCancel={() => {
          write.clear();
          setReason("");
          setOpen(false);
        }}
      />
    </>
  );
}
