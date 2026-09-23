import { Button, Modal, useApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { CanonicalOrderFields } from "./order-kind-fields";
import { OrderAdmissionLookup, OrderingPhysicianLookup } from "./order-lookups";

const KINDS = [
  "lab",
  "dme",
  "level_of_care_change",
  "recertification",
  "comfort_kit",
  "supply",
  "ancillary_service",
  "idg_requested",
] as const;

export interface EditableOrder {
  id: string;
  admissionId: string;
  kind: (typeof KINDS)[number];
  priority: string;
  drafterDiscipline: string;
  orderingPhysicianMdmId: string;
  data: unknown;
}

export function OrderEditor({
  open,
  onClose,
  patientId,
  replacesOrderId,
  draft,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  patientId: string;
  replacesOrderId?: string;
  draft?: EditableOrder;
  onSaved: (id: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [admissionId, setAdmissionId] = useState(draft?.admissionId ?? "");
  const [physicianId, setPhysicianId] = useState(draft?.orderingPhysicianMdmId ?? "");
  const [kind, setKind] = useState<(typeof KINDS)[number]>(draft?.kind ?? "lab");
  const [discipline, setDiscipline] = useState(draft?.drafterDiscipline ?? "rn_case_manager");
  const [priority, setPriority] = useState(draft?.priority ?? "routine");
  const [data, setData] = useState<Record<string, unknown>>(() => asData(draft?.data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open || !draft) return;
    setAdmissionId(draft.admissionId);
    setPhysicianId(draft.orderingPhysicianMdmId);
    setKind(draft.kind);
    setDiscipline(draft.drafterDiscipline);
    setPriority(draft.priority);
    setData(asData(draft.data));
    setError(null);
    setFieldErrors({});
  }, [draft, open]);
  const save = async (): Promise<void> => {
    if (!admissionId || !physicianId) {
      setError("Admission and ordering physician are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const post = client.POST as unknown as (
      path: string,
      init: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>;
    const path = draft
      ? "/api/v1/orders/{id}"
      : replacesOrderId
        ? "/api/v1/orders/{id}/correct"
        : "/api/v1/orders";
    const result = await post(path, {
      params: draft
        ? { path: { id: draft.id } }
        : replacesOrderId
          ? { path: { id: replacesOrderId } }
          : undefined,
      body: draft
        ? { data, priority }
        : {
            patientId,
            admissionId,
            kind,
            drafterDiscipline: discipline,
            data,
            priority,
            orderingPhysicianMdmId: physicianId,
          },
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(message(result.error));
      setFieldErrors(findings(result.error));
      return;
    }
    onSaved((result.data as { id: string }).id ?? draft?.id ?? "");
  };
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={draft ? "Edit draft" : replacesOrderId ? "Correct order" : "New order"}
      width="42rem"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={{ display: "grid", gap: "1rem", padding: "1.25rem" }}
      >
        <h2 style={{ margin: 0 }}>
          {draft ? "Edit draft" : replacesOrderId ? "Create corrected order" : "New order"}
        </h2>
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>
          {replacesOrderId
            ? "The original order remains immutable; this creates its replacement draft."
            : "Create a draft. It is not active until the server accepts the required signatures."}
        </p>
        {error ? <div role="alert">{error}</div> : null}
        <label>
          Order kind
          <select
            value={kind}
            disabled={Boolean(draft)}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            style={control}
          >
            <option value="lab">Lab</option>
            <option value="dme">DME</option>
            <option value="level_of_care_change">Level of care change</option>
            <option value="recertification">Recertification</option>
            <option value="comfort_kit">Comfort kit</option>
            <option value="supply">Supply</option>
            <option value="ancillary_service">Ancillary service</option>
          </select>
        </label>
        {!draft ? (
          <>
            <OrderAdmissionLookup
              label="Admission"
              value={admissionId}
              onChange={(value) => setAdmissionId(value)}
              patientId={patientId}
              required
            />
            <OrderingPhysicianLookup
              label="Ordering physician"
              value={physicianId}
              onChange={(value) => setPhysicianId(value)}
              required
            />
            <label>
              Drafting discipline
              <input
                value={discipline}
                onChange={(e) => setDiscipline(e.target.value)}
                required
                style={control}
              />
            </label>
          </>
        ) : null}
        <label>
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={control}>
            <option value="routine">Routine</option>
            <option value="asap">ASAP</option>
            <option value="stat">STAT</option>
          </select>
        </label>
        <CanonicalOrderFields kind={kind} value={data} onChange={setData} errors={fieldErrors} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: ".75rem" }}>
          <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save draft"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function asData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function message(error: unknown): string {
  const x = error as { message?: string; detail?: string } | undefined;
  return (
    x?.detail ??
    x?.message ??
    "The server could not save this order. Review the clinical details and try again."
  );
}
function findings(error: unknown): Record<string, string> {
  const details = (error as { details?: Array<{ field?: string; message?: string }> } | undefined)?.details ?? [];
  return Object.fromEntries(details.filter((x) => x.field && x.message).map((x) => [x.field!.replace(/^data\./, ""), x.message!]));
}
const control = {
  display: "block",
  width: "100%",
  boxSizing: "border-box" as const,
  marginTop: ".3rem",
  padding: ".5rem",
};
