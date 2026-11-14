// apps/web/src/modules/34-saas/wizard — the form that creates the organization's provider entity (CMS identity: CCN, NPI, EIN), shared by
// the wizard's step 5 and the Agency setup screen. POST /api/v1/provider-entities (`org.manage`); the CCN, NPI, EIN and fiscal year end
// cannot be changed afterwards (a change is a re-enrolment ChartWarden handles). The EIN is write-once and sealed server-side: it is never
// shown again and never stashed. One Idempotency-Key per attempt (a retry after no answer replays instead of creating twice).
import { Button, InlineAlert, TextField, bodyFingerprint, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { FailureNotice } from "./failure-notice";
import { useOpsWrite } from "./use-ops-write";
import { useWizardDraft } from "./wizard-drafts";
import { viewHasMoved } from "./wizard-errors";

const CCN_SHAPE = /^[0-9A-Z]{6}$/;
const NPI_SHAPE = /^[0-9]{10}$/;
const FISCAL_YEAR_END_SHAPE = /^[0-9]{4}$/;
const EMPTY_ENTITY = { legalName: "", ccn: "", npi: "", taxId: "", fiscalYearEnd: "" };
/** What a Re-verify keeps: every field but the EIN, which is write-once and is never stashed anywhere. */
const DRAFT_NAME = "provider-entity";
type Stashed = Omit<typeof EMPTY_ENTITY, "taxId">;

export function ProviderEntityForm({
  onCreated,
  onViewMoved,
}: {
  /** Called once the entity is saved (the host reloads its list). */
  onCreated: () => Promise<void>;
  /** Called when a refusal says the wizard's view is out of date (the host reloads it). */
  onViewMoved?: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const { restored, stash } = useWizardDraft<Stashed>(DRAFT_NAME);
  const [form, setForm] = useState({ ...EMPTY_ENTITY, ...restored });
  const [error, setError] = useState<string | null>(null);
  // Held from the first instant of a submit (the digest below is asynchronous), so a second Enter cannot start a second attempt.
  const submitting = useRef(false);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting.current) return;
    const legalName = form.legalName.trim();
    const ccn = form.ccn.trim().toUpperCase();
    const npi = form.npi.trim();
    const taxId = form.taxId.trim();
    const fiscalYearEnd = form.fiscalYearEnd.trim();
    if (!legalName || !taxId) return setError("Enter the legal name and the 9-digit EIN.");
    if (!CCN_SHAPE.test(ccn))
      return setError("The CCN is 6 characters (digits or capital letters).");
    if (!NPI_SHAPE.test(npi)) return setError("The NPI is 10 digits.");
    if (!FISCAL_YEAR_END_SHAPE.test(fiscalYearEnd))
      return setError("The fiscal year end is MMDD, e.g. 1231.");
    setError(null);
    const body = { legalName, ccn, npi, taxId, fiscalYearEnd };
    submitting.current = true;
    try {
      const outcome = await write.run(
        await bodyFingerprint(body),
        (key) =>
          client.POST("/api/v1/provider-entities", { body, headers: { "Idempotency-Key": key } }),
        onCreated,
      );
      if (outcome.ok) setForm(EMPTY_ENTITY);
      else if (viewHasMoved(outcome.failure)) await onViewMoved?.();
    } finally {
      submitting.current = false;
    }
  }

  return (
    <form className="wx-form-stack wx-form-narrow" onSubmit={(e) => void submit(e)}>
      <TextField
        label="Legal name"
        value={form.legalName}
        onChange={(e) => set("legalName")(e.target.value)}
        error={write.failure?.fieldErrors.legalName}
      />
      <TextField
        label="CCN"
        hint="6-character CMS Certification Number."
        value={form.ccn}
        onChange={(e) => set("ccn")(e.target.value)}
        error={write.failure?.fieldErrors.ccn}
      />
      <TextField
        label="NPI"
        hint="10 digits."
        value={form.npi}
        onChange={(e) => set("npi")(e.target.value)}
        error={write.failure?.fieldErrors.npi}
      />
      <TextField
        label="Tax ID (EIN)"
        hint="12-3456789. Stored encrypted; never shown again."
        value={form.taxId}
        autoComplete="off"
        onChange={(e) => set("taxId")(e.target.value)}
        error={write.failure?.fieldErrors.taxId}
      />
      <TextField
        label="Fiscal year end (MMDD)"
        value={form.fiscalYearEnd}
        onChange={(e) => set("fiscalYearEnd")(e.target.value)}
        error={write.failure?.fieldErrors.fiscalYearEnd}
      />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {!error && write.failure ? (
        <FailureNotice
          failure={write.failure}
          inputFields={["legalName", "ccn", "npi", "taxId", "fiscalYearEnd"]}
          onReverify={() => {
            const { taxId: _never, ...rest } = form;
            stash(rest);
          }}
        />
      ) : null}
      <Button type="submit" disabled={write.busy}>
        {write.busy ? "Adding…" : "Add provider entity"}
      </Button>
    </form>
  );
}
