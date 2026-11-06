// apps/admin/src/modules/34-saas-platform/onboarding — step 8, Billing: MAC credentials. The Medicare submitter credential the tenant's
// claims go out under, entered on its behalf. The client secret is write-only: sealed under the tenant's own key, never returned,
// never shown, never stashed through a re-verify (the operator types it again). An update is pinned to the version the operator read
// (If-Match, an integer); a first create carries none, and a stale pin is a 412 that reloads the record.
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

interface Credential {
  credentialId: string;
  providerEntityId: string;
  macJurisdiction: string;
  submitterId: string;
  tradingPartnerId: string;
  clientId: string;
  hasSecret: boolean;
  baaRecordRef: string | null;
  version: number;
}
interface Entity {
  id: string;
  ccn: string;
  legalName: string;
}
interface Form {
  providerEntityId: string;
  macJurisdiction: string;
  submitterId: string;
  tradingPartnerId: string;
  clientId: string;
  baaRecordRef: string;
}
type Errors = Partial<Record<keyof Form | "clientSecret", string>>;

/** The MAC jurisdictions M23 accepts (a 422 refuses any other). */
const JURISDICTIONS: readonly { value: string; label: string }[] = [
  { value: "ngs_j6", label: "NGS J6" },
  { value: "ngs_jk", label: "NGS JK" },
  { value: "cgs_j15", label: "CGS J15" },
  { value: "palmetto_jj", label: "Palmetto JJ" },
  { value: "palmetto_jm", label: "Palmetto JM" },
  { value: "noridian_jf", label: "Noridian JF" },
  { value: "noridian_je", label: "Noridian JE" },
];
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:mac_configured:credential`;

const BLANK: Form = {
  providerEntityId: "",
  macJurisdiction: "noridian_jf",
  submitterId: "",
  tradingPartnerId: "",
  clientId: "",
  baaRecordRef: "",
};

function validate(form: Form, clientSecret: string): Errors {
  const errors: Errors = {};
  if (form.providerEntityId === "") errors.providerEntityId = "Pick the provider entity.";
  if (form.submitterId.trim() === "") errors.submitterId = "Enter the submitter id.";
  if (form.tradingPartnerId.trim() === "")
    errors.tradingPartnerId = "Enter the trading partner id.";
  if (form.clientId.trim() === "") errors.clientId = "Enter the client id.";
  if (clientSecret === "") errors.clientSecret = "Enter the client secret.";
  return errors;
}

export function MacPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const canWrite = actions.readOnlyReason === null;
  const entities = useLoad<{ items: Entity[] }>(`mac-entities:${orgSlug}`, () =>
    client.GET("/api/v1/platform/tenants/{orgSlug}/provider-entities", {
      params: { path: { orgSlug } },
    }),
  );
  const credentials = useLoad<{ items: Credential[] }>(
    `mac:${orgSlug}`,
    () =>
      client.GET("/api/v1/platform/tenants/{orgSlug}/mac-credentials", {
        params: { path: { orgSlug } },
      }) as Promise<{
        data?: { items: Credential[] };
        error?: unknown;
        response?: { status: number };
      }>,
  );
  const restored = useStepUpDraft<Form>(draftKey(orgSlug));
  const [editing, setEditing] = useState<{ pinnedVersion: number | null } | null>(
    restored ? { pinnedVersion: null } : null,
  );
  const [form, setForm] = useState<Form>(restored ?? BLANK);
  const [clientSecret, setClientSecret] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [asking, setAsking] = useState(false);
  const write = useOpsWrite();

  const entityList = entities.data?.items ?? [];
  const items = credentials.data?.items ?? [];
  const entityName = (id: string): string => entityList.find((e) => e.id === id)?.legalName ?? id;
  const set = (field: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  function open(existing: Credential | null): void {
    write.clear();
    setErrors({});
    setClientSecret("");
    setForm(
      existing
        ? {
            providerEntityId: existing.providerEntityId,
            macJurisdiction: existing.macJurisdiction,
            submitterId: existing.submitterId,
            tradingPartnerId: existing.tradingPartnerId,
            clientId: existing.clientId,
            baaRecordRef: existing.baaRecordRef ?? "",
          }
        : { ...BLANK, providerEntityId: entityList[0]?.id ?? "" },
    );
    setEditing({ pinnedVersion: existing?.version ?? null });
  }

  function askForReason(): void {
    const found = validate(form, clientSecret);
    setErrors(found);
    if (Object.keys(found).length === 0) setAsking(true);
  }

  async function save(reason: string): Promise<void> {
    if (!editing) return;
    const body = {
      providerEntityId: form.providerEntityId,
      macJurisdiction: form.macJurisdiction,
      submitterId: form.submitterId.trim(),
      tradingPartnerId: form.tradingPartnerId.trim(),
      clientId: form.clientId.trim(),
      clientSecret,
      ...(form.baaRecordRef.trim() ? { baaRecordRef: form.baaRecordRef.trim() } : {}),
      reason,
    };
    const pinned = editing.pinnedVersion;
    const outcome = await write.run(`${pinned ?? "new"}:${JSON.stringify(body)}`, (key) =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/mac-credentials", {
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
      setAsking(false);
      setEditing(null);
      setClientSecret("");
      await Promise.all([credentials.reload(true), ctx.refresh()]);
    } else if (outcome.failure.kind === "conflict") {
      // Someone changed it since it was read: show what it says now and make the operator enter the new value again.
      setClientSecret("");
      await credentials.reload(true);
    }
  }

  const facts: Fact[] = [
    {
      key: "one",
      label: "A MAC credential is on file",
      state: items.length > 0 ? "ok" : "pending",
    },
  ];
  const fieldError = (field: keyof Errors): string | undefined =>
    errors[field] ?? write.failure?.fieldErrors[field];
  const creating = editing !== null && editing.pinnedVersion === null;

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="MAC credentials">
        <div className="wx-drawer-card-head">
          <h3>MAC credentials</h3>
          {canWrite && !editing && entityList.length > 0 && items.length === 0 ? (
            <Button size="sm" tone="secondary" onClick={() => open(null)}>
              Add MAC credential
            </Button>
          ) : null}
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        {entities.data !== null && entityList.length === 0 ? (
          <p>Add a provider entity first: a credential belongs to one.</p>
        ) : null}
        {credentials.failure ? <p role="alert">Could not load the credentials.</p> : null}
        {credentials.data && items.length === 0 && entityList.length > 0 ? (
          <p>No MAC credential yet.</p>
        ) : null}
        {items.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">MAC credentials</caption>
            <thead>
              <tr>
                <th scope="col">Provider entity</th>
                <th scope="col">Jurisdiction</th>
                <th scope="col">Submitter id</th>
                <th scope="col">Client id</th>
                <th scope="col">Secret</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.credentialId}>
                  <td>{entityName(c.providerEntityId)}</td>
                  <td>{c.macJurisdiction}</td>
                  <td className="wx-data-md">{c.submitterId}</td>
                  <td className="wx-data-md">{c.clientId}</td>
                  <td>{c.hasSecret ? "Secret on file" : "None"}</td>
                  <td>
                    {canWrite ? (
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Replace credential for ${entityName(c.providerEntityId)}`}
                        onClick={() => open(c)}
                      >
                        Replace
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
        <section className="wx-drawer-card" aria-label="MAC credential form">
          <div className="wx-drawer-card-head">
            <h3>{creating ? "New MAC credential" : "Replace MAC credential"}</h3>
          </div>
          <PendingAttestationWarning view={view} />
          <div className="wx-form-grid">
            <SelectField
              label="Provider entity"
              value={form.providerEntityId}
              disabled={!creating}
              onChange={set("providerEntityId")}
              options={entityList.map((e) => ({ value: e.id, label: `${e.legalName} (${e.ccn})` }))}
              error={fieldError("providerEntityId")}
            />
            <SelectField
              label="MAC jurisdiction"
              value={form.macJurisdiction}
              onChange={set("macJurisdiction")}
              options={JURISDICTIONS}
            />
            <TextField
              label="Submitter id"
              value={form.submitterId}
              onChange={set("submitterId")}
              error={fieldError("submitterId")}
            />
            <TextField
              label="Trading partner id"
              value={form.tradingPartnerId}
              onChange={set("tradingPartnerId")}
              error={fieldError("tradingPartnerId")}
            />
            <TextField
              label="Client id"
              value={form.clientId}
              onChange={set("clientId")}
              error={fieldError("clientId")}
            />
            <TextField
              label="Client secret"
              hint="Write-only. Sealed under the tenant's key and never shown again."
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              error={fieldError("clientSecret")}
            />
            <TextField
              label="BAA record reference (optional)"
              value={form.baaRecordRef}
              onChange={set("baaRecordRef")}
            />
          </div>
          <div className="wx-drawer-actions">
            <Button tone="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={askForReason}>Save credential</Button>
          </div>
          {write.failure && !asking ? (
            <FailureNotice failure={write.failure} orgSlug={orgSlug} />
          ) : null}
        </section>
      ) : null}

      <RecordSaveDialog
        open={asking}
        title={creating ? "Save the new MAC credential" : "Replace the MAC credential"}
        confirmLabel="Save"
        write={write}
        orgSlug={orgSlug}
        onReverify={() => stashStepUpDraft<Form>(draftKey(orgSlug), form)}
        onConfirm={(reason) => void save(reason)}
        onCancel={() => {
          write.clear();
          setAsking(false);
        }}
      />
    </StepFrame>
  );
}
