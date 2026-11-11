// apps/web/src/modules/34-saas/wizard — the state and the write of step 7's choice form. The vendor credential is write-only: it lives only
// in `secret`, is cleared the moment the write is sent or the form closes or the vendor or mode it was typed for changes (a Claim.MD key
// must never reach Stedi), and is never stashed. The first choice carries no If-Match; a change carries the version the member read.
import {
  BLANK_CHOICE,
  type ChoiceErrors,
  type ChoiceForm,
  bodyFingerprint,
  isAboutAnInput,
  useApiClient,
  useEditorFocus,
  useOpsWrite,
  validateChoice,
} from "@chartwarden/ui";
import { useEffect, useState } from "react";
import { DRAFT_ACTIONS, draftKeyFor, stashDraft, useRestoredDraft } from "./billing-drafts";
import { BILLING_ERROR_COPY, isStalePin } from "./billing-errors";
import { useServerFieldErrors } from "./billing-field-errors";
import type { CardContext } from "./card-context";
import { type TenantClearinghouseView, tenantConsequenceOf } from "./clearinghouse-tenant";
import type { TenantWizardView } from "./panel-props";
import { useGuarded } from "./use-guarded";

const PATH = "/api/v1/tenant/clearinghouse";
/** The fields the choice form renders. */
export const CHOICE_FIELDS: ReadonlySet<string> = new Set(["vendor", "mode", "secret"]);
/** A tenant cannot change its billing service mode, so the shared form never asks for one. */
const NO_CONTRACT = { hasContract: false } as const;

interface ChoiceDraft {
  readonly form: ChoiceForm;
  /** The version the member read when the form opened (null: a first choice). Sent from here, never re-read. */
  readonly pinnedVersion: number | null;
}

export function useChoiceEditor(args: {
  current: TenantClearinghouseView;
  wizard: TenantWizardView;
  canWrite: boolean;
  ctx: CardContext;
}) {
  const { current, wizard, canWrite, ctx } = args;
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const { guard, notice } = useGuarded();
  const serverErrors = useServerFieldErrors(write.failure);
  const draftKey = draftKeyFor(ctx.scope, DRAFT_ACTIONS.clearinghouseChoice, ctx.stepKey);
  const restored = useRestoredDraft<ChoiceDraft>(draftKey, ctx.scope.returning);
  const [editing, setEditing] = useState(restored !== undefined);
  const [form, setForm] = useState<ChoiceForm>({ ...BLANK_CHOICE, ...restored?.form });
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(
    restored?.pinnedVersion ?? null,
  );
  const [secret, setSecret] = useState("");
  const [localErrors, setLocalErrors] = useState<ChoiceErrors>({});
  const headingRef = useEditorFocus(editing && canWrite, "clearinghouse");
  const { onBusy } = ctx;
  useEffect(() => {
    onBusy("choice", editing || write.busy);
  }, [onBusy, editing, write.busy]);

  function open(): void {
    write.clear();
    setLocalErrors({});
    setSecret("");
    const chosen = current.vendor !== null && current.source === "tenant";
    setForm(
      chosen
        ? {
            vendor:
              current.vendor === "stedi" || current.vendor === "outside"
                ? current.vendor
                : "claimmd",
            mode: current.mode ?? "production",
            billingServiceMode: "",
          }
        : BLANK_CHOICE,
    );
    setPinnedVersion(chosen ? current.version : null);
    setEditing(true);
  }

  function cancel(): void {
    setEditing(false);
    setSecret("");
    write.clear();
  }

  function change(next: ChoiceForm): void {
    // A credential was typed for ONE vendor and mode: carrying it to another would disclose it to the wrong vendor.
    if (next.vendor !== form.vendor || next.mode !== form.mode) setSecret("");
    setForm(next);
    setLocalErrors({});
    serverErrors.touch("vendor");
    serverErrors.touch("mode");
  }

  async function save(): Promise<void> {
    write.clear();
    const found = validateChoice(current, form, secret, {
      tenantStatus: wizard.tenantStatus,
      ...NO_CONTRACT,
    });
    setLocalErrors(found);
    if (Object.keys(found).length > 0) return;
    const body =
      form.vendor === "outside"
        ? { vendor: "outside" as const }
        : { vendor: form.vendor, mode: form.mode, ...(secret !== "" ? { secret } : {}) };
    const pinned = pinnedVersion;
    // a digest, not the body: the vendor credential is in it and is never held outside its input
    const fingerprint = `choose:${pinned ?? "new"}:${await bodyFingerprint(body)}`;
    const outcome = await write.run(
      fingerprint,
      (key) =>
        client.PUT(PATH, {
          params: {
            header: {
              "Idempotency-Key": key,
              ...(pinned !== null ? { "If-Match": String(pinned) } : {}),
            },
          },
          body,
        }),
      async () => {
        // The credential has been sent: it leaves this screen before anything slow runs.
        setEditing(false);
        setSecret("");
        ctx.announce({
          tone: "success",
          text:
            form.vendor === "outside"
              ? "Billing outside ChartWarden is saved. Steps 8 and 9 are skipped."
              : "Your clearinghouse choice is saved. Record your vendor BAA and verify the connection next.",
        });
        await ctx.onSettled();
      },
    );
    if (!outcome.ok && isStalePin(outcome.failure)) {
      // Changed since it was read (412), or no pin was sent (428): the form's pin is stale, so it closes, the record AND the wizard are
      // read again (another tab may have chosen outside, which skips steps 8 and 9), and the member opens the form anew on what it says
      // now and enters the credential again.
      setEditing(false);
      setSecret("");
      await ctx.onMoved();
    }
  }

  const failure = write.failure;
  const errors: ChoiceErrors = { ...serverErrors.errors, ...localErrors };
  return {
    editing,
    open,
    cancel,
    change,
    form,
    secret,
    setSecret: (value: string) => {
      setSecret(value);
      serverErrors.touch("secret");
    },
    errors,
    save: () => guard(save),
    busy: write.busy,
    headingRef,
    consequence: tenantConsequenceOf(current, form),
    failure,
    failureBesideInput: failure !== null && isAboutAnInput(failure, (f) => CHOICE_FIELDS.has(f)),
    reverify: () => stashDraft(draftKey, { form, pinnedVersion } satisfies ChoiceDraft),
    notice,
  };
}
