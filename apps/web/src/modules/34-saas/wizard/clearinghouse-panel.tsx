// apps/web/src/modules/34-saas/wizard — step 7, Billing: clearinghouse, on the tenant's side. The organization chooses Stedi, Claim.MD or
// billing outside ChartWarden, records the BAA it holds with its vendor, verifies the connection, and (once ChartWarden has verified the BAA)
// activates. The vendor credential is write-only: sealed under the organization's own key, never returned, never shown, never stashed
// through a Re-verify (the member types it again). The first choice carries no If-Match, a change carries the version the member read
// (a 412 or 428 reloads and says so). Every write needs a fresh step-up and one Idempotency-Key per intent.
import {
  BLANK_CHOICE,
  Button,
  type ChoiceErrors,
  type ChoiceForm,
  ChoiceFormCard,
  FactList,
  InlineAlert,
  LoadingSpinner,
  stashStepUpMemoryDraft,
  useApiClient,
  useLoad,
  useOpsWrite,
  useStepUpMemoryDraft,
  validateChoice,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { BILLING_ERROR_COPY, isAboutAnInput, isStalePin } from "./billing-errors";
import { bodyFingerprint } from "./body-fingerprint";
import { BaaCard } from "./clearinghouse-baa-card";
import {
  type TenantClearinghouseView,
  asSharedView,
  tenantActionsOf,
  tenantConsequenceOf,
  tenantFactsOf,
} from "./clearinghouse-tenant";
import { ActivateCard, VerifyCard } from "./clearinghouse-verify-card";
import { useEditorFocus } from "./editor-focus";
import { type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { StaleDataNotice } from "./stale-data-notice";
import { WriteFailureNotice } from "./write-failure";

const PATH = "/api/v1/tenant/clearinghouse";
const READ_KEY = "billing.clearinghouse.read";
const ADMIN_KEY = "billing.clearinghouse.admin";
const DRAFT_KEY = "wizard:clearinghouse_selected:choice";
const CHOICE_FIELDS = ["vendor", "mode", "secret"] as const;
/** A tenant cannot change its billing service mode, so the shared form never asks for one. */
const CONTEXT_HAS_NO_CONTRACT = { hasContract: false } as const;

interface ChoiceDraft {
  readonly form: ChoiceForm;
  /** The version the member read when the form opened (null: a first choice). Sent from here, never re-read. */
  readonly pinnedVersion: number | null;
}

/** What the server said about each choice input, merged under what the form itself found. */
function withServerErrors(
  local: ChoiceErrors,
  server: Readonly<Record<string, string>>,
): ChoiceErrors {
  const merged: ChoiceErrors = { ...local };
  for (const field of CHOICE_FIELDS) {
    const said = server[field];
    if (merged[field] === undefined && said !== undefined) merged[field] = said;
  }
  return merged;
}

export function ClearinghousePanel(props: StepPanelProps): JSX.Element {
  if (!props.held.has(READ_KEY)) {
    return (
      <section className="wx-drawer-card" aria-label="Clearinghouse settings">
        <div className="wx-drawer-card-head">
          <h3>Clearinghouse</h3>
        </div>
        <InlineAlert tone="info">
          Your role cannot view the clearinghouse settings. Ask your administrator.
        </InlineAlert>
      </section>
    );
  }
  return <ClearinghouseBody {...props} />;
}

function ClearinghouseBody({ step, view, held, onChanged }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const load = useLoad<TenantClearinghouseView>(
    "tenant-clearinghouse",
    () => client.GET(PATH),
    BILLING_ERROR_COPY,
  );
  const restored = useStepUpMemoryDraft<ChoiceDraft>(DRAFT_KEY);
  const [editing, setEditing] = useState(restored !== undefined);
  const [form, setForm] = useState<ChoiceForm>({ ...BLANK_CHOICE, ...restored?.form });
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(
    restored?.pinnedVersion ?? null,
  );
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<ChoiceErrors>({});
  const write = useOpsWrite(BILLING_ERROR_COPY);

  const current = load.data;
  const canWrite = held.has(ADMIN_KEY) && isStepOpenForWork(view, step);
  const actions = current ? tenantActionsOf(current, canWrite) : null;
  const choiceHeading = useEditorFocus(editing && canWrite && current !== null, "clearinghouse");

  /** A write that finished: read this step's data and the wizard again (the step settles after most of these). */
  const settled = async (): Promise<void> => {
    await Promise.all([load.reload(true), onChanged()]);
  };

  function openChoice(): void {
    if (!current) return;
    write.clear();
    setErrors({});
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

  async function save(): Promise<void> {
    if (!current) return;
    write.clear();
    const found = validateChoice(asSharedView(current), form, secret, {
      tenantStatus: view.tenantStatus,
      ...CONTEXT_HAS_NO_CONTRACT,
    });
    setErrors(found);
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
        setEditing(false);
        setSecret("");
        await settled();
      },
    );
    if (!outcome.ok && isStalePin(outcome.failure)) {
      // Changed since it was read (412), or no pin was sent (428): the form's pin is stale, so it closes, the record is read again, and
      // the member opens the form anew on what it says now and enters the credential again.
      setEditing(false);
      setSecret("");
      await load.reload(true);
    }
  }

  const shared = current ? asSharedView(current) : null;
  const failure = write.failure;
  const consequence = current ? tenantConsequenceOf(current, form) : undefined;

  return (
    <>
      <section className="wx-drawer-card" aria-label="Clearinghouse settings">
        <div className="wx-drawer-card-head">
          <h3>Clearinghouse</h3>
          {canWrite && current && !editing ? (
            <Button
              size="sm"
              tone="secondary"
              data-editor-return="clearinghouse"
              onClick={openChoice}
            >
              {current.vendor !== null && current.source === "tenant"
                ? "Change the clearinghouse"
                : "Choose the clearinghouse"}
            </Button>
          ) : null}
        </div>
        <p className="wx-row-sub">
          This step is done when your clearinghouse is active, or when you choose to bill outside
          ChartWarden.
        </p>
        {load.loading && !current ? (
          <LoadingSpinner label="Loading the clearinghouse settings" />
        ) : null}
        {load.failure ? (
          <div className="wx-form-stack">
            <InlineAlert tone="error">
              Could not load the clearinghouse settings. {load.failure.message}
            </InlineAlert>
            <div>
              <Button size="sm" tone="secondary" onClick={() => void load.reload()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
        <StaleDataNotice stale={load.stale} onReload={() => void load.reload()} />
        {current ? (
          <FactList facts={tenantFactsOf(current)} ariaLabel="What settles this step" />
        ) : null}
      </section>

      {/* A refusal that closed the form (a stale pin) is still read here, under the card, not in a form that is gone. */}
      {failure && !editing && !isAboutAnInput(failure) ? (
        <WriteFailureNotice failure={failure} />
      ) : null}

      {editing && canWrite && current && shared ? (
        <>
          <ChoiceFormCard
            view={shared}
            form={form}
            secret={secret}
            errors={withServerErrors(errors, failure?.fieldErrors ?? {})}
            context={{ tenantStatus: view.tenantStatus, ...CONTEXT_HAS_NO_CONTRACT }}
            headingRef={choiceHeading}
            busy={write.busy}
            copy={{
              submitLabel: "Save choice",
              secretNeededHint:
                "Write-only. Sealed under your organization's own key and never shown again.",
              ...(consequence ? { consequence } : {}),
            }}
            onChange={(next) => {
              setForm(next);
              setErrors({});
            }}
            onSecret={setSecret}
            onCancel={() => {
              setEditing(false);
              setSecret("");
              write.clear();
            }}
            onContinue={() => void save()}
          />
          {failure && !isAboutAnInput(failure) ? (
            <WriteFailureNotice
              failure={failure}
              onReverify={() =>
                stashStepUpMemoryDraft<ChoiceDraft>(DRAFT_KEY, { form, pinnedVersion })
              }
            />
          ) : null}
        </>
      ) : null}

      {current && actions?.canRecordBaa ? <BaaCard view={current} onSettled={settled} /> : null}
      {current && actions?.canVerifyConnection ? (
        <VerifyCard view={current} onSettled={settled} />
      ) : null}
      {current && actions?.showActivation ? (
        <ActivateCard
          view={current}
          actions={actions}
          onSettled={settled}
          onRefresh={() => load.reload(true)}
        />
      ) : null}
    </>
  );
}
