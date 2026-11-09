// apps/admin/src/modules/34-saas-platform/onboarding — step 7, Billing: clearinghouse. Choose Stedi, Claim.MD or billing outside
// ChartWarden for the tenant, then walk a vendor to active: the tenant records its vendor BAA, an operator verifies it (its own key; the
// write is PINNED to the record the operator read, so a BAA the tenant swapped meanwhile is never verified unseen), the connection is
// verified (a no-PHI test for Claim.MD, an attestation with evidence for Stedi); the tenant's own billing administrator then activates it
// (no operator action: CW-AC-17). The vendor credential is
// write-only: sealed under the tenant's key, never returned, never shown, never stashed through a re-verify.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  LoadingSpinner,
  TextAreaField,
  stashStepUpDraft,
  useApiClient,
  useStepUpDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { VerifyBaa } from "./clearinghouse-baa-verify";
import {
  BLANK_CHOICE,
  type ChoiceContext,
  type ChoiceErrors,
  type ChoiceForm,
  ChoiceFormCard,
  consequenceOf,
  isLeavingOutside,
  validateChoice,
} from "./clearinghouse-choice-form";
import {
  type ClearinghouseView,
  MODE_LABEL,
  VENDOR_LABEL,
  clearinghouseActions,
  clearinghouseFacts,
  isTransmitting,
} from "./clearinghouse-model";
import { ContractModeBanner } from "./contract-mode-banner";
import { FailureNotice } from "./failure-notice";
import { ModeUnconfirmedNotice } from "./mode-unconfirmed-notice";
import type { PanelContext } from "./panel-types";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RecordSaveDialog } from "./record-save-dialog";
import { StaleNotice } from "./stale-notice";
import { StepFrame } from "./step-frame";
import { useEditorFocus } from "./use-editor-focus";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";

