// apps/admin/src/modules/34-saas-platform/onboarding — "Switch to a vendor": a LIVE tenant that bills outside ChartWarden and holds a contract
// has no way off `outside` on its own (its own lane is blocked while a contract exists, because the billing mode that follows is the operator's
// to set), and the wizard's step 7 is read-only once it is active. This is the operator's way: the choose form with the billing service mode
// pick (no default; None is an explicit choice), then the reason prompt, then one pinned write that sets the mode and the vendor together.
// For a live tenant the mode is dated the 1st of next month, and the form says so before anything is confirmed. The vendor credential is
// write-only and never kept (a Re-verify stashes the form and its pin, never the credential): a stale pin (412) or a missing one (428)
// closes the form and reads the record again.
import { Button, stashStepUpDraft, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import {
  BLANK_CHOICE,
  type ChoiceErrors,
  type ChoiceForm,
  ChoiceFormCard,
  TRANSMITTING_VENDORS,
  consequenceOf,
  validateChoice,
} from "./clearinghouse-choice-form";
import type { ClearinghouseView } from "./clearinghouse-model";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RecordSaveDialog } from "./record-save-dialog";
import { RoleCannot } from "./role-cannot";
import { useEditorFocus } from "./use-editor-focus";
import { useOpsWrite } from "./use-ops-write";
import { useReturnedDraft } from "./use-returned-draft";

const PATH = "/api/v1/platform/tenants/{orgSlug}/clearinghouse";
/** The tenant statuses in which the switch is offered here: a live tenant (the wizard's step 7 serves one that is still onboarding). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "at_risk", "suspended"]);
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:clearinghouse:switch`;

/** Whether the operator is offered the switch: a live tenant on its own `outside` choice that holds a contract (the server's answer). */
export function canSwitchToVendor(view: ClearinghouseView, tenantStatus: string): boolean {
  return (
    LIVE_STATUSES.has(tenantStatus) &&
    view.source === "tenant" &&
    view.vendor === "outside" &&
    view.hasContract
  );
}

export function SwitchToVendor({
  orgSlug,
  view,
  tenantStatus,
  returnedFromStepUp,
  reload,
  onSwitched,
}: {
  orgSlug: string;
  view: ClearinghouseView;
  tenantStatus: string;
  /** The hub card read the return from Re-verify once and cleared its history marker before this mounted: it hands the answer down. */
  returnedFromStepUp?: boolean;
  /** Read the choice again (a pin that went stale). */
  reload: () => Promise<void> | void;
  /** The switch committed; `modeConfirmed` is false when the billing mode could not be confirmed afterwards (the caller says so). */
  onSwitched: (modeConfirmed: boolean) => Promise<void> | void;
}): JSX.Element | null {
  const client = useApiClient();
  const write = useOpsWrite();
  // the switch always names the billing mode, so it takes the pricing key as well as the clearinghouse one
  const mayWrite = useCan(ONBOARDING_KEYS.clearinghouseWrite, ONBOARDING_KEYS.pricingWrite);
  // Coming back from Re-verify: the form and its pin are restored (the credential is typed again).
  const restored = useReturnedDraft<{ form: ChoiceForm; pinnedVersion: number | null }>(
    draftKey(orgSlug),
    returnedFromStepUp,
  );
  const [open, setOpen] = useState(restored !== undefined);
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState<ChoiceForm>(
    restored?.form ?? { ...BLANK_CHOICE, vendor: "claimmd" },
  );
  // The pin is the version the operator read when the form opened, captured then: a reload behind them never moves it.
  const [pinned, setPinned] = useState<number | null>(restored?.pinnedVersion ?? null);
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<ChoiceErrors>({});
  const heading = useEditorFocus(open, "clearinghouse-switch");
  if (!canSwitchToVendor(view, tenantStatus)) return null;
  if (!mayWrite) return <RoleCannot what="switch this tenant to a clearinghouse vendor" />;
  const context = { tenantStatus, hasContract: view.hasContract };

  function begin(): void {
    write.clear();
    setErrors({});
    setSecret("");
    setForm({ ...BLANK_CHOICE, vendor: "claimmd" });
    setPinned(view.version);
    setOpen(true);
  }

  function close(): void {
    write.clear();
    setAsking(false);
    setOpen(false);
    setSecret("");
  }

  function next(): void {
    write.clear();
    const found = validateChoice(view, form, secret, context);
    setErrors(found);
    if (Object.keys(found).length === 0) setAsking(true);
  }

  async function confirm(reason: string): Promise<void> {
    const mode = form.billingServiceMode;
    if (mode === "" || pinned === null) return;
    const outcome = await write.run(
      `switch:${pinned}:${form.vendor}:${form.mode}:${mode}:${reason}`,
      (key) =>
        client.PUT(PATH, {
          params: {
            path: { orgSlug },
            header: { "Idempotency-Key": key, "If-Match": String(pinned) },
          },
          body: {
            vendor: form.vendor,
            mode: form.mode,
            secret,
            billingServiceMode: mode,
            reason,
          },
        }),
    );
    if (outcome.ok) {
      close();
      await onSwitched(outcome.data.billingModeConfirmed !== false);
      return;
    }
    const { failure } = outcome;
    if (
      failure.kind === "validation" &&
      Object.keys(failure.fieldErrors).some((f) => f !== "reason")
    ) {
      // An input was refused: the prompt steps aside, the form keeps what was typed, the error sits under its input.
      setAsking(false);
      setErrors({
        ...(failure.fieldErrors.mode ? { mode: failure.fieldErrors.mode } : {}),
        ...(failure.fieldErrors.secret ? { secret: failure.fieldErrors.secret } : {}),
        ...(failure.fieldErrors.billingServiceMode
          ? { billingServiceMode: failure.fieldErrors.billingServiceMode }
          : {}),
      });
    } else if (failure.kind === "conflict" || failure.kind === "precondition") {
      // Someone changed it since it was read (412), or no pin was sent (428): the form closes, the record is read again.
      close();
      await reload();
    }
  }

  return (
    <>
      {open ? (
        <ChoiceFormCard
          headingRef={heading}
          view={view}
          form={form}
          secret={secret}
          errors={errors}
          context={context}
          vendors={TRANSMITTING_VENDORS}
          title="Switch to a clearinghouse"
          onChange={setForm}
          onSecret={setSecret}
          onCancel={close}
          onContinue={next}
        />
      ) : (
        <Button
          tone="secondary"
          size="sm"
          data-editor-return="clearinghouse-switch"
          onClick={begin}
        >
          Switch to a vendor
        </Button>
      )}
      <RecordSaveDialog
        open={asking}
        title="Switch this tenant to a clearinghouse"
        description={consequenceOf(view, form, context)}
        confirmLabel="Switch"
        write={write}
        orgSlug={orgSlug}
        onReverify={() => stashStepUpDraft(draftKey(orgSlug), { form, pinnedVersion: pinned })}
        onConfirm={(reason) => void confirm(reason)}
        onCancel={() => {
          write.clear();
          setAsking(false);
        }}
      />
    </>
  );
}
