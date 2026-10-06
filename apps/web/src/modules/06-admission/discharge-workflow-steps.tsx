import { Glyph, InlineAlert } from "@wardenx/ui";
// apps/web/src/modules/06-admission — the two form steps of the Discharge / Revocation / Transfer-out
// workflow (discharge-workflow.tsx): the reason choice and the reason-specific details. Split out so the
// screen file stays within the size budget; the frame primitives come from end-of-episode-ui.tsx.
import type { JSX } from "react";
import {
  type EndReason,
  type Errors,
  type FormState,
  NARRATIVE_MAX,
  REASONS,
  RECEIVING_CARE_SETTINGS,
  REVOCATION_REASONS,
  type ReasonDef,
  type ReceivingCareSetting,
  type RevocationReason,
} from "./discharge-workflow-model";
import { ChoiceRows, Field, Section } from "./end-of-episode-ui";

type Update = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

export function ReasonStep({
  reason,
  can,
  showError,
  onChoose,
}: {
  reason: EndReason | null;
  can: (permission: string) => boolean;
  showError: boolean;
  onChoose: (reason: EndReason) => void;
}): JSX.Element {
  return (
    <Section
      icon="clipboard-list"
      title="Why is hospice care ending?"
      description="Death is recorded in the Death & Pronouncement workflow, not here."
    >
      <fieldset className="wx-choice-fieldset">
        <legend className="wx-sr-only">Reason</legend>
        <div className="wx-option-rows">
          {REASONS.map((r) => {
            const allowed = can(r.permission);
            const checked = reason === r.value;
            return (
              <label
                key={r.value}
                className={
                  checked
                    ? "wx-option-row checked"
                    : allowed
                      ? "wx-option-row"
                      : "wx-option-row blocked"
                }
                style={{ alignItems: "flex-start", padding: "0.65rem 0.875rem" }}
              >
                <input
                  type="radio"
                  name="discharge-reason"
                  value={r.value}
                  checked={checked}
                  disabled={!allowed}
                  aria-label={r.label}
                  onChange={() => onChoose(r.value)}
                />
                <span className="wx-tile-text">
                  <span style={{ fontWeight: 600 }}>{r.label}</span>
                  <small>{allowed ? r.hint : "You do not have permission for this reason."}</small>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {showError ? (
        <p className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
          Choose a reason to continue.
        </p>
      ) : null}
      {reason === "moved_out_of_service_area" ? (
        <MovedGuidance
          canTransfer={can("transfer.out")}
          onSwitch={() => onChoose("transfer_out")}
        />
      ) : null}
    </Section>
  );
}

export function DischargeDetailsStep({
  def,
  form,
  errors,
  canTransfer,
  onSwitchToTransfer,
  update,
}: {
  def: ReasonDef;
  form: FormState;
  /** The errors to show (empty until the clinician tried to continue). */
  errors: Errors;
  canTransfer: boolean;
  onSwitchToTransfer: () => void;
  update: Update;
}): JSX.Element {
  return (
    <>
      {def.value === "moved_out_of_service_area" ? (
        <MovedGuidance canTransfer={canTransfer} onSwitch={onSwitchToTransfer} />
      ) : null}
      {def.value === "for_cause" ? (
        <InlineAlert tone="info">
          A for-cause discharge needs the medical director's cosign. Until then the patient stays on
          service and nothing ends.
        </InlineAlert>
      ) : null}
      {def.value === "transfer_out" ? (
        <ReceivingHospiceSection form={form} errors={errors} update={update} />
      ) : null}
      {def.value === "revocation" ? (
        <RevocationSection form={form} errors={errors} update={update} />
      ) : null}
      {def.value === "for_cause" ? (
        <Section icon="shield" title="Grounds for discharge">
          <Field
            id="dw-for-cause"
            label="For-cause reason"
            required
            hint={`${form.forCauseReason.trim().length} / at least 20 characters`}
            error={errors.forCauseReason}
          >
            <textarea
              id="dw-for-cause"
              rows={3}
              maxLength={2000}
              value={form.forCauseReason}
              onChange={(e) => update("forCauseReason", e.target.value)}
            />
          </Field>
        </Section>
      ) : null}
      <Section icon="file-text" title={def.narrativeLabel} description={def.narrativePrompt}>
        <Field
          id="dw-narrative"
          label="Narrative"
          required
          hint={`${form.narrative.trim().length} / at least ${def.minNarrative} characters`}
          error={errors.narrative}
        >
          <textarea
            id="dw-narrative"
            rows={6}
            maxLength={NARRATIVE_MAX}
            value={form.narrative}
            placeholder={def.narrativePrompt}
            onChange={(e) => update("narrative", e.target.value)}
          />
        </Field>
      </Section>
    </>
  );
}

function ReceivingHospiceSection({
  form,
  errors,
  update,
}: {
  form: FormState;
  errors: Errors;
  update: Update;
}): JSX.Element {
  return (
    <Section icon="send" title="Receiving hospice">
      <div style={{ display: "grid", gap: "1rem" }}>
        <div className="wx-field-grid">
          <Field
            id="dw-hospice-name"
            label="Receiving hospice name"
            required
            error={errors.otherHospiceName}
          >
            <input
              id="dw-hospice-name"
              value={form.otherHospiceName}
              maxLength={200}
              onChange={(e) => update("otherHospiceName", e.target.value)}
            />
          </Field>
          <Field
            id="dw-hospice-ccn"
            label="Receiving hospice CCN"
            optional
            hint="Medicare CCN — 6 characters."
            error={errors.otherHospiceCcn}
          >
            <input
              id="dw-hospice-ccn"
              value={form.otherHospiceCcn}
              maxLength={6}
              onChange={(e) => update("otherHospiceCcn", e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        <ChoiceRows<ReceivingCareSetting>
          name="receiving-care-setting"
          legend="Where will the receiving hospice care for the patient?"
          options={RECEIVING_CARE_SETTINGS}
          value={form.receivingCareSetting}
          onChange={(v) => update("receivingCareSetting", v)}
          error={errors.receivingCareSetting}
          hint="Sets the patient status on the final claim: 50 (hospice, home) or 51 (hospice, medical facility)."
        />
      </div>
    </Section>
  );
}

function RevocationSection({
  form,
  errors,
  update,
}: {
  form: FormState;
  errors: Errors;
  update: Update;
}): JSX.Element {
  return (
    <Section icon="pencil" title="Revocation statement">
      <div className="wx-field-grid">
        <Field
          id="dw-rev-reason"
          label="Revocation reason"
          required
          error={errors.revocationReason}
        >
          <select
            id="dw-rev-reason"
            value={form.revocationReason}
            onChange={(e) => update("revocationReason", e.target.value as RevocationReason | "")}
          >
            <option value="">Choose…</option>
            {REVOCATION_REASONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="dw-rev-role" label="Signed by" required>
          <select
            id="dw-rev-role"
            value={form.signingRole}
            onChange={(e) => update("signingRole", e.target.value as FormState["signingRole"])}
          >
            <option value="patient">Patient</option>
            <option value="legal_representative">Legal representative</option>
          </select>
        </Field>
        <Field id="dw-rev-signer" label="Signer's name" required error={errors.signingPatientName}>
          <input
            id="dw-rev-signer"
            value={form.signingPatientName}
            maxLength={200}
            onChange={(e) => update("signingPatientName", e.target.value)}
          />
        </Field>
      </div>
    </Section>
  );
}

function MovedGuidance({
  canTransfer,
  onSwitch,
}: {
  canTransfer: boolean;
  onSwitch: () => void;
}): JSX.Element {
  return (
    <div
      role="note"
      aria-label="Moved or transferring?"
      style={{
        display: "grid",
        gap: "0.5rem",
        marginTop: "0.875rem",
        padding: "0.75rem 0.875rem",
        borderRadius: "var(--radius-md)",
        background: "var(--color-primary-tint)",
        color: "var(--color-on-surface)",
        fontSize: "0.8125rem",
      }}
    >
      <strong style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <Glyph name="info" size={16} /> Is another hospice in the new area taking over care?
      </strong>
      <span>
        Use <b>Transfer out</b> instead — the benefit period carries over to the receiving hospice
        and no new election is needed. Use <b>Moved out of service area</b> when the patient leaves
        the area without an immediate hospice hand-off.
      </span>
      {canTransfer ? (
        <div>
          <button type="button" className="wx-btn-secondary wx-btn-sm" onClick={onSwitch}>
            Switch to Transfer out
          </button>
        </div>
      ) : null}
    </div>
  );
}
