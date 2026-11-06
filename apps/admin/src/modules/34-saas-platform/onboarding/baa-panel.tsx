// apps/admin/src/modules/34-saas-platform/onboarding — step 3, BAA: the business associate agreement between ChartWarden and the tenant.
// The operator records it (status, dates, the signed document's id); the platform settles the step at once when the latest record is
// executed, has its document and has more than 90 days left (the same facts the go-live guard judges). The operator who records the BAA
// cannot also approve go-live (four eyes), so the panel says so before anyone is surprised at the last step.
// The signed PDF lives in the document store; a platform operator holds no upload permission there, so the panel takes the document's
// id (the agreement is uploaded and its id handed over by whoever holds it).
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
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
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";

interface BaaRecord {
  id: string;
  addendumVersion: string;
  baaStatus: "executed" | "pending" | "terminated" | "missing";
  executedOn: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  documentId: string | null;
}
interface Form {
  addendumVersion: string;
  baaStatus: BaaRecord["baaStatus"];
  executedOn: string;
  effectiveOn: string;
  expiresOn: string;
  documentId: string;
}
type Errors = Partial<Record<keyof Form, string>>;

/** The go-live guard: an executed BAA must have more than this many days left. */
const MIN_DAYS_LEFT = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "executed", label: "Executed" },
  { value: "terminated", label: "Terminated" },
  { value: "missing", label: "Missing" },
] as const;
const BLANK: Form = {
  addendumVersion: "",
  baaStatus: "pending",
  executedOn: "",
  effectiveOn: "",
  expiresOn: "",
  documentId: "",
};
const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:baa_executed:record`;

/** The facts that settle the step, judged on the record the go-live guard would pick: the executed one with the latest expiry. */
export function baaFacts(records: readonly BaaRecord[], today: Date): Fact[] {
  const executed = records
    .filter((r) => r.baaStatus === "executed")
    .sort((a, b) => (b.expiresOn ?? "9999").localeCompare(a.expiresOn ?? "9999"))[0];
  const daysLeft =
    executed?.expiresOn != null
      ? Math.floor(
          (new Date(`${executed.expiresOn}T00:00:00Z`).getTime() - today.getTime()) / DAY_MS,
        )
      : null;
  return [
    { key: "executed", label: "A BAA is executed", state: executed ? "ok" : "pending" },
    {
      key: "document",
      label: "Its signed document is linked",
      state: executed?.documentId ? "ok" : "pending",
    },
    {
      key: "expiry",
      label: `It has more than ${MIN_DAYS_LEFT} days left`,
      state: daysLeft === null ? "pending" : daysLeft > MIN_DAYS_LEFT ? "ok" : "blocked",
      ...(executed && daysLeft === null ? { detail: "No expiry date is recorded yet." } : {}),
      ...(daysLeft !== null && daysLeft <= MIN_DAYS_LEFT
        ? { detail: `Expires ${executed?.expiresOn}: ${Math.max(daysLeft, 0)} days left.` }
        : {}),
    },
  ];
}

function validate(form: Form, creating: boolean): Errors {
  const errors: Errors = {};
  if (creating && form.addendumVersion.trim() === "")
    errors.addendumVersion = "Enter the addendum version, for example v1.";
  if (form.baaStatus === "executed" && !UUID.test(form.documentId.trim())) {
    errors.documentId = "An executed BAA needs the document id of the signed agreement.";
  } else if (form.documentId.trim() !== "" && !UUID.test(form.documentId.trim())) {
    errors.documentId = "The document id is a UUID.";
  }
  return errors;
}

export function BaaPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const tenantAccountId = view.tenantAccountId;
  const canWrite = actions.readOnlyReason === null;
  const list = useLoad<{ items: BaaRecord[] }>(
    `baa:${tenantAccountId}`,
    () =>
      client.GET("/api/v1/platform/baa-register", {
        params: { query: { tenantAccountId } },
      }) as Promise<{
        data?: { items: BaaRecord[] };
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
  const write = useOpsWrite();
  const items = list.data?.items ?? [];

  const set = (field: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  function open(record: BaaRecord | null): void {
    write.clear();
    setErrors({});
    setForm(
      record
        ? {
            addendumVersion: record.addendumVersion,
            baaStatus: record.baaStatus,
            executedOn: record.executedOn ?? "",
            effectiveOn: record.effectiveOn ?? "",
            expiresOn: record.expiresOn ?? "",
            documentId: record.documentId ?? "",
          }
        : { ...BLANK, addendumVersion: items.length === 0 ? "v1" : "" },
    );
    setEditing({ id: record?.id ?? null });
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const found = validate(form, editing.id === null);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const fields = {
      baaStatus: form.baaStatus,
      ...(form.executedOn ? { executedOn: form.executedOn } : {}),
      ...(form.effectiveOn ? { effectiveOn: form.effectiveOn } : {}),
      ...(form.expiresOn ? { expiresOn: form.expiresOn } : {}),
      ...(form.documentId.trim() ? { documentId: form.documentId.trim() } : {}),
    };
    const id = editing.id;
    const outcome = await write.run(`${id ?? "new"}:${JSON.stringify(fields)}`, () =>
      id === null
        ? client.POST("/api/v1/platform/baa-register", {
            body: { tenantAccountId, addendumVersion: form.addendumVersion.trim(), ...fields },
          })
        : client.PATCH("/api/v1/platform/baa-register/{id}", {
            params: { path: { id } },
            body: fields,
          }),
    );
    if (outcome.ok) {
      setEditing(null);
      await Promise.all([list.reload(true), ctx.refresh()]);
    }
  }

  const fieldError = (field: keyof Form): string | undefined =>
    errors[field] ?? write.failure?.fieldErrors[field];

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="BAA register">
        <div className="wx-drawer-card-head">
          <h3>Business associate agreement</h3>
          {canWrite && !editing ? (
            <Button size="sm" tone="secondary" onClick={() => open(null)}>
              Record BAA
            </Button>
          ) : null}
        </div>
        <FactList facts={baaFacts(items, new Date())} ariaLabel="What settles this step" />
        <InlineAlert tone="info">
          The operator who records this BAA cannot also approve go-live: a different operator
          approves.
        </InlineAlert>
        {list.failure ? <p role="alert">Could not load the BAA register.</p> : null}
        {list.data && items.length === 0 ? <p>No BAA on record.</p> : null}
        {items.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">BAA records</caption>
            <thead>
              <tr>
                <th scope="col">Addendum</th>
                <th scope="col">Status</th>
                <th scope="col">Executed</th>
                <th scope="col">Expires</th>
                <th scope="col">Document</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.addendumVersion}</td>
                  <td>{r.baaStatus}</td>
                  <td className="wx-nums">{r.executedOn ?? "—"}</td>
                  <td className="wx-nums">{r.expiresOn ?? "—"}</td>
                  <td>{r.documentId ? "Linked" : "—"}</td>
                  <td>
                    {canWrite ? (
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Edit ${r.addendumVersion}`}
                        onClick={() => open(r)}
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
        <section className="wx-drawer-card" aria-label="BAA form">
          <div className="wx-drawer-card-head">
            <h3>{editing.id === null ? "Record a BAA" : "Edit BAA"}</h3>
          </div>
          <PendingAttestationWarning view={view} />
          <div className="wx-form-grid">
            {editing.id === null ? (
              <TextField
                label="Addendum version"
                value={form.addendumVersion}
                onChange={set("addendumVersion")}
                error={fieldError("addendumVersion")}
              />
            ) : null}
            <SelectField
              label="Status"
              value={form.baaStatus}
              onChange={set("baaStatus")}
              options={STATUS_OPTIONS}
            />
            <TextField
              label="Executed on"
              type="date"
              value={form.executedOn}
              onChange={set("executedOn")}
            />
            <TextField
              label="Effective on"
              type="date"
              value={form.effectiveOn}
              onChange={set("effectiveOn")}
            />
            <TextField
              label="Expires on"
              type="date"
              value={form.expiresOn}
              onChange={set("expiresOn")}
            />
            <TextField
              label="Signed document id"
              hint="The document id of the signed agreement. Required when the status is executed."
              value={form.documentId}
              onChange={set("documentId")}
              error={fieldError("documentId")}
            />
          </div>
          {write.failure ? (
            <FailureNotice
              failure={write.failure}
              orgSlug={orgSlug}
              onReverify={() =>
                stashStepUpDraft(draftKey(orgSlug), { form, id: editing?.id ?? null })
              }
            />
          ) : null}
          <div className="wx-drawer-actions">
            <Button tone="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={write.busy}>
              {write.busy ? "Saving…" : "Save BAA"}
            </Button>
          </div>
        </section>
      ) : null}
    </StepFrame>
  );
}
