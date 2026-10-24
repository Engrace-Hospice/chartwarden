// M36 WP 6.7 (ADR-0099 D8, D12) - Revoke link, Close / Reopen and Block / Unblock for one contact, each behind a confirmation (one click ends a person's access).
// Only rendered for a holder of messaging.family.manage. Revoke, Block and Unblock need a fresh step-up (the failure text hands a stale one to the step-up
// page); an unblock by the same person who blocked is refused by the backend with a plain sentence, which is shown as it is. None of these depends on the flag.
import type { FamilyContactSummaryDto } from "@chartwarden/types";
import { Button, ConfirmDialog } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useFamilyFailureText } from "./family-failure";
import { type FamilyKey, ft } from "./family-text";
import { useOnlineStatus } from "./offline-banner";
import { type FamilyResult, useFamilyActions } from "./use-family";

type Kind = "revoke" | "close" | "reopen" | "block" | "unblock";

const LABEL: Record<Kind, FamilyKey> = {
  revoke: "family.manage.revoke",
  close: "family.manage.close",
  reopen: "family.manage.reopen",
  block: "family.manage.block",
  unblock: "family.manage.unblock",
};

function kindsFor(contact: FamilyContactSummaryDto): readonly Kind[] {
  const live =
    contact.linkState === "not_opened" ||
    contact.linkState === "verifying" ||
    contact.linkState === "active";
  return [
    ...(live ? (["revoke"] as const) : []),
    contact.closed ? "reopen" : "close",
    contact.blocked ? "unblock" : "block",
  ];
}

export function FamilyManageActions({
  contact,
  onChanged,
}: {
  readonly contact: FamilyContactSummaryDto;
  readonly onChanged: (text: string) => void;
}): JSX.Element {
  const actions = useFamilyActions();
  const failureText = useFamilyFailureText();
  const online = useOnlineStatus();
  const inFlight = useRef(false);
  const [confirming, setConfirming] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (kind: Kind): Promise<FamilyResult<FamilyContactSummaryDto>> => {
    switch (kind) {
      case "revoke":
        return actions.revoke(contact.contactId);
      case "close":
      case "reopen":
        return actions.setClosed(contact.contactId, kind === "close");
      default:
        return actions.setBlocked(contact.contactId, kind === "block");
    }
  };

  const confirm = async (kind: Kind): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await run(kind);
    inFlight.current = false;
    setBusy(false);
    setConfirming(null);
    if (result.kind === "ok") {
      onChanged(ft(`family.manage.done.${kind}`));
      return;
    }
    setError(failureText(result, "manage"));
  };

  const name = contact.displayName;
  return (
    <div className="wx-family-manage">
      <div className="wx-export-actions">
        {kindsFor(contact).map((kind) => (
          <Button
            key={kind}
            type="button"
            tone="secondary"
            size="lg"
            disabled={busy || !online}
            onClick={() => setConfirming(kind)}
          >
            {ft(LABEL[kind])}
          </Button>
        ))}
      </div>
      {error ? (
        <p className="wx-export-error" role="alert">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        tone="danger"
        pending={busy}
        title={confirming ? ft(`family.confirm.${confirming}.title`, { name }) : ""}
        description={confirming ? <p>{ft(`family.confirm.${confirming}.text`)}</p> : null}
        confirmLabel={confirming ? ft(`family.confirm.${confirming}.yes`) : ""}
        cancelLabel={ft("family.manage.cancel")}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void confirm(confirming);
        }}
      />
    </div>
  );
}
