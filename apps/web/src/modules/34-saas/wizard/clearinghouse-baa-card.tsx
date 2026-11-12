// apps/web/src/modules/34-saas/wizard — step 7, the vendor BAA: the organization records the BAA it holds with its own clearinghouse
// vendor (where it is kept, and when it took effect); a ChartWarden operator then verifies it, and the clearinghouse cannot be activated
// before that. The write needs a fresh step-up and one Idempotency-Key per intent, and it voids a pending go-live attestation. No
// credential is involved, so what was typed is stashed for the return from Re-verify.
import {
  Button,
  PendingAttestationWarning,
  TextField,
  isAboutAnInput,
  nowLocalInput,
  useApiClient,
  useEditorFocus,
  useOpsWrite,
} from "@chartwarden/ui";
import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import { DRAFT_ACTIONS, draftKeyFor, stashDraft, useRestoredDraft } from "./billing-drafts";
import { BILLING_ERROR_COPY, isViewMoved } from "./billing-errors";
import { BillingFailureNotice } from "./billing-failure-notice";
import { useServerFieldErrors } from "./billing-field-errors";
import type { CardContext } from "./card-context";
import {
  type TenantClearinghouseIdentity,
  type TenantClearinghouseView,
  sameTenantClearinghouseIdentity,
  tenantClearinghouseIdentity,
} from "./clearinghouse-tenant";
import { useGuarded } from "./use-guarded";

const PATH = "/api/v1/tenant/clearinghouse/baa";
const CARD = "baa";
const REF_MIN = 3;
const REF_MAX = 200;
/** The fields this card renders: a refusal naming only others is not "beside its input" and shows as a notice. */
const FIELDS: ReadonlySet<string> = new Set(["effectiveDate", "documentRef"]);

interface BaaForm {
  readonly effectiveDate: string;
  readonly documentRef: string;
}
interface BaaDraft {
  readonly config: TenantClearinghouseIdentity;
  readonly form: BaaForm;
}
type BaaErrors = Partial<Record<keyof BaaForm, string>>;

/** The server counts the reference after whitespace is collapsed. */
const collapse = (text: string): string => text.trim().replace(/\s+/g, " ");

/** Today as `YYYY-MM-DD` in the member's own calendar (a date input's value is local, never a UTC instant). */
const todayLocal = (): string => nowLocalInput().slice(0, 10);

function validateBaa(form: BaaForm, today: string = todayLocal()): BaaErrors {
  const errors: BaaErrors = {};
  if (form.effectiveDate === "") errors.effectiveDate = "Enter the date the BAA took effect.";
  else if (form.effectiveDate > today)
    errors.effectiveDate = "The effective date cannot be in the future.";
  const length = collapse(form.documentRef).length;
  if (length < REF_MIN || length > REF_MAX)
    errors.documentRef = `Say where the signed BAA is kept (${REF_MIN} to ${REF_MAX} characters).`;
  return errors;
}

