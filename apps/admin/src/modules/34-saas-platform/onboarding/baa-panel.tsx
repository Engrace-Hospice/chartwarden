// apps/admin/src/modules/34-saas-platform/onboarding — step 3, BAA: the business associate agreement between ChartWarden and the tenant.
// The operator records it (status, dates, the signed document's id); the platform settles the step at once when the GOVERNING record
// (the one the server marks: an undated termination, else the newest dated record) is executed, its signed agreement is filed for this
// tenant, and it has more than 90 days left (or no expiry). The register says which record governs and whether its document verifies,
// so these facts are the server's, never a pick of the panel's own. The operator who records the BAA
// cannot also approve go-live (four eyes), so the panel says so before anyone is surprised at the last step.
// The operator uploads the signed agreement here (its own permission, a fresh step-up and a reason): the platform files it with the
// tenant's documents and answers its id, which the BAA record then carries.
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
import { BaaDocumentField } from "./baa-document-field";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { StepFrame } from "./step-frame";
import { useEditorFocus } from "./use-editor-focus";
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
  /** The server marks the record go-live judges for this tenant. */
  governing: boolean;
  /** On the governing record: its document is a signed BAA filed for this tenant (M22). Null on any other record. */
  documentFiled: boolean | null;
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

/**
 * The facts that settle the step, judged as the server judges them (activation-guards.ts): on the record the register marks `governing`,
 * executed with its signed agreement filed for this tenant (`documentFiled`), and more than 90 days left; a record with no expiry does not
 * expire.
 */
export function baaFacts(records: readonly BaaRecord[], today: Date): Fact[] {
  const governing = records.find((r) => r.governing);
  const statusExecuted = governing?.baaStatus === "executed";
  const executed = statusExecuted && governing?.documentFiled !== false;
  const daysLeft =
    governing?.expiresOn != null
      ? Math.floor(
          (new Date(`${governing.expiresOn}T00:00:00Z`).getTime() - today.getTime()) / DAY_MS,
        )
      : null;
  const expiryState = !executed
    ? "pending"
    : daysLeft === null || daysLeft > MIN_DAYS_LEFT
      ? "ok"
      : "blocked";
  return [
    {
      key: "executed",
      label: "The governing BAA is executed",
      state: statusExecuted ? "ok" : "pending",
      ...(governing && !statusExecuted
        ? {
            detail: `The record that governs (${governing.addendumVersion}) is ${governing.baaStatus}.`,
          }
        : {}),
    },
    {
      key: "document",
      label: "Its signed agreement is filed for this tenant",
      state:
        governing?.documentFiled === true
          ? "ok"
          : statusExecuted && governing?.documentFiled === false
            ? "blocked"
            : "pending",
      ...(statusExecuted && governing?.documentFiled === false
        ? {
            detail:
              "The linked document is not a signed BAA filed for this tenant: upload the signed agreement and link it.",
          }
        : {}),
    },
    {
      key: "expiry",
      label: `It has more than ${MIN_DAYS_LEFT} days left`,
      state: expiryState,
      ...(executed && daysLeft === null
        ? { detail: "No expiry date is recorded: it does not expire." }
        : {}),
      ...(expiryState === "blocked" && daysLeft !== null
        ? { detail: `Expires ${governing?.expiresOn}: ${Math.max(daysLeft, 0)} days left.` }
        : {}),
    },
  ];
}

function validate(form: Form, creating: boolean): Errors {
  const errors: Errors = {};
  if (creating && form.addendumVersion.trim() === "")
    errors.addendumVersion = "Enter the addendum version, for example v1.";
  if (form.baaStatus === "executed" && form.documentId.trim() === "") {
    errors.documentId = "An executed BAA needs the signed agreement: upload it first.";
  }
  return errors;
}

export function BaaPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const tenantAccountId = view.tenantAccountId;
  const canWrite = actions.readOnlyReason === null;
  const mayUpload = useCan(ONBOARDING_KEYS.baaDocumentUpload);
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
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const write = useOpsWrite();
  const items = list.data?.items ?? [];

  const set = (field: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  function open(record: BaaRecord | null): void {
    write.clear();
    setErrors({});
    setUploadedName(null);
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
    const addendumVersion = form.addendumVersion.trim();
    // the whole body is the fingerprint: a create's addendum version is part of it, so a corrected version is a new attempt
    await write.run(
      `${id ?? "new"}:${id === null ? addendumVersion : ""}:${JSON.stringify(fields)}`,
      (key) =>
        id === null
          ? client.POST("/api/v1/platform/baa-register", {
              body: { tenantAccountId, addendumVersion, ...fields },
              headers: { "Idempotency-Key": key },
            })
          : client.PATCH("/api/v1/platform/baa-register/{id}", {
              params: { path: { id } },
              body: fields,
              headers: { "Idempotency-Key": key },
            }),
      // closing the editor and the reloads run inside the write's in-flight window: a submit during them is dropped
      async () => {
        setEditing(null);
        await Promise.all([list.reload(true), ctx.refresh()]);
      },
    );
  }

  const fieldError = (field: keyof Form): string | undefined =>
    errors[field] ?? write.failure?.fieldErrors[field];
  const editorHeading = useEditorFocus(editing !== null && canWrite, "baa");

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="BAA register">
        <div className="wx-drawer-card-head">
          <h3>Business associate agreement</h3>
          {canWrite && !editing ? (
            <Button size="sm" tone="secondary" data-editor-return="baa" onClick={() => open(null)}>
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
                  <td>
                    {r.documentId ? "Linked" : "—"}
                    {r.governing ? " · Governs" : ""}
                  </td>
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
        <form
          className="wx-drawer-card"
          aria-label="BAA form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="wx-drawer-card-head">
            <h3 ref={editorHeading} tabIndex={-1}>
              {editing.id === null ? "Record a BAA" : "Edit BAA"}
            </h3>
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
          </div>
          {mayUpload ? (
            <BaaDocumentField
              orgSlug={orgSlug}
              linked={form.documentId.trim() !== ""}
              uploadedName={uploadedName}
              error={fieldError("documentId")}
              onUploaded={(documentId, fileName) => {
                setForm((f) => ({ ...f, documentId }));
                setErrors((e) => ({ ...e, documentId: undefined }));
                setUploadedName(fileName);
              }}
              onReverify={() =>
                stashStepUpDraft(draftKey(orgSlug), { form, id: editing?.id ?? null })
              }
            />
          ) : (
            <RoleCannot what="upload the signed agreement (that needs the tenant_baa_document.upload_platform permission); a record can still link one already filed" />
          )}
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
            <Button type="submit" disabled={write.busy}>
              {write.busy ? "Saving…" : "Save BAA"}
            </Button>
          </div>
        </form>
      ) : null}
    </StepFrame>
  );
}