const PATH = "/api/v1/platform/tenants/{orgSlug}/clearinghouse";
const EVIDENCE_NOTE_MIN = 8;
const EVIDENCE_NOTE_MAX = 500;
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:clearinghouse_selected:choice`;

type Dialog = "choose" | "verify" | null;
type TestOutcome = "ok" | "credential_rejected" | "unreachable";
const TEST_PROBLEM: Record<Exclude<TestOutcome, "ok">, string> = {
  credential_rejected:
    "The vendor rejected the credential. Nothing was verified; choose the clearinghouse again with the right credential.",
  unreachable: "The vendor could not be reached. Nothing was verified; try the test again shortly.",
};

const CHOICE_FIELDS = ["vendor", "mode", "secret", "billingServiceMode"] as const;

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

/** A refusal that is about an input (not the reason itself): the prompt gets out of the way so the error is read beside that input. */
const isAboutAnInput = (failure: {
  kind: string;
  fieldErrors: Readonly<Record<string, string>>;
}): boolean =>
  failure.kind === "validation" &&
  Object.keys(failure.fieldErrors).some((field) => field !== "reason");

function SummaryCard({ view }: { view: ClearinghouseView }): JSX.Element | null {
  if (view.vendor === null || view.source !== "tenant") return null;
  const baa = view.baa;
  return (
    <dl className="wx-kv">
      <dt>Clearinghouse</dt>
      <dd>{VENDOR_LABEL[view.vendor] ?? view.vendor}</dd>
      {view.mode ? (
        <>
          <dt>Mode</dt>
          <dd>{MODE_LABEL[view.mode]}</dd>
        </>
      ) : null}
      {isTransmitting(view) ? (
        <>
          <dt>Credential</dt>
          <dd>{view.hasSecret ? "Secret on file" : "None"}</dd>
        </>
      ) : null}
      {view.verification?.evidence ? (
        <>
          <dt>Connection evidence</dt>
          <dd>{view.verification.evidence}</dd>
        </>
      ) : null}
      {baa ? (
        <>
          <dt>Vendor BAA</dt>
          <dd>
            {baa.documentRef}
            <span className="wx-row-sub">
              {" "}
              effective {baa.effectiveDate}, recorded {new Date(baa.recordedAt).toLocaleString()}
            </span>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

export function ClearinghousePanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view: wizard, actions } = ctx;
  const canWrite = actions.readOnlyReason === null;
  // Leaving outside with a contract also sets the billing mode, which the server guards with the pricing key.
  const mayChooseMode = useCan(ONBOARDING_KEYS.pricingWrite);
  const load = useLoad<ClearinghouseView>(`clearinghouse:${orgSlug}`, () =>
    client.GET(PATH, { params: { path: { orgSlug } } }),
  );
  // The version the operator read when the form opened (null: a first choice). It is stashed through Re-verify and sent from there,
  // never re-read, so a config changed while they re-verified is a 412 that reloads it, not a change they did not see.
  const restored = useStepUpDraft<{ form: ChoiceForm; pinnedVersion: number | null }>(
    draftKey(orgSlug),
  );
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(
    restored?.pinnedVersion ?? null,
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState(restored !== undefined);
  const [form, setForm] = useState<ChoiceForm>({ ...BLANK_CHOICE, ...restored?.form });
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<ChoiceErrors>({});
  const [attesting, setAttesting] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [notePhiFree, setNotePhiFree] = useState(false);
  const [testProblem, setTestProblem] = useState<string | null>(null);
  const [modeUnconfirmed, setModeUnconfirmed] = useState(false);
  const write = useOpsWrite();

  const current = load.data;
  const choiceContext: ChoiceContext = {
    tenantStatus: wizard.tenantStatus,
    // The SERVER says whether a contract exists (live or paused): never inferred from the wizard's plan step, which can be done
    // while the contract is canceled, or open while one exists, and would make the form unsatisfiable.
    hasContract: current?.hasContract === true,
  };
  const available = current ? clearinghouseActions(current) : null;

  function closeDialog(): void {
    write.clear();
    setDialog(null);
    setNotePhiFree(false); // backing out of the prompt: the confirmation is asked again before the words are sent
  }

  function openChoice(): void {
    if (!current) return;
    write.clear();
    setErrors({});
    setSecret("");
    setForm(
      current.vendor !== null && current.source === "tenant"
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
    setPinnedVersion(current.source === "tenant" ? current.version : null);
    setEditing(true);
  }

  function continueChoice(): void {
    if (!current) return;
    write.clear(); // an earlier refusal of an input has been read; this attempt starts clean
    const found = {
      ...validateChoice(current, form, secret, choiceContext),
      ...(isLeavingOutside(current, form, choiceContext) && !mayChooseMode
        ? {
            billingServiceMode: `Leaving outside also sets the billing mode, and your role cannot (that needs the ${ONBOARDING_KEYS.pricingWrite} permission).`,
          }
        : {}),
    };
    setErrors(found);
    if (Object.keys(found).length === 0) setDialog("choose");
  }

  /** A write that finished: reread this step's data and the wizard (the step settles after most of these). */
  async function settled(): Promise<void> {
    closeDialog();
    await Promise.all([load.reload(true), ctx.refresh()]);
  }

  async function choose(reason: string): Promise<void> {
    if (!current) return;
    const pinned = pinnedVersion;
    const body =
      form.vendor === "outside"
        ? { vendor: "outside" as const, reason }
        : {
            vendor: form.vendor,
            mode: form.mode,
            ...(secret !== "" ? { secret } : {}),
            // Leaving outside with a contract: the billing mode the vendor billing calls for (the server sets it first, undoes it on failure).
            ...(isLeavingOutside(current, form, choiceContext) && form.billingServiceMode !== ""
              ? { billingServiceMode: form.billingServiceMode }
              : {}),
            reason,
          };
    const outcome = await write.run(`choose:${pinned ?? "new"}:${JSON.stringify(body)}`, (key) =>
      client.PUT(PATH, {
        params: {
          path: { orgSlug },
          header: {
            "Idempotency-Key": key,
            ...(pinned !== null ? { "If-Match": String(pinned) } : {}),
          },
        },
        body,
      }),
    );
    if (outcome.ok) {
      setEditing(false);
      setSecret("");
      setModeUnconfirmed(outcome.data.billingModeConfirmed === false);
      await settled();
    } else if (isAboutAnInput(outcome.failure)) {
      setDialog(null); // the form stays open with what was typed; the error is under its input
    } else if (outcome.failure.kind === "conflict" || outcome.failure.kind === "precondition") {
      // Someone changed it since it was read (412), or no pin was sent (428): the form closes (its pin is stale), the record is
      // read again, and the operator opens the form anew on what it says now and enters the credential again.
      setDialog(null);
      setEditing(false);
      setSecret("");
      await load.reload(true);
    }
  }

  async function verifyConnection(reason: string): Promise<void> {
    const evidence =
      current?.verifiableBy === "attestation"
        ? { evidenceNote: note.trim(), confirmNoPatientInformation: true as const }
        : {};
    const outcome = await write.run(`verify:${note.trim()}:${reason}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/clearinghouse/verify", {
        params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
        body: { ...evidence, reason },
      }),
    );
    if (!outcome.ok) {
      if (isAboutAnInput(outcome.failure)) setDialog(null); // the attestation form stays open, the error under its note
      return;
    }
    const test = outcome.data.test?.outcome as TestOutcome | undefined;
    setTestProblem(test && test !== "ok" ? TEST_PROBLEM[test] : null);
    setAttesting(false);
    setNote("");
    setNotePhiFree(false);
    await settled();
  }

  function askToAttest(): void {
    const trimmed = note.trim();
    if (trimmed.length < EVIDENCE_NOTE_MIN || trimmed.length > EVIDENCE_NOTE_MAX) {
      setNoteError(
        `Say what was checked and by whom (${EVIDENCE_NOTE_MIN}-${EVIDENCE_NOTE_MAX} characters, no patient information).`,
      );
      return;
    }
    if (!notePhiFree) {
      setNoteError("Confirm the note names no patient information.");
      return;
    }
    setNoteError(null);
    write.clear();
    setDialog("verify");
  }

  const facts: Fact[] = current ? clearinghouseFacts(current) : [];
  const vendorChosen = current !== null && isTransmitting(current) && current.source === "tenant";
  const choiceHeading = useEditorFocus(editing && canWrite && current !== null, "clearinghouse");

  return (
    <StepFrame ctx={ctx}>
      {vendorChosen ? <ContractModeBanner orgSlug={orgSlug} /> : null}
      <section className="wx-drawer-card" aria-label="Clearinghouse">
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
                ? "Change"
                : "Choose clearinghouse"}
            </Button>
          ) : null}
        </div>
        {load.loading && !current ? <LoadingSpinner label="Loading the clearinghouse…" /> : null}
        {load.failure && !current ? (
          <InlineAlert tone="error">Could not load the clearinghouse.</InlineAlert>
        ) : null}
        <StaleNotice stale={load.stale} onReload={() => void load.reload()} />
        {current ? (
          <>
            <FactList facts={facts} ariaLabel="What settles this step" />
            <SummaryCard view={current} />
          </>
        ) : null}
        {testProblem ? <InlineAlert tone="warning">{testProblem}</InlineAlert> : null}
        {modeUnconfirmed ? <ModeUnconfirmedNotice orgSlug={orgSlug} /> : null}
        {canWrite && available && !editing ? (
          <div className="wx-drawer-actions">
            {current ? (
              <VerifyBaa
                orgSlug={orgSlug}
                view={current}
                reload={() => load.reload(true)}
                onVerified={() =>
                  Promise.all([load.reload(true), ctx.refresh()]).then(() => undefined)
                }
              />
            ) : null}
            {available.canVerifyConnection ? (
              <Button
                tone="secondary"
                onClick={() => {
                  setTestProblem(null);
                  if (current?.verifiableBy === "attestation") setAttesting(true);
                  else {
                    write.clear();
                    setDialog("verify");
                  }
                }}
              >
                {current?.verifiableBy === "attestation"
                  ? "Verify the connection"
                  : "Run the connection test"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {available?.tenantActivationNote ? (
          <p className="wx-row-sub">{available.tenantActivationNote}</p>
        ) : null}
      </section>

      {editing && canWrite && current ? (
        <>
          <PendingAttestationWarning view={wizard} />
          <ChoiceFormCard
            headingRef={choiceHeading}
            view={current}
            form={form}
            secret={secret}
            errors={withServerErrors(errors, write.failure?.fieldErrors ?? {})}
            context={choiceContext}
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
            onContinue={continueChoice}
          />
        </>
      ) : null}
      {write.failure && dialog === null ? (
        <FailureNotice failure={write.failure} orgSlug={orgSlug} />
      ) : null}

      {attesting && canWrite ? (
        <section className="wx-drawer-card" aria-label="Verify the connection">
          <div className="wx-drawer-card-head">
            <h3>Verify the connection</h3>
          </div>
          <p className="wx-row-sub">
            Stedi has no safe connection test, so an operator attests what was checked. Name no
            patient.
          </p>
          <TextAreaField
            label="What was checked, and by whom"
            rows={3}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setNotePhiFree(false); // the confirmation is about THESE words
            }}
            error={noteError ?? write.failure?.fieldErrors.evidenceNote ?? undefined}
          />
          <label className="inline-flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="size-5"
              checked={notePhiFree}
              onChange={(e) => setNotePhiFree(e.target.checked)}
            />
            This note names no patient information
          </label>
          <div className="wx-drawer-actions">
            <Button
              tone="secondary"
              onClick={() => {
                setAttesting(false);
                setNote("");
                setNotePhiFree(false);
                setNoteError(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={askToAttest}>Continue</Button>
          </div>
        </section>
      ) : null}

      <RecordSaveDialog
        open={dialog === "choose" && current !== null}
        title={
          current?.vendor !== null && current?.source === "tenant"
            ? "Change the clearinghouse"
            : "Choose the clearinghouse"
        }
        description={current ? consequenceOf(current, form, choiceContext) : undefined}
        confirmLabel="Save"
        write={write}
        orgSlug={orgSlug}
        onReverify={() => stashStepUpDraft(draftKey(orgSlug), { form, pinnedVersion })}
        onConfirm={(reason) => void choose(reason)}
        onCancel={() => {
          write.clear();
          setDialog(null);
        }}
      />
      <RecordSaveDialog
        open={dialog === "verify"}
        title={
          current?.verifiableBy === "attestation"
            ? "Attest the connection"
            : "Run the connection test"
        }
        description={
          current?.verifiableBy === "attestation"
            ? "Records your note as the evidence that the connection works."
            : "Sends a no-patient test request to the vendor with the tenant's credential."
        }
        confirmLabel={current?.verifiableBy === "attestation" ? "Attest" : "Run test"}
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void verifyConnection(reason)}
        onCancel={closeDialog}
      />
    </StepFrame>
  );
}
