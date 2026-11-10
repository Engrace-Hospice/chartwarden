// A platform operator's kill switch for a tenant-held clearinghouse BAA. The request deliberately has no free-text reason: the closed
// code and ticket reference are the complete durable record, pinned to the BAA the operator read.
import { Button, InlineAlert, Modal, SelectField, TextField, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { ClearinghouseView } from "./clearinghouse-model";
import { clearinghouseActions } from "./clearinghouse-model";
import { FailureNotice } from "./failure-notice";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";

type RevokeReason = "vendor_terminated" | "account_closed" | "baa_expired" | "other";

const REASONS: readonly { value: RevokeReason; label: string }[] = [
  { value: "vendor_terminated", label: "Vendor terminated the BAA" },
  { value: "account_closed", label: "Vendor account closed" },
  { value: "baa_expired", label: "BAA expired" },
  { value: "other", label: "Other closed reason" },
];
const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/;

export function RevokeBaa({
  orgSlug,
  view,
  reload,
}: {
  orgSlug: string;
  view: ClearinghouseView;
  reload: () => Promise<void>;
}): JSX.Element | null {
  const client = useApiClient();
  const write = useOpsWrite();
  const mayRevoke = useCan(ONBOARDING_KEYS.clearinghouseRevokeBaa);
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<RevokeReason>("vendor_terminated");
  const [ticketRef, setTicketRef] = useState("");
  const baa = view.baa && !view.baa.revoked ? view.baa : null;

  function close(): void {
    write.clear();
    setOpen(false);
    setReasonCode("vendor_terminated");
    setTicketRef("");
  }

  useEffect(() => {
    if (open && baa === null) close();
  }, [open, baa === null]);

  async function revoke(): Promise<void> {
    if (!baa || !TICKET.test(ticketRef)) return;
    const pin = baa.recordedAt;
    const outcome = await write.run(`baa-revoke:${pin}:${reasonCode}:${ticketRef}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/clearinghouse/baa/revoke", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key, "If-Match": pin } },
        body: { reasonCode, ticketRef },
      }),
    );
    if (outcome.ok) {
      close();
      await reload();
    } else if (outcome.failure.kind === "conflict" || outcome.failure.kind === "precondition") {
      await reload();
    }
  }

  if (!clearinghouseActions(view).canRevokeBaa) return null;
  if (!mayRevoke) return <RoleCannot what="revoke the vendor BAA" />;
  const ticketError =
    ticketRef.length > 0 && !TICKET.test(ticketRef)
      ? "Use a ticket such as SEC-42 (capital letters and digits, a dash, then a number)."
      : write.failure?.fieldErrors.ticketRef;
  return (
    <>
      <Button
        tone="danger"
        size="sm"
        onClick={() => {
          write.clear();
          setOpen(true);
        }}
      >
        Revoke vendor BAA
      </Button>
      <Modal open={open && baa !== null} onClose={write.busy ? undefined : close} ariaLabel="Revoke vendor BAA" width="34rem">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Revoke vendor BAA</h2>
          <InlineAlert tone="warning">
            This immediately holds new clearinghouse traffic and takes an active configuration out of service. It does not delete the
            credential or retrieve responses already owed by the vendor.
          </InlineAlert>
          <SelectField
            label="Closed reason"
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value as RevokeReason)}
            options={REASONS}
          />
          <TextField
            label="Operator ticket"
            hint="Recorded with the revocation; no free-text reason is accepted."
            value={ticketRef}
            onChange={(event) => setTicketRef(event.target.value.toUpperCase())}
            {...(ticketError ? { error: ticketError } : {})}
          />
          {write.failure ? <FailureNotice failure={write.failure} orgSlug={orgSlug} /> : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <Button tone="secondary" onClick={close} disabled={write.busy}>Cancel</Button>
            <Button tone="danger" onClick={() => void revoke()} disabled={write.busy || !TICKET.test(ticketRef)}>
              {write.busy ? "Revoking…" : "Revoke BAA"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
