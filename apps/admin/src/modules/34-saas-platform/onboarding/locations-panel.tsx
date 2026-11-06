// apps/admin/src/modules/34-saas-platform/onboarding — step 6, Locations: the service sites the tenant works from, entered on its
// behalf behind a reason and an Idempotency-Key. The step settles on its own once a primary location exists (the platform checks
// straight after each save), so "mark done" only matters where it cannot read that fact.
import {
  Button,
  type Fact,
  FactList,
  SelectField,
  TextField,
  stashStepUpDraft,
  useApiClient,
  useStepUpDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { RecordSaveDialog } from "./record-save-dialog";
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";

interface Location {
  id: string;
  providerEntityId: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  phone: string | null;
  fax: string | null;
  timezone: string;
  status: string;
}
interface Form {
  providerEntityId: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  fax: string;
  timezone: string;
}
type Errors = Partial<Record<keyof Form, string>>;

const BLANK: Form = {
  providerEntityId: "",
  name: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  phone: "",
  fax: "",
  timezone: "",
};
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:locations_seeded:location`;

const formOf = (l: Location): Form => ({
  providerEntityId: l.providerEntityId,
  name: l.name,
  addressLine1: l.addressLine1,
  addressLine2: l.addressLine2 ?? "",
  city: l.city,
  state: l.state,
  postalCode: l.postalCode,
  phone: l.phone ?? "",
  fax: l.fax ?? "",
  timezone: l.timezone,
});

function validate(form: Form): Errors {
  const errors: Errors = {};
  if (form.name.trim() === "") errors.name = "Enter the location name.";
  if (form.addressLine1.trim() === "") errors.addressLine1 = "Enter the street address.";
  if (form.city.trim() === "") errors.city = "Enter the city.";
  if (!/^[A-Za-z]{2}$/.test(form.state.trim()))
    errors.state = "State is two letters, for example NV.";
  if (!/^\d{5}(-\d{4})?$/.test(form.postalCode.trim()))
    errors.postalCode = "ZIP code is five digits, for example 89501.";
  if (form.timezone.trim() === "")
    errors.timezone = "Enter the time zone, for example America/Denver.";
  return errors;
}

/** The fields a location carries, trimmed, with the optional ones left out when blank. */
function fieldsOf(form: Form) {
  return {
    name: form.name.trim(),
    addressLine1: form.addressLine1.trim(),
    ...(form.addressLine2.trim() ? { addressLine2: form.addressLine2.trim() } : {}),
    city: form.city.trim(),
    state: form.state.trim().toUpperCase(),
    postalCode: form.postalCode.trim(),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    ...(form.fax.trim() ? { fax: form.fax.trim() } : {}),
    timezone: form.timezone.trim(),
  };
}

export function LocationsPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const canWrite = actions.readOnlyReason === null;
  const entities = useLoad<{ items: { id: string; ccn: string; legalName: string }[] }>(
    `loc-entities:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/tenants/{orgSlug}/provider-entities", {
        params: { path: { orgSlug } },
      }),
  );
  const locations = useLoad<{ items: Location[] }>(
    `locations:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/tenants/{orgSlug}/locations", {
        params: { path: { orgSlug } },
      }) as Promise<{
        data?: { items: Location[] };
        error?: unknown;
        response?: { status: number };
      }>,
  );
  // The stash names what was being edited (a record, or null for a new one) so coming back resumes THAT edit, not a create.
  const restored = useStepUpDraft<{ form: Form; id: string | null }>(draftKey(orgSlug));
  const [editing, setEditing] = useState<{ id: string | null } | null>(
    restored ? { id: restored.id } : null,
  );
  const [form, setForm] = useState<Form>(restored?.form ?? BLANK);
  const [errors, setErrors] = useState<Errors>({});
  const [asking, setAsking] = useState(false);
  const write = useOpsWrite();

  const entityList = entities.data?.items ?? [];
  const items = locations.data?.items ?? [];
  const set = (field: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  function open(location: Location | null): void {
    write.clear();
    setErrors({});
    setForm(location ? formOf(location) : { ...BLANK, providerEntityId: entityList[0]?.id ?? "" });
    setEditing({ id: location?.id ?? null });
  }
  function askForReason(): void {
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length === 0) setAsking(true);
  }

  async function save(reason: string): Promise<void> {
    if (!editing) return;
    const id = editing.id;
    const body =
      id === null
        ? { providerEntityId: form.providerEntityId, ...fieldsOf(form), reason }
        : { ...fieldsOf(form), reason };
    const outcome = await write.run(JSON.stringify(body), (key) =>
      id === null
        ? client.POST("/api/v1/platform/tenants/{orgSlug}/locations", {
            params: { path: { orgSlug }, header: { "Idempotency-Key": key } },
            body: body as never,
          })
        : client.PATCH("/api/v1/platform/tenants/{orgSlug}/locations/{id}", {
            params: { path: { orgSlug, id }, header: { "Idempotency-Key": key } },
            body: body as never,
          }),
    );
    if (outcome.ok) {
      setAsking(false);
      setEditing(null);
      await Promise.all([locations.reload(true), ctx.refresh()]);
    }
  }

  const facts: Fact[] = [
    { key: "one", label: "At least one location", state: items.length > 0 ? "ok" : "pending" },
    {
      key: "primary",
      label: "A primary location exists: the platform checks this right after each save",
      state: "info",
    },
  ];
  const fieldError = (field: keyof Form): string | undefined =>
    errors[field] ?? write.failure?.fieldErrors[field];
  const needsEntity = entities.data !== null && entityList.length === 0;

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Locations">
        <div className="wx-drawer-card-head">
          <h3>Locations</h3>
          {canWrite && !editing && !needsEntity ? (
            <Button size="sm" tone="secondary" onClick={() => open(null)}>
              Add location
            </Button>
          ) : null}
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        {needsEntity ? <p>Add a provider entity first: a location belongs to one.</p> : null}
        {locations.failure ? <p role="alert">Could not load the locations.</p> : null}
        {locations.data && items.length === 0 && !needsEntity ? <p>No location yet.</p> : null}
        {items.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Locations</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Address</th>
                <th scope="col">Time zone</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>
                    {l.addressLine1}, {l.city}, {l.state} {l.postalCode}
                  </td>
                  <td>{l.timezone}</td>
                  <td>
                    {canWrite ? (
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Edit ${l.name}`}
                        onClick={() => open(l)}
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
        <section className="wx-drawer-card" aria-label="Location form">
          <div className="wx-drawer-card-head">
            <h3>{editing.id === null ? "New location" : "Edit location"}</h3>
          </div>
          <PendingAttestationWarning view={view} />
          <div className="wx-form-grid">
            {editing.id === null ? (
              <SelectField
                label="Provider entity"
                value={form.providerEntityId}
                onChange={set("providerEntityId")}
                options={entityList.map((e) => ({
                  value: e.id,
                  label: `${e.legalName} (${e.ccn})`,
                }))}
              />
            ) : null}
            <TextField
              label="Name"
              value={form.name}
              onChange={set("name")}
              error={fieldError("name")}
            />
            <TextField
              label="Address line 1"
              value={form.addressLine1}
              onChange={set("addressLine1")}
              error={fieldError("addressLine1")}
            />
            <TextField
              label="Address line 2 (optional)"
              value={form.addressLine2}
              onChange={set("addressLine2")}
            />
            <TextField
              label="City"
              value={form.city}
              onChange={set("city")}
              error={fieldError("city")}
            />
            <TextField
              label="State"
              value={form.state}
              onChange={set("state")}
              error={fieldError("state")}
            />
            <TextField
              label="ZIP code"
              value={form.postalCode}
              onChange={set("postalCode")}
              error={fieldError("postalCode")}
            />
            <TextField label="Phone (optional)" value={form.phone} onChange={set("phone")} />
            <TextField label="Fax (optional)" value={form.fax} onChange={set("fax")} />
            <TextField
              label="Time zone"
              hint="An IANA name, for example America/Denver."
              value={form.timezone}
              onChange={set("timezone")}
              error={fieldError("timezone")}
            />
          </div>
          <div className="wx-drawer-actions">
            <Button tone="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={askForReason}>Save location</Button>
          </div>
          {write.failure && !asking ? (
            <FailureNotice failure={write.failure} orgSlug={orgSlug} />
          ) : null}
        </section>
      ) : null}

      <RecordSaveDialog
        open={asking}
        title={editing?.id === null ? "Save the new location" : "Save location changes"}
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
