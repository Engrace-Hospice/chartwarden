// apps/web/src/modules/34-saas/wizard — step 8's credential form: the Medicare submitter credential the organization's claims go out under.
// The client secret is write-only (sealed under the organization's own key, never returned, never stashed through a Re-verify), and the
// server requires it on every save, a replacement included.
import { Button, SECRET_INPUT_PROPS, SelectField, TextField } from "@chartwarden/ui";
import type { JSX, ReactNode, Ref } from "react";

export type MacJurisdiction =
  | "ngs_j6"
  | "ngs_jk"
  | "cgs_j15"
  | "palmetto_jj"
  | "palmetto_jm"
  | "noridian_jf"
  | "noridian_je";

/** The MAC jurisdictions M23 accepts (a 422 refuses any other). */
export const JURISDICTIONS: readonly { value: MacJurisdiction; label: string }[] = [
  { value: "ngs_j6", label: "NGS J6" },
  { value: "ngs_jk", label: "NGS JK" },
  { value: "cgs_j15", label: "CGS J15" },
  { value: "palmetto_jj", label: "Palmetto JJ" },
  { value: "palmetto_jm", label: "Palmetto JM" },
  { value: "noridian_jf", label: "Noridian JF" },
  { value: "noridian_je", label: "Noridian JE" },
];

export interface MacForm {
  readonly providerEntityId: string;
  readonly macJurisdiction: MacJurisdiction;
  readonly submitterId: string;
  readonly tradingPartnerId: string;
  readonly clientId: string;
  readonly baaRecordRef: string;
}
export type MacErrors = Partial<Record<keyof MacForm | "clientSecret", string>>;

export const BLANK_MAC_FORM: MacForm = {
  providerEntityId: "",
  macJurisdiction: "noridian_jf",
  submitterId: "",
  tradingPartnerId: "",
  clientId: "",
  baaRecordRef: "",
};

export interface EntityOption {
  readonly id: string;
  readonly legalName: string;
  readonly ccn: string | null;
}

// The server's limits (UpsertMacCredentialBodySchema).
const SUBMITTER_MAX = 64;
const CLIENT_ID_MAX = 256;
const SECRET_MAX = 4096;
const BAA_REF_MAX = 256;

export function validateMac(form: MacForm, clientSecret: string): MacErrors {
  const errors: MacErrors = {};
  if (form.providerEntityId === "") errors.providerEntityId = "Pick the provider entity.";
  if (form.submitterId.trim() === "") errors.submitterId = "Enter the submitter id.";
  else if (form.submitterId.trim().length > SUBMITTER_MAX)
    errors.submitterId = `The submitter id is at most ${SUBMITTER_MAX} characters.`;
  if (form.tradingPartnerId.trim() === "")
    errors.tradingPartnerId = "Enter the trading partner id.";
  else if (form.tradingPartnerId.trim().length > SUBMITTER_MAX)
    errors.tradingPartnerId = `The trading partner id is at most ${SUBMITTER_MAX} characters.`;
  if (form.clientId.trim() === "") errors.clientId = "Enter the client id.";
  else if (form.clientId.trim().length > CLIENT_ID_MAX)
    errors.clientId = `The client id is at most ${CLIENT_ID_MAX} characters.`;
  if (clientSecret === "") errors.clientSecret = "Enter the client secret.";
  else if (clientSecret.length > SECRET_MAX)
    errors.clientSecret = `The client secret is at most ${SECRET_MAX} characters.`;
  if (form.baaRecordRef.trim().length > BAA_REF_MAX)
    errors.baaRecordRef = `The reference is at most ${BAA_REF_MAX} characters.`;
  return errors;
}

export function MacCredentialForm({
  form,
  secret,
  errors,
  entities,
  creating,
  busy,
  locked,
  headingRef,
  failure,
  warning,
  onChange,
  onSecret,
  onCancel,
  onSubmit,
}: {
  form: MacForm;
  secret: string;
  errors: MacErrors;
  entities: readonly EntityOption[];
  /** A first credential (the provider entity is picked); a replacement keeps its provider entity. */
  creating: boolean;
  busy: boolean;
  /** A sibling write is running: the fields and Save wait. */
  locked: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  /** A refusal that is not about an input (step-up, a lock, no answer), read under the fields. */
  failure: ReactNode;
  /** Said before anything is saved (a pending go-live attestation this save voids). */
  warning: ReactNode;
  onChange: (next: MacForm, field: keyof MacForm) => void;
  onSecret: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const set = (field: keyof MacForm) => (e: { target: { value: string } }) =>
    onChange({ ...form, [field]: e.target.value }, field);
  return (
    <form
      className="wx-drawer-card"
      aria-label="MAC credential form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // aria-disabled while a write runs (the pressed button keeps focus): a second press is dropped here and by the write's own guard.
        if (!busy && !locked) onSubmit();
      }}
    >
      <div className="wx-drawer-card-head">
        <h3 ref={headingRef} tabIndex={-1}>
          {creating ? "New MAC credential" : "Replace MAC credential"}
        </h3>
      </div>
      {warning}
      <div className="wx-form-grid">
        <SelectField
          label="Provider entity"
          value={form.providerEntityId}
          disabled={!creating || locked}
          onChange={set("providerEntityId")}
          options={[
            ...(creating ? [{ value: "", label: "Choose the provider entity…" }] : []),
            ...entities.map((e) => ({
              value: e.id,
              label: e.ccn ? `${e.legalName} (${e.ccn})` : e.legalName,
            })),
          ]}
          error={errors.providerEntityId}
        />
        <SelectField
          label="MAC jurisdiction"
          // The server refuses a changed jurisdiction on an existing credential ("a new credential"), so a replacement keeps it.
          hint={
            creating
              ? undefined
              : "The jurisdiction of a credential cannot be changed. Ask ChartWarden for help."
          }
          disabled={!creating || locked}
          value={form.macJurisdiction}
          onChange={set("macJurisdiction")}
          options={JURISDICTIONS}
          error={errors.macJurisdiction}
        />
        <TextField
          label="Submitter id"
          autoComplete="off"
          disabled={locked}
          value={form.submitterId}
          onChange={set("submitterId")}
          error={errors.submitterId}
        />
        <TextField
          label="Trading partner id"
          autoComplete="off"
          disabled={locked}
          value={form.tradingPartnerId}
          onChange={set("tradingPartnerId")}
          error={errors.tradingPartnerId}
        />
        <TextField
          label="Client id"
          autoComplete="off"
          disabled={locked}
          value={form.clientId}
          onChange={set("clientId")}
          error={errors.clientId}
        />
        <TextField
          label="Client secret"
          hint="Write-only. Sealed under your organization's own key and never shown again. Enter it again on every save."
          {...SECRET_INPUT_PROPS}
          disabled={locked}
          value={secret}
          onChange={(e) => onSecret(e.target.value)}
          error={errors.clientSecret}
        />
        <TextField
          label="BAA record reference (optional)"
          hint="Where your BAA with the MAC portal is kept. Never a patient."
          autoComplete="off"
          disabled={locked}
          value={form.baaRecordRef}
          onChange={set("baaRecordRef")}
          error={errors.baaRecordRef}
        />
      </div>
      {failure}
      <div className="wx-drawer-actions">
        <Button tone="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={locked} aria-disabled={busy || undefined}>
          Save credential
        </Button>
      </div>
    </form>
  );
}