export function BaaCard({
  view,
  ctx,
}: {
  view: TenantClearinghouseView;
  ctx: CardContext;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite(BILLING_ERROR_COPY);
  const { guard, notice } = useGuarded();
  const serverErrors = useServerFieldErrors(write.failure);
  const draftKey = draftKeyFor(ctx.scope, DRAFT_ACTIONS.clearinghouseBaa, ctx.stepKey);
  const config = tenantClearinghouseIdentity(view);
  const candidate = useRestoredDraft<BaaDraft>(draftKey, ctx.scope.returning);
  const restored = sameTenantClearinghouseIdentity(candidate?.config, config)
    ? candidate?.form
    : undefined;
  const recorded = view.baa;
  // First BAA: the form is open. A recorded BAA is shown, and a different one is recorded only on request (it voids the verification).
  const [replacing, setReplacing] = useState(restored !== undefined);
  const [form, setForm] = useState<BaaForm>(restored ?? { effectiveDate: "", documentRef: "" });
  const [errors, setErrors] = useState<BaaErrors>({});
  const open = recorded === null || replacing;
  const locked = ctx.lockedFor(CARD);
  const headingId = useId();
  const heading = useEditorFocus(replacing, "baa");
  const { onBusy } = ctx;
  useEffect(() => {
    onBusy(CARD, write.busy);
    return () => onBusy(CARD, false);
  }, [onBusy, write.busy]);

  async function record(): Promise<void> {
    const found = validateBaa(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = {
      heldBy: "tenant" as const,
      effectiveDate: form.effectiveDate,
      documentRef: collapse(form.documentRef),
    };
    const outcome = await write.run(
      JSON.stringify(body),
      (key) =>
        client.POST(PATH, {
          params: {
            header: { "Idempotency-Key": key, "If-Match": String(view.version) },
          },
          body,
        }),
      async () => {
        setReplacing(false);
        ctx.announce(
          {
            tone: "success",
            text:
              recorded === null
                ? "Your vendor BAA is recorded. Waiting for ChartWarden to verify it."
                : "Your vendor BAA record was replaced. ChartWarden must verify it again.",
          },
          true,
        );
        await ctx.onSettled();
      },
    );
    if (!outcome.ok && isViewMoved(outcome.failure)) await ctx.onMoved();
  }

  const fieldError = (field: keyof BaaForm): string | undefined =>
    errors[field] ?? serverErrors.errors[field];
  const edit = (next: BaaForm, field: keyof BaaForm): void => {
    setForm(next);
    setErrors((e) => ({ ...e, [field]: undefined }));
    serverErrors.touch(field);
  };

  return (
    <section className="wx-drawer-card" aria-labelledby={headingId}>
      <div className="wx-drawer-card-head">
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          Vendor BAA
        </h3>
        {recorded !== null && !replacing ? (
          <Button
            size="sm"
            tone="secondary"
            data-editor-return="baa"
            disabled={locked}
            onClick={() => {
              write.clear();
              setReplacing(true);
            }}
          >
            Record a different BAA
          </Button>
        ) : null}
      </div>
      {recorded !== null && !replacing ? (
        <p className="wx-row-sub">
          {recorded.documentRef}, effective {recorded.effectiveDate}. ChartWarden verifies the BAA
          you record; the clearinghouse can be activated once it has.
        </p>
      ) : null}
      {write.failure && !open ? <BillingFailureNotice failure={write.failure} /> : null}
      {open ? (
        <form
          className="wx-form-stack"
          aria-label="Record the vendor BAA"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!write.busy && !locked) void guard(record);
          }}
        >
          <p className="wx-row-sub">
            Record the business associate agreement your organization holds with this vendor. Name
            the document, never a patient.
            {recorded !== null
              ? " Recording a different BAA means ChartWarden must verify it again."
              : ""}
          </p>
          {locked ? null : <PendingAttestationWarning view={ctx.wizard} audience="tenant" />}
          {locked ? <p className="wx-row-sub">Finish or cancel the change above first.</p> : null}
          <div className="wx-form-grid">
            <TextField
              label="Effective date"
              type="date"
              max={todayLocal()}
              disabled={locked}
              value={form.effectiveDate}
              onChange={(e) => edit({ ...form, effectiveDate: e.target.value }, "effectiveDate")}
              error={fieldError("effectiveDate")}
            />
            <TextField
              label="Where the signed BAA is kept"
              hint="A title, contract folder or document id."
              autoComplete="off"
              disabled={locked}
              value={form.documentRef}
              onChange={(e) => edit({ ...form, documentRef: e.target.value }, "documentRef")}
              error={fieldError("documentRef")}
            />
          </div>
          {write.failure && !isAboutAnInput(write.failure, (f) => FIELDS.has(f)) ? (
            <BillingFailureNotice
              failure={write.failure}
              onReverify={() => stashDraft(draftKey, { config, form } satisfies BaaDraft)}
            />
          ) : null}
          <div className="wx-drawer-actions">
            {replacing ? (
              <Button
                tone="secondary"
                disabled={locked}
                onClick={() => {
                  write.clear();
                  setErrors({});
                  setReplacing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
            <Button type="submit" disabled={locked} aria-disabled={write.busy || undefined}>
              Record BAA
            </Button>
          </div>
        </form>
      ) : null}
      {notice}
    </section>
  );
}
