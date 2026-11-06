// apps/admin/src/modules/34-saas-platform/onboarding — step 5, Provider entity & NPI: the CMS identity (CCN, NPI, EIN) the tenant bills
// under, entered on its behalf. Each save is its own audited write behind a reason and an Idempotency-Key; the tenant's own validators
// judge the values (CCN, NPI check digit, EIN). The EIN is write-once: it is never shown, never returned and never stashed. NPI
// verification against the registry is done by platform staff on its own screen; this step is marked done once they have.
import {
  Button,
  type Fact,
  FactList,
  TextField,
  stashStepUpDraft,
  useApiClient,
  useStepUpDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { RecordSaveDialog } from "./record-save-dialog";
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";

interface Entity {
  id: string;
  ccn: string;
  npi: string;
  legalName: string;
  doingBusinessAs: string | null;
  fiscalIntermediary: string | null;
  fiscalYearEnd: string;
  iqiesFacilityId: string | null;
  status: string;
}

interface Form {
  ccn: string;
  npi: string;
  legalName: string;
  doingBusinessAs: string;
  fiscalIntermediary: string;
  fiscalYearEnd: string;
  iqiesFacilityId: string;
}
type Errors = Partial<Record<keyof Form | "taxId", string>>;

const BLANK: Form = {
  ccn: "",
  npi: "",
  legalName: "",
  doingBusinessAs: "",
  fiscalIntermediary: "",
  fiscalYearEnd: "",
  iqiesFacilityId: "",
};
const NPI_VERIFICATION_PATH = "/admin/billing/npi-verifications";
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:ccn_registered:entity`;

const formOf = (e: Entity): Form => ({
  ccn: e.ccn,
  npi: e.npi,
  legalName: e.legalName,
  doingBusinessAs: e.doingBusinessAs ?? "",
  fiscalIntermediary: e.fiscalIntermediary ?? "",
  fiscalYearEnd: e.fiscalYearEnd,
  iqiesFacilityId: e.iqiesFacilityId ?? "",
});

function validate(form: Form, taxId: string, creating: boolean): Errors {
  const errors: Errors = {};
  if (form.legalName.trim() === "") errors.legalName = "Enter the legal name.";
  if (creating) {
    if (!/^[0-9A-Z]{6}$/.test(form.ccn.trim())) errors.ccn = "A CCN is six letters or digits.";
    if (!/^[0-9]{10}$/.test(form.npi.trim())) errors.npi = "An NPI is ten digits.";
    if (taxId.trim() === "") errors.taxId = "Enter the EIN, for example 12-3456789.";
    if (!/^[0-9]{4}$/.test(form.fiscalYearEnd.trim()))
      errors.fiscalYearEnd = "Four digits, month then day: 0630.";
  }
  return errors;
}

export function ProviderEntityPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const canWrite = actions.readOnlyReason === null;
  const list = useLoad<{ items: Entity[] }>(
    `entities:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/tenants/{orgSlug}/provider-entities", {
        params: { path: { orgSlug } },
      }) as Promise<{ data?: { items: Entity[] }; error?: unknown; response?: { status: number } }>,
  );
  // The stash names what was being edited (a record, or null for a new one) so coming back resumes THAT edit, not a create.
  const restored = useStepUpDraft<{ form: Form; id: string | null }>(draftKey(orgSlug));
  const [editing, setEditing] = useState<{ id: string | null } | null>(
    restored ? { id: restored.id } : null,
  );
  const [form, setForm] = useState<Form>(restored?.form ?? BLANK);
  const [taxId, setTaxId] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [asking, setAsking] = useState(false);
  const write = useOpsWrite();

  const items = list.data?.items ?? [];
  const set = (field: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  function open(entity: Entity | null): void {
    write.clear();
    setErrors({});
    setTaxId("");
    setForm(entity ? formOf(entity) : BLANK);
    setEditing({ id: entity?.id ?? null });
  }

  function askForReason(): void {
    const found = validate(form, taxId, editing?.id === null);
    setErrors(found);
    if (Object.keys(found).length === 0) setAsking(true);
  }

  async function save(reason: string): Promise<void> {
    if (!editing) return;
    const common = {
      legalName: form.legalName.trim(),
      ...(form.doingBusinessAs.trim() ? { doingBusinessAs: form.doingBusinessAs.trim() } : {}),
      ...(form.fiscalIntermediary.trim()
        ? { fiscalIntermediary: form.fiscalIntermediary.trim() }
        : {}),
      ...(form.iqiesFacilityId.trim() ? { iqiesFacilityId: form.iqiesFacilityId.trim() } : {}),
      reason,
    };
    const id = editing.id;
    const body =
      id === null
        ? {
            ...common,
            ccn: form.ccn.trim(),
            npi: form.npi.trim(),
            taxId: taxId.trim(),
            fiscalYearEnd: form.fiscalYearEnd.trim(),
          }
        : common;
    // The EIN is part of the attempt but never of its fingerprint on screen: the key follows the whole body, which includes it.
    const outcome = await write.run(JSON.stringify(body), (key) =>
      id === null
        ? client.POST("/api/v1/platform/tenants/{orgSlug}/provider-entities", {
            params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
            body: body as never,
          })
        : client.PATCH("/api/v1/platform/tenants/{orgSlug}/provider-entities/{id}", {
            params: { path: { orgSlug, id }, header: { "Idempotency-Key": key } },
            body: body as never,
          }),
    );
    if (outcome.ok) {
      setAsking(false);
      setEditing(null);
      setTaxId("");
      await Promise.all([list.reload(true), ctx.refresh()]);
    }
  }

  const facts: Fact[] = [
    {
      key: "one",
      label: "At least one provider entity",
      state: items.length > 0 ? "ok" : "pending",
    },
    {
      key: "ccn",
      label: "Every entity has its CCN and NPI",
      state: items.length > 0 && items.every((e) => e.ccn && e.npi) ? "ok" : "pending",
    },
    {
      key: "npi",
      label: (
        <>
          NPI verified against the registry by platform staff (
          <Link to={NPI_VERIFICATION_PATH}>NPI verification</Link>)
        </>
      ),
      state: "info",
    },
  ];
  const fieldError = (field: keyof Errors): string | undefined =>
    errors[field] ?? write.failure?.fieldErrors[field];

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Provider entities">
        <div className="wx-drawer-card-head">
          <h3>Provider entities</h3>
          {canWrite && !editing ? (
            <Button size="sm" tone="secondary" onClick={() => open(null)}>
              Add provider entity
            </Button>
          ) : null}
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        {list.failure ? <p role="alert">Could not load the provider entities.</p> : null}
        {list.loading && !list.data ? <p>Loading provider entities…</p> : null}
        {list.data && items.length === 0 ? <p>No provider entity yet.</p> : null}
        {items.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Provider entities</caption>
            <thead>
              <tr>
                <th scope="col">CCN</th>
                <th scope="col">NPI</th>
                <th scope="col">Legal name</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="wx-data-md">{e.ccn}</td>
                  <td className="wx-data-md">{e.npi}</td>
                  <td>{e.legalName}</td>
                  <td>{e.status}</td>
                  <td>
                    {canWrite ? (
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Edit ${e.ccn}`}
                        onClick={() => open(e)}
                      >
                        Edit
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {editing && canWrite ? (
        <section className="wx-drawer-card" aria-label="Provider entity form">
          <div className="wx-drawer-card-head">
            <h3>{editing.id === null ? "New provider entity" : "Edit provider entity"}</h3>
          </div>
          <PendingAttestationWarning view={view} />
          <div className="wx-form-grid">
            {editing.id === null ? (
              <>
                <TextField
                  label="CCN"
                  value={form.ccn}
                  onChange={set("ccn")}
                  error={fieldError("ccn")}
                />
                <TextField
                  label="NPI"
                  value={form.npi}
                  onChange={set("npi")}
                  error={fieldError("npi")}
                />
              </>
            ) : null}
            <TextField
              label="Legal name"
              value={form.legalName}
              onChange={set("legalName")}
              error={fieldError("legalName")}
            />
            <TextField
              label="Doing business as (optional)"
              value={form.doingBusinessAs}
              onChange={set("doingBusinessAs")}
            />
            <TextField
              label="Fiscal intermediary (optional)"
              value={form.fiscalIntermediary}
              onChange={set("fiscalIntermediary")}
            />
            <TextField
              label="iQIES facility id (optional)"
              value={form.iqiesFacilityId}
              onChange={set("iqiesFacilityId")}
            />
            {editing.id === null ? (
              <>
                <TextField
                  label="Fiscal year end (MMDD)"
                  hint="For example 0630."
                  value={form.fiscalYearEnd}
                  onChange={set("fiscalYearEnd")}
                  error={fieldError("fiscalYearEnd")}
                />
                <TextField
                  label="EIN"
                  hint="Write-once. Sealed under the tenant's key and never shown again."
                  type="password"
                  autoComplete="off"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                  error={fieldError("taxId")}
                />
              </>
            ) : null}
          </div>
          <div className="wx-drawer-actions">
            <Button tone="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={askForReason}>Save provider entity</Button>
          </div>
          {write.failure && !asking ? (
            <FailureNotice failure={write.failure} orgSlug={orgSlug} />
          ) : null}
        </section>
      ) : null}

      <RecordSaveDialog
        open={asking}
        title={
          editing?.id === null ? "Save the new provider entity" : "Save provider entity changes"
        }
        confirmLabel="Save"
        write={write}
        orgSlug={orgSlug}
        onReverify={() => stashStepUpDraft(draftKey(orgSlug), { form, id: editing?.id ?? null })}
        onConfirm={(reason) => void save(reason)}
        onCancel={() => {
          write.clear();
          setAsking(false);
        }}
      />
    </StepFrame>
  );
}
