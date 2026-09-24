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

type OrderKind = (typeof KINDS)[number];

export interface EditableOrder {
  id: string;
  admissionId: string;
  kind: OrderKind;
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
  const [physicianId, setPhysicianId] = useState(
    draft?.orderingPhysicianMdmId ?? "",
  );
  const [kind, setKind] = useState<OrderKind>(draft?.kind ?? "lab");
  const [discipline, setDiscipline] = useState(
    draft?.drafterDiscipline ?? "rn_case_manager",
  );
  const [priority, setPriority] = useState(draft?.priority ?? "routine");
  const [data, setData] = useState<Record<string, unknown>>(() =>
    asData(draft?.data),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    if (draft) {
      setAdmissionId(draft.admissionId);
      setPhysicianId(draft.orderingPhysicianMdmId);
      setKind(draft.kind);
      setDiscipline(draft.drafterDiscipline);
      setPriority(draft.priority);
      setData(asData(draft.data));
    }
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

    try {
      let result: { data?: unknown; error?: unknown };

      if (draft) {
        const patch = client.PATCH as unknown as (
          path: string,
          init: unknown,
        ) => Promise<{ data?: unknown; error?: unknown }>;
        result = await patch("/api/v1/orders/{id}", {
          params: { path: { id: draft.id } },
          body: { data, priority },
        });
      } else {
        const post = client.POST as unknown as (
          path: string,
          init: unknown,
        ) => Promise<{ data?: unknown; error?: unknown }>;
        const path = replacesOrderId
          ? "/api/v1/orders/{id}/correct"
          : "/api/v1/orders";
        result = await post(path, {
          params: replacesOrderId
            ? { path: { id: replacesOrderId } }
            : undefined,
          body: {
            patientId,
            admissionId,
            kind,
            drafterDiscipline: discipline,
            data,
            priority,
            orderingPhysicianMdmId: physicianId,
          },
        });
      }

      if (result.error || !result.data) {
        setError(message(result.error));
        setFieldErrors(findings(result.error));
        return;
      }

      onSaved((result.data as { id?: string }).id ?? draft?.id ?? "");
    } catch {
      setError("The server could not save this order. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const title = draft
    ? "Edit draft"
    : replacesOrderId
      ? "Create corrected order"
      : "New order";

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={title}
      width="42rem"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={form}
      >
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <p style={intro}>
            {draft
              ? "Complete the clinical details for this draft. You can save incomplete work and return later."
              : replacesOrderId
                ? "The original order remains unchanged. This creates a replacement draft that must be reviewed and signed."
                : "Create the order as a draft. It will not become active until the required review and signatures are complete."}
          </p>
        </div>

        {error ? (
          <div role="alert" style={errorBox}>
            {error}
          </div>
        ) : null}

        <div style={section}>
          <h3 style={sectionTitle}>Order setup</h3>
          <div style={grid}>
            <label style={field}>
              Order kind
              <select
                value={kind}
                disabled={Boolean(draft)}
                onChange={(e) => setKind(e.target.value as OrderKind)}
                style={control}
              >
                <option value="lab">Lab</option>
                <option value="dme">DME</option>
                <option value="level_of_care_change">
                  Level of care change
                </option>
                <option value="recertification">Recertification</option>
                <option value="comfort_kit">Comfort kit</option>
                <option value="supply">Supply</option>
                <option value="ancillary_service">Ancillary service</option>
              </select>
            </label>
            <label style={field}>
              Priority
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                style={control}
              >
                <option value="routine">Routine</option>
                <option value="asap">ASAP</option>
                <option value="stat">STAT</option>
              </select>
            </label>
          </div>

          {!draft ? (
            <div style={{ ...grid, marginTop: "1rem" }}>
              <OrderAdmissionLookup
                label="Admission"
                value={admissionId}
                onChange={setAdmissionId}
                patientId={patientId}
                required
              />
              <OrderingPhysicianLookup
                label="Ordering physician"
                value={physicianId}
                onChange={setPhysicianId}
                required
              />
              <label style={field}>
                Drafting discipline
                <input
                  value={discipline}
                  onChange={(e) => setDiscipline(e.target.value)}
                  required
                  style={control}
                />
              </label>
            </div>
          ) : null}
        </div>

        <CanonicalOrderFields
          kind={kind}
          value={data}
          onChange={setData}
          errors={fieldErrors}
        />

        <div style={footer}>
          <span style={saveHint}>
            {draft
              ? "Saving updates this Draft only."
              : "This will be saved as a Draft."}
          </span>
          <div style={{ display: "flex", gap: ".75rem" }}>
            <Button
              type="button"
              tone="secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function asData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  const details =
    (
      error as
        | { details?: Array<{ field?: string; message?: string }> }
        | undefined
    )?.details ?? [];
  return Object.fromEntries(
    details
      .filter((x) => x.field && x.message)
      .map((x) => [x.field!.replace(/^data\./, ""), x.message!]),
  );
}

const form = { display: "grid", gap: "1.25rem", padding: "1.25rem" } as const;
const intro = {
  margin: ".4rem 0 0",
  color: "var(--color-on-surface-variant)",
  lineHeight: 1.5,
} as const;
const section = {
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
} as const;
const sectionTitle = { margin: "0 0 .9rem", fontSize: ".95rem" } as const;
const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: "1rem",
} as const;
const field = {
  display: "grid",
  gap: ".4rem",
  fontSize: ".875rem",
  fontWeight: 600,
} as const;
const control = {
  display: "block",
  width: "100%",
  boxSizing: "border-box" as const,
  minHeight: "2.5rem",
  padding: ".55rem .65rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".45rem",
  background: "var(--color-surface, #fff)",
  color: "var(--color-on-surface)",
} as const;
const errorBox = {
  padding: ".75rem 1rem",
  border: "1px solid var(--color-error, #b42318)",
  borderRadius: ".5rem",
  color: "var(--color-error, #b42318)",
} as const;
const footer = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap" as const,
  gap: "1rem",
  paddingTop: ".25rem",
} as const;
const saveHint = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".8rem",
} as const;
